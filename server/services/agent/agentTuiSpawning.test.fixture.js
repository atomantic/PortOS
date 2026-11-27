import { vi, beforeEach, afterEach } from 'vitest';
import { existsSync, statSync } from 'fs';
import { readFile, } from 'fs/promises';
import { execFile } from '../../lib/childProcess.js';
import { spawnTuiAgent } from './agentTuiSpawning.js';
import { spawnTuiSessionViaRunner } from '../cos/cosRunnerClient.js';
import * as shellService from '../shell.js';
import { promptOpensOwnPr } from '../promptSections/completion.js';
import { activeAgents, userTerminatedAgents, } from './agentState.js';

// ─── Mocks for spawnTuiAgent tests ──────────────────────────────────────────
// All vi.mock calls must be at the top level before any imports.

vi.mock('../shell.js', () => ({
  createShellSession: vi.fn(),
  spawnCommandSession: vi.fn(),
  writeToSession: vi.fn(),
  pasteToSession: vi.fn(),
  killSession: vi.fn(),
  getSession: vi.fn(),
  getSessionProcess: vi.fn(),
  registerExternalSession: vi.fn(),
  unregisterExternalSession: vi.fn(),
}));

// Only the spawn rpc is faked. The refusal/ambiguity classifier is the real one
// (importOriginal): re-implementing it here would make the ledger assertions
// below agree with a copy of the rule rather than with the rule (#4615).
vi.mock('../cos/cosRunnerClient.js', async (importOriginal) => ({
  ...(await importOriginal()),
  spawnTuiSessionViaRunner: vi.fn(),
}));

vi.mock('../cos/cosEvents.js', () => ({
  emitLog: vi.fn()
}));

vi.mock('../cos/cosAgentLifecycle.js', () => ({
  appendAgentOutputLines: vi.fn().mockResolvedValue(undefined),
  updateAgent: vi.fn().mockResolvedValue(undefined),
  completeAgent: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../provider/providerStatus.js', () => ({
  markProviderUsageLimit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../cos/cosTaskStore.js', () => ({
  updateTask: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('./agentErrorAnalysis.js', () => ({
  analyzeAgentFailure: vi.fn().mockReturnValue(null),
  resolveFailedTaskUpdate: vi.fn().mockResolvedValue({ status: 'failed' })
}));

// The lifecycle ledger is a real file writer (data/cos/run-events.jsonl) — mocked
// so first-output telemetry lands in a spy rather than the developing install's
// ledger, and because this suite's fileUtils mock carries no PATHS.cos (#4540).
const { appendRunEvent } = vi.hoisted(() => ({ appendRunEvent: vi.fn(async () => ({ appended: true })) }));

vi.mock('./agentRunEventLog.js', () => ({ appendRunEvent }));

vi.mock('./agentRunTracking.js', () => ({
  completeAgentRun: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('./agentCompletion.js', () => ({
  processAgentCompletion: vi.fn().mockResolvedValue(undefined)
}));

// The Ollama-backed spawn path prepares the daemon's context window first, which
// otherwise reaches a real localhost:11434 in this suite. Stub it to a no-op —
// its own behavior is covered by services/ollamaAgentContext.test.js.
vi.mock('../ollamaAgentContext.js', () => ({
  ensureOllamaAgentContext: vi.fn().mockResolvedValue({ skipped: false, contextLength: null, applied: false, warning: null }),
  beginOllamaAgentWork: vi.fn().mockResolvedValue(() => {})
}));

vi.mock('./agentFinalization.js', () => ({
  finalizeAgent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../codeReview.js', () => ({
  resolveReviewLoopOptions: vi.fn().mockResolvedValue({
    reviewers: ['codex'],
    usernames: [],
    optionalReviewers: [],
    reviewerMaxRounds: {},
    reviewStopMode: 'on-clean',
    reviewerApplies: false,
    reviewerModels: {},
  })
}));

// Only the mutable registries are stubbed; the module's other state helpers
// come from the real module so the test does not duplicate their behavior.
vi.mock('./agentState.js', async (importOriginal) => ({
  ...await importOriginal(),
  activeAgents: new Map(),
  userTerminatedAgents: new Set(),
  pausedAgents: new Map(),
  consumePausedAgentExit: vi.fn(),
  registerSpawnedAgent: vi.fn(),
  unregisterSpawnedAgent: vi.fn(),
}));

// The loopback API token the agent's own PortOS `curl`s spend. The real one
// reads settings.json to decide whether an instance password is set; this suite
// only cares that whatever it returns reaches the PTY env.
vi.mock('./agentApiAuth.js', () => ({
  resolveAgentApiEnv: vi.fn().mockResolvedValue({}),
}));

vi.mock('../git/status.js', () => ({
  getDiff: vi.fn().mockResolvedValue('diff content here'),
  // Read by the merge-gate contract check (#5876) to name the branch it
  // probes the forge for.
  getBranch: vi.fn().mockResolvedValue('claim/issue-5876'),
}));

vi.mock('../forgeAuth.js', () => ({
  // No owner-matched gh account by default → empty overlay (ambient auth kept).
  resolveForgeTokenEnv: vi.fn().mockResolvedValue({}),
}));

// The forge lookup itself (`resolveForgeForRepo` + gitlab.js/github.js) is
// exercised on its own in prProbe.test.js — this suite only needs to drive
// the merge-gate contract check's branching on the tri-state result.
vi.mock('../prProbe.js', () => ({
  probePrForBranch: vi.fn().mockResolvedValue({ prState: null, prUrl: null, prNumber: null, cli: null, readable: true }),
}));

// finish() hands the run to the shared completion dispatch (pipeline
// progression → worktree cleanup with the PR disposition → retry-hold release).
// Doubled at that boundary: what this suite owns is that the TUI path dispatches
// with the right verdict and PR ownership, and only when it should — the
// dispatch's own sequence is pinned in agentCompletionCleanup.test.js. Mocking
// it also keeps the real cleanup graph (cos.js, worktreeManager, recoveryTasks)
// out of this suite.
vi.mock('./agentCompletionCleanup.js', () => ({
  runSpawnerCompletionCleanup: vi.fn().mockResolvedValue(undefined),
}));

// Unit tests must not hit the real maintenance journal (disk locks, lstatSync on the fs mock below).
vi.mock('../../lib/maintenanceAdmission.js', () => ({ maintenance: {
  withResource: (_kind, _id, fn) => fn(), finishResource: vi.fn(), markResourceUnsettled: vi.fn(),
  continueSettlement: fn => fn(), recoverOwned: vi.fn(),
} }));

vi.mock('../../lib/backupSnapshotBoundary.js', async importOriginal => ({
  ...(await importOriginal()),
  withBackupAssetPublication: async work => work(),
}));

vi.mock('fs', () => ({
  readdirSync: vi.fn().mockReturnValue([]),
  // Default: no .agent-done sentinel on disk. The completion-sentinel test
  // overrides this to true. Re-set in beforeEach so it can't leak between tests.
  existsSync: vi.fn().mockReturnValue(false),
  statSync: vi.fn().mockReturnValue({ isFile: () => true, mtimeMs: Date.now() }),
  watch: vi.fn(() => {
    let onClose;
    return {
      once: vi.fn((event, callback) => {
        if (event === 'close') onClose = callback;
      }),
      close: vi.fn(() => onClose?.()),
    };
  }),
}));

vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  appendFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(''),
  rm: vi.fn().mockResolvedValue(undefined),
  // raw.txt tail-read for failure analysis. The default stat → open/read
  // chain reports a zero-byte file so non-tail-read tests don't accidentally
  // exercise the read path. The two tail-read tests below override stat
  // and open via mockResolvedValueOnce to assert the IO contract on the
  // failure / success finalize branches.
  stat: vi.fn().mockResolvedValue({ size: 0 }),
  open: vi.fn().mockResolvedValue({
    read: vi.fn().mockResolvedValue({ bytesRead: 0 }),
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../../lib/fileUtils.js', async (importOriginal) => ({
  // Keep the real pure helpers (safeJSONParse — used transitively by
  // agentSentinel.parseSentinelPayload, etc.); only stub the I/O + PATHS.
  ...(await importOriginal()),
  tryReadFile: vi.fn().mockResolvedValue(null),
  // `data` is required alongside `root`: this module pulls in taskTypeHooks.js
  // -> ... -> lib/subscriptionSavings.js -> postStreak.js ->
  // activeDays.js -> timezone.js -> services/settings.js, whose module-scope
  // `join(PATHS.data, 'settings.json')` throws on load without it (#4211
  // added the activeDays.js edge). The bare `PATHS: {...}` below fully
  // replaces the real object (it doesn't merge), so every member this graph
  // needs at import time has to be listed explicitly.
  PATHS: { root: '/tmp/portos-root', data: '/tmp/portos-root/data' }
}));

vi.mock('../../lib/provider/providerModels.js', async (importOriginal) => ({
  // Pull the real module first so pure helpers added later (isClaudeCommand,
  // applyLeanClaudeArgs, leanClaudeAuthEnv, …) don't silently vanish from the
  // mock — only the fns below are stubbed/spied.
  ...(await importOriginal()),
  // Mirror the real behaviour: pass through the model string, return null for
  // the codex-configured-default sentinel or null/undefined input.
  resolveCliModel: vi.fn((m) => (m === 'codex-configured-default' || !m) ? null : m),
  // NOTE: `appendModelArgs` calls `resolveInjectedTuiModel`, which is pulled in
  // REAL via importOriginal above and calls `resolveBedrockCliModel` /
  // `prefixOpencodeModel` as module-INTERNAL references — a vi.mock override of
  // those two names cannot intercept an internal call, so stubbing them here
  // would be dead weight that reads as protection. Instead the suite pins the
  // one input the real mapper keys on (`CLAUDE_CODE_USE_BEDROCK`, cleared in
  // beforeEach below), so these assertions are deterministic regardless of the
  // ambient env on a developer's Bedrock box or a CI runner.
  // Mirror hasModelFlag (real impl unit-tested in providerModels.test.js).
  hasModelFlag: vi.fn((a) => Array.isArray(a) && a.some((x) => x === '--model' || x === '-m' || (typeof x === 'string' && (x.startsWith('--model=') || x.startsWith('-m=')))))
}));

// Shrink buffer thresholds so the truncation tests can trip them with tiny
// inputs. Real values (10MB output, 256MB raw spool) would force tests to
// push millions of bytes through the spawner; the wiring under test is
// identical at any cap. OUTPUT_BUFFER_HEADROOM is intentionally 1 byte so
// ANY appendLine call trips it — otherwise the output-buffer overflow test
// would assert on the byte count of the two spawn-startup string literals
// (which would silently stop tripping if those strings change). The raw
// spool cap is shrunk to 100 bytes so the disk-safety-valve test exercises
// the truncation path without allocating hundreds of MB.
vi.mock('../../lib/tuiHandshake.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    OUTPUT_BUFFER_HEADROOM: 1,
    OUTPUT_BUFFER_CAP: 1,
    RAW_SPOOL_MAX_BYTES: 100,
  };
});

// child_process.execFile is used only by the TUI liveness probe
// (shellHasLiveChild). Default to an error callback so the probe resolves
// "assume alive" (guard bypassed) for every test that doesn't exercise it —
// the early-exit test below overrides this to report no child process.
vi.mock('../../lib/childProcess.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execFile: vi.fn((_file, _args, _opts, cb) => cb(new Error('not mocked'))) };
});

// ─── spawnTuiAgent runtime tests ─────────────────────────────────────────────

// Flush the microtask queue (pending Promise continuations). vi.runAllMicrotasksAsync
// is available in neither vitest 4 nor 5 — use Promise.resolve() ticks instead.
const flushMicrotasks = () => Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());

const sessionCallbacks = { onData: null, onExit: null };

const SESSION_ID = 'test-session-id-abc';

const defaultProvider = { id: 'codex-tui', name: 'Codex TUI', type: 'tui', envVars: {} };

// Short delays so fake timers don't need to advance huge amounts of time.
const defaultTuiConfig = {
  command: 'codex',
  args: [],
  // `spawnCommand`/`spawnArgs` are what a real `buildTuiSpawnConfig` always
  // populates (identical to `command`/`args` absent a credentialBootstrap
  // config) — see credentialBootstrap.test.js for that module's own coverage.
  spawnCommand: 'codex',
  spawnArgs: [],
  commandLine: 'codex',
  promptDelayMs: 100,
};

// The stamp `agentLifecycle` would write for this run, derived through the
// REAL predicate rather than hand-written. The old `!leanMode` default pinned
// `true` for every non-lean host, a value the spawn path never produced for a
// slashdo-capable one (#6869), so the suite agreed with itself and not with
// production. A worktree is assumed unless a case says otherwise: a PR-opening
// TUI run always has one.
function stampPrOpenedBy(overrides, task, provider) {
  return promptOpensOwnPr(task, {
    providerType: provider?.type ?? 'tui',
    providerId: provider?.id ?? null,
    providerCommand: provider?.command ?? null,
    leanMode: overrides.leanMode ?? false,
    worktreeInfo: overrides.worktreeInfo ?? { branchName: 'agent/t', worktreePath: '/tmp/ws', baseBranch: 'main' },
  });
}

function runSpawn(overrides = {}) {
  const agentId = overrides.agentId ?? 'agent-1';
  const task = overrides.task ?? { id: 'task-1', description: 'do the thing', metadata: {} };
  const prompt = overrides.prompt ?? 'do the thing';
  const workspacePath = overrides.workspacePath ?? '/tmp/ws';
  const model = overrides.model ?? null;
  const provider = overrides.provider ?? defaultProvider;
  const runId = overrides.runId ?? 'run-1';
  const tuiConfig = overrides.tuiConfig ?? defaultTuiConfig;
  const agentDir = overrides.agentDir ?? '/tmp/agentdir';
  const helpers = overrides.helpers ?? {};
  return spawnTuiAgent({
    agentId,
    task,
    prompt,
    workspacePath,
    model,
    provider,
    runId,
    tuiConfig,
    agentDir,
    prOpenedBy: overrides.prOpenedBy ?? stampPrOpenedBy(overrides, task, provider),
    leanMode: overrides.leanMode ?? false,
    useDurableRunner: overrides.useDurableRunner ?? false,
    securityScanGrant: overrides.securityScanGrant ?? null,
    safetyProfile: overrides.safetyProfile ?? null,
    ...helpers,
  });
}

let warnSpy = null;

// ── 1c. claude waits for bracketed-paste mode (input ready) before pasting ───
const claudeTuiConfig = { command: 'claude', args: [], spawnCommand: 'claude', spawnArgs: [], commandLine: 'claude', promptDelayMs: 100 };

// Antigravity (agy) gets the SAME positive input-ready gate as claude (#2705).
const agyTuiConfig = { command: 'agy', args: [], spawnCommand: 'agy', spawnArgs: [], commandLine: 'agy', promptDelayMs: 100 };

// Codex's composer placeholder — the positive 	he input box is live signal
// the idle paste path now requires (CODEX_COMPOSER_READY_PATTERN). A codex
// that has not painted it is still booting, and a paste into it is swallowed.
const CODEX_COMPOSER = '> Ask Codex to do anything\n';

const pasteCount = () => vi.mocked(shellService.writeToSession).mock.calls
  .filter(([, d]) => typeof d === 'string' && d.includes('\x1b[200~')).length;

// The launch shell turns bracketed-paste OFF to run the command, then claude
// turns it back ON when its input box is ready — that OFF→ON is "ready".
const PASTE_OFF = '\x1b[?2004l';

const PASTE_ON = '\x1b[?2004h';

// ── 1c-bis. Antigravity (agy) uses the SAME positive input-ready gate (#2705) ─
// agy's TUI emits the bracketed-paste-mode toggle exactly like claude, so it
// must gate the paste on paste-mode-re-enabled rather than blind-pasting on the
// quiet-startup heuristic (which fired into agy's still-initializing banner and
// left the agent sitting at an empty prompt). Without the fix agy took that
// path and WOULD have pasted after ~2s of banner silence;
// asserting pasteCount()===0 there is what discriminates the fix.
//
// agy needs a SECOND gate on top of paste mode, because — unlike claude — it
// enables bracketed paste on alt-screen entry, before its composer exists. Its
// composer footer is the marker that says the input box is actually live.
const AGY_COMPOSER_FOOTER = '? for shortcuts';

// The spawner acts on every gate from one 5s poll (PROVIDER_SIGNAL_POLL_MS,
// module-private), so each nudge lands within a tick of its threshold.
const SIGNAL_POLL_MS = 5000;

function installTuiRuntimeHooks() {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    // Clear shared mutable state between tests
    activeAgents.clear();
    userTerminatedAgents.clear();

    sessionCallbacks.onData = null;
    sessionCallbacks.onExit = null;

    // Silence the truncation warn globally for this describe block — the
    // mocked tiny OUTPUT_BUFFER_HEADROOM (above) makes every spawn trip it
    // via the two initial appendLine calls, so non-truncation tests would
    // otherwise spam stderr. The truncation-specific tests below reach for
    // this same spy to assert the warn fired.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Default createShellSession captures callbacks and returns a valid session id.
    // Real shell.js fires onInitialCommandSent when it injects the CLI command
    // (after its round-trip readiness probe); the claude input-ready gate only
    // observes paste-mode toggles AFTER that fires, so invoke it here to mirror
    // the real flow (otherwise commandInjected stays false and no paste ever gates).
    vi.mocked(shellService.createShellSession).mockImplementation((_socket, opts) => {
      sessionCallbacks.onData = opts.onData;
      sessionCallbacks.onExit = opts.onExit;
      opts.onInitialCommandSent?.();
      return SESSION_ID;
    });

    // The direct-PTY path a public-content stage takes (#6159). Real shell.js
    // has no readiness probe there — the CLI *is* the PTY — so
    // createAgentTuiSession opens the paste gate itself before the spawn; the
    // mock therefore does NOT invoke onInitialCommandSent.
    vi.mocked(shellService.spawnCommandSession).mockImplementation((_command, _args, opts) => {
      sessionCallbacks.onData = opts.onData;
      sessionCallbacks.onExit = opts.onExit;
      return SESSION_ID;
    });

    vi.mocked(shellService.getSessionProcess).mockReturnValue(null);
    vi.mocked(shellService.getSession).mockReturnValue({ id: SESSION_ID });
    // Restore the liveness probe's "assume alive" default. `clearAllMocks` clears
    // call history but KEEPS implementations, so a test that makes the probe
    // report "no live child" would otherwise leak that verdict into whichever
    // test runs next and strand it at the paste gate.
    vi.mocked(execFile).mockImplementation((_file, _args, _opts, cb) => cb(new Error('not mocked')));
    vi.mocked(spawnTuiSessionViaRunner).mockImplementation(async (options) => {
      sessionCallbacks.onData = options.onData;
      sessionCallbacks.onExit = options.onExit;
      return {
        sessionId: SESSION_ID,
        pid: 4321,
        ptyProcess: {
          pid: 4321,
          onData: vi.fn(),
          onExit: vi.fn(),
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
        },
      };
    });

    // Reset sentinel state: no .agent-done on disk, empty read. The
    // completion-sentinel test overrides both. clearAllMocks keeps the factory
    // implementation, so re-set explicitly to prevent cross-test leakage.
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(statSync).mockReturnValue({ isFile: () => true, mtimeMs: Date.now() });
    vi.mocked(readFile).mockResolvedValue('');

  });

  afterEach(() => {
    vi.useRealTimers();
    warnSpy?.mockRestore();
  });
}

export {
  flushMicrotasks,
  sessionCallbacks,
  SESSION_ID,
  defaultProvider,
  defaultTuiConfig,
  runSpawn,
  claudeTuiConfig,
  agyTuiConfig,
  CODEX_COMPOSER,
  pasteCount,
  PASTE_OFF,
  PASTE_ON,
  AGY_COMPOSER_FOOTER,
  SIGNAL_POLL_MS,
  installTuiRuntimeHooks,
  warnSpy,
  appendRunEvent,
};
