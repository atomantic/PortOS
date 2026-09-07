/**
 * Import-scoping guards (#6009).
 *
 * The Linux CI server suite spends more wall time importing modules than
 * running assertions, and almost none of that is any one test's fault: a
 * handful of widely-reached modules each pulled a subtree they only needed a
 * constant (or a boot-time function) from, and every test file downstream paid
 * for the whole thing. Narrowing those imports cut the suite's static module
 * instantiations — the sum, over all 1,588 server test files, of the modules in
 * each one's import closure — from ~115.5k to ~94.5k (-18%).
 *
 * That is a property nothing else in the tree defends, and it regresses
 * silently: re-pointing one of these imports back at the convenient barrel
 * still passes every behavioral test, it just quietly re-adds thousands of
 * module instantiations to CI. So each narrowing is pinned here as a negative
 * reachability assertion, paired with a positive control (per the contract in
 * `staticImportGraph.js`: a resolver gap must not be able to make the walk look
 * clean).
 *
 * BEFORE narrowing one of these — or any other production import — read the
 * "Import scoping" section of `server/AGENTS.md`. Bypassing a barrel that a
 * suite `vi.mock()`s reaches the real implementation instead of the double, and
 * the failure surfaces in an unrelated test file.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { staticImportClosure, staticImportSpecifiers } from './staticImportGraph.js';

const SERVER_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

// Server-relative POSIX paths, so a failure names `lib/db.js` rather than the
// absolute path of whoever's checkout is running the suite.
const abs = (relative) => join(SERVER_DIR, ...relative.split('/'));
const reaches = (entry, target) => staticImportClosure(abs(entry)).files.has(abs(target));

// Each row: the entry that was narrowed, the module it must no longer
// statically reach, and why the entry only ever needed a slice of it.
const NARROWED = [
  ['services/providerRuntimeInstaller.js', 'lib/harnessOutput.js',
    'loads version and catalog parsers only when probing a harness'],
  ['lib/db.js', 'lib/db/schema/index.js',
    'the DDL composer is boot-only — ensureSchemaImpl() imports it lazily'],
  ['lib/pipelineValidation.js', 'lib/editorial/checkRegistry.js',
    'needs CHECK_SCOPES/CHECK_SEVERITIES, not the 13 check-definition modules'],
  ['lib/editorial/severityConfig.js', 'lib/editorial/checkRegistry.js',
    'needs CHECK_SEVERITIES only'],
  ['services/pipeline/series.js', 'lib/editorial/checkRegistry.js',
    'needs CHECK_SEVERITIES only'],
  ['services/pipeline/applyCuts.js', 'lib/editorial/checkRegistry.js',
    'needs CUT_TYPES/SAFE_CUT_TYPES only'],
  ['services/apps.js', 'lib/validation.js',
    'needs sanitizeTaskMetadata, which cosValidation.js declares'],
  ['services/memoryEmbeddings.js', 'services/memoryBackend.js',
    'needs DEFAULT_MEMORY_CONFIG, which memoryConfig.js declares'],
  ['lib/llmRoutePin.js', 'lib/storyBible.js',
    'needs trimTo, which textUtils.js declares'],
  ['lib/slashdoInvocation.js', 'lib/tuiHandshake.js',
    'needs inferTuiCommand, which providerVendors.js declares'],
  ['services/voice/tools/pipeline.js', 'services/pipeline/issues.js',
    'needs NAVIGABLE_STAGE_IDS, which issuesShared.js declares'],
];

describe('narrowed imports stay narrow (#6009)', () => {
  it.each(NARROWED)('%s no longer statically reaches %s — it %s', (entry, target) => {
    expect(reaches(entry, target)).toBe(false);
  });

  // Positive controls. Without these the negatives above would also pass if
  // `staticImportClosure` stopped resolving these files at all.
  it('still sees the modules the narrowed entries were pointed AT', () => {
    expect(reaches('lib/pipelineValidation.js', 'lib/editorial/checkInfra/taxonomy.js')).toBe(true);
    expect(reaches('services/apps.js', 'lib/cosValidation.js')).toBe(true);
    expect(reaches('services/memoryEmbeddings.js', 'services/memoryConfig.js')).toBe(true);
    expect(reaches('lib/llmRoutePin.js', 'lib/textUtils.js')).toBe(true);
    expect(reaches('lib/slashdoInvocation.js', 'lib/providerVendors.js')).toBe(true);
    expect(reaches('services/voice/tools/pipeline.js', 'services/pipeline/issuesShared.js')).toBe(true);
  });

  // And a control on the other side: the barrels themselves still reach what
  // they re-export, so "nobody reaches checkRegistry" is a statement about the
  // narrowed callers, not about a broken registry.
  it('leaves the editorial barrel and the schema composer intact', () => {
    expect(reaches('lib/editorial/checkRegistry.js', 'lib/editorial/checks/proseStyle.js')).toBe(true);
    expect(reaches('lib/db/schema/index.js', 'lib/db/schema/catalog.js')).toBe(true);
  });
});

/**
 * Deferred imports (#6156).
 *
 * The other shape from the AGENTS.md section: not a constant reachable from a
 * lighter module, but a dependency that only a run/boot path executes. #6009
 * used it once (`ensureSchemaImpl`); these are the rest of the head of the
 * distribution — the four heaviest remaining edges were all "imported at module
 * scope, called only once a run is actually executing".
 *
 * Each row is asserted BOTH ways. The negative alone would also pass if someone
 * deleted the call entirely, which is a different (and probably wrong) change
 * than the one this row is defending; the positive pins the `await import()`
 * that has to remain in its place.
 */
// [entry, target, why, specifier] — same first three columns as NARROWED above,
// plus the specifier the call site must still name in its `await import()`.
const DEFERRED = [
  ['services/agentManagement.js', 'lib/privateSecuritySandbox.js',
    'loads sandbox cleanup only for private assessments', '../lib/privateSecuritySandbox.js'],
  ['services/cos.js', 'services/persistentMindAdapter.js',
    'is registered once at daemon start, but pulls the CoS tool registry, voice tools, ask service and image-gen backends',
    './persistentMindAdapter.js'],
  ['services/promptRunner.js', 'services/providerExecutionReadiness.js',
    'runs readiness only on the TUI execution branch, not when a run is built or classified',
    './providerExecutionReadiness.js'],
  ['services/promptRunner.js', 'services/tuiPromptRunner.js',
    'drags node-pty in through services/shell.js for a branch most promptRunner suites never take',
    './tuiPromptRunner.js'],
  ['services/settings.js', 'services/userActions.js',
    'makes one ledger write reaching the DB layer, from a module nearly every service imports',
    './userActions.js'],
  ['services/runner.js', 'services/ollamaAgentContext.js',
    'needs the daemon manager only for an ollama-backed CLI run; the call was already predicate-gated',
    './ollamaAgentContext.js'],
];

describe('deferred imports stay deferred (#6156)', () => {
  it.each(DEFERRED)('%s no longer statically reaches %s — it %s', (entry, target) => {
    expect(reaches(entry, target)).toBe(false);
  });

  it.each(DEFERRED)('%s still lazily imports %s at its call site', (entry, target, why, specifier) => {
    const src = readFileSync(abs(entry), 'utf-8');
    expect(
      src.includes(`import('${specifier}')`),
      `${entry} no longer contains a dynamic import('${specifier}'). If ${target} is genuinely unused now, delete this row — do not restore a static import.`,
    ).toBe(true);
  });

  // Positive control, mirroring the one above: these targets are real modules
  // with real graphs, so a resolver gap can't be what makes the negatives pass.
  it('still sees the deferred modules from their own entry points', () => {
    expect(reaches('services/persistentMindAdapter.js', 'services/cosToolRegistry.js')).toBe(true);
    expect(reaches('services/tuiPromptRunner.js', 'services/shell.js')).toBe(true);
  });
});

/**
 * The trend metric, as a budget.
 *
 * The rows above are exact: each defends one edge. This defends the property
 * they exist for — that the suite as a whole does not drift back toward
 * importing what it never runs — and it is the only assertion here that catches
 * a NEW heavy edge somewhere nobody has thought to add a row for.
 *
 * It is a budget, not a high-water mark. It sits ~1.5k above the measured total
 * so ordinary growth (a new service plus its suite) does not fail it, while the
 * shape this file exists to catch — one eager edge into a heavy subtree,
 * multiplied by every suite crossing it — moves the number by thousands.
 *
 * If a change pushes past it, first ask whether the new import belongs at module
 * scope at all. If it does, raise the number in the same commit and say what was
 * added. When a narrowing drops the total well below it, lower it — a budget
 * nobody tightens stops measuring anything.
 *
 * History, over the test files under `server/` only — the same denominator
 * #6009 reported, and what `serverTestFiles()` below walks:
 *   115,519 before #6009 · 96,233 after · 83,439 after #6156 · 85,105 after #5992 (orchestration profiles service & routes).
 *
 * Raised to 88,000 in #6305. The budget had drifted to within single digits of
 * the measured total, so the next ordinary addition was always going to trip it
 * — #6305's own share is ~43 (two new suites, plus one leaf service module,
 * `services/codexOssSupport.js`, reached by the 14 suites that cross
 * `services/providerPrerequisites.js`). That is the ordinary growth this budget
 * is documented to tolerate, not the shape it exists to catch, so the fix is to
 * restore the ~1.5k headroom the number is supposed to carry rather than to
 * inch it up by a hundred each time. It stays thousands below what ONE eager
 * edge into a heavy subtree costs, which is what actually has to fail here.
 */
// #6350: Pi's vendor leaf is necessarily reached by the shared dispatcher.
// Deferring catalog/version parsers removes 296 instantiations (88,360 →
// 88,064). Restore the documented ~1.5k allowance for ordinary leaf growth;
// keep the negative runtime-installer guard above so eager parsing cannot return.
//
// #6377 measures 89,889. Its share is ~389, and it is the tolerated shape, not
// the one this budget exists to catch: two new LEAF vocabulary modules with no
// subtree behind them — `lib/taskTargetScope.js` (four constants, zero imports)
// and `lib/quotaBurnTaskRef.js` (pure shape + resolver, importing only
// `objects.js`, which every reacher already had). They are reached by the ~200
// suites that cross `lib/quotaBurnConfig.js`, so a leaf costs ~200 apiece with
// nothing to defer. Restore the ~1.5k allowance again rather than inching the
// number up by a few hundred per PR.
//
// #6368 adds `lib/callerModePolicy.js`, another zero-dependency leaf reached by
// the routing boundary and the lib barrel (~92 instantiations). Same tolerated
// shape; it fits inside the allowance above.
//
// #6375 adds `lib/autonomousJobIntervals.js` — the autonomous-job cadence
// vocabulary `cosValidation.js` validates against, so ~194 suites reach it. It is
// a zero-import leaf (its time units are declared locally precisely so it drags
// nothing); the alternative is re-declaring the cadence list at the Zod boundary,
// which is the drift that issue exists to close. Fits inside the allowance above.
//
// #6364 retires the server/client copy convention, splitting four pure leaves
// out of modules the client now imports (`bibleLimits.js` out of `storyBible.js`,
// `portosUrls.js` out of `ports.js`, `youtubeUrlAssert.js` out of `youtubeUrl.js`,
// `avatarStyles.js` in from the client tree). Each is one extra NODE on a path
// that already existed — a flatter graph, not a new eager edge into a heavy
// subtree. Fits inside the allowance above.
//
// #6380 measures 91,710 — the ~1.5k allowance restored at #6377 is spent, so
// re-measure and restore it rather than inching. The +371 is ONE new suite,
// `services/cosTaskGenerator.auditMode.test.js`, and its cost IS its point: it
// generates a real audit task through `cosTaskGenerator.js` (274) and renders
// the final agent prompt from it through `agentPromptBuilder.js` (+94
// marginal), because the file-issues mode is enforced across exactly that seam
// and neither half alone can prove an issues-only run cannot acquire
// commit/push/PR instructions. No new eager edge into a heavy subtree: the
// production change adds only `lib/auditCatalog.js` (a zero-import leaf) to
// `autonomousJobs/skillTemplates.js`, worth 2.
// #6434: after deferring the private sandbox at all three CoS call sites,
// this branch measures 93,722 versus 93,229 on its current main base. The
// remaining +493 is the shared policy/provenance leaves and two boundary
// suites, not an eager sandbox/runtime subtree. Main already exceeded the
// previous ceiling; restore the documented ~1.5k ordinary-growth allowance.
// The DEFERRED row above prevents the avoidable sandbox edge from returning.
//
// #6442 adds 344 on top of that base (94,066), which fits inside the allowance
// #6434 restored — so the ceiling stays put. All 344 is three NEW suites and
// none of it a new eager edge; the production change adds no import its module
// did not already reach. The largest,
// services/pipeline/editorial/reviewStaleness.test.js (198), earns its reach:
// only the real SOURCE_RESOLVERS table can prove the evolution lens has its own
// fingerprint token, so a lens edit stales a review while a want/need edit does
// not. services/pipeline/arcPlanner/context.test.js (78) and
// lib/editorial/checks/characterArcEvolution.test.js (68) are boundary tests
// over modules those trees already instantiate.
const MAX_STATIC_INSTANTIATIONS = 95200;

const SKIP_DIRS = new Set(['node_modules', 'coverage', 'dist', 'data']);
const serverTestFiles = (dir = SERVER_DIR, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      serverTestFiles(join(dir, entry.name), out);
    } else if (entry.name.endsWith('.test.js')) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
};

/**
 * `staticImportClosure` re-reads and re-parses every module it walks, so calling
 * it once per suite re-parses widely-shared modules thousands of times. That is
 * fine for the handful of single-entry assertions above and far too slow here:
 * ~1,600 entries took 18s on a CI runner and blew the 10s testTimeout.
 *
 * Same walk, with the per-file specifier list memoized across entries. The
 * agreement test below pins it to the shared implementation so the two cannot
 * drift into measuring different things.
 */
const depsCache = new Map();
const resolvedDeps = (file) => {
  const cached = depsCache.get(file);
  if (cached) return cached;
  const deps = [...new Set(
    staticImportSpecifiers(file)
      .filter((spec) => spec.startsWith('.'))
      .map((spec) => resolve(dirname(file), spec))
      .filter((path) => existsSync(path)),
  )];
  depsCache.set(file, deps);
  return deps;
};

const closureSize = (entry) => {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const dep of resolvedDeps(file)) if (!seen.has(dep)) stack.push(dep);
  }
  return seen.size;
};

describe('server suite import budget (#6156)', () => {
  it('memoized closure walk agrees with staticImportClosure', () => {
    // A spread of entry points: two modules this PR touched, one heavy suite,
    // and a leaf. If the shared parser gains a specifier shape this walk does
    // not follow (or vice versa), these diverge.
    for (const sample of ['lib/db.js', 'lib/pipelineValidation.js', 'services/agentManagement.test.js', 'lib/editorial/checkInfra/taxonomy.js']) {
      expect(closureSize(abs(sample)), sample).toBe(staticImportClosure(abs(sample)).files.size);
    }
  });

  // Explicit timeout: this walks every server test file, which is inherently
  // more work than a unit test and runs on a shared CI runner. The memoized
  // walk brings it to ~1s locally, but the default 10s leaves no margin for a
  // slow or contended runner — and a timeout here reads as a budget failure,
  // which is exactly the wrong diagnosis.
  it(`stays under ${MAX_STATIC_INSTANTIATIONS.toLocaleString()} static module instantiations`, () => {
    const files = serverTestFiles();
    // Guards the walk itself: an empty or tiny list would make the budget pass
    // vacuously, the same failure mode the positive controls above defend.
    expect(files.length, 'found almost no test files — the walk above is broken').toBeGreaterThan(1000);

    const total = files.reduce((sum, file) => sum + closureSize(file), 0);
    expect(
      total,
      `Static module instantiations across the server suite rose to ${total.toLocaleString()}. Something added an eager import into a heavy subtree from a widely-reached module — narrow it, defer it with a call-site await import(), or raise the budget deliberately. See the "Import scoping" section of server/AGENTS.md.`,
    ).toBeLessThanOrEqual(MAX_STATIC_INSTANTIATIONS);
  }, 60_000);
});
