/**
 * Shard sizing and GitHub output of a CI impact plan: matrices, fan-out, per-suite reasons, step outputs and the step summary.
 *
 * Split out of `scripts/ci-test-plan.js` (#16998), which re-exports the
 * public names. Builtins only: the planner runs before `npm ci`.
 */

import { writeStepOutput, writeStepSummary } from './githubOutput.js';
import { selectWorkflowFiles } from './actionlint.js';
import { WINDOWS_CONTRACT_TESTS } from './ciPlanRules.js';

// Explicit selectors one runner carries before its scoped plan fans out across
// the full-suite shard matrix. It used to escalate the whole repository to a
// full plan; over-selection is a capacity limit, not a risk signal, so the
// selection now stays exactly as computed and only execution is partitioned
// (#11871). 125 is that former full-plan threshold (#10312).
export const MAX_TARGETED_TEST_FILES = 125;
// A client runner's cold-memo cost is about 0.4s per file including overhead
// (#16805 measurements), so one runner absorbs 400 client files, explicit or
// reached through a related walk, inside the existing critical path. Fanning
// out earlier adds runner starts, Chrome warm-ups and memo restores.
export const CLIENT_FANOUT_TEST_FILES = 400;
// A real-Chromium client suite costs a Chrome launch and a cold Vite graph:
// 30-75s each on a 4-vCPU runner against ~0.4s for a happy-dom file, so 32 of
// them on one runner took 282-402s while four shards finished in 55-91s
// (#17616). Four such suites already outweigh the extra runner starts.
export const CLIENT_BROWSER_FANOUT_SUITES = 4;

// Parallel runners per test job on a full plan. Decided here rather than in
// ci.yml because a job-level `if` cannot read the matrix context, so the
// planner emits the matrix for scoped plans too. Sizing rationale:
// docs/CI_TEST_SELECTION.md "Full-suite sharding".
export const FULL_SUITE_SHARDS = { server: 2, client: 4, windows: 1 };

/** Matrix values for one runner: every shard on a full run, one otherwise. */
export const shardIndexes = (mode, count) => (
  mode === 'full' ? Array.from({ length: count }, (_, index) => index + 1) : [1]
);

/**
 * Whether a scoped Linux runner fans out across its full-suite shard count.
 *
 * - Over the runner's cap of explicit selectors (MAX_TARGETED_TEST_FILES for the
 *   server, CLIENT_FANOUT_TEST_FILES for the client): either mode.
 * - A `related` plan whose measured import reach (`serverReach.selected` /
 *   `clientReach.selected`, the suites Vitest's related walk will select)
 *   exceeds the same cap (#16547 server, #17456 client): its explicit selectors
 *   stay few, yet one runner would execute ~1,000 suites.
 * - A client plan whose real-Chromium suites (`browserSuites`: explicit
 *   selectors plus, for `related`, the suites changed files reach) number at
 *   least CLIENT_BROWSER_FANOUT_SUITES, whatever the file count (#17616).
 * - Everything else stays on one runner. Record-aware selection
 *   (`recordedReach` in lib/testMemo/analyzer.js, #16424) narrows what a selected test
 *   actually runs; reach is measured, not assumed, so a small graph stays put.
 *
 * No shard-count floor is needed: the runner slices the selection itself and
 * never hands Vitest `--shard`, so a shard whose slice is empty exits green.
 */
const runnerFanOutCap = (runner) => (runner === 'client' ? CLIENT_FANOUT_TEST_FILES : MAX_TARGETED_TEST_FILES);
export const fansOut = (runner, { mode, files }, reach = 0, browserSuites = 0) => mode !== 'skip' && mode !== 'full'
  && (Math.max(files.length, mode === 'related' ? reach : 0) > runnerFanOutCap(runner)
    || (runner === 'client' && browserSuites >= CLIENT_BROWSER_FANOUT_SUITES));

/** The suites a measureRepoImportReach() report selects; 0 when it was not measured. */
export const reachCount = (report) => (Number.isFinite(report?.selected) ? report.selected : 0);

// A scoped runner spread over several shards says why, so the summary never
// reads as a full run.
const fanOutNote = (plan, runner) => {
  const count = plan.shards[runner].length;
  if (plan.full || count === 1) return '';
  const cap = runnerFanOutCap(runner);
  if (plan[runner].files.length > cap) return `; ${plan[runner].files.length} selected test files exceed the ${cap}-file cap, sharded ${count} ways`;
  if (plan.reachSelected[runner] > cap) return `; related import reach of ${plan.reachSelected[runner]} suites exceeds the ${cap}-file cap, sharded ${count} ways`;
  return `; ${plan.browserSuites?.[runner] ?? 0} real-Chromium suites selected (at least ${CLIENT_BROWSER_FANOUT_SUITES}), sharded ${count} ways`;
};

export const suiteReasonsFor = (plan, { appRouteOnly = false } = {}) => ({
  server: plan.server.mode === 'skip'
    ? 'skipped: no server-impacting source changed'
    : plan.full
      ? `full matrix: ${plan.reason}`
      : `always-run cross-install and repository guards${fanOutNote(plan, 'server')}`,
  client: plan.client.mode === 'skip'
    ? 'skipped: no client-impacting source changed'
    : appRouteOnly
      ? `route-only client App.jsx change: related client contracts${fanOutNote(plan, 'client')}`
      : plan.full
        ? `full matrix: ${plan.reason}`
        : `${plan.build ? 'client-impacting source changed' : 'client test and contract coverage selected'}${fanOutNote(plan, 'client')}`,
  browser: plan.browserFiles.length > 0
    ? (plan.full ? `full matrix: ${plan.reason}` : `${plan.browserFiles.length} cross-workspace browser suite(s) selected`)
    : 'skipped: no cross-workspace browser suite selected',
  db: plan.db ? (plan.full ? `full matrix: ${plan.reason}` : 'database-risk source changed') : 'skipped: no database-risk source changed',
  lint: plan.lint.mode === 'skip' ? 'skipped: no changed source needs linting' : plan.full ? `full matrix: ${plan.reason}` : 'changed lintable source',
  build: plan.build ? (plan.full ? `full matrix: ${plan.reason}` : 'client-impacting source changed') : 'skipped: no client-impacting source changed',
  smoke: plan.smoke ? (plan.full ? `full matrix: ${plan.reason}` : 'server-impacting source changed') : 'skipped: no server-impacting source changed',
  windows: !plan.windows
    ? `skipped: no Windows native contract changed${plan.windowsNote ? `; ${plan.windowsNote}` : ''}`
    : `Windows native CLI/TUI and filesystem contracts${plan.full ? ` (full primary plan: ${plan.reason})` : ''}${plan.windowsNote ? `; ${plan.windowsNote}` : ''}`,
});

/**
 * The impact job's `plan` output. Jobs read a decision as
 * `fromJSON(needs.impact.outputs.plan).<key>`, so values keep their JSON types:
 * booleans are compared bare (`== 'true'` would never match a boolean after
 * fromJSON) and file lists arrive as arrays, which a step hands to a script
 * with `toJSON(...)`. scripts/ci-test-plan.test.js fails when ci.yml reads a
 * key this object does not have.
 */
export function githubPlanOutput(plan) {
  return {
    full: plan.full,
    // Rendered into the step summary's inline code span.
    reason: plan.reason.replace(/[`<>\r\n]+/g, ' '),
    server_mode: plan.server.mode,
    server_files: plan.server.files,
    server_sources: plan.server.sources,
    client_mode: plan.client.mode,
    client_files: plan.client.files,
    client_sources: plan.client.sources,
    // A job-level `if` cannot test an array for emptiness without toJSON.
    browser: plan.browserFiles.length > 0,
    browser_files: plan.browserFiles,
    db: plan.db,
    db_live_restore: plan.dbLiveRestore,
    lint_mode: plan.lint.mode,
    lint_files: plan.lint.files,
    workflow_lint: plan.lint.mode === 'full' || selectWorkflowFiles(plan.lint.files).length > 0,
    build: plan.build,
    smoke: plan.smoke,
    slashdo: plan.slashdo,
    linux_containment: plan.linuxContainment,
    supercollider_live: plan.supercolliderLive,
    docker_containment_live: plan.dockerContainmentLive,
    macos_native: plan.macosNative,
    node_minimum: plan.nodeMinimum,
    native_gated: plan.nativeGated,
    snapshot_scoped: Boolean(plan.snapshotScoped),
    windows: plan.windows,
    windows_mode: plan.windowsMode,
    windows_files: plan.windowsFiles,
    windows_sources: plan.windowsSources,
    suite_reasons: plan.suiteReasons,
  };
}

/** The impact job's step summary for one plan; `gatedBaseSha` is the push's last green base, if any. */
export function formatPlanSummary(output, shards, gatedBaseSha) {
  const value = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
  const code = (v) => `\`${value(v)}\``;
  return [
    '### CI impact plan',
    '',
    `- Reason: ${code(output.reason)}`,
    `- Server tests: ${code(output.server_mode)} (shards ${code(shards.server)})`,
    `- Client tests: ${code(output.client_mode)} (shards ${code(shards.client)})`,
    `- DB tests: ${code(output.db)}`,
    `- Live pg_dump restore: ${code(output.db_live_restore)}`,
    `- Cross-workspace browser suites: ${code(output.browser_files)} (shards ${code(shards.browser)})`,
    `- Client lint: ${code(output.lint_mode)}`,
    `- Client build: ${code(output.build)}`,
    `- Server smoke: ${code(output.smoke)}`,
    `- Slashdo submodule: ${code(output.slashdo)}`,
    `- Linux worker containment: ${code(output.linux_containment)}`,
    `- SuperCollider live containment: ${code(output.supercollider_live)}`,
    `- Docker containment live: ${code(output.docker_containment_live)}`,
    `- macOS native release-agent supervision: ${code(output.macos_native)}`,
    `- Node minimum compatibility: ${code(output.node_minimum)}`,
    `- Windows server tests: ${code(output.windows)} (${code(output.windows_mode)}, shards ${code(shards.windows)})`,
    `- Native jobs gated against last green main run: ${code(gatedBaseSha || 'none')}`,
    `- Suite selection reasons: ${code(output.suite_reasons)}`,
  ].join('\n');
}

export function emitGitHubPlan(plan, { gatedBaseSha } = {}) {
  if (plan.windows && plan.windowsFiles.length === 0) throw new Error('Windows native contract inventory is empty');
  if (plan.windows) {
    const missing = WINDOWS_CONTRACT_TESTS.filter(path => !plan.windowsFiles.includes(path));
    if (missing.length) throw new Error(`Windows native contract inventory is missing: ${missing.join(', ')}`);
  }
  const output = githubPlanOutput(plan);
  writeStepOutput('plan', JSON.stringify(output));
  // Separate outputs because `strategy.matrix` needs a bare JSON array: each
  // leaf job's matrix is `fromJSON(needs.impact.outputs.<suite>_shards)`.
  writeStepOutput('server_shards', JSON.stringify(plan.shards.server));
  writeStepOutput('client_shards', JSON.stringify(plan.shards.client));
  writeStepOutput('browser_shards', JSON.stringify(plan.shards.browser));
  writeStepOutput('windows_shards', JSON.stringify(plan.shards.windows));
  writeStepSummary(formatPlanSummary(output, plan.shards, gatedBaseSha));
  console.log(JSON.stringify({
    ...output,
    server_shards: plan.shards.server,
    client_shards: plan.shards.client,
    browser_shards: plan.shards.browser,
    windows_shards: plan.shards.windows,
    changed_files: plan.changedFiles,
  }, null, 2));
}
