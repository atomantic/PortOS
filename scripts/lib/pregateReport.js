/**
 * The machine-readable receipt `npm run pregate` leaves behind.
 *
 * A later step (a merge gate) needs
 * to know three things a terminal transcript cannot prove: which stages ran
 * and passed, which suites were NOT run and why, and the exact working tree
 * that was validated. The tree hash is the seam: it covers untracked and
 * uncommitted files, so committing the validated state later yields an
 * identical `HEAD^{tree}` and the receipt can be matched to that commit.
 *
 * Builtins only: `scripts/pregate.js` loads this module from the bare fixture
 * checkouts its own tests build.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

/** Repo-relative location of the receipt; gitignored under `/.cache/`. */
export const PREGATE_REPORT_PATH = '.cache/pregate/report.json';

/**
 * Version 4 adds per-stage `reuseKey` / `reusedFrom`: a guard or lint stage
 * that passed on identical inputs in an earlier invocation is not rerun.
 * Version 3 added validationMode: focused receipts never attest CI suites.
 * Version 2 added `plan.downgraded`: whether a full plan was replaced by the
 * always-run guards, because a downgraded server stage passing is not CI's
 * server selection passing.
 */
export const PREGATE_REPORT_VERSION = 4;

/**
 * Hash the exact working tree as it stands: tracked, modified, deleted and
 * untracked files alike, ignored files excluded.
 *
 * Builds a throwaway index (a copy of the real one, so git reuses its stat
 * cache instead of rehashing every file), stages the whole tree into it and
 * writes a tree object. The real index and HEAD are never touched. `git add -A`
 * and `git commit` share the same ignore rules, so a commit of this same state
 * produces the same tree id.
 */
export function validatedTreeHash(cwd, { env = process.env } = {}) {
  const git = (args, extraEnv = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...env, ...extraEnv } }).trim();
  const scratch = mkdtempSync(join(tmpdir(), 'portos-pregate-index-'));
  try {
    const temporaryIndex = join(scratch, 'index');
    const liveIndex = resolve(cwd, git(['rev-parse', '--git-path', 'index']));
    if (existsSync(liveIndex)) {
      copyFileSync(liveIndex, temporaryIndex);
      // Git rehashes an entry whose mtime is not older than the index file's
      // ("racily clean"). A fresh copy is newer than every entry, so without
      // the original timestamp a same-size edit made just after the index was
      // written would be hashed as its old content. Millisecond rounding only
      // makes more entries racy, never fewer.
      const { atime, mtime } = statSync(liveIndex);
      utimesSync(temporaryIndex, atime, mtime);
    }
    const indexEnv = { GIT_INDEX_FILE: temporaryIndex };
    git(['add', '-A', '--', '.'], indexEnv);
    return git(['write-tree'], indexEnv);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// This cache lives only for one pregate invocation. Tree scanners deliberately
// cannot use the persistent module memo: their inputs include the index and Git
// refs as well as every working-tree file. Any unreadable input means no reuse.
export function guardInputSnapshot(cwd) {
  try {
    const digest = createHash('sha256').update(validatedTreeHash(cwd));
    for (const args of [
      ['rev-parse', 'HEAD'], ['ls-files', '--stage', '-z'],
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      ['for-each-ref', '--format=%(refname) %(objectname)'],
    ]) {
      digest.update(execFileSync('git', args, { cwd, maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }));
    }
    return digest.digest('hex');
  } catch {
    return null;
  }
}

/**
 * Ignored paths that are not stage inputs, the same set the persistent test
 * memo treats as non-inputs (IGNORED_INPUT_PREFIXES and SKIP_TREE_DIRS in
 * scripts/lib/testMemo.js): tool caches, which also hold this receipt, build
 * output, coverage and the live `data/` tree.
 */
const IGNORED_NON_INPUT = /(?:^|\/)(?:\.cache|dist|coverage)(?:\/|$)|^data(?:\/|$)/;
/** Installed dependencies are keyed by their manifest, never walked. */
const NODE_MODULES = /(?:^|\/)node_modules\/?$/;
/** Past this many other ignored entries, reuse is refused rather than keyed. */
export const IGNORED_INPUT_LIMIT = 5000;
/** Shell bookkeeping that differs between invocations and that no tracked code reads. */
const ENV_BOOKKEEPING = new Set(['_', 'OLDPWD', 'SHLVL', 'COLUMNS', 'LINES']);
const MAX_SUBMODULE_DEPTH = 3;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function installedManifest(dir) {
  const read = (fn) => {
    try { return fn(); } catch { return 'absent'; }
  };
  return `${read(() => realpathSync(dir))} ${read(() => sha256(readFileSync(join(dir, '.package-lock.json'))))}`;
}

/** Digest one ignored entry by stat, descending into directories. */
function addIgnoredEntry(root, rel, digest, budget) {
  const path = rel.replace(/\/$/, '');
  if (NODE_MODULES.test(path)) {
    digest.update(`deps ${path} ${installedManifest(join(root, path))}\0`);
    return;
  }
  if (IGNORED_NON_INPUT.test(path)) return;
  budget.remaining -= 1;
  if (budget.remaining < 0) throw new Error(`more than ${IGNORED_INPUT_LIMIT} ignored entries outside caches, build output and data/`);
  const stat = lstatSync(join(root, path));
  const type = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'dir' : 'file';
  digest.update(`ignored ${path} ${type} ${stat.size} ${stat.mtimeMs}\0`);
  if (type !== 'dir') return;
  for (const name of readdirSync(join(root, path)).sort()) addIgnoredEntry(root, `${path}/${name}`, digest, budget);
}

const within = (root, target) => target === root || target.startsWith(`${root}${sep}`);

/**
 * True when a symlink resolves to a file outside the checkout, whose bytes the
 * tree hash never sees. A link to anything else outside it refuses reuse. A
 * dangling link that points inside (an uninitialized submodule's target) is
 * covered by the checkout's own state.
 */
function symlinkLeavesCheckout(cwd, path) {
  const link = join(cwd, path);
  let target;
  try {
    target = realpathSync(link);
  } catch {
    if (within(resolve(cwd), resolve(dirname(link), readlinkSync(link)))) return false;
    throw new Error(`symlink ${path} points outside the checkout at a missing target`);
  }
  if (within(realpathSync(cwd), target)) return false;
  if (!statSync(target).isFile()) throw new Error(`symlink ${path} points outside the checkout at a non-file`);
  return true;
}

/** Attributes under which Git stores content other than the working-tree bytes. */
const CONTENT_ATTRIBUTES = ['filter', 'ident', 'working-tree-encoding'];

/**
 * The tree hash is Git's normalized content: an eol conversion (`text=auto
 * eol=lf`, `*.cmd eol=crlf`) or a clean filter leaves it unchanged while the
 * bytes a guard reads (a size budget, a CR-sensitive pattern) differ. Hash the
 * raw bytes of every path Git may have converted, and of any symlink target
 * outside the checkout.
 */
function addRawContentInputs(cwd, git, digest) {
  const paths = [];
  const candidates = new Set();
  for (const entry of git(['ls-files', '--eol', '--cached', '--others', '--exclude-standard', '-z'])) {
    const tab = entry.indexOf('\t');
    const path = entry.slice(tab + 1);
    paths.push(path);
    const worktree = entry.slice(0, tab).split(/\s+/).find((field) => field.startsWith('w/'));
    // `w/lf` and `w/none` hold no CR for a conversion to remove; `w/` is a symlink, gitlink or deleted path.
    if (worktree && !['w/lf', 'w/none', 'w/'].includes(worktree)) candidates.add(path);
    else if (worktree === 'w/') {
      let stat = null;
      try { stat = lstatSync(join(cwd, path)); } catch { /* deleted: the tree hash records the deletion */ }
      if (stat?.isSymbolicLink() && symlinkLeavesCheckout(cwd, path)) candidates.add(path);
    }
  }
  if (paths.length > 0) {
    const attributes = execFileSync('git', ['check-attr', '-z', '--stdin', ...CONTENT_ATTRIBUTES], {
      cwd, input: `${paths.join('\0')}\0`, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }).toString('utf8').split('\0');
    for (let index = 0; index + 2 < attributes.length; index += 3) {
      if (!['unspecified', 'unset'].includes(attributes[index + 2])) candidates.add(attributes[index]);
    }
  }
  for (const path of [...candidates].sort()) {
    digest.update(`raw ${path} ${sha256(readFileSync(join(cwd, path)))}\0`);
  }
}

function addCheckoutInputs(cwd, digest, depth, budget) {
  const git = (args) => execFileSync('git', args, {
    cwd, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  }).toString('utf8').split('\0').filter(Boolean);
  digest.update(`tree ${validatedTreeHash(cwd)}\0`);
  addRawContentInputs(cwd, git, digest);
  const submodules = [];
  for (const entry of git(['ls-files', '--stage', '-z'])) {
    const tab = entry.indexOf('\t');
    const [mode, oid, stage] = entry.slice(0, tab).split(' ');
    const path = entry.slice(tab + 1);
    // Guards read index modes (envExampleDrift) and symlink targets from the
    // index (agent-instructions-files), never a regular file's staged blob, so
    // committing the validated content leaves the key unchanged.
    digest.update(`index ${mode} ${stage} ${mode === '120000' || mode === '160000' ? oid : '-'} ${path}\0`);
    if (mode === '160000') submodules.push(path);
  }
  // Branch entries hold per-branch bookkeeping (upstream, review notes) that
  // changes between invocations and that no stage reads.
  for (const entry of git(['config', '--list', '-z'])) {
    if (!entry.startsWith('branch.')) digest.update(`config ${entry}\0`);
  }
  for (const entry of git(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']).sort()) {
    addIgnoredEntry(cwd, entry, digest, budget);
  }
  for (const path of submodules.sort()) {
    const checkout = join(cwd, path);
    if (!existsSync(join(checkout, '.git'))) {
      digest.update(`submodule ${path} absent\0`);
      continue;
    }
    if (depth >= MAX_SUBMODULE_DEPTH) throw new Error(`submodules nest deeper than ${MAX_SUBMODULE_DEPTH} levels`);
    digest.update(`submodule ${path}\0`);
    addCheckoutInputs(checkout, digest, depth + 1, budget);
  }
}

/**
 * Fingerprint everything a structural guard or lint stage can read, so a pass
 * can be reused by a later invocation (`guardReuseStageKey` adds the stage
 * itself and the base). Unlike `guardInputSnapshot` it omits HEAD and refs:
 * every guard stage receives `CI_BASE_SHA`, and the HEAD/ref reads in guards
 * are fallbacks taken only without it. It covers the exact working tree
 * (with the raw bytes of any path Git normalizes),
 * tracked paths with their modes and symlink/gitlink entries, Git config,
 * ignored paths (stat) outside the test memo's non-input set, each installed
 * dependency tree's manifest, initialized submodules recursively, the Node
 * and Git toolchain and the inherited environment. Anything it cannot read
 * refuses reuse: `{ inputs: null, reason }`.
 */
export function guardReuseInputs(cwd, { env = process.env } = {}) {
  try {
    const digest = createHash('sha256');
    digest.update(`node ${process.version} ${process.platform} ${process.arch} ${process.execPath}\0`);
    digest.update(`${execFileSync('git', ['--version'], { cwd, encoding: 'utf8' }).trim()}\0`);
    for (const name of Object.keys(env).filter((key) => !ENV_BOOKKEEPING.has(key)).sort()) {
      digest.update(`env ${name}=${env[name]}\0`);
    }
    addCheckoutInputs(cwd, digest, 0, { remaining: IGNORED_INPUT_LIMIT });
    return { inputs: digest.digest('hex'), reason: null };
  } catch (error) {
    return { inputs: null, reason: error.message.split('\n')[0] };
  }
}

/** Reuse key for one stage: the inputs digest plus the base and the stage's exact command, environment and files. */
export function guardReuseStageKey(inputs, stage, { baseSha, baseRef }) {
  // `undefined` removes an inherited variable (stageSpawnEnv), so it must not collapse into "absent".
  const env = Object.entries(stage.env ?? {}).map(([name, value]) => [name, value === undefined ? null : value]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256(JSON.stringify({
    inputs, baseSha, baseRef, name: stage.name, suite: stage.suite, script: stage.script ?? null, npm: stage.npm ?? null,
    args: stage.args ?? [], env, files: [...(stage.files ?? [])].sort(),
  }));
}

/** Reuse keys of the stages the previous receipt passed, mapped to when each originally ran. */
export function readReusableStagePasses(root) {
  try {
    const report = JSON.parse(readFileSync(join(root, PREGATE_REPORT_PATH), 'utf8'));
    if (report?.version !== PREGATE_REPORT_VERSION || !Array.isArray(report.stages)) return new Map();
    return new Map(report.stages
      .filter((stage) => stage?.status === 'passed' && typeof stage.reuseKey === 'string')
      .map((stage) => [stage.reuseKey, stage.reusedFrom ?? stage.passedAt])
      .filter(([, at]) => typeof at === 'string'));
  } catch {
    return new Map();
  }
}

/**
 * Shape the receipt. Pure: every input is a value the gate already holds.
 *
 * `stages` carry only names, commands and outcomes — never their environment,
 * which can hold database credentials. `skipped` names each suite CI would run
 * that this run did not, with the reason, so a consumer can never read a green
 * receipt as proof of a suite it never saw.
 */
export function buildPregateReport({
  plan,
  options,
  base,
  head,
  tree,
  treeAfterRun = tree,
  stages,
  skipped,
  runtime,
  startedAt,
  finishedAt,
  downgraded = false,
}) {
  const stageRecords = stages.map(({ name, suite, command, status, durationMs, exitCode = null, signal = null, guard, files, guardReuse, fileDurations, reuseKey, passedAt, reusedFrom }) => ({
    name, suite, command, status, durationMs, exitCode, signal,
    ...(guard ? { guard: true, files, fileDurations: fileDurations ?? {} } : {}),
    ...(guardReuse ? { guardReuse } : {}),
    ...(reuseKey ? { reuseKey } : {}),
    ...(passedAt ? { passedAt } : {}),
    ...(reusedFrom ? { reusedFrom } : {}),
  }));
  const passed = stageRecords.length > 0 && stageRecords.every((stage) => stage.status === 'passed');
  return {
    version: PREGATE_REPORT_VERSION,
    validationMode: options.full ? 'ci' : 'focused',
    startedAt,
    finishedAt,
    passed,
    treeStable: tree === treeAfterRun,
    base,
    head,
    tree,
    treeAfterRun,
    runtime,
    options,
    plan: {
      full: plan.full,
      // True when the local selection reduced CI coverage (no `--full`):
      // the server and client stages below then prove less than CI's selection.
      downgraded: Boolean(downgraded),
      reason: plan.reason,
      server: { mode: plan.server.mode, files: plan.server.files, sources: plan.server.sources },
      client: { mode: plan.client.mode, files: plan.client.files, sources: plan.client.sources },
      lint: { mode: plan.lint.mode, files: plan.lint.files },
      browser: { files: plan.browser.files },
      db: plan.db,
      build: plan.build,
      smoke: plan.smoke,
      windows: plan.windows,
      linuxContainment: plan.linuxContainment,
      supercolliderLive: plan.supercolliderLive,
      dockerContainmentLive: plan.dockerContainmentLive,
      macosNative: plan.macosNative,
      suiteReasons: plan.suiteReasons ?? {},
    },
    stages: stageRecords,
    skipped: skipped.map(({ suite, reason, remedy }) => ({ suite, reason, remedy })),
  };
}

/** Write the receipt under the checkout root and return its absolute path. */
export function writePregateReport(root, report) {
  const path = join(root, PREGATE_REPORT_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}
