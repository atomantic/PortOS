/**
 * Repository inputs around the pure CI plan builder: the diff, tracked files, manifest verdicts, contract-test references and graph closures.
 *
 * Split out of `scripts/ci-test-plan.js` (#16998), which re-exports the
 * public names. Every module-graph closure reads the shared graph in
 * `moduleGraph.js`. Builtins only: the planner runs before `npm ci`.
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, posix } from 'path';
import { escapeRegExp } from '../../server/lib/textUtils.js';
import { MODULE_SOURCE_RE, createModuleGraph } from './moduleGraph.js';
import { resolveDbTestFiles } from './dbTestFiles.js';
import { clientRunnerTestPredicate, measureRepoImportReach, serverRunnerTestPredicate } from './importReach.js';
import {
  DOCKER_CONTAINMENT_LIVE_ENTRIES, LINUX_CONTAINMENT_ENTRIES, SUPERCOLLIDER_LIVE_ENTRIES, TEST_FILE_GLOBS,
  browserSuitesIn, isExecutable, isServerRunnerFile, isSharedClientDependency, isTestFile,
  sourceReferencePattern, uniqueSorted,
} from './ciPlanRules.js';
import { DEPENDENCY_MANIFEST_RE, classifyDependencyChange } from './ciPlanDependencies.js';

/**
 * Repository-relative static import closure of `entries` over `graph`, or
 * null when a member cannot be read, a relative edge resolves to no file, or
 * an entry exists in `cwd` outside the graph (untracked) — the caller then
 * runs the gated job rather than trusting a partial walk. Every entry is an
 * input even when absent, so deleting or renaming one still runs the job
 * that names it.
 */
const staticClosureOf = (entries, graph, cwd) => {
  const present = entries.filter((entry) => existsSync(join(cwd, entry)));
  if (present.some((entry) => !graph.known.has(entry))) return null;
  const closure = graph.closure(present, graph.staticDependencies);
  return closure && uniqueSorted([...entries, ...closure]);
};

/** The module graph over the tracked files of `cwd`. */
const trackedModuleGraph = (cwd) => createModuleGraph(gitPaths(['ls-files', '-z'], cwd),
  (path) => readFileSync(join(cwd, path), 'utf8'));

/** Static closure of the linux-containment tests and their Vitest harness. */
export const collectLinuxContainmentInputs = (cwd, graph = trackedModuleGraph(cwd)) => staticClosureOf(LINUX_CONTAINMENT_ENTRIES, graph, cwd);

/** Static closure of the SuperCollider live suite, its setup script and their Vitest harness. */
export const collectSuperColliderLiveInputs = (cwd, graph = trackedModuleGraph(cwd)) => staticClosureOf(SUPERCOLLIDER_LIVE_ENTRIES, graph, cwd);

/** Static closure of the Docker containment live suite and its Vitest harness. */
export const collectDockerContainmentLiveInputs = (cwd, graph = trackedModuleGraph(cwd)) => staticClosureOf(DOCKER_CONTAINMENT_LIVE_ENTRIES, graph, cwd);

// Git's display output quotes non-ASCII/control characters; trimming also
// changes valid paths. Read raw NUL-delimited paths so selectors stay exact.
const gitPaths = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const WORD_RUN_RE = /[A-Za-z0-9_]+/g;
const wordRuns = (text) => text.match(WORD_RUN_RE) ?? [];

/**
 * Tracked test files, read once, answering the reference lookups that used to
 * be one repository-wide `git grep` per changed source (#14866: ~600 sources
 * took minutes). Matching semantics are those of the old `git grep -E`: the
 * same patterns run over the working-tree text of tracked files whose path
 * contains `.test.` / `.spec.` (the `*` in a git pathspec crosses `/`).
 *
 * Each test also keeps its set of maximal word runs. Every pattern here is a
 * word-boundary-delimited literal, so each word run of that literal must
 * appear whole in any file it matches — a necessary condition that rejects
 * nearly every file before the regex runs.
 */
const createTestReferenceIndex = (cwd) => {
  const byPath = new Map();
  for (const path of gitPaths(['ls-files', '-z', '--', ...TEST_FILE_GLOBS], cwd)) {
    let text;
    try {
      text = readFileSync(join(cwd, path), 'utf8');
    } catch (err) {
      // Deleted from the working tree, or a submodule gitlink: git grep skips both.
      if (err.code === 'ENOENT' || err.code === 'EISDIR') continue;
      throw err;
    }
    byPath.set(path, { text, words: new Set(wordRuns(text)) });
  }

  const matcher = (pattern, literal) => {
    const regex = new RegExp(pattern);
    const required = wordRuns(literal);
    return ({ text, words }) => required.every((word) => words.has(word)) && regex.test(text);
  };
  const byBasename = new Map();
  const tokenMatchers = new Map();
  return {
    /** Tests naming `sourcePath` by basename (see sourceReferencePattern), in path order. */
    referencing(sourcePath) {
      const name = basenameOf(sourcePath);
      if (!byBasename.has(name)) {
        const matches = matcher(sourceReferencePattern(sourcePath), name);
        byBasename.set(name, [...byPath].filter(([, entry]) => matches(entry)).map(([path]) => path));
      }
      return byBasename.get(name);
    },
    /** Whether the indexed test at `path` names `token` as a whole identifier-delimited token. */
    mentions(path, token) {
      const entry = byPath.get(path);
      if (!entry) return false;
      if (!tokenMatchers.has(token)) {
        tokenMatchers.set(token, matcher(`(^|[^A-Za-z0-9_])${escapeRegExp(token)}([^A-Za-z0-9_]|$)`, token));
      }
      return tokenMatchers.get(token)(entry);
    },
  };
};

const basenameOf = (path) => path.slice(path.lastIndexOf('/') + 1);

/** Basenames carried by more than one present, executable, non-test source. */
const sharedSourceBasenames = (files) => {
  const seen = new Set();
  const shared = new Set();
  for (const path of files) {
    if (!isExecutable(path) || isTestFile(path)) continue;
    const name = basenameOf(path);
    (seen.has(name) ? shared : seen).add(name);
  }
  return shared;
};

/**
 * Keep the basename hits that plausibly mean THIS copy of a shared basename:
 * a test inside the source's directory subtree (it reaches the file as
 * `./name` or `../name`), or one whose text also names the source's parent
 * directory as a token (`cos-runner`, `aiToolkit`, `join(…, 'imageGen', …)`).
 * A test naming only another directory's `index.js` is dropped; Vitest's
 * import graph still selects every real importer. A repo-root source has no
 * parent to tell copies apart, so it keeps every hit (#11870).
 */
const narrowSharedBasenameHits = (source, hits, index) => {
  const dir = posix.dirname(source);
  if (dir === '.' || hits.length === 0) return hits;
  const parent = basenameOf(dir);
  return hits.filter((path) => path.startsWith(`${dir}/`) || index.mentions(path, parent));
};

// Start from every browser source, including lazy-loaded pages, then follow
// relative static imports and re-exports across directory boundaries. Unresolved
// edges must widen CI rather than disappearing from a negative graph walk.
function collectClientDependencies(graph) {
  const entries = graph.files.filter((path) => path.startsWith('client/src/')
    && MODULE_SOURCE_RE.test(path) && !isTestFile(path));
  return graph.closure(entries, graph.staticDependencies)?.filter((path) => path.startsWith('server/lib/')) ?? null;
}

// Project DB and browser consumers without importing test code or Vitest (the
// planner runs before npm installation). Deferred literals participate; unreadable,
// unresolved and computed imports retain conservative prerequisite coverage.
const collectTestDependencies = (graph, entries) => graph.closure(entries, graph.testDependencies);

/**
 * Collect the repository-derived inputs that surround the pure plan builder.
 *
 * CI leaves `changedFiles` unset and keeps deriving its diff from baseSha. A
 * local caller may supply the complete committed + working-tree path list; in
 * that mode files present but not yet tracked are plan inputs too, while paths
 * deleted from the working tree are deliberately absent from trackedFiles.
 *
 * `gatedBaseSha` (forced-full runs only) is a commit whose tree passed a
 * complete CI run; the path-gated jobs are then decided from the tree diff
 * against it. A diff that git cannot produce leaves `gatedChangedFiles` null,
 * which runs every gated job.
 */
export function collectPlanInputs({ baseSha, forceFull = false, changedFiles, gatedBaseSha, cwd = process.cwd() }) {
  const hasChangedFilesOverride = changedFiles !== undefined;
  const collectedChangedFiles = forceFull
    ? []
    : hasChangedFilesOverride
      ? changedFiles
      : gitPaths(['diff', '-z', '--name-only', '--diff-filter=ACMRD', `${baseSha}...HEAD`], cwd);
  const trackedFiles = gitPaths(['ls-files', '-z'], cwd);
  const presentFiles = hasChangedFilesOverride
    ? uniqueSorted([
      ...trackedFiles,
      ...collectedChangedFiles.filter((path) => existsSync(join(cwd, path))),
    ]).filter((path) => existsSync(join(cwd, path)))
    : trackedFiles;

  // Present, non-ignored untracked sources are real local imports: without them
  // a tracked importer of a not-yet-staged module looks unresolved and the
  // dependency walk fails closed to a full plan. Local override mode only —
  // committed CI inputs stay tracked-only.
  const untrackedFiles = hasChangedFilesOverride
    ? gitPaths(['ls-files', '-z', '--others', '--exclude-standard'], cwd).filter((path) => existsSync(join(cwd, path)))
    : [];

  let appDiff = null;
  if (!forceFull && collectedChangedFiles.includes('client/src/App.jsx')) {
    const committedDiff = execFileSync(
      'git', ['diff', '--unified=0', `${baseSha}...HEAD`, '--', 'client/src/App.jsx'],
      { cwd, encoding: 'utf8' },
    );
    const workingTreeDiff = hasChangedFilesOverride
      ? execFileSync('git', ['diff', '--unified=0', 'HEAD', '--', 'client/src/App.jsx'], { cwd, encoding: 'utf8' })
      : '';
    appDiff = `${committedDiff}${workingTreeDiff}`;
  }

  // Every changed executable, non-test source — not only python scripts — gets
  // a basename lookup: looking up tracked test files that name its filename finds
  // the text-reading contract tests (mirror parity, navManifest.js's 20+ client
  // reads) that no import edge or feature-directory match can reach. Basename
  // matching is deliberate: a mirror test names the client copy only as e.g.
  // 'canonPrompt.js', never by its full path. Under-selection is the bug this
  // closes (issue #6363), but over-selection is not free: every hit is an
  // explicit selector, and a broad selection fans the runner out across shards.
  // A basename several tracked sources share (42 `index.js`) is narrowed by
  // narrowSharedBasenameHits (#11870).
  const changedSources = collectedChangedFiles.filter((path) => isExecutable(path) && !isTestFile(path));
  const sharedBasenames = changedSources.length > 0 ? sharedSourceBasenames(presentFiles) : new Set();
  const testIndex = changedSources.length > 0 ? createTestReferenceIndex(cwd) : null;
  const pathContractTests = Object.fromEntries(changedSources.map((path) => {
    const hits = testIndex.referencing(path);
    return [path, sharedBasenames.has(basenameOf(path)) ? narrowSharedBasenameHits(path, hits, testIndex) : hits];
  }));

  const dependencyFiles = hasChangedFilesOverride ? uniqueSorted([...presentFiles, ...untrackedFiles]) : presentFiles;
  const graph = createModuleGraph(dependencyFiles, (path) => readFileSync(join(cwd, path), 'utf8'));
  const clientDependencies = collectedChangedFiles.some((path) => path.startsWith('server/lib/')
    && isExecutable(path) && !isTestFile(path))
    ? collectClientDependencies(graph)
    : [];

  // Include test fixtures and literal deferred imports, unlike the production
  // projection. Keep uncertainty per test so one unresolved/computed fixture
  // retains its consumer without widening every resolved test.
  const clientTestDependencies = collectedChangedFiles.some((path) => isSharedClientDependency(path)
    && isExecutable(path) && !isTestFile(path))
    ? Object.fromEntries(dependencyFiles.filter((path) => path.startsWith('client/src/')
      && isTestFile(path)).map((test) => [test,
      collectTestDependencies(graph, [test])?.filter(isSharedClientDependency) ?? null]))
    : {};

  const hasRelatedServerSource = collectedChangedFiles.some((path) => isServerRunnerFile(path)
    && MODULE_SOURCE_RE.test(path) && !isTestFile(path));
  const dbDependencies = hasRelatedServerSource
    ? collectTestDependencies(graph, resolveDbTestFiles(dependencyFiles))
    : [];
  const browserDependencies = hasRelatedServerSource
    ? Object.fromEntries(browserSuitesIn(presentFiles).map((suite) => [suite,
      collectTestDependencies(graph, [suite])]))
    : {};

  // Each changed manifest at the diff base vs the tree under test (the working
  // tree: HEAD in CI, HEAD plus local edits under pregate). The base commit is
  // inside the depth-2 checkout, so `git show` resolves it; any read failure
  // becomes null, which classifyDependencyChange() treats as escalation.
  const readAt = (sha, path) => {
    try {
      return execFileSync('git', ['show', `${sha}:${path}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    } catch {
      return null;
    }
  };
  const readAtBase = (path) => readAt(baseSha, path);
  const readInTree = (path) => {
    try {
      return readFileSync(join(cwd, path), 'utf8');
    } catch {
      return null;
    }
  };
  const dependencyChanges = Object.fromEntries(collectedChangedFiles
    .filter((path) => DEPENDENCY_MANIFEST_RE.test(path))
    .map((path) => [path, classifyDependencyChange(path, baseSha ? readAtBase(path) : null, readInTree(path))]));

  // `vitest related` follows dynamic imports too; measure that fan-out per
  // changed source so the selection size is attributable and a broad related
  // walk fans its runner out (fansOut). A failed walk only loses the
  // measurement: the runner then stays on its explicit-selector cap.
  const measureReach = (runner, sources, isTest) => {
    if (sources.length === 0) return null;
    try {
      return measureRepoImportReach({ graph, sources, isTest });
    } catch (err) {
      console.warn(`⚠️ Dynamic-aware ${runner} reach not measured: ${err.message}`);
      return null;
    }
  };
  const serverReach = measureReach('server', collectedChangedFiles.filter((path) => isServerRunnerFile(path)
    && MODULE_SOURCE_RE.test(path) && !isTestFile(path)), serverRunnerTestPredicate());
  // The client runner's related sources (buildSuitePlan's isClientSource): any
  // client source, plus a shared server/lib module the browser bundle imports.
  const clientDependencySet = new Set(clientDependencies ?? []);
  const clientReach = measureReach('client', collectedChangedFiles.filter((path) => MODULE_SOURCE_RE.test(path)
    && !isTestFile(path) && (path.startsWith('client/') || clientDependencySet.has(path))), clientRunnerTestPredicate());

  // Two-dot: a tree comparison, so the base need not be an ancestor of HEAD
  // and needs no merge base in the shallow clone. --no-renames lists a renamed
  // file under both paths, so a renamed job entry point still selects its job.
  let gatedChangedFiles = null;
  let gatedDependencyChanges = {};
  if (forceFull && gatedBaseSha) {
    try {
      gatedChangedFiles = gitPaths(['diff', '-z', '--name-only', '--no-renames', gatedBaseSha, 'HEAD'], cwd);
      gatedDependencyChanges = Object.fromEntries(gatedChangedFiles
        .filter((path) => DEPENDENCY_MANIFEST_RE.test(path))
        .map((path) => [path, classifyDependencyChange(path, readAt(gatedBaseSha, path), readInTree(path))]));
    } catch (err) {
      console.warn(`⚠️ No diff against the last green main run (${err.message.split('\n')[0]}); every native job runs`);
      gatedChangedFiles = null;
    }
  }

  // A forced-full run with no gated diff runs every gated job, so it skips the walks.
  const walkGates = !forceFull || gatedChangedFiles !== null;
  const linuxContainmentInputs = walkGates ? collectLinuxContainmentInputs(cwd, graph) : null;
  const supercolliderLiveInputs = walkGates ? collectSuperColliderLiveInputs(cwd, graph) : null;
  const dockerContainmentLiveInputs = walkGates ? collectDockerContainmentLiveInputs(cwd, graph) : null;

  return { changedFiles: collectedChangedFiles, trackedFiles: presentFiles, appDiff, pathContractTests,
    clientDependencies, clientTestDependencies, dbDependencies, browserDependencies, dependencyChanges,
    linuxContainmentInputs, supercolliderLiveInputs, dockerContainmentLiveInputs, serverReach, clientReach, gatedChangedFiles, gatedDependencyChanges };
}
