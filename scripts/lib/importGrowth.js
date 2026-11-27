/**
 * Base-relative server import-growth guard (#7993).
 *
 * The number this module reports is a static proxy, not a count of runtime
 * module instantiations. For each server `*.test.js` file it is the size of
 * that file's static import closure (the file included). Shared modules are
 * counted once per test that reaches them, because that is how the suite pays
 * import cost: every worker re-evaluates the closure. Dynamic `import()` is
 * invisible here, on purpose — the same rule `staticImportGraph.js` uses.
 * CI selection does follow it; `importReach.js` reports that view (#12285).
 *
 * An absolute ceiling on the sum made ordinary growth fail. A new leaf on a
 * widely reached module, or a new suite's own closure, inched the repository
 * total until the next unrelated change crossed a fixed line (#7993: CI
 * reported 116,920 against a 116,900 ceiling). This guard compares one
 * analyzer against the merge base and the working tree instead.
 *
 * The gated quantity is existing-suite growth: the sum, over test files that
 * exist on both sides, of how many modules each closure gained. New test
 * files are reported as new-suite contribution and do not spend the
 * allowance, so adding tests cannot by itself exhaust a repository-wide
 * budget. Shrinkage on one suite does not cancel growth on another.
 *
 * Threshold. The heavy edges this repository already measured:
 *   #6009 removed 19,286 (115,519 → 96,233) by cutting widely reached barrels.
 *   #6156 removed 12,794 (96,233 → 83,439) by deferring boot/run-only imports.
 * At the time this guard replaced the ceiling, `services/settings.js` was in
 * 331 suite closures and `services/userActions.js` (one of the #6156
 * deferrals) had a 23-module closure — on the order of 331×23 of proxy count
 * for that single edge. `lib/editorial/checkRegistry.js` (a #6009 barrel) was
 * 69 modules, and the retired catch-all validation barrel was reached by 224 suites. A new
 * zero-dependency leaf on the widest owner, `lib/provider/providerVendors.js` (376
 * suites), costs a few hundred. `EXISTING_SUITE_GROWTH_LIMIT` sits above that
 * ordinary band and below half of the smaller heavy regression, so a limit
 * bump large enough to admit a #6156-class edge fails the pin test.
 *
 * Missing history fails closed. An unresolvable base commit, a base tree
 * with too few test files to be the real suite, or a base blob git cannot
 * read throws `ImportGrowthBaseError`. None of those become a zero delta.
 *
 * Wall-clock is not a gate. Live report collect timings are evidence about the
 * guard reading source; they are not compared to a threshold.
 */

import { existsSync, readFileSync } from 'fs';
import { join, posix } from 'path';
import { staticImportSpecifiersFromSource } from '../../server/lib/staticImportGraph.js';
import { createGuardCorpus } from '../../lib/guardCorpus.js';
import { runWorktreeGit } from '../../lib/gitWorktree.js';

/** Proxy counts recorded for the heavy edges this guard is calibrated against. */
export const HISTORICAL_PROXY_TOTALS = Object.freeze({
  before6009: 115_519,
  after6009: 96_233,
  after6156: 83_439,
});

export const REGRESSION_6009 = HISTORICAL_PROXY_TOTALS.before6009 - HISTORICAL_PROXY_TOTALS.after6009;
export const REGRESSION_6156 = HISTORICAL_PROXY_TOTALS.after6009 - HISTORICAL_PROXY_TOTALS.after6156;

/**
 * Existing-suite proxy growth that fails the guard.
 * Above ordinary wide-leaf growth (~1,500 in the retired ceiling's own
 * notes; a few hundred for one leaf on `providerVendors.js`) and below half
 * of #6156's 12,794 so that regression cannot be waived by raising this.
 */
export const EXISTING_SUITE_GROWTH_LIMIT = 2_500;

/** Server entrypoint whose static import closure is growth-guarded per PR. */
export const BOOT_ENTRY = 'server/index.js';

/**
 * Maximum net modules a single change may add to `server/index.js`'s static
 * import closure relative to the base commit. Replaces the fixed absolute cap
 * that broke unrelated PRs once repository headroom ran out (#18119).
 */
export const BOOT_CLOSURE_GROWTH_LIMIT = 15;

/** Half of the smaller known heavy regression. The pin test keeps the limit under this. */
export const HEAVY_REGRESSION_BAND = Math.floor(REGRESSION_6156 / 2);

/** Below this, a measurement is not the server suite — passing would be vacuous. */
const MIN_SERVER_TESTS = 1_000;

const SKIP_DIRS = new Set(['node_modules', 'coverage', 'dist', 'data']);
const SOURCE_EXT = /\.(?:[cm]?js|jsx|tsx?)$/;

// Head, base and the parity walker use the same parser. Cache by text so
// different source at the same path in two revisions still gets parsed.
const specifierCache = new Map();
export function cachedStaticImportSpecifiers(text) {
  let specs = specifierCache.get(text);
  if (!specs) {
    specs = staticImportSpecifiersFromSource(text);
    specifierCache.set(text, specs);
  }
  return specs;
}

const PROXY_NOTE = 'Static closure sizes are a proxy for import cost, not a count of observed module instantiations.';

function importGrowthBaseError(message) {
  const error = new Error(message);
  error.name = 'ImportGrowthBaseError';
  error.code = 'IMPORT_GROWTH_BASE_UNAVAILABLE';
  return error;
}

/** Repo-relative POSIX path for a specifier, or null when it leaves the repo. */
export function resolveRepoSpecifier(fromRel, spec) {
  if (!spec.startsWith('.')) return null;
  const next = posix.join(posix.dirname(fromRel), spec);
  if (next === '..' || next.startsWith('../') || next.startsWith('/')) return null;
  return next;
}

function closureOf(entry, resolved) {
  const files = new Set();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop();
    if (files.has(file)) continue;
    files.add(file);
    for (const dep of resolved(file)) if (!files.has(dep)) stack.push(dep);
  }
  return files;
}

/**
 * Closure sizes for `testFiles` (plus `bootEntry` when present), using
 * `readText` for every file. Both the working tree and a git commit go through
 * this function — base and head never run different analyzers. `readText`
 * returns null when the path is absent. A throw from `readText` is a failed
 * read, not an empty closure.
 *
 * @returns {{ tests: Map<string, Set<string>>, deps: Map<string, string[]>, texts: Map<string, string|null>, bootClosure: Set<string>|null, testCount: number, total: number }}
 */
export function measureClosures(testFiles, readText, { bootEntry = BOOT_ENTRY, reuseFrom = null } = {}) {
  const textCache = new Map();
  const read = (rel) => {
    if (textCache.has(rel)) return textCache.get(rel);
    const text = readText(rel);
    textCache.set(rel, text);
    return text;
  };
  const deps = new Map();
  const resolved = (rel) => {
    const cached = deps.get(rel);
    if (cached) return cached;
    const text = read(rel);
    if (text == null) {
      deps.set(rel, []);
      return [];
    }
    const next = [];
    const seen = new Set();
    for (const spec of cachedStaticImportSpecifiers(text)) {
      const target = resolveRepoSpecifier(rel, spec);
      if (!target || seen.has(target)) continue;
      if (read(target) == null) continue;
      seen.add(target);
      next.push(target);
    }
    deps.set(rel, next);
    return next;
  };

  // Verify outgoing edges against this reader, including targets that only
  // exist in one tree. If none of a closure's members changed, the original
  // walk still reaches exactly the same files, even across cycles.
  const changedEdges = new Set();
  if (reuseFrom) {
    for (const [file, previous] of reuseFrom.deps) {
      const current = resolved(file);
      if (previous.length !== current.length || previous.some((target, i) => target !== current[i])) {
        changedEdges.add(file);
      }
    }
  }
  const closure = (entry, previous) => (previous?.isDisjointFrom(changedEdges)
    ? previous : closureOf(entry, resolved));
  const tests = new Map();
  let total = 0;
  for (const file of testFiles) {
    if (read(file) == null) continue;
    const reached = closure(file, reuseFrom?.tests.get(file));
    tests.set(file, reached);
    total += reached.size;
  }
  const previousBoot = reuseFrom?.bootClosure;
  // The first member is the entry of the original walk.
  const sameBootEntry = previousBoot?.values().next().value === bootEntry;
  const bootClosure = bootEntry && read(bootEntry) != null
    ? closure(bootEntry, sameBootEntry ? previousBoot : null) : null;
  return { tests, deps, texts: textCache, bootClosure, testCount: tests.size, total };
}

function closureSizeFromDeps(entry, deps) {
  return closureOf(entry, (rel) => deps.get(rel) || []).size;
}

function isServerTest(rel) {
  if (!rel.startsWith('server/') || !rel.endsWith('.test.js')) return false;
  return rel.split('/').every((part) => part && !part.startsWith('.') && !SKIP_DIRS.has(part));
}

/**
 * Compare two measurements from `measureClosures`.
 * `existingSuiteGrowth` sums per-file closure growth. A suite that shrinks
 * does not pay down a suite that grew. New test files contribute only to
 * `newSuiteContribution`. When either side measures `bootClosure`, its net
 * delta (head minus base) is also checked against `bootLimit`.
 */
export function compareImportGrowth(
  base,
  head,
  { limit = EXISTING_SUITE_GROWTH_LIMIT, bootLimit = BOOT_CLOSURE_GROWTH_LIMIT } = {},
) {
  let existingSuiteGrowth = 0;
  let existingSuiteShrink = 0;
  let comparedSuites = 0;
  let newSuiteContribution = 0;
  let newSuiteCount = 0;
  let removedSuiteContribution = 0;
  let removedSuiteCount = 0;
  const suiteDeltas = [];
  const newReach = new Map();

  for (const [file, headClosure] of head.tests) {
    const baseClosure = base.tests.get(file);
    if (!baseClosure) {
      newSuiteCount += 1;
      newSuiteContribution += headClosure.size;
      continue;
    }
    comparedSuites += 1;
    const growth = Math.max(0, headClosure.size - baseClosure.size);
    const shrink = Math.max(0, baseClosure.size - headClosure.size);
    existingSuiteGrowth += growth;
    existingSuiteShrink += shrink;
    if (growth === 0) continue;
    const added = [];
    for (const mod of headClosure) {
      if (baseClosure.has(mod)) continue;
      added.push(mod);
      newReach.set(mod, (newReach.get(mod) || 0) + 1);
    }
    suiteDeltas.push({
      file,
      base: baseClosure.size,
      head: headClosure.size,
      growth,
      added: added.sort(),
    });
  }

  for (const [file, baseClosure] of base.tests) {
    if (head.tests.has(file)) continue;
    removedSuiteCount += 1;
    removedSuiteContribution += baseClosure.size;
  }

  suiteDeltas.sort((a, b) => b.growth - a.growth || a.file.localeCompare(b.file));

  const largestNewDependencies = [...newReach.entries()]
    .map(([module, reach]) => ({
      module,
      newReach: reach,
      closureSize: closureSizeFromDeps(module, head.deps),
    }))
    .sort((a, b) => (b.newReach * b.closureSize) - (a.newReach * a.closureSize) || a.module.localeCompare(b.module))
    .slice(0, 8);

  const baseBoot = base.bootClosure ?? null;
  const headBoot = head.bootClosure ?? null;
  let bootClosure = null;
  if (baseBoot || headBoot) {
    const baseSet = baseBoot ?? new Set();
    const headSet = headBoot ?? new Set();
    const added = [...headSet].filter((mod) => !baseSet.has(mod)).sort();
    const delta = headSet.size - baseSet.size;
    bootClosure = {
      ok: delta <= bootLimit,
      limit: bootLimit,
      base: baseSet.size,
      head: headSet.size,
      delta,
      added,
    };
  }

  const suiteOk = existingSuiteGrowth <= limit;
  const bootOk = bootClosure ? bootClosure.ok : true;

  return {
    ok: suiteOk && bootOk,
    suiteOk,
    limit,
    proxyNote: PROXY_NOTE,
    baseTotal: base.total,
    headTotal: head.total,
    baseTestCount: base.testCount,
    headTestCount: head.testCount,
    comparedSuites,
    existingSuiteGrowth,
    existingSuiteShrink,
    newSuiteContribution,
    newSuiteCount,
    removedSuiteContribution,
    removedSuiteCount,
    largestSuiteDeltas: suiteDeltas.slice(0, 8),
    largestNewDependencies,
    bootClosure,
  };
}

export function formatImportGrowthReport(report) {
  if (report.skipped) return `Import growth not measured: ${report.skipped}.`;
  const lines = [
    PROXY_NOTE,
    `Base ${report.baseTestCount} suites, proxy total ${report.baseTotal}.`,
    `Head ${report.headTestCount} suites, proxy total ${report.headTotal}.`,
    `Existing-suite growth ${report.existingSuiteGrowth} (limit ${report.limit}); shrinkage elsewhere ${report.existingSuiteShrink}.`,
    `New-suite contribution ${report.newSuiteContribution} across ${report.newSuiteCount} new test file(s) — not part of the limit.`,
    `Removed-suite proxy ${report.removedSuiteContribution} across ${report.removedSuiteCount} deleted test file(s).`,
  ];
  if (report.baseSha) lines.splice(1, 0, `Compared with ${report.baseSource || 'base'} ${report.baseSha}.`);
  if (report.bootClosure) {
    const boot = report.bootClosure;
    const sign = boot.delta > 0 ? '+' : '';
    lines.push(`Boot closure (${BOOT_ENTRY}): ${boot.base} → ${boot.head} (${sign}${boot.delta}, limit +${boot.limit}).`);
    if (boot.added.length > 0) {
      const preview = boot.added.slice(0, 20).join(', ');
      const extra = boot.added.length > 20 ? ` (+${boot.added.length - 20} more)` : '';
      lines.push(`Added boot-reachable modules (${boot.added.length}): ${preview}${extra}`);
    }
  }
  if (report.largestSuiteDeltas.length > 0) {
    lines.push('Largest existing-suite increases:');
    for (const row of report.largestSuiteDeltas) {
      const sample = row.added.slice(0, 6).join(', ');
      lines.push(`  ${row.file}  ${row.base} → ${row.head} (+${row.growth})${sample ? ` added ${sample}` : ''}`);
    }
  }
  if (report.largestNewDependencies.length > 0) {
    lines.push('Largest new dependency closures (new reachers × that module\'s closure):');
    for (const row of report.largestNewDependencies) {
      lines.push(`  ${row.module}  closure ${row.closureSize}, newly reached by ${row.newReach} existing suite(s)`);
    }
  }
  const suiteFailed = report.suiteOk === false || (report.suiteOk == null && !report.ok);
  if (suiteFailed) {
    lines.push(
      'A widely reached module gained an eager dependency whose closure is too large to be ordinary leaf growth.',
      'Narrow it, or defer it with await import() on the path that actually uses it.',
      'New test files do not spend this allowance — do not delete a suite to get under the limit.',
      'Raising EXISTING_SUITE_GROWTH_LIMIT is the intentional-regression path: do it in the same change, name the module that cannot be deferred, and keep the limit below the #6156 band (the pin test enforces that). See server/AGENTS.md, Import scoping.',
    );
  }
  if (report.bootClosure && !report.bootClosure.ok) {
    lines.push(
      `Boot closure (${BOOT_ENTRY}) grew by +${report.bootClosure.delta} module(s), exceeding BOOT_CLOSURE_GROWTH_LIMIT (${report.bootClosure.limit}).`,
      'Defer rare-path or feature imports with await import(), or narrow imports to a leaf module so server boot stays lean.',
    );
  }
  if (report.timings) {
    const headTiming = report.timings.headCollectMs == null
      ? 'head collect reused from the caller'
      : `head collect ${report.timings.headCollectMs}ms`;
    lines.push(
      `Measurement timings (not a threshold): base collect ${report.timings.baseCollectMs}ms, ${headTiming}, compare ${report.timings.compareMs}ms.`,
      'Those timings are the guard reading source. They are not Vitest collection time and not test-execution time.',
    );
  }
  return lines.join('\n');
}


function git(repoRoot, args, { input, encoding = 'utf8', maxBuffer = 64 * 1024 * 1024 } = {}) {
  return runWorktreeGit(repoRoot, args, { input, encoding, maxBuffer });
}

function gitOk(repoRoot, args, options) {
  const result = git(repoRoot, args, options);
  if (result.error || result.status !== 0) return null;
  return typeof result.stdout === 'string' ? result.stdout.trim() : result.stdout;
}

export function gitRevParse(repoRoot, rev) {
  return gitOk(repoRoot, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
}

function gitMergeBase(repoRoot, ref) {
  return gitOk(repoRoot, ['merge-base', ref, 'HEAD']);
}

function defaultBaseRef(repoRoot) {
  const head = git(repoRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head.status === 0 && head.stdout.trim()) return head.stdout.trim();
  return 'origin/main';
}

/**
 * Why this run should not measure growth, or null when it should.
 * The limit is sized for ONE change. A pull request into `release`, and the
 * push that lands it, compare against the previous release, so they sum every
 * pull request of the cycle — each of which already passed this guard against
 * main. Measuring that aggregate fails a release on growth no change owns.
 */
export function importGrowthSkipReason(env = process.env) {
  // Pregate keeps the exact comparison SHA but also passes its chosen base
  // ref, so a release promotion gets the same policy as its hosted PR. A
  // selected local main base must not inherit an unrelated forge exemption.
  if (typeof env.PORTOS_PREGATE_BASE_REF === 'string') {
    return ['release', 'origin/release', 'refs/heads/release', 'refs/remotes/origin/release'].includes(env.PORTOS_PREGATE_BASE_REF)
      ? 'local pregate against release aggregates a whole release cycle'
      : null;
  }
  if (env.GITHUB_BASE_REF === 'release') return 'pull request into release aggregates a whole release cycle';
  if (env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF_NAME === 'release') return 'push to release aggregates a whole release cycle';
  return null;
}

/**
 * The commit head is compared against.
 * `CI_BASE_SHA` wins when it is set (CI pull requests and pregate, which
 * forwards the same sha the planner used). It must resolve; a present but
 * unreadable value does not fall through to a self-comparison.
 * On GitHub Actions without that variable (nightly, workflow dispatch) the
 * parent commit is the base — a depth-2 checkout has it — and a missing
 * parent fails. Locally, the merge-base with the remote default branch is
 * the base, and a missing ref fails the same way.
 */
export function resolveImportGrowthBase({
  repoRoot,
  env = process.env,
  revParse = gitRevParse,
  mergeBase = gitMergeBase,
  defaultRef,
} = {}) {
  const explicit = typeof env.CI_BASE_SHA === 'string' ? env.CI_BASE_SHA.trim() : '';
  if (explicit) {
    const sha = revParse(repoRoot, explicit);
    if (!sha) {
      throw importGrowthBaseError(
        `CI_BASE_SHA does not resolve to a commit. The import-growth guard does not pass when the base commit is unavailable.`,
      );
    }
    return { sha, source: 'CI_BASE_SHA' };
  }
  if (env.GITHUB_ACTIONS === 'true') {
    const sha = revParse(repoRoot, 'HEAD^1');
    if (!sha) {
      throw importGrowthBaseError(
        'GitHub Actions did not provide CI_BASE_SHA and HEAD^1 does not resolve. The import-growth guard does not pass without a base commit.',
      );
    }
    return { sha, source: 'HEAD^1' };
  }
  const ref = defaultRef || defaultBaseRef(repoRoot);
  const sha = mergeBase(repoRoot, ref);
  if (!sha) {
    throw importGrowthBaseError(
      `Cannot resolve a merge-base with ${ref}. Fetch it (git fetch origin). The import-growth guard does not pass without a base commit.`,
    );
  }
  return { sha, source: `merge-base ${ref}` };
}

function diskRead(readText) {
  // Callers first check membership in Git's repo-relative path inventory.
  // Trust that boundary instead of normalizing every candidate twice.
  return (rel) => {
    try {
      return readText(rel);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EISDIR' || error.code === 'ENOTDIR') return null;
      throw error;
    }
  };
}

export function measureWorkingTree(repoRoot, corpus = createGuardCorpus(repoRoot)) {
  // Untracked tests count toward new-suite growth. A parent repository's
  // inventory omits submodule contents on both sides of the comparison.
  let paths;
  try {
    paths = new Set(corpus.workingTreeCandidates());
  } catch (error) {
    throw importGrowthBaseError(`git ls-files failed (exit ${error.status ?? 'spawn'}). The import-growth guard does not pass when the file list cannot be read.`);
  }
  const readDisk = diskRead(corpus.read);
  const testFiles = [...paths].filter(isServerTest).sort();
  return measureClosures(testFiles, (rel) => (paths.has(rel) ? readDisk(rel) : null));
}

/**
 * Paths at `sha` whose blob must be read from git because the worktree copy
 * is not that commit's bytes (edits, deletions, renames). Added paths are
 * omitted: they are not in the base tree.
 */
export function basePathsToReadFromGit(nameStatusZ) {
  const parts = nameStatusZ.split('\0').filter((part) => part !== '');
  const paths = [];
  for (let i = 0; i < parts.length;) {
    const status = parts[i];
    i += 1;
    if (!status) break;
    const code = status[0];
    const path = parts[i];
    i += 1;
    if (path == null) {
      throw importGrowthBaseError('git diff --name-status output ended mid-record.');
    }
    if (code === 'R' || code === 'C') {
      const renamed = parts[i];
      i += 1;
      if (renamed == null) throw importGrowthBaseError('git diff --name-status rename record is missing its destination.');
      paths.push(path);
      continue;
    }
    if (code !== 'A') paths.push(path);
  }
  return paths;
}

function listTree(repoRoot, sha) {
  const result = git(repoRoot, ['ls-tree', '-r', '-z', '--name-only', sha]);
  if (result.status !== 0) {
    throw importGrowthBaseError(`Cannot list the tree of ${String(sha).slice(0, 12)}. The import-growth guard does not pass when base history is unreadable.`);
  }
  return new Set(result.stdout.split('\0').filter(Boolean));
}

function readBlobs(repoRoot, sha, paths) {
  const wanted = paths.filter((rel) => SOURCE_EXT.test(rel) && !rel.includes('\0') && !rel.includes('\n'));
  const blobs = new Map();
  if (wanted.length === 0) return blobs;
  const input = Buffer.from(wanted.map((rel) => `${sha}:${rel}`).join('\n') + '\n');
  const result = git(repoRoot, ['cat-file', '--batch'], { input, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw importGrowthBaseError(`git cat-file failed while reading ${String(sha).slice(0, 12)} (exit ${result.status ?? 'spawn'}).`);
  }
  const stdout = result.stdout;
  let offset = 0;
  const decodeLine = () => {
    const end = stdout.indexOf(0x0a, offset);
    if (end === -1) return null;
    const line = stdout.toString('utf8', offset, end);
    offset = end + 1;
    return line;
  };
  for (let n = 0; n < wanted.length; n += 1) {
    const header = decodeLine();
    if (header == null) {
      throw importGrowthBaseError(`git cat-file ended early while reading ${String(sha).slice(0, 12)}.`);
    }
    if (header.endsWith(' missing')) {
      throw importGrowthBaseError(`Base commit ${String(sha).slice(0, 12)} has no blob for ${wanted[n]}. The import-growth guard does not pass when a base file is missing.`);
    }
    const match = header.match(/^([0-9a-f]+) blob (\d+)$/);
    if (!match) {
      throw importGrowthBaseError(`git cat-file returned an unexpected header while reading ${String(sha).slice(0, 12)}.`);
    }
    const size = Number(match[2]);
    const body = stdout.toString('utf8', offset, offset + size);
    offset += size;
    if (stdout[offset] === 0x0a) offset += 1;
    blobs.set(wanted[n], body);
  }
  return blobs;
}

/**
 * An optional worktree measurement supplies the text of unchanged paths and
 * the closures that can be reused after checking their edges against the base.
 */
export function measureGitTree(repoRoot, sha, head = null) {
  const tree = listTree(repoRoot, sha);
  const testFiles = [...tree].filter(isServerTest).sort();
  // git diff exits 1 when the trees differ and 0 when they do not. Above 1 is a real failure.
  // Only old paths are used, so rename detection and the parallel index
  // preload are unnecessary. One stat pass avoids fanning out filesystem
  // work alongside the other guard workers.
  const diff = git(repoRoot, ['-c', 'core.preloadIndex=false', 'diff', '-z', '--name-status', '--no-renames', sha]);
  if (diff.error || diff.status > 1) {
    throw importGrowthBaseError(`Cannot diff the worktree against ${String(sha).slice(0, 12)}. The import-growth guard does not pass when the base diff is unreadable.`);
  }
  const dirty = new Set(basePathsToReadFromGit(diff.stdout).filter((rel) => tree.has(rel)));
  const blobs = readBlobs(repoRoot, sha, [...dirty]);
  const fromDisk = diskRead((rel) => readFileSync(join(repoRoot, rel), 'utf8'));
  const readText = (rel) => {
    if (!tree.has(rel)) return null;
    if (blobs.has(rel)) return blobs.get(rel);
    if (dirty.has(rel)) {
      throw importGrowthBaseError(`Base file ${rel} differs from the worktree but its blob was not loaded from ${String(sha).slice(0, 12)}.`);
    }
    const shared = head?.texts.get(rel);
    if (typeof shared === 'string') return shared;
    const abs = join(repoRoot, ...rel.split('/'));
    if (!existsSync(abs)) {
      throw importGrowthBaseError(`Base file ${rel} is unchanged from ${String(sha).slice(0, 12)} but missing from the worktree.`);
    }
    return fromDisk(rel);
  };
  return measureClosures(testFiles, readText, { reuseFrom: head });
}

/**
 * Measure the working tree and the resolved base with the same analyzer.
 * Throws `ImportGrowthBaseError` when the base cannot be read or either side
 * is too small to be the server suite. A thrown error is not a passing delta.
 *
 * `headMeasurement` is a `measureWorkingTree` result for this same `repoRoot`.
 * The always-run guard already needs that map for a second assertion, and
 * walking the suite again only repeats the head collect.
 */
export function evaluateWorkingTreeImportGrowth({
  repoRoot,
  env = process.env,
  limit = EXISTING_SUITE_GROWTH_LIMIT,
  bootLimit = BOOT_CLOSURE_GROWTH_LIMIT,
  now = () => performance.now(),
  headMeasurement = null,
  measureHead = measureWorkingTree,
} = {}) {
  const skipped = importGrowthSkipReason(env);
  if (skipped) return { ok: true, skipped };
  const baseRef = resolveImportGrowthBase({ repoRoot, env });
  const headStart = now();
  const head = headMeasurement ?? measureHead(repoRoot);
  const headCollectMs = headMeasurement == null ? Math.round(now() - headStart) : null;
  if (head.testCount < MIN_SERVER_TESTS) {
    throw importGrowthBaseError(
      `Found ${head.testCount} server test files. The import-growth guard does not pass on a walk that cannot see the suite.`,
    );
  }
  const baseStart = now();
  const base = measureGitTree(repoRoot, baseRef.sha, head);
  const baseCollectMs = Math.round(now() - baseStart);
  if (base.testCount < MIN_SERVER_TESTS) {
    throw importGrowthBaseError(
      `Base ${baseRef.sha.slice(0, 12)} has ${base.testCount} server test files. The import-growth guard does not treat a partial history read as zero growth.`,
    );
  }
  const compareStart = now();
  const report = compareImportGrowth(base, head, { limit, bootLimit });
  const compareMs = Math.round(now() - compareStart);
  report.baseSha = baseRef.sha;
  report.baseSource = baseRef.source;
  report.timings = { baseCollectMs, headCollectMs, compareMs };
  return report;
}
