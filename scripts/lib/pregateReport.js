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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Repo-relative location of the receipt; gitignored under `/.cache/`. */
export const PREGATE_REPORT_PATH = '.cache/pregate/report.json';

// Version 5 removes cross-run stage reuse records and requires tree stability for a pass.
export const PREGATE_REPORT_VERSION = 5;

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
export function createWorkingTreeHasher(cwd, { env = process.env, indexPath } = {}) {
  const git = (args, extraEnv = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...env, ...extraEnv } }).trim();
  let previousIndex;
  let previousTree;
  return () => {
    const scratch = mkdtempSync(join(tmpdir(), 'portos-pregate-index-'));
    try {
      const temporaryIndex = join(scratch, 'index');
      const liveIndex = indexPath ?? resolve(cwd, git(['rev-parse', '--git-path', 'index']));
      if (existsSync(liveIndex)) {
        copyFileSync(liveIndex, temporaryIndex);
        // Preserve Git's racy-clean check for same-size edits. A plain copy
        // would make the index newer than entries that Git needs to rehash.
        const { atime, mtime } = statSync(liveIndex);
        utimesSync(temporaryIndex, atime, mtime);
      }
      const indexEnv = { GIT_INDEX_FILE: temporaryIndex };
      git(['add', '-A', '--', '.'], indexEnv);
      const index = readFileSync(temporaryIndex);
      // Each snapshot stages from the live index so ignore rules and staged
      // membership still apply. Identical index bytes describe the same tree.
      if (!previousIndex?.equals(index)) {
        previousTree = git(['write-tree'], indexEnv);
        previousIndex = index;
      }
      return previousTree;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };
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
  const stageRecords = stages.map(({ name, suite, command, status, durationMs, exitCode = null, signal = null, guard, files }) => ({
    name, suite, command, status, durationMs, exitCode, signal,
    ...(guard ? { guard: true, files } : {}),
  }));
  const treeStable = tree !== null && tree === treeAfterRun;
  const passed = treeStable && stageRecords.length > 0 && stageRecords.every((stage) => stage.status === 'passed');
  return {
    version: PREGATE_REPORT_VERSION,
    validationMode: options.full ? 'ci' : 'focused',
    startedAt,
    finishedAt,
    passed,
    treeStable,
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
