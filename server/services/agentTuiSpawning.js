/**
 * Agent TUI Spawning
 *
 * Runs CoS agents inside an interactive PTY-backed shell session. This is for
 * providers whose useful interface is a terminal UI rather than a headless CLI
 * or HTTP API.
 */

import { join } from 'path';
import { existsSync } from 'fs';
import { appendFile, readFile, rm, open, stat as fsStat, writeFile } from 'fs/promises';
import * as shellService from './shell.js';
import { emitLog } from './cosEvents.js';
import { appendAgentOutputLines, updateAgent } from './cosAgents.js';
import { registerSpawnedAgent, unregisterSpawnedAgent } from './agents.js';
import { analyzeAgentFailure } from './agentErrorAnalysis.js';
import { finalizeAgent, releaseAgentLane } from './agentLifecycle.js';
import { activeAgents, userTerminatedAgents, pausedAgents } from './agentState.js';
import { PATHS } from '../lib/fileUtils.js';
import { DONE_SENTINEL_NAME, parseSentinelPayload } from '../lib/agentSentinel.js';
import * as git from './git.js';
import { shellQuote } from '../lib/shellQuote.js';
import { resolveCliModel, buildEffortArgs, resolveBedrockCliModel, prefixOpencodeModel, hasModelFlag, isOpencodeCommand, isClaudeCommand, applyLeanClaudeArgs, providerSuppliesGithubToken } from '../lib/providerModels.js';
import { createStreamingAnsiStripper, stripAnsi } from '../lib/ansiStrip.js';
import { createImmediateFallbackSignalDetector } from '../lib/aiToolkit/errorDetection.js';
import { isAntigravityCommand } from '../lib/antigravity.js';
import {
  DEFAULT_TUI_PROMPT_DELAY_MS,
  DEFAULT_TUI_IDLE_TIMEOUT_MS,
  DEFAULT_TUI_MAX_RUNTIME_MS,
  MERGE_QUEUE_IDLE_TIMEOUT_MS,
  REVIEW_LOOP_IDLE_TIMEOUT_MS,
  READY_POLL_INTERVAL_MS,
  READY_IDLE_THRESHOLD_MS,
  PASTE_MARKER_POLL_MS,
  countPasteMarkers,
  createWorkActivityTracker,
  createMergeQueueTracker,
  createReviewLoopTracker,
  createMcpBootTracker,
  MCP_BOOT_PASTE_DEADLINE_MS,
  MCP_BOOT_PASTE_RETRY_DELAY_MS,
  createInputReadyTracker,
  rendersWorkCounter,
  PASTE_TO_ENTER_MIN_DELAY_MS,
  PASTE_TO_ENTER_FALLBACK_MS,
  scheduleSubmitEnters,
  PASTE_DEADLINE_MS,
  TUI_INPUT_READY_DEADLINE_MS,
  OUTPUT_BUFFER_CAP,
  OUTPUT_BUFFER_HEADROOM,
  RAW_SPOOL_MAX_BYTES,
  inferTuiCommand,
  applyCommandDefaults,
  PASTE_VERIFY_POLL_MS,
  PASTE_VERIFY_WINDOW_MS,
  PASTE_RETRY_MAX_ATTEMPTS,
  PASTE_RETRY_BASE_DELAY_MS,
  extractVerifiablePromptPrefix,
  isPasteConfirmed,
} from '../lib/tuiHandshake.js';
import { agentGuardEnv } from '../lib/agentGuard/index.js';
import { buildOpencodeEnvVars } from '../lib/opencodeConfig.js';
import { execFile } from 'child_process';

// Agent-specific timing/lifecycle constants (not shared with the one-shot
// runner — agents stay alive much longer and write a sentinel file when done).
const DEFAULT_TUI_MIN_RUNTIME_MS = 15000;
// Grace window after the last input written to the session (human paste via
// the Shell page, or our own auto-paste) before the idle reaper is allowed to
// fire again. Covers a large bracketed paste sitting in a silent reflow/commit
// window with no PTY output yet — comfortably above the paste-to-enter
// handshake windows in tuiHandshake.js (PASTE_DEADLINE_MS=10s) without
// meaningfully weakening the idle-reap protection once input truly stops.
const PASTE_INPUT_GRACE_MS = 15000;
// Tail-read window for raw.txt at failure analysis. analyzeAgentFailure only
// inspects the last ~200 lines, so reading the whole file (which has no upper
// bound for long-running agents) would reintroduce the OOM risk the disk
// spool was meant to avoid. 1MB easily contains the last 200 lines of any
// realistic PTY stream while keeping peak finalize memory bounded.
const RAW_TAIL_ANALYSIS_BYTES = 1024 * 1024;

// RAW_SPOOL_MAX_BYTES lives in tuiHandshake.js so the test suite can shrink
// the cap via the same vi.mock pattern that overrides the output-buffer
// thresholds — saves the truncation test from having to push hundreds of MB
// through the spawner. A misbehaving (or compromised) TUI agent could in
// principle emit MB/sec forever and fill the volume; realistic agents idle
// out at 180s and emit <10MB total. At this threshold the spool is truncated
// (rewritten with the current batch) so the most-recent data remains, which
// is what readFileTail at finalize needs anyway. Warn fires once per agent
// run; the `rawSpoolTruncated` metadata flag persists in the agent record
// so the operator can spot the affected runs after the fact.

/**
 * Read at most `maxBytes` from the end of a file. Returns null when the file
 * doesn't exist or can't be opened; an empty string for a zero-byte file.
 * Used to bound the memory footprint of failure-analysis reads against the
 * uncapped raw PTY spool. Non-throwing — any failure surfaces as null so
 * the caller's failure-analysis path can fall back to outputBuffer instead
 * of aborting `finish()` before finalizeAgent runs.
 */
async function readFileTail(path, maxBytes) {
  const st = await fsStat(path).catch(() => null);
  if (!st) return null;
  if (st.size === 0) return '';
  const start = Math.max(0, st.size - maxBytes);
  const length = st.size - start;
  const fh = await open(path, 'r').catch(() => null);
  if (!fh) return null;
  try {
    const buf = Buffer.alloc(length);
    // Honour bytesRead — the file can shrink between stat and read, or the
    // OS can return a short read; decoding the whole `buf` would otherwise
    // append NULs to the returned string. Read failures surface as null so
    // callers can distinguish "empty file" ('') from "read error" (null) —
    // a `bytesRead: 0` fallback would conflate the two.
    const readResult = await fh.read(buf, 0, length, start).catch(() => null);
    if (readResult === null) return null;
    return buf.toString('utf8', 0, readResult.bytesRead);
  } finally {
    await fh.close().catch(() => {});
  }
}
/**
 * Check if a worktree has any uncommitted changes. Returns true when the
 * working tree is dirty (staged or unstaged changes exist). Used to gate
 * idle-complete success — an agent that idled out with zero file changes
 * should fail, not succeed.
 */
async function worktreeHasChanges(workspacePath) {
  if (!workspacePath || typeof workspacePath !== 'string') return false;
  const status = await git.getStatus(workspacePath).catch(() => null);
  return status && !status.clean;
}

/**
 * Capture the git diff (staged + unstaged) from a worktree and save it to the
 * agent archive dir. Called before worktree cleanup so post-mortems can see
 * what changes existed even if the worktree is deleted. Non-throwing — a
 * failure to capture shouldn't block finalize.
 *
 * @returns {string|null} The captured diff, or null if none/error.
 */
async function captureWorktreeDiff(workspacePath, agentDir) {
  if (!workspacePath || typeof workspacePath !== 'string') return null;
  if (!agentDir || typeof agentDir !== 'string') return null;
  const [staged, unstaged] = await Promise.all([
    git.getDiff(workspacePath, true).catch(() => ''),
    git.getDiff(workspacePath, false).catch(() => ''),
  ]);
  const combined = [
    staged ? `### STAGED CHANGES ###\n${staged}` : '',
    unstaged ? `### UNSTAGED CHANGES ###\n${unstaged}` : '',
  ].filter(Boolean).join('\n\n');
  if (!combined.trim()) return null;
  const diffFile = join(agentDir, 'worktree-diff.txt');
  await writeFile(diffFile, combined).catch((err) => {
    console.error(`❌ Failed to capture worktree diff for agent: ${err.message}`);
  });
  return combined;
}

// Debounce window for batching parsed output to disk + state. A chatty TUI can
// emit hundreds of lines/sec; without batching, each line triggers a full
// state load+save (see appendAgentOutput) and a small appendFile, which slows
// the PTY event loop and thrashes the filesystem. 250ms is invisible to the
// live tail but cuts I/O by 1-2 orders of magnitude.
const OUTPUT_FLUSH_INTERVAL_MS = 250;
// Sentinel-file polling. TUI agents write `.agent-done` in their workspace
// when they've finished /simplify + /do:pr (or /do:push) — we poll for it
// here so the agent gets cleanly finalized as soon as the work is done,
// without waiting on the much longer idle timeout fallback.
// DONE_SENTINEL_NAME is shared from ../lib/agentSentinel.js.
const DONE_POLL_INTERVAL_MS = 2000;

/**
 * Thin wrapper around `shellService.createShellSession` for the agent TUI
 * path. Centralizes the agent-side defaults (kind, label, initialCommand)
 * and pairs the returned session id with its underlying pty process so
 * callers don't have to make a second `getSessionProcess` call inline.
 *
 * Returns `{ sessionId, ptyProcess, pid }`. When the shell service fails
 * to create the session, `sessionId` is null and the caller is expected
 * to bail out via its `finish` path.
 */
export function createAgentTuiSession({ agentId, provider, model, tuiConfig, cwd, forgeTokenEnv = {}, onData, onExit, onInitialCommandSent }) {
  // For OpenCode Ollama providers, build dynamic OPENCODE_CONFIG_CONTENT with
  // the models map so --model is accepted (the static env var lacked this).
  const opencodeEnv = buildOpencodeEnvVars(provider, model);
  const sessionId = shellService.createShellSession(null, {
    cwd,
    kind: 'agent-tui',
    agentId,
    label: `${provider.name} ${agentId}`,
    command: tuiConfig.commandLine,
    initialCommand: tuiConfig.commandLine,
    // Wait until the shell can actually RUN commands before injecting the CLI
    // command — a fixed delay races a heavy interactive shell and the launched
    // TUI can fall straight back to a half-loaded prompt (see shell.js
    // waitForPromptReady, which proves readiness with a round-trip probe).
    waitForPromptReady: true,
    // Fires when the CLI command is actually injected. We start observing
    // claude's input-readiness only after this so the readiness probe's own
    // shell activity can't prematurely open the paste gate.
    onInitialCommandSent,
    // agentGuardEnv() prepends the pm2 shim to the agent session's PATH (and
    // points it at the real pm2). Spread LAST so it wins over any provider PATH.
    // Only AI agent sessions get this — the user's own Shell page does not.
    // opencodeEnv comes after provider.envVars to override the static config.
    // forgeTokenEnv is threaded in explicitly because buildSafeEnv strips
    // GH_TOKEN from the inherited env (see resolveForgeTokenEnv); it goes before
    // provider.envVars so an explicit provider GH_TOKEN override still wins,
    // matching the direct-CLI and runner spawn paths.
    env: { ...forgeTokenEnv, ...(provider.envVars || {}), ...opencodeEnv, ...agentGuardEnv() },
    onData,
    onExit,
  });

  if (!sessionId) {
    return { sessionId: null, ptyProcess: null, pid: null };
  }

  const ptyProcess = shellService.getSessionProcess(sessionId);
  return { sessionId, ptyProcess, pid: ptyProcess?.pid || null };
}

// Best-effort liveness probe for the launched TUI command. The TUI runs e.g.
// `claude` as a CHILD of a persistent PTY shell (see createShellSession writing
// initialCommand), so when that command exits at startup the PTY itself stays
// open — the shell just returns to its prompt — and the spawner's onExit never
// fires. "The shell PID has no live child process" therefore means the launched
// command has already exited. Resolves true (assume alive) when the probe can't
// run, so a flaky/absent `ps` never blocks an otherwise-healthy paste.
function shellHasLiveChild(shellPid) {
  if (!shellPid) return Promise.resolve(true);
  return new Promise((resolve) => {
    // `-Ao ppid=` is POSIX (all processes, ppid column only, no header) and
    // works on both macOS (BSD ps) and Linux (procps).
    execFile('ps', ['-Ao', 'ppid='], { timeout: 2000 }, (err, stdout) => {
      if (err) { resolve(true); return; }
      resolve(stdout.split('\n').some((line) => parseInt(line, 10) === shellPid));
    });
  });
}

function appendModelArgs(args, model, command, provider) {
  if (isAntigravityCommand(command)) return args;
  const effectiveModel = resolveCliModel(model);
  if (!effectiveModel) return args;
  // OpenCode TUI launches with `opencode --model ollama/<id>` (the top-level
  // flag preselects the model). Namespace the bare Ollama id; no Bedrock mapping.
  // Respect a user-baked --model/-m pin (mirrors buildTuiInvocation/buildCliArgs)
  // rather than appending a second flag that overrides it.
  if (isOpencodeCommand(command)) {
    if (hasModelFlag(args)) return args;
    return [...args, '--model', prefixOpencodeModel(provider, effectiveModel)];
  }
  // Bedrock box: map a bare Claude id to its region-prefixed form just-in-time
  // (no-op off Bedrock / for non-Claude ids).
  const injectedModel = resolveBedrockCliModel(effectiveModel, {
    env: { ...process.env, ...provider?.envVars },
    providerId: provider?.id,
  });
  return [...args, '--model', injectedModel];
}

export function buildTuiSpawnConfig(provider, model, { systemPromptFile = null, effort = null } = {}) {
  const command = provider?.command || inferTuiCommand(provider?.id);
  const baseArgs = applyCommandDefaults(command, [...(provider?.args || [])]);
  let args = appendModelArgs(baseArgs, model, command, provider);
  // Reasoning-effort override — the provider is re-keyed on the RESOLVED launch
  // command so an inferred command (blank provider.command) still qualifies.
  args = [...args, ...buildEffortArgs(effort, { id: provider?.id, command }, args)];
  // Lean mode for Ollama-backed claude sessions (no-op otherwise) — must come
  // before the system-prompt flag so `--bare` is present when the contract
  // file rides along.
  args = applyLeanClaudeArgs(provider, args, command);
  if (systemPromptFile && isClaudeCommand(command)) {
    args = [...args, '--append-system-prompt-file', systemPromptFile];
  }

  return {
    command,
    args,
    commandLine: [command, ...args].map(shellQuote).join(' '),
    promptDelayMs: provider?.tuiPromptDelayMs || DEFAULT_TUI_PROMPT_DELAY_MS,
    idleTimeoutMs: provider?.tuiIdleTimeoutMs || DEFAULT_TUI_IDLE_TIMEOUT_MS,
    maxRuntimeMs: provider?.tuiMaxRuntimeMs || DEFAULT_TUI_MAX_RUNTIME_MS
  };
}

export async function spawnTuiAgent({
  agentId,
  task,
  prompt,
  workspacePath,
  model,
  provider,
  runId,
  tuiConfig,
  agentDir,
  executionId,
  laneName,
  cleanupWorktreeFn,
  isTruthyMetaFn,
}) {
  const outputFile = join(agentDir, 'output.txt');
  // Raw PTY bytes spool to disk continuously rather than accumulate in-memory.
  // A chatty TUI (token-tick repaints, status lines) emits hundreds of chunks
  // /sec; a per-run in-memory buffer would grow without bound on long agents
  // and the join-into-single-string at finalize would double peak RAM. The
  // disk file is appended in 250ms-debounced batches (same pattern as
  // `flushPendingLines` for parsed output — see CLAUDE.md "High-frequency
  // state writes must batch"), and `analyzeAgentFailure` reads the file on
  // failure so it gets the full PTY stream regardless of run length.
  const rawFile = join(agentDir, 'raw.txt');
  const cwd = workspacePath && typeof workspacePath === 'string' ? workspacePath : PATHS.root;
  // The agent writes `.agent-done` in its workspace to signal completion (see
  // the sentinel watcher below) and then stops — it does NOT run `/quit` (that
  // is a UI command the agent can't invoke). The 2s poll is the primary
  // finalize path; finish() also ingests the sentinel directly so the summary
  // is captured even if some other path (idle/exit) finalizes first. Computed
  // up front so both the watcher AND finish() can read it (see ingestDoneSentinel).
  const doneSentinelPath = workspacePath ? join(workspacePath, DONE_SENTINEL_NAME) : null;
  const promptPreview = prompt.replace(/\s+/g, ' ').slice(0, 100);
  const commandName = tuiConfig.command.split('/').pop();
  // Markers already present in the prompt text itself (a transcript-analysis task
  // can echo `[Pasted text #N]` back). The paste-commit fast path must wait for
  // the TUI's OWN marker — i.e. the count to EXCEED this — so an echoed marker
  // doesn't fire the submit-Enters mid-reflow (issue #1229 review). STRIP the
  // prompt first: a pasted RAW transcript may carry the cursor-positioned marker
  // form (`[Pasted\x1b[11Gtext…`), which counts as 0 unstripped but echoes back as
  // the stripped `[Pastedtext#…]` (count 1) — so we must count the prompt the same
  // way the post-paste buffer is counted, or the gate undercounts and fires early.
  const promptMarkerCount = countPasteMarkers(stripAnsi(prompt));

  let outputBuffer = '';
  let finalized = false;
  let immediateFallbackAnalysis = null;
  const detectImmediateFallbackSignal = createImmediateFallbackSignalDetector();
  // Guards ingestDoneSentinel to a single read. finish() is its only caller and
  // is itself guarded by `finalized`, so this is defensive — it pins the
  // read-at-most-once invariant at the helper.
  let sentinelIngested = false;
  let hasStartedWorking = false;
  let promptSentAt = null;
  // When the submit-Enter is first written (NOT when the paste starts). Work-
  // activity observation keys on this so the prompt ECHO — which renders during
  // the paste→Enter window, before this is set — is never scanned for the working
  // counter (issue #1229 review: a pasted transcript could otherwise echo counters
  // that fake work before the prompt is actually submitted).
  let promptSubmittedAt = null;
  // Tracks evidence the model is actively processing the SUBMITTED prompt — the
  // TUI's elapsed working counter advancing through ≥2 distinct values (see
  // createWorkActivityTracker; echo-proof, unlike word-matching the prompt text).
  // Distinct from `hasStartedWorking`, which flips on ANY post-spawn PTY output
  // including pure banner/status-line chrome. `tracker.active` is what gates the
  // fallback idle-complete path from finalizing a never-submitted prompt as
  // success (issue #1229).
  const workActivity = createWorkActivityTracker();
  // Latches once the agent enters a `/do:next --swarm` Phase C serialized merge
  // queue, whose per-PR CI re-runs produce minutes of silent output. While
  // latched, the idle reaper uses the extended MERGE_QUEUE_IDLE_TIMEOUT_MS so a
  // still-working orchestrator isn't reaped mid-merge (issue #2074).
  const mergeQueue = createMergeQueueTracker();
  // Latches once the agent enters a do:release/do:pr/do:rpr multi-reviewer
  // loop, whose external reviewer passes (codex reading a large diff, a
  // Copilot cloud review, a human @<login> review) can go silent in the TUI
  // for well over the default idle window. While latched, the idle reaper
  // uses the extended REVIEW_LOOP_IDLE_TIMEOUT_MS so a still-waiting release
  // isn't reaped as a false `idle-complete` success before it reaches the
  // merge gate (issue observed on agent-61508f36, PR #2084).
  const reviewLoop = createReviewLoopTracker();
  // Latches once codex prints its MCP-server boot banner during startup. A user
  // with heavyweight interactive MCP servers in ~/.codex/config.toml (playwright
  // via npx, a node_repl with startup_timeout_sec=120) makes codex spend tens of
  // seconds — up to ~2min — booting them before its input box accepts a paste,
  // far longer than the default 3-attempt paste-retry window. While latched, the
  // paste-retry loop below extends its budget to MCP_BOOT_PASTE_DEADLINE_MS so a
  // slow boot completes and the paste finally lands, instead of being killed
  // `paste-not-rendered` mid-boot (incident 2026-07-10, agent-c5a26b40).
  //
  // Gated to codex ONLY (isCodexSession below). The extended budget and the
  // failure message ("check your ~/.codex config") are codex-specific, and the
  // claude path never blind-pastes during its own MCP boot — it waits for
  // claude's positive input-ready signal first (createInputReadyTracker) — so it
  // can't hit this failure mode. Observing every provider would let an unrelated
  // TUI whose startup text happened to contain "starting mcp servers" inherit
  // codex's 150s budget and its misleading codex-config guidance, breaking the
  // "non-codex TUIs are unchanged" contract (codex review [P2]).
  const isCodexSession = commandName.toLowerCase().includes('codex');
  const mcpBoot = createMcpBootTracker();
  // Tracks claude's interactive input-readiness (footer chrome) and its first-run
  // folder-trust gate. Gates the prompt paste for the claude TUI so we never
  // paste into a startup banner, a trust menu, or a returned shell prompt.
  const inputReady = createInputReadyTracker();
  let trustAccepted = false;
  // True once shell.js actually injects the `claude` command (after its
  // round-trip readiness probe). The probe runs its OWN shell command first,
  // which toggles bracketed-paste mode and would otherwise advance the
  // input-ready tracker (sawCommandRun + pasteModeOn) while still at the bare
  // shell prompt — pasting the prompt into claude's startup banner. Gating
  // observation on this discards every pre-command toggle.
  let commandInjected = false;
  let firstOutputAt = null;
  let lastOutputAt = Date.now();
  let lastLine = '';
  let sessionId = null;
  // True once outputBuffer crossed its HEADROOM and the head was dropped.
  // Mirrors `outputBufferTruncated` in `tuiPromptRunner.js`: warn once per
  // buffer and surface via agent metadata so the agent record distinguishes
  // a long-run-with-overflow from a clean short run.
  let outputBufferTruncated = false;

  // Bounded post-paste accumulator. Lives only while pasteEnterTimer is
  // running (a few seconds at most), so the in-memory cost is bounded by
  // however much the TUI emits during the paste-marker window — typically
  // a few KB. Set to '' when sendPrompt fires; nulled when paste detection
  // resolves or the agent finalizes.
  let postPasteBuffer = null;

  let pendingLines = [];
  let flushTimer = null;
  let flushing = null;
  let pendingRawChunks = [];
  let rawFlushTimer = null;
  let rawFlushing = null;
  let rawBytesWritten = 0;
  let rawSpoolTruncationWarned = false;
  let pasteEnterTimer = null;
  let pasteVerifyTimer = null;
  let submitEnterTimer = null;
  // Absolute wall-clock backstop — armed once the prompt is SUBMITTED, cleared
  // in finish(). Unlike the idle reaper (which resets on every PTY repaint and
  // so never fires for a busy-but-stuck agent whose working counter keeps
  // ticking), this bounds the total run so a hung provider/CLI can't run
  // unbounded. See DEFAULT_TUI_MAX_RUNTIME_MS for the incident.
  let maxRuntimeTimer = null;

  const streamingStrip = createStreamingAnsiStripper();

  const flushPendingLines = async () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (pendingLines.length === 0) return;
    const batch = pendingLines;
    pendingLines = [];
    await Promise.all([
      appendAgentOutputLines(agentId, batch).catch(() => {}),
      appendFile(outputFile, batch.map(l => `${l}\n`).join('')).catch(() => {})
    ]);
  };

  const scheduleFlush = () => {
    if (flushTimer || flushing) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushing = flushPendingLines().finally(() => {
        flushing = null;
        // Catch chunks that arrived during the in-flight flush — without
        // this, a producer that goes quiet right after the flush starts
        // strands its last batch in pendingLines until finalize.
        if (pendingLines.length > 0) scheduleFlush();
      });
    }, OUTPUT_FLUSH_INTERVAL_MS);
  };

  // Raw PTY flush pipeline. Parallel to flushPendingLines but appends the
  // unprocessed chunks (no ANSI strip, no line semantics) to raw.txt.
  // shellService surfaces node-pty output as already-decoded UTF-8 strings
  // (node-pty's internal StringDecoder handles multi-byte boundaries before
  // we see chunks), so queueing strings here is sufficient — no Buffer
  // bookkeeping needed. pendingRawChunks holds whatever arrives during the
  // 250ms debounce window AND while an appendFile is in-flight (the next
  // scheduleRawFlush is gated by rawFlushing); join() runs once per flush
  // tick, so peak in-memory raw data is bounded by one debounce-plus-IO
  // window of TUI output (typically hundreds of KB on a chatty agent).
  const flushPendingRawChunks = async () => {
    if (rawFlushTimer) { clearTimeout(rawFlushTimer); rawFlushTimer = null; }
    if (pendingRawChunks.length === 0) return;
    const batch = pendingRawChunks.join('');
    pendingRawChunks = [];
    // Count UTF-8 bytes actually written to disk, NOT the UTF-16 code-unit
    // length of the JS string — non-ASCII output would otherwise under-
    // report and let the spool exceed the safety cap.
    const batchBytes = Buffer.byteLength(batch, 'utf8');
    if (rawBytesWritten + batchBytes > RAW_SPOOL_MAX_BYTES) {
      // Safety valve: rewrite the file with just this batch instead of
      // appending. The tail-read at finalize wants the MOST RECENT bytes,
      // not the oldest, so truncating preserves what analyzeAgentFailure
      // actually uses while bounding disk usage at ~RAW_SPOOL_MAX_BYTES.
      // If a single debounce-window batch exceeds the cap (runaway producer
      // emitting MB/sec), slice to the trailing RAW_SPOOL_MAX_BYTES bytes
      // first — Buffer-slice to keep UTF-8 byte semantics correct (a
      // string.slice would index by UTF-16 code units and produce torn
      // multi-byte sequences at the boundary).
      let writeBuf;
      if (batchBytes > RAW_SPOOL_MAX_BYTES) {
        const buf = Buffer.from(batch, 'utf8');
        writeBuf = buf.subarray(buf.length - RAW_SPOOL_MAX_BYTES);
      } else {
        writeBuf = batch;
      }
      const writeBytes = typeof writeBuf === 'string' ? batchBytes : writeBuf.length;
      if (!rawSpoolTruncationWarned) {
        rawSpoolTruncationWarned = true;
        console.warn(`⚠️ TUI agent ${agentId} raw PTY spool reached ${Math.round(RAW_SPOOL_MAX_BYTES / 1024 / 1024)}MB — truncating spool (oldest bytes dropped; tail-read still reflects most recent)`);
        updateAgent(agentId, { metadata: { rawSpoolTruncated: true } })
          .catch(err => console.error(`❌ TUI agent ${agentId} rawSpoolTruncated metadata write failed: ${err.message}`));
      }
      // Only update the byte counter on successful write — a failed write
      // would otherwise inflate rawBytesWritten and make subsequent flush
      // decisions race the actual on-disk state.
      const wrote = await writeFile(rawFile, writeBuf).then(() => true).catch(() => false);
      if (wrote) rawBytesWritten = writeBytes;
      return;
    }
    const wrote = await appendFile(rawFile, batch).then(() => true).catch(() => false);
    if (wrote) rawBytesWritten += batchBytes;
  };

  const scheduleRawFlush = () => {
    if (rawFlushTimer || rawFlushing) return;
    rawFlushTimer = setTimeout(() => {
      rawFlushTimer = null;
      rawFlushing = flushPendingRawChunks().finally(() => {
        rawFlushing = null;
        // Same re-schedule guard as scheduleFlush: chunks that arrived
        // during the in-flight appendFile would otherwise sit until
        // finalize if the producer goes quiet immediately after.
        if (pendingRawChunks.length > 0) scheduleRawFlush();
      });
    }, OUTPUT_FLUSH_INTERVAL_MS);
  };

  // TUI agents only emit a handful of internal status lines (session-started,
  // prompt-pasted, completion) — see handleData for why per-line capture of
  // the PTY stream itself is intentionally dropped.
  const appendLine = (line) => {
    const cleanLine = line.trim();
    if (!cleanLine || cleanLine === lastLine) return;

    lastLine = cleanLine;
    outputBuffer += `${cleanLine}\n`;
    if (outputBuffer.length > OUTPUT_BUFFER_HEADROOM) {
      outputBuffer = outputBuffer.slice(-OUTPUT_BUFFER_CAP);
      if (!outputBufferTruncated) {
        outputBufferTruncated = true;
        console.warn(`⚠️ TUI agent ${agentId} parsed-output buffer exceeded ${Math.round(OUTPUT_BUFFER_HEADROOM / 1024 / 1024)}MB — head dropped (output.txt is the authoritative on-disk record)`);
        updateAgent(agentId, { metadata: { outputBufferTruncated: true } })
          .catch(err => console.error(`❌ TUI agent ${agentId} outputBufferTruncated metadata write failed: ${err.message}`));
      }
    }
    pendingLines.push(cleanLine);
    scheduleFlush();
  };

  // Read the `.agent-done` sentinel (if present) and append its markdown task
  // summary line-by-line into the agent's output so downstream consumers
  // (extractFinalSummary, persistSimplifySummaries, completion hooks, the agent
  // card, output.txt) get the resolution. Called only from finish() (the single
  // finalize chokepoint); idempotent via `sentinelIngested` so it reads at most
  // once. Capped at 4 KB so an agent that pasted the whole diff into the
  // sentinel can't blow up the record.
  const ingestDoneSentinel = async () => {
    if (sentinelIngested) return;
    if (!doneSentinelPath || !existsSync(doneSentinelPath)) return;
    sentinelIngested = true;
    const contents = await readFile(doneSentinelPath, 'utf8').catch(err => {
      console.error(`❌ ingestDoneSentinel readFile failed: ${err.message}`);
      return '';
    });
    // A programmatic-I/O task type writes a JSON `{ summary, payload }` sentinel;
    // append only the human `summary` to the agent output (the structured
    // `payload` is consumed separately by the task type's processTaskOutput hook,
    // read mode-agnostically in finalizeAgent). A legacy plain-markdown sentinel
    // parses back as its own text, so this is a no-op change for existing types.
    const { summary } = parseSentinelPayload(contents);
    if (!summary) return;
    appendLine(`✅ Agent signaled completion`);
    const truncated = summary.length > 4096 ? `${summary.slice(0, 4096)}\n…[truncated]` : summary;
    for (const line of truncated.split('\n')) appendLine(line);
  };

  const finish = async ({ success, exitCode = 0, error = null, reason = 'completed' }) => {
    if (finalized) return;
    finalized = true;

    const agentData = activeAgents.get(agentId);
    if (agentData?.idleTimer) clearInterval(agentData.idleTimer);
    if (agentData?.promptTimer) clearInterval(agentData.promptTimer);
    if (agentData?.doneSentinelTimer) clearInterval(agentData.doneSentinelTimer);
    if (pasteEnterTimer) { clearInterval(pasteEnterTimer); pasteEnterTimer = null; }
    if (pasteVerifyTimer) { clearInterval(pasteVerifyTimer); pasteVerifyTimer = null; }
    if (submitEnterTimer) { clearInterval(submitEnterTimer); submitEnterTimer = null; }
    if (maxRuntimeTimer) { clearTimeout(maxRuntimeTimer); maxRuntimeTimer = null; }
    // Release the post-paste accumulator even when finalize fires mid-paste-
    // window. The pasteEnterTimer's own cleanup path nulls this too, but if
    // finalize comes from elsewhere (shell-exit, command-not-found, user
    // termination) the timer never gets a chance to run.
    postPasteBuffer = null;

    // Ingest the .agent-done sentinel BEFORE draining, so its markdown summary
    // lands in outputBuffer/output.txt regardless of WHICH path finalized the
    // agent. The completion workflow writes the sentinel and stops; the 2s
    // doneSentinelTimer poll is what normally calls finish(). Reading it here
    // (not just in the poll) keeps the resolution captured even when a
    // different path (idle-complete, shell-exit) finalizes first. Idempotent
    // via `sentinelIngested`.
    await ingestDoneSentinel();

    // Drain pending parsed lines AND raw chunks before the final state
    // writes so completion events don't beat the last output batch to disk.
    if (flushing) await flushing.catch(() => {});
    await flushPendingLines();
    if (rawFlushing) await rawFlushing.catch(() => {});
    await flushPendingRawChunks();

    if (pausedAgents.has(agentId)) {
      pausedAgents.delete(agentId);
      const pausedAgentData = activeAgents.get(agentId);
      if (pausedAgentData?.pid) unregisterSpawnedAgent(pausedAgentData.pid);
      activeAgents.delete(agentId);
      return;
    }

    const duration = Date.now() - (agentData?.startedAt || Date.now());
    const terminatedByUser = userTerminatedAgents.has(agentId);
    if (terminatedByUser) userTerminatedAgents.delete(agentId);

    const finalSuccess = terminatedByUser ? false : success;
    const finalError = terminatedByUser ? 'Agent terminated by user' : error;

    // Release the lane + complete execution tracking BEFORE the
    // potentially-slow error-analysis / completeAgent / processAgentCompletion
    // chain — neither call blocks on I/O, but lanes serialize related work
    // and we don't want them held longer than necessary.
    releaseAgentLane({
      agentId,
      success: finalSuccess,
      duration,
      exitCode,
      executionId: agentData?.executionId || executionId,
      laneName: agentData?.laneName || laneName,
      errorExecutionMessage: finalError || `TUI agent ended: ${reason}`,
    });

    // output.txt has already been incrementally appended via flushPendingLines;
    // do NOT writeFile() it from outputBuffer at finalize — outputBuffer is
    // capped at OUTPUT_BUFFER_CAP and would silently truncate the on-disk
    // record for long runs. The append-only stream is the authoritative copy.
    //
    // For failure analysis: read only the tail of the raw PTY spool — the
    // analyzer's window is the last ~200 lines, so reading the full file
    // (potentially many MB on long agents) would defeat the disk-spool's
    // memory-bound guarantee. Successful runs skip the read entirely.
    // raw.txt stays in agentDir alongside output.txt as the persistent
    // record of the agent's full PTY transcript.
    const rawAnalysisText = finalSuccess
      ? null
      : await readFileTail(rawFile, RAW_TAIL_ANALYSIS_BYTES);
    // `??` (not `||`) so an empty raw spool ('') stays distinguishable from
    // a read failure (null) — readFileTail's contract. A zero-byte raw.txt
    // (file was created but the PTY never emitted) lets failure analysis
    // run against ''; both a missing file AND a read error return null and
    // fall back to outputBuffer (which has the spawn-startup notices).
    const errorAnalysis = finalSuccess
      ? null
      : (immediateFallbackAnalysis || analyzeAgentFailure(rawAnalysisText ?? outputBuffer, task, model));

    // try/finally so a throw from finalizeAgent (e.g. processAgentCompletion
    // hook crash) still runs the local cleanup — sentinel removal, worktree
    // cleanup, pid unregister, activeAgents delete, session kill. Without
    // this, a memory-extraction crash would strand the worktree and the
    // shell session on disk.
    try {
      await finalizeAgent({
        agentId,
        task,
        runId,
        providerId: provider?.id,
        success: finalSuccess,
        exitCode,
        duration,
        outputBuffer,
        errorAnalysis,
        terminatedByUser,
        isTruthyMetaFn,
        error: finalError || undefined,
        completionReason: reason,
        workspacePath,
      });
    } finally {
      if (workspacePath) await rm(join(workspacePath, DONE_SENTINEL_NAME)).catch(() => {});

      // TUI agents run /do:pr (or /do:push) themselves before signaling via
      // .agent-done, so the system-side cleanup must NOT also push or open a
      // PR — that would double-fire. `skipMerge` is forced on so the
      // post-exit auto-merge doesn't trip over a branch the agent already
      // pushed. The worktree directory itself is still cleaned up.
      await cleanupWorktreeFn(agentId, finalSuccess, {
        openPR: false,
        requestCopilotReview: false,
        skipMerge: true,
        description: task.description,
        agentOutput: outputBuffer,
        originalTask: task
      }).catch(err => emitLog('warn', `TUI worktree cleanup failed for ${agentId}: ${err.message}`, { agentId }));

      if (agentData?.pid) unregisterSpawnedAgent(agentData.pid);
      activeAgents.delete(agentId);
      if (sessionId && shellService.getSession(sessionId)) shellService.killSession(sessionId);
    }
  };

  const handleData = async (data) => {
    // EventEmitter listeners run outside the request lifecycle — a rejection
    // here on Node ≥15 will kill the process unless we catch locally. The
    // outer try/catch routes failures through emitLog (best-effort log, no
    // re-throw) and leaves the agent run intact.
    // See skill: nodejs-async-event-listener-unhandled-rejection.
    try {
      // node-pty can deliver chunks between finalize starting and the shell
      // session being killed in finalize's finally block. Once finalized, drop
      // them — appending to the spool, growing the post-paste accumulator, or
      // mutating timing state is all pointless after finish has settled.
      if (finalized) return;
      // node-pty surfaces output as already-decoded UTF-8 strings via
      // shellService's onData hook (StringDecoder handles multi-byte
      // boundaries internally), so `data` is a string here in normal use.
      // The String(...) coerces defensively in case a future caller wires
      // a Buffer-emitting encoding.
      const text = typeof data === 'string' ? data : String(data);
      const stripped = streamingStrip(text);
      pendingRawChunks.push(text);
      scheduleRawFlush();
      // Accumulate the ANSI-STRIPPED chunk (not the raw text): the paste marker
      // is rendered with absolute-column cursor moves between glyphs, so it only
      // matches after stripping (see countPasteMarkers). Appending raw text here
      // — as this did before #1229 — left the marker unmatchable and the fast
      // path dead.
      if (postPasteBuffer !== null && stripped) postPasteBuffer += stripped;
      // Observe claude's input-readiness / folder-trust chrome (before the
      // paste). Raw `text` carries the bracketed-paste-mode toggles; `stripped`
      // carries the visible footer/trust text. Only AFTER the CLI command is
      // injected — earlier toggles belong to shell startup and the readiness
      // probe, not to claude.
      if (!promptSentAt && commandInjected) inputReady.observe(text, stripped);
      // Latch codex's MCP-server boot banner during startup (codex sessions only;
      // before the prompt is submitted, so codex's own boot chrome — not the
      // echoed prompt — is what trips it). Gates the extended, boot-aware
      // paste-retry budget below. Observing until promptSubmittedAt (set only on a
      // CONFIRMED paste) means a banner that arrives AFTER an early swallowed paste
      // still latches — the swallowed paste never sets promptSubmittedAt.
      if (isCodexSession && !promptSubmittedAt && stripped && !mcpBoot.active) mcpBoot.observe(stripped);
      const now = Date.now();
      // Once the prompt is SUBMITTED (Enter sent — not merely pasted), watch for
      // proof the model is actually working. Keying on promptSubmittedAt (not
      // promptSentAt) excludes the prompt echo rendered during the paste→Enter
      // window. The TUI repaints chrome continuously even with an unsent prompt,
      // so we can't trust mere PTY activity — only the working counter advancing
      // across wall-clock time confirms real work (a static echo's counters all
      // arrive together and fail the time-span). Gates idle-complete (#1229).
      if (promptSubmittedAt && stripped && !workActivity.active) workActivity.observe(stripped, now);
      // Detect entry into the swarm Phase C merge queue so the idle reaper can
      // extend its grace window across the silent per-PR CI waits (issue #2074).
      // Latches once — observe only until active, then announce the transition.
      if (promptSubmittedAt && stripped && !mergeQueue.active && mergeQueue.observe(stripped)) {
        emitLog('info', `TUI agent ${agentId} entered merge queue — idle reaper extended to ${Math.round(MERGE_QUEUE_IDLE_TIMEOUT_MS / 60000)}min`, { agentId, phase: 'merge-queue' });
        await updateAgent(agentId, { metadata: { phase: 'merge-queue' } });
      }
      // Detect entry into a do:release/do:pr/do:rpr multi-reviewer loop so the
      // idle reaper can extend its grace across a slow reviewer's silent
      // working stretch (see reviewLoop declaration above for the incident).
      if (promptSubmittedAt && stripped && !reviewLoop.active && reviewLoop.observe(stripped)) {
        emitLog('info', `TUI agent ${agentId} entered review loop — idle reaper extended to ${Math.round(REVIEW_LOOP_IDLE_TIMEOUT_MS / 60000)}min`, { agentId, phase: 'review-loop' });
        await updateAgent(agentId, { metadata: { phase: 'review-loop' } });
      }
      lastOutputAt = now;
      if (firstOutputAt === null) firstOutputAt = lastOutputAt;

      if (!hasStartedWorking) {
        hasStartedWorking = true;
        await updateAgent(agentId, { metadata: { phase: 'working' } });
        emitLog('info', `TUI agent ${agentId} working...`, { agentId, phase: 'working' });
      }

      // The TUI is a *screen*, not a log: every progress tick repaints the
      // status line (`thinking with…`, token counters, footer) and gets
      // re-captured if we parse it line-by-line. The attached shell session
      // shows the live TUI faithfully — see-the-shell is the user-facing
      // path. We still spool the raw stream to raw.txt for error analysis
      // on failure, and we detect early "command not found" so a missing
      // binary fails fast instead of idling.
      const fallbackSignal = detectImmediateFallbackSignal(stripped);
      if (fallbackSignal) {
        immediateFallbackAnalysis = fallbackSignal;
        appendLine(`⚡ Provider fallback signal: ${fallbackSignal.message}`);
        await finish({
          success: false,
          exitCode: 1,
          error: fallbackSignal.message || 'Provider requires fallback',
          reason: 'fallback-signal'
        });
        return;
      }

      if (!promptSentAt) {
        const lowerStripped = stripped.toLowerCase();
        if (lowerStripped.includes('command not found') && lowerStripped.includes(commandName.toLowerCase())) {
          // finish() uses try/finally internally: finalizeAgent errors re-throw after
          // cleanup, so finish() can reject. The outer try/catch in handleData already
          // handles any such rejection via emitLog — no additional .catch() needed here.
          await finish({
            success: false,
            exitCode: 127,
            error: `TUI command not found: ${tuiConfig.command}`,
            reason: 'command-not-found'
          });
        }
      }
    } catch (err) {
      emitLog('error', `TUI agent ${agentId} handleData failed: ${err?.message || err}`, { agentId });
    }
  };

  const handleExit = async ({ exitCode, killed }) => {
    if (finalized) return;
    const code = typeof exitCode === 'number' ? exitCode : killed ? 130 : 0;
    await finish({
      success: code === 0 && !killed,
      exitCode: code,
      error: killed ? 'TUI shell session was killed' : null,
      reason: killed ? 'shell-killed' : 'shell-exit'
    });
  };

  // Repo-owner-pinned GH_TOKEN for the agent's own `gh pr create` (see
  // resolveForgeTokenEnv). Resolved here since createAgentTuiSession is sync.
  // Skip when the provider supplies its own GH_TOKEN/GITHUB_TOKEN so its explicit
  // credential wins.
  const forgeTokenEnv = providerSuppliesGithubToken(provider)
    ? {}
    : await git.resolveForgeTokenEnv(cwd);

  const session = createAgentTuiSession({
    agentId,
    provider,
    model,
    tuiConfig,
    cwd,
    forgeTokenEnv,
    onData: handleData,
    onExit: handleExit,
    onInitialCommandSent: () => { commandInjected = true; },
  });
  sessionId = session.sessionId;

  if (!sessionId) {
    await finish({ success: false, exitCode: 1, error: 'Failed to create TUI shell session', reason: 'spawn-error' });
    return null;
  }

  const { ptyProcess, pid } = session;
  if (pid) {
    registerSpawnedAgent(pid, {
      fullCommand: tuiConfig.commandLine,
      agentId,
      taskId: task.id,
      model,
      workspacePath,
      prompt: (task.description || '').substring(0, 500)
    });
  }

  // Send the bracketed-paste prompt only after the TUI has finished its initial
  // repaint and gone quiet — pasting during the banner/loading screen is the
  // failure mode that left the input empty. The `\r` is split from the paste
  // write because a fixed delay races Claude Code's paste-commit on large
  // prompts; instead we poll Claude Code's raw output for its
  // `[Pasted text #N +M lines]` marker, then wait an extra
  // PASTE_TO_ENTER_MIN_DELAY_MS before submitting. A fallback timer fires
  // the Enter unconditionally if the marker never appears (very small
  // prompts won't trigger the marker). All timers are tracked so finish()
  // can cancel pending writes if the agent ends mid-handshake.
  const startedAt = Date.now();

  // Finalize a startup failure WITHOUT pasting — surfacing whatever the CLI
  // printed (raw.txt tail) so the real cause is visible instead of a wedged
  // shell. Shared by the liveness guard (command exited) and the readiness cap
  // (claude never showed its input prompt).
  const finishStartupFailure = async (reason, summary) => {
    if (finalized) return;
    // Flush any debounced raw-PTY chunks first so the captured tail includes
    // the CLI's most recent output (e.g. claude's final error before exiting),
    // not just whatever happened to be on disk before the last 250ms window.
    await flushPendingRawChunks().catch(() => {});
    const raw = await readFile(rawFile, 'utf8').catch(() => '');
    const tail = raw
      ? stripAnsi(raw).split('\n').map((s) => s.trimEnd()).filter(Boolean).slice(-12).join('\n')
      : '';
    appendLine(`❌ ${summary}`);
    await finish({
      success: false,
      exitCode: 1,
      error: `${summary}${tail ? `\nCaptured output:\n${tail}` : ' No output was captured.'}`,
      reason,
    });
  };

  // Extract a verifiable prefix from the prompt for paste verification (issue #2192).
  // Computed once up front so retry attempts use the same verification target.
  const verifiablePrefix = extractVerifiablePromptPrefix(prompt);
  let pasteAttempt = 0;
  // Wall-clock of the FIRST paste attempt — the anchor for the MCP-boot-aware
  // retry deadline (retries are time-bounded, not attempt-count-bounded, while
  // codex is still booting its MCP servers).
  let firstPasteStartedAt = null;

  const sendPrompt = async (reason) => {
    if (finalized || promptSentAt) return;
    promptSentAt = Date.now();
    // Liveness guard: the TUI command runs as a child of the persistent PTY
    // shell, so if it exited at startup (e.g. claude failing to enter
    // interactive mode) the PTY stays open and onExit never fires. Pasting now
    // would dump the bracketed-paste prompt into the bare shell — the wedged
    // `^[[200~ …` session. If the shell has no live child, the command is gone:
    // fail loudly with whatever it printed instead of pasting into the shell.
    if (!(await shellHasLiveChild(pid))) {
      if (finalized) return; // a real onExit may have finalized during the probe await
      await finishStartupFailure(
        'tui-exited-early',
        `${tuiConfig.command} exited at startup before the TUI was ready, so no prompt was sent.`,
      );
      return;
    }
    // Start the paste attempt — may be retried if verification fails (issue #2192).
    attemptPaste(reason);
  };

  // Actually perform a paste attempt. Separated from sendPrompt so retries don't
  // re-run the liveness guard or re-set promptSentAt. Increments pasteAttempt on
  // each call; clears any pending timers from the previous attempt first.
  const attemptPaste = (reason) => {
    pasteAttempt += 1;
    const attemptNum = pasteAttempt;
    if (firstPasteStartedAt === null) firstPasteStartedAt = Date.now();
    if (pasteEnterTimer) { clearInterval(pasteEnterTimer); pasteEnterTimer = null; }
    if (pasteVerifyTimer) { clearInterval(pasteVerifyTimer); pasteVerifyTimer = null; }
    // Start capturing post-paste output. Set BEFORE writing the paste so
    // every chunk that arrives in response gets appended. Cleared the moment
    // detection resolves (marker seen or fallback elapsed) so the accumulator
    // never lives beyond the paste-marker window.
    postPasteBuffer = '';
    shellService.writeToSession(sessionId, `\x1b[200~${prompt}\x1b[201~`);
    const attemptSuffix = attemptNum > 1 ? ` [attempt ${attemptNum}/${PASTE_RETRY_MAX_ATTEMPTS}]` : '';
    appendLine(`📟 Prompt pasted into TUI session ${sessionId.slice(0, 8)} (${reason})${attemptSuffix}`);

    // Submit the pasted prompt with repeated Enters — a single `\r` can be
    // swallowed while the TUI is still reflowing a large paste, stranding the
    // prompt unsent (the "I had to hit Enter myself" bug). Tracked in
    // submitEnterTimer so finish() can cancel pending retries if the agent ends.
    const submitEnter = () => {
      // Mark submission so work-activity observation begins only now — after the
      // Enter is written, past the prompt-echo window (issue #1229 review).
      if (promptSubmittedAt === null) promptSubmittedAt = Date.now();
      submitEnterTimer = scheduleSubmitEnters(
        () => shellService.writeToSession(sessionId, '\r'),
        () => finalized
      );
      // Arm the absolute wall-clock backstop from submission (once — a paste
      // retry re-enters submitEnter but must not stack timers). The idle reaper
      // can't bound a busy-but-stuck agent because Claude Code's working counter
      // keeps repainting through a stalled provider retry, resetting lastOutputAt
      // forever; this timer is the honest ceiling regardless of PTY chatter.
      if (!maxRuntimeTimer) {
        maxRuntimeTimer = setTimeout(() => {
          if (finalized) return;
          // Salvage net: if the agent already wrote its .agent-done sentinel the
          // run truly finished (the TUI just never idled/exited), so complete as
          // success — mirrors the one-shot runner's response-file salvage. The
          // 2s doneSentinelTimer normally catches this first; this covers the
          // boundary where it lands right at the deadline.
          const salvaged = doneSentinelPath && existsSync(doneSentinelPath);
          if (salvaged) {
            finish({ success: true, exitCode: 0, reason: 'max-runtime-sentinel' }).catch(err => {
              emitLog('error', `Failed to finalize TUI agent ${agentId} at max-runtime salvage: ${err.message}`, { agentId });
            });
            return;
          }
          // Capture any uncommitted work for post-mortem before cleanup, then
          // fail with a needs-manual-finish message — a stuck orchestrator may
          // have left PRs/worktrees behind (same recovery guidance as the
          // merge-queue/review-loop idle-timeout paths).
          captureWorktreeDiff(cwd, agentDir).catch(() => {});
          finish({
            success: false,
            exitCode: 124,
            error: `TUI agent exceeded its max runtime of ${Math.round(tuiConfig.maxRuntimeMs / 60000)}min — the provider/CLI likely hung (a stalled request keeps the working counter repainting so the idle reaper never fires); check for open or merged-but-uncleaned PRs and finish them manually.`,
            reason: 'max-runtime-timeout',
          }).catch(err => {
            emitLog('error', `Failed to finalize TUI agent ${agentId} at max-runtime: ${err.message}`, { agentId });
          });
        }, tuiConfig.maxRuntimeMs);
      }
    };

    // Confirms the TUI actually received the paste before we submit. The
    // paste-commit MARKER ([Pasted text #N]) is authoritative — Claude Code
    // collapses a multi-line paste into that chip and HIDES the body text, so a
    // literal text check false-negatives on every multi-line prompt (real
    // incident 2026-07-05: agent-656efa6e et al. failed `paste-not-rendered`
    // despite the marker being present). Literal-text verification is only the
    // fallback for the markerless path — see isPasteConfirmed.
    const pasteConfirmed = (buffer) =>
      isPasteConfirmed(buffer, { verifiablePrefix, promptMarkerCount });

    // Markerless AND the prompt text never rendered → the paste was swallowed by
    // a still-initializing TUI (issue #2192). Retry, then fail.
    //
    // Budget is boot-aware: once codex's MCP-boot banner has been seen (mcpBoot
    // active), the boot can legitimately run for tens of seconds — up to ~2min
    // for a node_repl/npx server — during which EVERY paste is swallowed. Switch
    // from the fixed 3-attempt/exponential-backoff budget to a TIME budget
    // (MCP_BOOT_PASTE_DEADLINE_MS from the first paste) with a fixed cadence, so
    // retries outlast the boot and the paste finally lands once the input box is
    // live (incident 2026-07-10, agent-c5a26b40). No MCP boot → unchanged.
    const retryOrFailPaste = () => {
      if (finalized) return;
      const bootActive = mcpBoot.active;
      const withinBudget = bootActive
        ? (Date.now() - firstPasteStartedAt) < MCP_BOOT_PASTE_DEADLINE_MS
        : attemptNum < PASTE_RETRY_MAX_ATTEMPTS;
      if (withinBudget) {
        const retryDelayMs = bootActive
          ? MCP_BOOT_PASTE_RETRY_DELAY_MS
          : PASTE_RETRY_BASE_DELAY_MS * Math.pow(2, attemptNum - 1);
        const bootNote = bootActive
          ? ` (waiting for ${tuiConfig.command} MCP servers to finish booting)`
          : '';
        appendLine(`⚠️ Paste verification failed — prompt text not found in buffer, retrying in ${retryDelayMs}ms${bootNote}`);
        setTimeout(() => {
          if (finalized) return;
          attemptPaste(reason);
        }, retryDelayMs);
        return;
      }
      // Budget exhausted — fail the agent, naming the MCP-boot cause when that's
      // what kept the paste from landing so the operator knows to check their
      // codex config rather than chasing a phantom paste-timing bug.
      const bootSecs = Math.round(MCP_BOOT_PASTE_DEADLINE_MS / 1000);
      const summary = bootActive
        ? `${tuiConfig.command} did not finish booting its MCP servers within ${bootSecs}s, so the prompt was never delivered. A slow or hung MCP server in your ~/.codex config (e.g. playwright via npx, or a node_repl) blocks codex from accepting input — disable or fix it, or remove it for headless runs.`
        : `${tuiConfig.command} was still initializing and the paste was silently swallowed. The prompt never appeared in the TUI buffer after ${PASTE_RETRY_MAX_ATTEMPTS} attempts.`;
      appendLine(
        bootActive
          ? `❌ Paste never landed after ${bootSecs}s of waiting for MCP servers to boot — prompt never rendered`
          : `❌ Paste verification failed after ${PASTE_RETRY_MAX_ATTEMPTS} attempts — prompt never rendered`,
      );
      finishStartupFailure('paste-not-rendered', summary)
        .catch(err => emitLog('error', `TUI agent ${agentId} finishStartupFailure(paste-not-rendered) failed: ${err?.message || err}`, { agentId }));
    };

    const pasteSentAt = Date.now();
    pasteEnterTimer = setInterval(() => {
      if (finalized) {
        clearInterval(pasteEnterTimer);
        pasteEnterTimer = null;
        postPasteBuffer = null;
        return;
      }
      const elapsed = Date.now() - pasteSentAt;
      const markerSeen = countPasteMarkers(postPasteBuffer) > promptMarkerCount;
      // Submit when EITHER the paste-commit marker appears (preferred) or
      // the fallback window elapses (covers small prompts that don't render
      // the marker).
      if ((markerSeen && elapsed >= PASTE_TO_ENTER_MIN_DELAY_MS)
        || elapsed >= PASTE_TO_ENTER_FALLBACK_MS) {
        clearInterval(pasteEnterTimer);
        pasteEnterTimer = null;
        // Capture the buffer before clearing, then confirm the paste (issue #2192).
        const commitBuffer = postPasteBuffer || '';
        postPasteBuffer = null;
        // Marker present (or text already visible, or nothing to verify) → the
        // paste landed; submit now. Trusting the marker here is what fixes the
        // multi-line-collapse false negative — Claude hides the pasted body text.
        if (pasteConfirmed(commitBuffer)) {
          submitEnter();
          return;
        }
        // Markerless AND text not visible yet: give the prompt a short window to
        // render (a late marker also counts as confirmed) before declaring it
        // swallowed. Resume accumulation for the verification window.
        let verifyBuffer = commitBuffer;
        const verifyStartedAt = Date.now();
        postPasteBuffer = commitBuffer;
        pasteVerifyTimer = setInterval(() => {
          if (finalized) {
            clearInterval(pasteVerifyTimer);
            pasteVerifyTimer = null;
            postPasteBuffer = null;
            return;
          }
          verifyBuffer = postPasteBuffer || verifyBuffer;
          const verifyElapsed = Date.now() - verifyStartedAt;
          const confirmed = pasteConfirmed(verifyBuffer);
          // Submit once confirmed, or give up and retry/fail when the window expires.
          if (confirmed || verifyElapsed >= PASTE_VERIFY_WINDOW_MS) {
            clearInterval(pasteVerifyTimer);
            pasteVerifyTimer = null;
            postPasteBuffer = null;
            if (confirmed) submitEnter();
            else retryOrFailPaste();
          }
        }, PASTE_VERIFY_POLL_MS);
      }
    }, PASTE_MARKER_POLL_MS);
  };

  // Claude Code renders a startup banner and (in unfamiliar folders) a
  // folder-trust gate before its input box exists, and the old "saw output then
  // went idle" heuristic fired during those lulls — pasting the prompt into the
  // banner / trust menu / a returned shell. For claude we instead gate on its
  // POSITIVE input-ready footer (see createInputReadyTracker), auto-confirm the
  // trust gate, and NEVER blind-paste: if the prompt never appears we surface a
  // failure. Other TUI providers keep the original idle heuristic + deadline.
  //
  // Antigravity (agy) gets the SAME positive gate (issue #2705). agy's TUI also
  // enables bracketed-paste mode (`ESC[?2004h`) exactly when its input box is
  // live — the identical signal createInputReadyTracker keys on — but the old
  // blind-paste path fired into agy's still-initializing banner, so the prompt
  // never landed and the agent sat idle at an empty prompt until it was reaped
  // having done nothing. agy has no folder-trust gate (`needsTrust` stays false,
  // so the auto-confirm branch below is inert for it); and if agy ever fails to
  // signal ready, the requireInputReady path fails fast with a surfaced startup
  // error instead of silently idle-reaping.
  const requireInputReady = isClaudeCommand(tuiConfig.command) || isAntigravityCommand(tuiConfig.command);
  // sendPrompt / finishStartupFailure are async and dispatched fire-and-forget
  // from the interval below. A setInterval callback can't await, and an
  // unhandled rejection there (e.g. a finalizeAgent throw inside finish())
  // would crash the process — the callback-boundary hazard CLAUDE.md calls out.
  // Wrap each floating call so a rejection is logged, not thrown.
  const safeSendPrompt = (reason) => sendPrompt(reason).catch((err) =>
    emitLog('error', `TUI agent ${agentId} sendPrompt(${reason}) failed: ${err?.message || err}`, { agentId }));
  const safeFinishStartupFailure = (reason, summary) => finishStartupFailure(reason, summary).catch((err) =>
    emitLog('error', `TUI agent ${agentId} finishStartupFailure(${reason}) failed: ${err?.message || err}`, { agentId }));
  const promptTimer = setInterval(() => {
    if (finalized || promptSentAt) {
      clearInterval(promptTimer);
      return;
    }
    const now = Date.now();
    const elapsed = now - startedAt;

    if (requireInputReady) {
      // Auto-confirm claude's first-run "trust this folder?" gate (default is
      // "Yes, I trust") so claims can run in fresh worktrees. Send Enter once.
      if (inputReady.needsTrust && !trustAccepted) {
        trustAccepted = true;
        shellService.writeToSession(sessionId, '\r');
        appendLine(`📟 Auto-confirmed claude folder-trust prompt for session ${sessionId.slice(0, 8)}`);
        return;
      }
      if (inputReady.ready && elapsed >= tuiConfig.promptDelayMs) {
        safeSendPrompt('input-ready');
        clearInterval(promptTimer);
        return;
      }
      // Never blind-paste for claude: if the input prompt never showed within
      // the cap, finalize a startup failure with the captured output.
      if (elapsed >= TUI_INPUT_READY_DEADLINE_MS) {
        clearInterval(promptTimer);
        safeFinishStartupFailure(
          'tui-not-ready',
          `${tuiConfig.command} did not present an input prompt within ${Math.round(TUI_INPUT_READY_DEADLINE_MS / 1000)}s, so no prompt was sent.`,
        );
      }
      return;
    }

    if (elapsed >= PASTE_DEADLINE_MS) {
      safeSendPrompt('fallback');
      clearInterval(promptTimer);
      return;
    }
    if (elapsed < tuiConfig.promptDelayMs) return;
    if (firstOutputAt === null) return;
    if (now - lastOutputAt < READY_IDLE_THRESHOLD_MS) return;
    safeSendPrompt('ready');
    clearInterval(promptTimer);
  }, READY_POLL_INTERVAL_MS);

  const idleTimer = setInterval(() => {
    if (!promptSentAt || finalized) return;
    // Don't reap a session that just received real input — a human pasting
    // into the Shell page, or our own auto-paste. A big bracketed paste can
    // sit in a silent reflow/commit window with no PTY output yet, which
    // looks identical to "idle" to this timer otherwise (same class of bug
    // as #2074/#2084, but for a live paste instead of a merge-queue/
    // review-loop wait). Gated on INPUT RECENCY, not "is a socket attached" —
    // a regular (non-external) Shell session keeps its socket bound after the
    // viewer navigates away (only external one-shot runs get released via
    // `shell:release-views`), so "attached" would permanently suppress
    // idle-complete for any agent glanced at once in the Shell UI. Recency
    // naturally expires once nobody is actually interacting.
    if (sessionId) {
      const lastInputAt = shellService.getLastInputAt(sessionId);
      if (lastInputAt && Date.now() - lastInputAt < PASTE_INPUT_GRACE_MS) return;
    }
    const runtime = Date.now() - promptSentAt;
    const idle = Date.now() - lastOutputAt;
    if (runtime < DEFAULT_TUI_MIN_RUNTIME_MS) return;
    // We track post-paste activity via lastOutputAt instead of parsed-line
    // counts because per-line PTY capture is intentionally disabled for TUI
    // agents — see handleData.
    if (lastOutputAt <= promptSentAt) return;
    // While the agent is in a swarm Phase C serialized merge queue, per-PR CI
    // re-runs go silent for minutes at a time; extend the idle grace so a
    // still-working orchestrator isn't reaped mid-merge (issue #2074). The
    // extended window still bounds a genuinely-dead orchestrator's reap.
    const effectiveIdleTimeoutMs = mergeQueue.active
      ? Math.max(tuiConfig.idleTimeoutMs, MERGE_QUEUE_IDLE_TIMEOUT_MS)
      : reviewLoop.active
        ? Math.max(tuiConfig.idleTimeoutMs, REVIEW_LOOP_IDLE_TIMEOUT_MS)
        : tuiConfig.idleTimeoutMs;
    if (idle >= effectiveIdleTimeoutMs) {
      // Reaped AFTER the extended merge-queue grace elapsed: the orchestrator
      // almost certainly died mid-merge with PRs opened/merged-but-uncleaned.
      // Surface it as a needs-manual-finish FAILURE rather than the silent
      // `status: completed` that hid the half-done merge queue (issue #2074).
      if (mergeQueue.active) {
        finish({
          success: false,
          exitCode: 1,
          error: `TUI agent idled out after ${Math.round(effectiveIdleTimeoutMs / 60000)}min in the merge queue — it likely died mid-merge; check for open or merged-but-uncleaned PRs and finish them manually.`,
          reason: 'merge-queue-idle-timeout',
        }).catch(err => {
          emitLog('error', `Failed to finalize TUI agent ${agentId}: ${err.message}`, { agentId });
        });
        return;
      }
      // Reaped AFTER the extended review-loop grace elapsed: a reviewer
      // (copilot/codex/agy/claude/ollama/@<login>) likely hung, or the wait
      // simply exceeded budget. Surface it as a needs-manual-finish FAILURE
      // rather than the silent `status: completed` that let PR #2084 sit
      // open+unmerged for hours while agent-61508f36 looked "done".
      if (reviewLoop.active) {
        finish({
          success: false,
          exitCode: 1,
          error: `TUI agent idled out after ${Math.round(effectiveIdleTimeoutMs / 60000)}min waiting inside the multi-reviewer loop — a reviewer may have hung or the wait exceeded budget; check the PR's review/merge state and finish manually.`,
          reason: 'review-loop-idle-timeout',
        }).catch(err => {
          emitLog('error', `Failed to finalize TUI agent ${agentId}: ${err.message}`, { agentId });
        });
        return;
      }
      // Distinguish a real (sentinel-less) completion from a never-submitted
      // prompt that just idled out. `lastOutputAt > promptSentAt` only proves
      // the TUI repainted SOMETHING — banner/status chrome churns even with the
      // prompt sitting unsent. The #1229 failure mode (prompt never submitted,
      // zero work done) must be recorded as a FAILURE so the orchestrator doesn't
      // treat a no-op run as done — but the work-counter signal exists ONLY on
      // Claude Code / Codex. On a provider that never renders the counter
      // (Antigravity/Gemini), its absence proves nothing, so we must preserve the
      // original permissive idle-complete=success there (else every sentinel-less
      // completion on those providers would falsely fail). So: downgrade to
      // failure only when the provider DOES render the counter and we never saw
      // it advance.
      //
      // Issue #2191 extension: even when workActivity.active is true, the model
      // may have "worked" (made tool calls, printed output) without actually
      // writing any files — e.g. rambled, made invalid tool calls, or hit an
      // error. Check the worktree for evidence of actual changes: if the
      // worktree is clean (no git status changes), mark as failed so the
      // orchestrator doesn't treat a no-op as done. Capture the diff into the
      // agent archive dir before cleanup so post-mortems can see what (if
      // anything) was left behind.
      const noWorkButCounterExpected = !workActivity.active && rendersWorkCounter(commandName);
      if (noWorkButCounterExpected) {
        // Capture any uncommitted changes for post-mortem analysis
        captureWorktreeDiff(cwd, agentDir).catch(() => {});
        finish({
          success: false,
          exitCode: 1,
          error: 'TUI agent idled out with no sign of work — the prompt likely never submitted (no working indicator ever appeared after submit).',
          reason: 'idle-no-activity',
        }).catch(err => {
          emitLog('error', `Failed to finalize TUI agent ${agentId}: ${err.message}`, { agentId });
        });
      } else {
        // Gate idle-complete success on evidence of work in the worktree.
        // An agent that shows activity counters but makes no file changes
        // (rambled, invalid tool calls, hit an error) should fail, not succeed.
        (async () => {
          const hasChanges = await worktreeHasChanges(cwd);
          // Capture any uncommitted changes for post-mortem analysis regardless
          // of outcome — the diff is useful even on success for debugging.
          await captureWorktreeDiff(cwd, agentDir).catch(() => {});
          if (!hasChanges) {
            finish({
              success: false,
              exitCode: 1,
              error: 'TUI agent idled out with zero uncommitted file changes — the model may have processed but produced no work.',
              reason: 'idle-no-changes',
            }).catch(err => {
              emitLog('error', `Failed to finalize TUI agent ${agentId}: ${err.message}`, { agentId });
            });
          } else {
            finish({ success: true, exitCode: 0, reason: 'idle-complete' }).catch(err => {
              emitLog('error', `Failed to finalize TUI agent ${agentId}: ${err.message}`, { agentId });
            });
          }
        })().catch(err => {
          emitLog('error', `TUI agent ${agentId} idle-complete check failed: ${err.message}`, { agentId });
          // Fall back to success if the check itself failed (don't block on git)
          finish({ success: true, exitCode: 0, reason: 'idle-complete' }).catch(() => {});
        });
      }
    }
  }, 5000);

  // Sentinel-file watcher. The agent's prompt instructs it to write
  // .agent-done in the workspace after running /simplify + /do:pr and then
  // stop (it does NOT `/quit` — that is a UI command it can't invoke). This
  // poll is the PRIMARY finalize path: it fires finish() within DONE_POLL_
  // INTERVAL_MS of the sentinel appearing, and finish()'s own cleanup kills
  // the still-running TUI session. The actual sentinel READ happens in finish()
  // (via ingestDoneSentinel) so the resolution is captured no matter which path
  // finalizes. Idle-complete is the fallback for a non-complying agent that
  // never writes the sentinel.
  const doneSentinelTimer = doneSentinelPath ? setInterval(() => {
    try {
      if (finalized) return;
      if (!existsSync(doneSentinelPath)) return;
      clearInterval(doneSentinelTimer);
      finish({ success: true, exitCode: 0, reason: 'agent-signaled-done' }).catch(err => {
        emitLog('error', `Failed to finalize TUI agent ${agentId} after sentinel: ${err.message}`, { agentId });
      });
    } catch (err) {
      console.error(`❌ doneSentinelTimer interval callback failed: ${err.message}`);
    }
  }, DONE_POLL_INTERVAL_MS) : null;

  activeAgents.set(agentId, {
    process: ptyProcess || { kill: () => shellService.killSession(sessionId) },
    taskId: task.id,
    startedAt: Date.now(),
    runId,
    pid,
    providerId: provider.id,
    executionId,
    laneName,
    tuiSessionId: sessionId,
    idleTimer,
    promptTimer,
    doneSentinelTimer
  });

  // Identify which TUI binary this session is running so consumers can gate
  // features that aren't universal — e.g. only Claude Code supports
  // bracketed-paste injection of post-spawn BTW messages; codex/gemini/lm-studio
  // TUIs don't.
  const tuiKind = commandName.toLowerCase();
  await updateAgent(agentId, {
    pid,
    metadata: {
      phase: 'working',
      executionMode: 'tui',
      tuiSessionId: sessionId,
      tuiCommand: tuiConfig.commandLine,
      tuiKind,
      tuiIdleTimeoutMs: tuiConfig.idleTimeoutMs,
      tuiMaxRuntimeMs: tuiConfig.maxRuntimeMs
    }
  });

  appendLine(`📟 TUI session started: ${sessionId.slice(0, 8)} (${tuiConfig.commandLine})`);
  appendLine(`💡 Open the Shell tab for live TUI output — this panel only logs lifecycle events.`);
  return agentId;
}
