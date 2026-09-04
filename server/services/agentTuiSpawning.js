/**
 * Agent TUI Spawning
 *
 * Runs CoS agents inside an interactive PTY-backed shell session. This is for
 * providers whose useful interface is a terminal UI rather than a headless CLI
 * or HTTP API.
 */

import { join } from 'path';
import { existsSync } from 'fs';
import { readFile, rm } from 'fs/promises';
import * as shellService from './shell.js';
import { emitLog } from './cosEvents.js';
import { updateAgent } from './cosAgentLifecycle.js';
import { createOutputSpooler } from './agentTuiSpawning/outputSpooler.js';
import { resolveErrorAnalysis } from './agentTuiSpawning/finalizeHelpers.js';
import { finalizeAgent, releaseAgentLane } from './agentFinalization.js';
import { activeAgents, userTerminatedAgents, pausedAgents, consumePausedAgentExit, registerSpawnedAgent, unregisterSpawnedAgent } from './agentState.js';
import { PATHS, watchForFile } from '../lib/fileUtils.js';
import { resolveAgentCliCwd } from '../lib/spawnCwd.js';
import { doneSentinelName, doneSentinelPath as resolveDoneSentinelPath, parseSentinelPayload } from '../lib/agentSentinel.js';
import { shouldAbandonForHostShutdown, HOST_SHUTDOWN_REASON } from '../lib/hostShutdown.js';
import { SENTINEL_COMPLETION_MARKER } from '../lib/agentOutputMarkers.js';
import { PR_CREATION, prClaimWasVerified, resolvePrCompletion, resolvePrCreation, leavesPrForHuman } from '../lib/prDisposition.js';
import { canTypeSlashCommands, agentOwnsPrWorkflow } from '../lib/slashdoInvocation.js';
import { mergeGateOwed, resolveMergeGateVerdict, buildMergeGateReprompt } from '../lib/mergeGateContract.js';
import { probePrForBranch } from './prProbe.js';
import { PROVIDER_TYPES } from '../lib/aiToolkit/constants.js';
import { normalizeReviewers } from '../lib/validation.js';
import * as git from './git.js';
import { resolveReviewLoopOptions } from './codeReview.js';
import { spawnTuiSessionViaRunner, classifyRunnerSpawnFailure, RUNNER_SPAWN_REFUSED, RUNNER_SPAWN_AMBIGUOUS } from './cosRunnerClient.js';
import { resolveInteractiveShell } from '../lib/interactiveShellResolver.js';
import { formatShellCommandLine } from '../lib/shellCd.js';
import { buildCodexAgentThreadArgs, isClaudeCommand, applyLeanClaudeArgs, providerSuppliesGithubToken } from '../lib/providerModels.js';
import { createStreamingAnsiStripper, stripAnsi } from '../lib/ansiStrip.js';
import { createImmediateFallbackSignalDetector, createLocalRuntimeOomDetector } from '../lib/aiToolkit/errorDetection.js';
import { isAntigravityCommand } from '../lib/antigravity.js';
import { isCodexCommand } from '../lib/codex.js';
import {
  DEFAULT_TUI_PROMPT_DELAY_MS,
  READY_POLL_INTERVAL_MS,
  READY_IDLE_THRESHOLD_MS,
  PASTE_MARKER_POLL_MS,
  countPasteMarkers,
  createSelfClearingSignalGate,
  createOomNudgeGate,
  OOM_NUDGE_MAX_ATTEMPTS,
  OOM_NUDGE_TEXT,
  createMcpBootTracker,
  MCP_BOOT_PASTE_DEADLINE_MS,
  MCP_BOOT_PASTE_RETRY_DELAY_MS,
  createInputReadyTracker,
  AGY_INPUT_READY_PATTERN,
  PASTE_TO_ENTER_MIN_DELAY_MS,
  PASTE_TO_ENTER_FALLBACK_MS,
  scheduleSubmitEnters,
  PASTE_DEADLINE_MS,
  TUI_INPUT_READY_DEADLINE_MS,
  inferTuiCommand,
  applyCommandDefaults,
  PASTE_VERIFY_POLL_MS,
  PASTE_VERIFY_WINDOW_MS,
  PASTE_RETRY_MAX_ATTEMPTS,
  PASTE_RETRY_BASE_DELAY_MS,
  extractVerifiablePromptPrefix,
  isPasteConfirmed,
  SUBMIT_KEY,
  detectMissingTuiBinary,
} from '../lib/tuiHandshake.js';
import { buildVendorSpawnConfig, injectTuiModelAndEffort, supportsTuiPublicReviewPosture } from '../lib/providerVendors.js';
import { isPublicReviewRestrictedProfile, publicReviewPostureForProfile } from '../lib/agentExecutionProfiles.js';
import { agentGuardEnv } from '../lib/agentGuard/index.js';
import { buildCliChildEnv, composeProviderEnv } from '../lib/cliChildEnv.js';
import { cliProviderAuthDescriptor } from '../lib/processEnv.js';
import { ensureOllamaAgentContext } from './ollamaAgentContext.js';
import { isOllamaBackedProvider } from './providers.js';
import { shellHasLiveChild } from '../lib/shellLivenessProbe.js';
import { appendRunEvent } from './agentRunEventLog.js';

// Agent-specific timing/lifecycle constants (not shared with the one-shot
// runner — agents stay alive much longer and write a sentinel file when done).
const PROVIDER_SIGNAL_POLL_MS = 5000;

// Output buffering/spooling (createOutputSpooler) and failure-analysis /
// worktree-inspection and failure-analysis helpers (resolveErrorAnalysis,
// RAW_TAIL_ANALYSIS_BYTES) live in
// ./agentTuiSpawning/ so spawnTuiAgent stays a thin orchestrator.

// Sentinel-file watching. TUI agents write `.agent-done` in their workspace
// when they've finished /simplify + /do:pr (or /do:push) — watch for it here
// so the agent gets cleanly finalized as soon as the work is done, without
// waiting for a shell exit or repeatedly touching the filesystem.
// The filename is per agent instance — see doneSentinelName in ../lib/agentSentinel.js.

/**
 * What kind of PTY a TUI run gets. Resolved ONCE per run and threaded, rather
 * than re-derived wherever it matters: two consumers wire the prompt handshake
 * BEFORE the spawn happens, and a predicate that silently disagreed with the
 * branch actually taken fails by never delivering the prompt — no error, on a
 * live run.
 *
 *   'runner'      — the CoS Runner owns the PTY, in another process.
 *   'direct'      — this process pty.spawns the provider binary itself.
 *   'login-shell' — an interactive login shell with the CLI typed into it.
 *
 * A public-content stage is `direct` because a login shell would run the
 * operator's rc file inside its allowlisted environment (#6159). It is never
 * `runner`: the runner builds its own child env, which would drop that
 * allowlist, so `agentLifecycle.js` forces those stages direct-only and
 * `createAgentTuiSession` fails closed if one arrives anyway.
 *
 * This is a separate axis from `isPublicReviewRestrictedProfile` itself, which
 * answers a different question (is the env COMPLETE or a delta?) — the runner
 * case is the proof they are not the same axis.
 */
export function resolveTuiLaunchShape({ useDurableRunner = false, safetyProfile = null } = {}) {
  if (useDurableRunner) return 'runner';
  return isPublicReviewRestrictedProfile(safetyProfile) ? 'direct' : 'login-shell';
}

/**
 * Open the agent TUI's PTY and pair the returned session id with its underlying
 * pty process, so callers don't have to make a second `getSessionProcess` call
 * inline. Centralizes the agent-side defaults (kind, label, initialCommand).
 *
 * Which of the three PTY shapes it opens is `resolveTuiLaunchShape`'s call.
 *
 * Returns `{ sessionId, ptyProcess, pid }`. When the shell service fails
 * to create the session, `sessionId` is null and the caller is expected
 * to bail out via its `finish` path.
 */
export async function createAgentTuiSession({
  agentId,
  taskId,
  provider,
  model,
  tuiConfig,
  cwd,
  forgeTokenEnv = {},
  doneSentinelPath = null,
  useDurableRunner = false,
  safetyProfile = null,
  onData,
  onExit,
  onInitialCommandSent,
}) {
  const restricted = isPublicReviewRestrictedProfile(safetyProfile);
  // A public-content stage's PTY starts from the SAME environment its headless
  // sibling gets — no forge credential, no SSH config, no cloud key, no
  // arbitrary provider var — so it calls the very builder the headless path
  // uses rather than re-deriving the profile→allowlist mapping here.
  //
  // The two branches produce DIFFERENT KINDS of value, which is why they route
  // to different spawn entry points below. `buildCliChildEnv` returns a COMPLETE
  // environment, so a restricted stage goes to `spawnCommandSession`, which
  // unions nothing underneath it — and which is also what removes the login
  // shell, so the operator's rc file can no longer run between this allowlist
  // and the provider and re-export whatever it likes (#6159). The ordinary
  // branch is a DELTA: `createShellSession` unions it onto `buildSafeEnv`.
  const env = restricted
    ? buildCliChildEnv({ before: forgeTokenEnv, provider, model, cwd, guard: true, safetyProfile })
    : { ...composeProviderEnv({ before: forgeTokenEnv, provider, model }), ...agentGuardEnv() };
  // How this session identifies itself in the Shell UI and the session registry.
  // Identical for all three spawn shapes below — an attached human sees the same
  // tab whichever one opened the PTY.
  const sessionOptions = {
    cwd,
    kind: 'agent-tui',
    agentId,
    label: `${provider.name} ${agentId}`,
    command: tuiConfig.commandLine,
  };
  const launchShape = resolveTuiLaunchShape({ useDurableRunner, safetyProfile });
  let sessionId;
  if (launchShape === 'runner') {
    // The CoS runner is a shared long-lived process and builds its own child
    // env from ITS ambient environment (`/spawn-tui` → `buildCliChildEnv`
    // without a profile), so a public-content stage routed through it would
    // silently lose the allowlist resolved above. `agentLifecycle.js` forces
    // every such stage direct-only (`dispatchUseRunner`); fail closed here so
    // that stays true by construction rather than by remembering it.
    if (restricted) {
      throw new Error(`Public-content stage cannot spawn via the CoS runner (profile '${safetyProfile}')`);
    }
    // The runner launches the TUI command directly (there is no intermediate
    // login-shell readiness probe), so output can arrive before the spawn HTTP
    // response. Open the readiness gate before handing off to avoid discarding
    // the TUI's first bracketed-paste/input-ready signals.
    onInitialCommandSent?.();
    const session = await spawnTuiSessionViaRunner({
      agentId,
      taskId,
      command: tuiConfig.command,
      args: tuiConfig.args,
      workspacePath: cwd,
      envVars: env,
      providerAuth: cliProviderAuthDescriptor(provider),
      doneSentinelPath,
      onData,
      onExit,
    });
    shellService.registerExternalSession(session.sessionId, session.ptyProcess, sessionOptions);
    // The runner owns this PTY, so it already returns the pty/pid pair the tail
    // below would otherwise have to look up locally.
    return session;
  }

  if (launchShape === 'direct') {
    // Launch the vendor recipe AS the PTY — no hosting shell, so no rc file runs
    // between the allowlist above and the provider (#6159). `env` is already the
    // COMPLETE environment, which is what `spawnCommandSession` takes.
    //
    // `spawnCommandSession` resolves the executable before it spawns and throws
    // `Command executable unavailable: …` when it cannot — which the caller's
    // catch maps to `command-not-found`. That pre-flight has to live in the
    // launcher: a PTY has no shell to print "command not found", so handleData's
    // output-driven probe can never fire on this path.
    //
    // No shell readiness probe fires `onInitialCommandSent` here, so open the
    // paste gate before the spawn — exactly as the runner branch above does —
    // or the TUI's first bracketed-paste/input-ready bytes are discarded.
    onInitialCommandSent?.();
    sessionId = shellService.spawnCommandSession(tuiConfig.command, tuiConfig.args, {
      ...sessionOptions,
      env,
      onData,
      onExit,
    });
  } else {
    // This shell exists only to host the CoS TUI. `exitWithCommand` makes it
    // follow the TUI's lifetime and preserve the TUI exit status; otherwise the
    // login shell returns to its prompt when the provider exits and the spawner
    // cannot observe completion until the wall-clock backstop fires. The wrapper
    // is dialect-specific, so shell.js renders it once it knows which shell the
    // session got (see lib/shellExit.js).
    sessionId = shellService.createShellSession(null, {
      ...sessionOptions,
      initialCommand: tuiConfig.commandLine,
      exitWithCommand: true,
      // Wait until the shell can actually RUN commands before injecting the CLI
      // command — a fixed delay races a heavy interactive shell and the launched
      // TUI can fall straight back to a half-loaded prompt (see shell.js
      // waitForPromptReady, which proves readiness with a round-trip probe).
      waitForPromptReady: true,
      // Fires when the CLI command is actually injected. We start observing
      // claude's input-readiness only after this so the readiness probe's own
      // shell activity can't prematurely open the paste gate.
      onInitialCommandSent,
      // A DELTA, not a full env — buildSafeEnv inside createShellSession supplies
      // the base and shell.js does the PWD pin. composeProviderEnv owns the layer
      // order (forgeTokenEnv before provider.envVars so an explicit provider
      // GH_TOKEN still wins; the OpenCode declared-models map after it, overriding
      // the static config). forgeTokenEnv has to be threaded in explicitly because
      // buildSafeEnv strips GH_TOKEN from the inherited env (resolveForgeTokenEnv).
      //
      // agentGuardEnv() is spread last so the pm2 shim wins over any provider PATH.
      // It reads PATH from process.env rather than the composed env — correct here
      // and NOT what buildCliChildEnv's `guard` does, because this is an overlay
      // whose real base env is assembled downstream. Only AI agent sessions get
      // the shim; the user's own Shell page does not.
      env,
      onData,
      onExit,
    });
  }

  if (!sessionId) {
    return { sessionId: null, ptyProcess: null, pid: null };
  }

  const ptyProcess = shellService.getSessionProcess(sessionId);
  return { sessionId, ptyProcess, pid: ptyProcess?.pid || null };
}

export function buildTuiSpawnConfig(provider, model, {
  systemPromptFile = null,
  effort = null,
  maxConcurrentThreads = null,
  safetyProfile = null,
  shell = resolveInteractiveShell(),
} = {}) {
  // A public-content stage's argv is the vendor's maintained recipe, never the
  // generic assembly below — that path forwards `provider.args` and applies
  // `applyCommandDefaults`, either of which can hand a contributor-controlled
  // review a saved `--dangerously-skip-permissions`. `tui: true` tells the
  // recipe to drop only the flags that require `--print` and keep every
  // enforcement flag. Fail closed when the pairing declares no attachable recipe: the
  // caller is supposed to have asked `supportsTuiPublicReviewPosture` first, so
  // reaching this is a routing bug and must not silently open a PTY whose
  // posture is decorative.
  const posture = publicReviewPostureForProfile(safetyProfile);
  if (posture) {
    if (!supportsTuiPublicReviewPosture(provider, posture)) {
      throw new Error(`Provider '${provider?.id || provider?.command || 'unknown'}' cannot run an attachable ${posture} session`);
    }
    const recipe = buildVendorSpawnConfig(provider, {
      effectiveModel: model,
      effort,
      maxConcurrentThreads,
      systemPromptFile,
      safetyProfile,
      tui: true,
    });
    return {
      command: recipe.command,
      args: recipe.args,
      commandLine: formatShellCommandLine(recipe.command, recipe.args, shell),
      promptDelayMs: provider?.tuiPromptDelayMs || DEFAULT_TUI_PROMPT_DELAY_MS,
    };
  }
  const command = provider?.command || inferTuiCommand(provider?.id);
  const baseArgs = applyCommandDefaults(command, [...(provider?.args || [])]);
  // Model+effort injection (including the antigravity-validates-the-pair special
  // case) is shared with tuiHandshake.js#buildTuiInvocation via
  // providerVendors.js#injectTuiModelAndEffort, so the two spawn paths can't
  // drift — they already had once, on cursor, before #3618.
  let args = injectTuiModelAndEffort(command, baseArgs, provider, model, effort);
  if (isCodexCommand(command)) {
    args = [...args, ...buildCodexAgentThreadArgs(maxConcurrentThreads)];
  }
  // Lean mode for Ollama-backed claude sessions (no-op otherwise) — must come
  // before the system-prompt flag so `--bare` is present when the contract
  // file rides along.
  args = applyLeanClaudeArgs(provider, args, command);
  if (systemPromptFile && isClaudeCommand(command)) {
    args = [...args, '--append-system-prompt-file', systemPromptFile];
  }
  const commandLine = formatShellCommandLine(command, args, shell);

  return {
    command,
    args,
    commandLine,
    promptDelayMs: provider?.tuiPromptDelayMs || DEFAULT_TUI_PROMPT_DELAY_MS
  };
}

// Paste + submit-Enter retry machinery for spawnTuiAgent's
// prompt delivery. Separated from spawnTuiAgent so retries don't re-run the
// liveness guard or re-set the outer promptSentAt (see `sendPrompt` below) —
// the cluster spawnTuiAgent's own comments already described as one cohesive
// concern. Owns the paste-attempt counter, the post-paste accumulator, the
// paste-marker/verify timers, and the submit-Enter backstop timer.
//
// `isFinalized`/`markPromptSent`/`markPromptSubmitted` are accessors into
// spawnTuiAgent's own `finalized`/`promptSentAt`/`promptSubmittedAt` — those
// are read by handleData and the provider-signal timer well outside this
// cluster, so they stay owned by spawnTuiAgent and are threaded through rather
// than duplicated here. `finishStartupFailure`/`appendLine` are likewise
// spawnTuiAgent's own closures, passed in rather than re-implemented.
function createPasteRetryController({
  agentId,
  sessionId,
  pid,
  directLaunch,
  prompt,
  tuiConfig,
  mcpBoot,
  appendLine,
  isFinalized,
  markPromptSent,
  markPromptSubmitted,
  finishStartupFailure,
}) {
  // Markers already present in the prompt text itself (a transcript-analysis task
  // can echo `[Pasted text #N]` back). The paste-commit fast path must wait for
  // the TUI's OWN marker — i.e. the count to EXCEED this — so an echoed marker
  // doesn't fire the submit-Enters mid-reflow (issue #1229 review). STRIP the
  // prompt first: a pasted RAW transcript may carry the cursor-positioned marker
  // form (`[Pasted\x1b[11Gtext…`), which counts as 0 unstripped but echoes back as
  // the stripped `[Pastedtext#…]` (count 1) — so we must count the prompt the same
  // way the post-paste buffer is counted, or the gate undercounts and fires early.
  const promptMarkerCount = countPasteMarkers(stripAnsi(prompt));
  // Extract a verifiable prefix from the prompt for paste verification (issue #2192).
  // Computed once up front so retry attempts use the same verification target.
  const verifiablePrefix = extractVerifiablePromptPrefix(prompt);
  const pasteConfirmed = (buffer) =>
    isPasteConfirmed(buffer, { verifiablePrefix, promptMarkerCount });

  // Bounded post-paste accumulator. Lives from an attempt through its marker /
  // verification windows and any bounded retry backoff, so delayed TUI output
  // can still confirm the paste. Set to '' when an attempt fires; nulled when
  // paste detection resolves, the next attempt replaces it, or the run ends.
  let postPasteBuffer = null;
  let pasteEnterTimer = null;
  let pasteVerifyTimer = null;
  let pasteRetryTimer = null;
  let submitEnterTimer = null;
  let pasteAttempt = 0;
  // Wall-clock of the FIRST paste attempt — the anchor for the MCP-boot-aware
  // retry deadline (retries are time-bounded, not attempt-count-bounded, while
  // codex is still booting its MCP servers).
  let firstPasteStartedAt = null;
  // Guards re-entry the way the outer promptSentAt used to before this state
  // moved here — sendPrompt is this controller's only setter for it now.
  let sent = false;

  /**
   * Re-deliver text into the live session: the whole prompt while a
   * self-clearing provider signal's grace window is open (agy's
   * account-eligibility banner), or the short `continue` nudge that recovers a
   * turn a local-GPU OOM killed (see createOomNudgeGate).
   *
   * The banner is the REJECTION of the submission, not a spinner over an
   * in-flight one: agy discards the prompt, empties its composer and returns to
   * its idle footer, so nothing will generate until something re-asks — which is
   * also what the banner instructs ("try again shortly"). Re-pasting the WHOLE
   * prompt is correct precisely because the composer is empty.
   *
   * Lives here rather than in spawnTuiAgent because this controller owns
   * `submitEnterTimer`; leaving the handle in one scope and the re-delivery in
   * another is how you leak an Enter interval past finish(). Nothing here
   * re-runs paste VERIFICATION: the prompt already rendered once (its rejection
   * is why we're here), and routing back through `attemptPaste` would spend the
   * startup paste-retry budget and let a verification hiccup mid-handshake
   * finalize the run as `paste-not-rendered`.
   *
   * @returns {boolean} whether the paste actually went out (false once the
   *   session is gone — the caller must not claim a re-submission that didn't
   *   happen).
   */
  const resubmit = ({ text = prompt, label = 'provider-handshake resubmit' } = {}) => {
    if (isFinalized() || !sessionId) return false;
    // Overwriting a live handle would leak the previous attempt's Enter interval
    // past cancel(); pasteToSession returns a fresh one, or false once the
    // session is gone — which is also the "don't bother" answer, since the
    // grace window's deadline still owns the fail-over.
    if (submitEnterTimer) clearInterval(submitEnterTimer);
    const handle = shellService.pasteToSession(sessionId, text, {
      label: `[cosAgents] ${label}`,
    });
    submitEnterTimer = handle || null;
    return !!handle;
  };

  const sendPrompt = async (reason) => {
    if (isFinalized() || sent) return;
    sent = true;
    markPromptSent();
    // Liveness guard: the TUI command runs as a child of the persistent PTY
    // shell, so if it exited at startup (e.g. claude failing to enter
    // interactive mode) the PTY stays open and onExit never fires. Pasting now
    // would dump the bracketed-paste prompt into the bare shell — the wedged
    // `^[[200~ …` session. If the shell has no live child, the command is gone:
    // fail loudly with whatever it printed instead of pasting into the shell.
    //
    // A direct launch — runner mode, or a public-content stage spawned as its
    // own PTY (#6159) — has no launch shell: the TUI IS the PTY process. "Does
    // this pid have a live child?" is then the wrong question (claude may have
    // zero children at paste time) and a TUI exit kills the PTY, firing onExit.
    // Skip the probe there.
    if (!directLaunch && !(await shellHasLiveChild(pid))) {
      if (isFinalized()) return; // a real onExit may have finalized during the probe await
      await finishStartupFailure(
        'tui-exited-early',
        `${tuiConfig.command} exited at startup before the TUI was ready, so no prompt was sent.`,
      );
      return;
    }
    // Start the paste attempt — may be retried if verification fails (issue #2192).
    attemptPaste(reason);
  };

  const submitPaste = () => {
    if (pasteRetryTimer) {
      clearTimeout(pasteRetryTimer);
      pasteRetryTimer = null;
    }
    markPromptSubmitted();
    submitEnterTimer = scheduleSubmitEnters(
      () => shellService.writeToSession(sessionId, SUBMIT_KEY),
      () => isFinalized()
    );
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
    if (pasteRetryTimer) { clearTimeout(pasteRetryTimer); pasteRetryTimer = null; }
    // Start capturing post-paste output. Set BEFORE writing the paste so
    // every chunk that arrives in response gets appended. A failed verification
    // deliberately keeps it through retry backoff so late output is not lost.
    postPasteBuffer = '';
    shellService.writeToSession(sessionId, `\x1b[200~${prompt}\x1b[201~`);
    const attemptSuffix = attemptNum > 1 ? ` [attempt ${attemptNum}/${PASTE_RETRY_MAX_ATTEMPTS}]` : '';
    appendLine(`📟 Prompt pasted into TUI session ${sessionId.slice(0, 8)} (${reason})${attemptSuffix}`);

    // Confirms the TUI actually received the paste before we submit. The
    // paste-commit marker is authoritative — Claude Code and OpenCode can
    // collapse a multi-line paste into a chip and HIDE the body text, so a
    // literal text check false-negatives on multi-line prompts (real incident
    // 2026-07-05: agent-656efa6e et al. failed `paste-not-rendered` despite
    // Claude's marker being present). Literal-text verification is only the
    // fallback for the markerless path — see isPasteConfirmed.
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
      if (isFinalized()) return;
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
        // Keep the failed attempt's buffer live during the backoff. A busy TUI
        // can paint its authoritative paste marker only after the verification
        // window closes; dropping output in this gap made Codex stack duplicate
        // prompt chips, then falsely report that none had rendered.
        pasteRetryTimer = setTimeout(() => {
          pasteRetryTimer = null;
          if (isFinalized()) return;
          if (pasteConfirmed(postPasteBuffer || '')) {
            postPasteBuffer = null;
            submitPaste();
            return;
          }
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
      if (isFinalized()) {
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
          submitPaste();
          return;
        }
        // Markerless AND text not visible yet: give the prompt a short window to
        // render (a late marker also counts as confirmed) before declaring it
        // swallowed. Resume accumulation for the verification window.
        let verifyBuffer = commitBuffer;
        const verifyStartedAt = Date.now();
        postPasteBuffer = commitBuffer;
        pasteVerifyTimer = setInterval(() => {
          if (isFinalized()) {
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
            if (confirmed) {
              postPasteBuffer = null;
              submitPaste();
            } else {
              // Preserve the buffer through retry backoff so a delayed marker
              // can still confirm this paste instead of triggering a duplicate.
              postPasteBuffer = verifyBuffer;
              retryOrFailPaste();
            }
          }
        }, PASTE_VERIFY_POLL_MS);
      }
    }, PASTE_MARKER_POLL_MS);
  };

  // handleData's own hook: accumulates PTY output while a paste attempt is
  // awaiting its marker, verification, or retry backoff (see postPasteBuffer
  // above). A no-op the rest of the time.
  const ingestChunk = (stripped) => {
    if (postPasteBuffer === null || !stripped) return;
    postPasteBuffer += stripped;
    // The retry backoff used to be a blind spot: output was discarded after
    // verification failed and before the next attempt began. A late marker or
    // prompt echo still proves the existing paste landed, so submit it now and
    // cancel the duplicate retry.
    if (pasteRetryTimer && pasteConfirmed(postPasteBuffer)) {
      clearTimeout(pasteRetryTimer);
      pasteRetryTimer = null;
      postPasteBuffer = null;
      submitPaste();
    }
  };

  // Stop everything this controller armed. Safe to call unconditionally (a run
  // that ends before any paste was attempted just clears nulls) — see
  // stopRunMachinery's own comment for why every teardown site must go through
  // one chokepoint.
  const cancel = () => {
    if (pasteEnterTimer) { clearInterval(pasteEnterTimer); pasteEnterTimer = null; }
    if (pasteVerifyTimer) { clearInterval(pasteVerifyTimer); pasteVerifyTimer = null; }
    if (pasteRetryTimer) { clearTimeout(pasteRetryTimer); pasteRetryTimer = null; }
    if (submitEnterTimer) { clearInterval(submitEnterTimer); submitEnterTimer = null; }
    postPasteBuffer = null;
  };

  return { sendPrompt, resubmit, ingestChunk, cancel };
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
  leanMode = false,
  useDurableRunner = false,
  // The public-content execution profile this run enforces (null for an
  // ordinary agent task). Threaded through to the session so the PTY child
  // gets the same allowlisted environment its headless sibling would.
  safetyProfile = null,
}) {
  // The SAME call `createAgentTuiSession` branches on — resolved here because
  // the prompt handshake below is wired before the spawn happens. Everything
  // that is not a login shell has the provider binary as its own PTY process,
  // which is what both consumers below actually depend on.
  const directLaunch = resolveTuiLaunchShape({ useDurableRunner, safetyProfile }) !== 'login-shell';
  const outputFile = join(agentDir, 'output.txt');
  // Raw PTY bytes spool to disk continuously rather than accumulate in-memory.
  // A chatty TUI (token-tick repaints, status lines) emits hundreds of chunks
  // /sec; a per-run in-memory buffer would grow without bound on long agents
  // and the join-into-single-string at finalize would double peak RAM. The
  // disk file is appended in 250ms-debounced batches (same pattern as
  // `flushPendingLines` for parsed output — see AGENTS.md "High-frequency
  // state writes must batch"), and `analyzeAgentFailure` reads the file on
  // failure so it gets the full PTY stream regardless of run length.
  const rawFile = join(agentDir, 'raw.txt');
  // CD no-worktree tasks get an isolated scratch cwd so native AGENTS.md
  // discovery cannot reach the PortOS repo tree (#4650). Everyone else keeps
  // workspacePath, falling back to the repo root when it was omitted.
  const cwd = resolveAgentCliCwd({ workspacePath, fallbackRoot: PATHS.root, task, agentId });
  // The agent writes `.agent-done` in its workspace to signal completion (see
  // the sentinel watcher below) and then stops — it does NOT run `/quit` (that
  // is a UI command the agent can't invoke). The file watcher is the primary
  // finalize path; finish() also ingests the sentinel directly so the summary
  // is captured even if some other path (shell exit) finalizes first. Computed
  // up front so both the watcher AND finish() can read it (see ingestDoneSentinel).
  // Resolved from the shared helper, so this is byte-identical to the path the
  // prompt told the agent to write (see resolveSentinelPath).
  const doneSentinelPath = resolveDoneSentinelPath(cwd, agentId);
  // Every TUI that is a real coding harness drives its own push → PR → review
  // → merge, whether or not it can type `/do:pr` (#3733) — a Claude TUI runs
  // the slashdo command, codex/antigravity/grok/OpenCode run the plain
  // `git`/`gh` equivalent from the same prompt. Only a lean `--bare` session
  // still hands the lifecycle back to PortOS. Computed once up front (rather
  // than inside finish()) so the merge-gate contract check below and finish()
  // itself read the same answer.
  const taskOpenPR = isTruthyMetaFn(task.metadata?.openPR);
  const agentOwnsPR = taskOpenPR && agentOwnsPrWorkflow({ providerType: PROVIDER_TYPES.TUI, leanMode });
  // Does this run's own task shape say it owed a merge (#5876)? A run PortOS
  // still backstops (no PR at all, or a lean session) or one whose prompt
  // hands the PR to a human (JIRA, claim flow) never owed one, so the
  // contract check below is inert for those — see mergeGateContract.js.
  const mergeGateIsOwed = mergeGateOwed({ taskOpenPR, ownsPrWorkflow: agentOwnsPR, leaveOpen: leavesPrForHuman(task) });
  const promptPreview = prompt.replace(/\s+/g, ' ').slice(0, 100);
  const commandName = tuiConfig.command.split('/').pop();
  let finalized = false;
  // Synchronous re-entrancy guard for finish() — see its own comment for why
  // `finalized` alone isn't enough once the merge-gate check adds awaits
  // before it (#5876).
  let finishing = false;
  // A finish() call's args, dropped by the `finishing` guard while an earlier
  // call was still deciding whether to finalize — replayed if that call ends
  // up NOT finalizing (see finish()'s own comments on both).
  let pendingFinish = null;
  // Caps the merge-gate re-prompt (#5876) at once per run — a local closure
  // counter is enough: the check only ever runs from this same live process,
  // and a fresh spawn (a real retry) starts a fresh closure with its own flag.
  let mergeGateReprompted = false;
  let immediateFallbackAnalysis = null;
  const detectImmediateFallbackSignal = createImmediateFallbackSignalDetector();
  // Holds the wait-it-out window for a provider signal carrying a `graceMs`
  // (agy's account-eligibility banner). The provider-signal timer below resolves
  // its deadline and drives the re-submission cadence.
  const selfClearingGate = createSelfClearingSignalGate();
  // A local-GPU OOM kills the turn but leaves the TUI session holding the whole
  // conversation, so it is nudged to carry on rather than re-prompted — see
  // createOomNudgeGate for why this is a separate mechanism from the gate above.
  const detectLocalRuntimeOom = createLocalRuntimeOomDetector();
  const oomNudgeGate = createOomNudgeGate();
  // Guards ingestDoneSentinel to a single read. finish() is its only caller and
  // is itself guarded by `finalized`, so this is defensive — it pins the
  // read-at-most-once invariant at the helper.
  let sentinelIngested = false;
  let hasStartedWorking = false;
  // Guards the once-per-run `run.output` boundary (#4540). Kept separate from
  // `firstOutputAt` / `hasStartedWorking`: both of those are also set by paths
  // with no real output behind them, and a run that never spoke is exactly the
  // run this boundary must not vouch for.
  let firstOutputRecorded = false;
  /**
   * Record the run's first observed output, once. Called from the live PTY
   * stream and from the exit-tail fallback — a durable runner can deliver a
   * short-lived agent's entire output as `outputTail` on `tui:exit`, and that
   * output is no less real for having lost the race with process exit.
   *
   * Not awaited: the live caller is on the hot output path, and
   * `appendRunEvent` is a serialized queue that never rejects — blocking a
   * terminal repaint on a telemetry write would be the wrong trade. The
   * explicit key makes the append idempotent however the two callers race.
   */
  const recordFirstOutput = (source) => {
    if (firstOutputRecorded) return;
    firstOutputRecorded = true;
    appendRunEvent({
      kind: 'run.output',
      runId,
      agentId,
      taskId: task.id,
      eventId: `output:${agentId}:${runId || 'no-run'}:first`,
      data: { source },
    });
  };
  let promptSentAt = null;
  // When the submit-Enter is first written (NOT when the paste starts). Provider
  // signal handling keys on this so a startup banner is not treated as a signal
  // from a submitted prompt.
  let promptSubmittedAt = null;
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
  // agy enables bracketed paste on alt-screen entry, before its composer (and
  // before its trust gate) exists, so it needs the extra composer-footer gate.
  // A direct launch pty.spawns the TUI itself (no launch shell), so the tracker
  // must not wait for a shell paste-mode OFF that will never come.
  const inputReady = createInputReadyTracker({
    ...(isAntigravityCommand(tuiConfig.command) ? { readyTextPattern: AGY_INPUT_READY_PATTERN } : {}),
    directLaunch,
  });
  let trustAccepted = false;
  let autoModeDeclined = false;
  let externalImportsDeclined = false;
  let hookReviewDeclined = false;
  // True once shell.js actually injects the `claude` command (after its
  // round-trip readiness probe). The probe runs its OWN shell command first,
  // which toggles bracketed-paste mode and would otherwise advance the
  // input-ready tracker (sawCommandRun + pasteModeOn) while still at the bare
  // shell prompt — pasting the prompt into claude's startup banner. Gating
  // observation on this discards every pre-command toggle.
  let commandInjected = false;
  let firstOutputAt = null;
  let lastOutputAt = Date.now();
  let sessionId = null;
  // The runner's `tui:output` socket messages are live telemetry. An OpenCode
  // CLI that prints one startup error and exits can race that delivery, while
  // its `tui:exit` arrives reliably enough to finish the session. Track whether
  // we received any ordinary chunk so the runner-provided exit tail is spooled
  // only as a recovery path, never duplicated into raw.txt.
  let receivedTuiOutput = false;

  // The paste-attempt / submit-Enter machinery (postPasteBuffer, pasteEnterTimer,
  // pasteVerifyTimer, submitEnterTimer) lives in createPasteRetryController
  // rather than this closure — see its own comment for why that cluster is
  // separated out.
  // `pasteController` is created once sessionId/pid are known (below) and torn
  // down from stopRunMachinery via `pasteController?.cancel()`.
  let pasteController = null;

  const streamingStrip = createStreamingAnsiStripper();

  // Output buffering + raw PTY spooling (parsed-line → output.txt/state,
  // raw bytes → raw.txt, both debounced) live in the extracted spooler so
  // this function stays orchestration. `appendLine` records a status line,
  // `pushRaw` queues a raw chunk, `drainLines`/`drainRaw` flush at finalize,
  // and `getOutputBuffer` reads the capped buffer for failure-analysis fallback.
  const spooler = createOutputSpooler({ agentId, outputFile, rawFile });
  const { appendLine, pushRaw, flushRaw, drainLines, drainRaw, getOutputBuffer } = spooler;

  // Read the `.agent-done` sentinel (if present) and append its markdown task
  // summary line-by-line into the agent's output so downstream consumers
  // (extractFinalSummary, persistSimplifySummaries, completion hooks, the agent
  // card, output.txt) get the resolution. Called only from finish() (the single
  // finalize chokepoint); idempotent via `sentinelIngested` so it reads at most
  // once. Capped at 4 KB so an agent that pasted the whole diff into the
  // sentinel can't blow up the record.
  // Has the agent written its completion sentinel? One predicate for the 2s
  // watcher and ingestDoneSentinel so "the run finished" can't mean subtly
  // different things in two places.
  const sentinelPresent = () => !!doneSentinelPath && existsSync(doneSentinelPath);

  // Returns the sentinel's `summary` text (or null on a second call / no
  // sentinel / an empty summary) — the merge-gate contract check below reads
  // this same return value rather than re-reading the file a second time.
  const ingestDoneSentinel = async () => {
    if (sentinelIngested) return null;
    if (!sentinelPresent()) return null;
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
    if (!summary) return null;
    // Shared constant, not a literal: `extractAgentSummary` anchors the PR-body
    // extraction on this exact line to tell the agent's summary apart from the
    // lifecycle telemetry above it. Reword it here only, and the noise returns.
    appendLine(SENTINEL_COMPLETION_MARKER);
    const truncated = summary.length > 4096 ? `${summary.slice(0, 4096)}\n…[truncated]` : summary;
    for (const line of truncated.split('\n')) appendLine(line);
    return summary;
  };

  // Sentinel-file watcher. The agent's prompt instructs it to write
  // .agent-done in the workspace after running /simplify + /do:pr and then
  // stop (it does NOT `/quit` — that is a UI command it can't invoke). This
  // watcher is the PRIMARY finalize path: it fires finish() shortly after the
  // sentinel appears, and finish()'s own cleanup kills the still-running TUI
  // session. The actual sentinel READ happens in finish() (via
  // ingestDoneSentinel) so the resolution is captured no matter which path
  // finalizes. A normal shell exit or explicit provider failure handles
  // agents that do not write the sentinel.
  //
  // `watchForFile` is one-shot (it detects, closes itself, then calls back) —
  // so a run whose merge-gate check re-prompts and deletes the sentinel to
  // await a SECOND completion needs a brand-new watcher, not a re-trigger of
  // this one. Factored out so both call sites build the exact same watcher.
  const armSentinelWatcher = () => (doneSentinelPath ? watchForFile(doneSentinelPath, async () => {
    if (finalized) return;
    await finish({ success: true, exitCode: 0, reason: 'agent-signaled-done' });
  }) : null);

  /**
   * Merge Gate contract check (#5876) — runs on a successful sentinel, before
   * ANY teardown, for a run whose own task shape said it owed a merge. Asks
   * the forge whether the PR this run opened actually landed and, if it is
   * still open with no blocker stated in the agent's own summary, re-pastes
   * one corrective nudge into the still-attached session instead of paying
   * for a cold recovery agent (`agentRepoStateVerification.js`) to do the
   * same merge later. See mergeGateContract.js for the decision table.
   *
   * @returns {Promise<boolean>} true when a re-prompt went out — the caller
   *   must NOT finalize this call; false means finalize normally.
   */
  const checkMergeGateCompliance = async (summary) => {
    if (!mergeGateIsOwed || mergeGateReprompted) return false;
    const branchName = await git.getBranch(cwd).catch(() => null);
    if (!branchName) return false;
    const prProbe = await probePrForBranch(cwd, branchName).catch(() => null);
    const verdict = resolveMergeGateVerdict({ prProbe, summary });
    if (verdict !== 'needs-reprompt') return false;
    if (!pasteController?.resubmit({ text: buildMergeGateReprompt(prProbe.prUrl || '<PR_URL>'), label: 'merge-gate contract nudge' })) {
      // Session is already gone — nothing to nudge; fall through to finalize.
      return false;
    }
    mergeGateReprompted = true;
    // Reopen the completion window: a fresh `.agent-done` write after the
    // nudge must be re-ingested (not silently skipped by the once-only guard)
    // and needs a brand-new watcher — the original already closed itself on
    // its first (this) detection.
    sentinelIngested = false;
    if (doneSentinelPath) await rm(doneSentinelPath).catch(() => {});
    // Armed unconditionally — the sentinel is already gone, so a missing
    // `activeAgents` entry (an anomaly this code doesn't otherwise expect)
    // must not also leave the run with no watcher at all. `stopRunMachinery`
    // reads it back off the map to tear it down at real finalize; if the
    // entry is missing there too, the watcher self-closes on its next fire.
    const newWatcher = armSentinelWatcher();
    const agentData = activeAgents.get(agentId);
    if (agentData) agentData.doneSentinelWatcher = newWatcher;
    appendLine(`🔁 Merge Gate not finished (PR still OPEN, no blocker stated) — re-prompted the session (1 nudge only)`);
    emitLog('warn', `🔁 Merge-gate contract nudge sent for ${agentId} — PR still OPEN with no stated blocker`, { agentId });
    return true;
  };

  /**
   * Stop everything this run armed, and hand back the agent record so the
   * caller doesn't need a second map lookup.
   *
   * Shared by the two paths that end a run — `finish()` (records an outcome) and
   * `abandonForHostShutdown()` (records none). Every timer here is created inside
   * this closure, so a teardown site that falls behind leaks an interval holding
   * the closure and the PTY handle alive, which is exactly the drift a single
   * teardown prevents.
   */
  const stopRunMachinery = () => {
    const agentData = activeAgents.get(agentId);
    if (agentData?.providerSignalTimer) clearInterval(agentData.providerSignalTimer);
    if (agentData?.promptTimer) clearInterval(agentData.promptTimer);
    agentData?.doneSentinelWatcher?.();
    // Cancels the paste-attempt timers and releases the post-paste accumulator
    // even when the run ends mid-paste-window — see
    // createPasteRetryController's own cancel() for why each is safe to clear
    // unconditionally (a run that ends from elsewhere — shell-exit,
    // command-not-found, user termination, a host restart — never gets a
    // chance to let its own cleanup path run).
    pasteController?.cancel();
    return agentData;
  };

  const finish = async ({ success, exitCode = 0, error = null, reason = 'completed' }) => {
    // `finalized` alone used to be the whole re-entrancy guard, safe because it
    // was set SYNCHRONOUSLY as this function's first act. The merge-gate check
    // below needs `ingestDoneSentinel`'s summary before it can decide whether
    // to finalize at all, which pushes `finalized = true` past several awaits —
    // wide enough for a second trigger (the shell exiting right after the
    // sentinel appears) to also pass the `if (finalized)` gate before the first
    // call sets it, double-firing `finalizeAgent`. `finishing` closes that
    // window synchronously; `finalized` still means "truly done" and is what
    // `pasteController.resubmit()` reads, so it must stay false while a
    // re-prompt is still possible.
    //
    // A trigger dropped here while the first call is mid-decision is not
    // discarded: it's the one call that could carry news the first call
    // doesn't have (the shell exiting right in this window), so it's replayed
    // once that call settles on "not finalizing after all" — see below.
    if (finalized) return;
    if (finishing) {
      pendingFinish = { success, exitCode, error, reason };
      return;
    }
    finishing = true;
    // PortOS is going down. Whatever path got here — the PTY exiting under
    // TreeKill, a provider-signal failure, a paste that failed because the shell died —
    // the cause is the host restart, not the agent, so there is no outcome to
    // record. Abandoning instead of finalizing is what keeps an interrupted run
    // from being written down as completed AND keeps its worktree (which
    // finalize's cleanup would delete) intact for the resume (#3202).
    //
    // Three exceptions keep their normal path. An agent that already wrote its
    // `.agent-done` sentinel has given a valid completion signal. A run the user
    // terminated must reach finalizeAgent to be recorded `user-terminated` —
    // abandoning it would leave the record `running` with no such mark, and boot
    // recovery's user-terminated skip would miss it and resurrect the run. And a
    // run the user paused already has its own don't-finalize branch below, which
    // owns the paused bookkeeping (pid unregister, activeAgents delete).
    if (shouldAbandonForHostShutdown({
      sentinelPresent: sentinelPresent(),
      terminatedByUser: userTerminatedAgents.has(agentId),
      paused: pausedAgents.has(agentId),
    })) {
      await abandonForHostShutdown();
      return;
    }

    // Ingest the .agent-done sentinel BEFORE any teardown decision, so its
    // markdown summary lands in outputBuffer/output.txt regardless of WHICH
    // path finalized the agent, AND so the merge-gate contract check right
    // below reads the same text without a second file read. The completion
    // workflow writes the sentinel and stops; the 2s doneSentinelWatcher is
    // what normally calls finish(). Idempotent via `sentinelIngested`.
    const sentinelSummary = await ingestDoneSentinel();

    // Merge Gate contract check (#5876): only for a run that actually
    // succeeded AND signaled that success via a real `.agent-done` summary —
    // an ordinary clean exit with no sentinel (or one with an empty summary)
    // is not the "the agent believes its Merge Gate is done" signal this
    // reads; re-prompting THAT would paste into a shell whose TUI child may
    // already be gone, parking the run on a nudge that can never land.
    // Returns true (and this call does NOT finalize) exactly once, when the
    // run owed a merge, the PR is open, and the summary names no blocker —
    // see mergeGateContract.js for the full decision table.
    if (success && sentinelSummary !== null && await checkMergeGateCompliance(sentinelSummary)) {
      // Not finalizing — reopen the re-entrancy gate for the next completion
      // signal the re-prompt is expected to produce. A trigger that arrived
      // WHILE this call was deciding (dropped by the `finishing` guard above)
      // is the only thing that could tell us the session actually died during
      // that window, so replay it now rather than losing it — otherwise the
      // run would sit waiting for a nudge with nothing left alive to receive it.
      finishing = false;
      if (pendingFinish) {
        const replay = pendingFinish;
        pendingFinish = null;
        return finish(replay);
      }
      return;
    }

    finalized = true;

    const agentData = stopRunMachinery();

    // Drain pending parsed lines AND raw chunks before the final state
    // writes so completion events don't beat the last output batch to disk.
    await drainLines();
    await drainRaw();

    if (pausedAgents.has(agentId)) {
      consumePausedAgentExit(agentId);
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

    // output.txt has already been incrementally appended via the spooler;
    // do NOT writeFile() it from the output buffer at finalize — the buffer is
    // capped at OUTPUT_BUFFER_CAP and would silently truncate the on-disk
    // record for long runs. The append-only stream is the authoritative copy.
    //
    // For failure analysis: resolveErrorAnalysis reads only the tail of the raw
    // PTY spool (the analyzer strips ANSI and windows it to the last ~200 lines /
    // 16K chars) and falls back to the capped output buffer if the spool is
    // missing/unreadable. Successful runs skip the read entirely. raw.txt stays
    // in agentDir alongside output.txt as the persistent record of the agent's
    // full PTY transcript.
    const errorAnalysis = await resolveErrorAnalysis({
      finalSuccess,
      rawFile,
      fallbackText: getOutputBuffer(),
      task,
      model,
      immediateFallbackAnalysis,
      // The finalize path's own verdict outranks a keyword sweep of the
      // transcript when the analyzer recognizes it (COMPLETION_REASON_ANALYSES).
      completionReason: reason,
      completionError: finalError,
    });

    // `taskOpenPR` / `agentOwnsPR` are computed once, up front, near
    // `doneSentinelPath` — the merge-gate contract check above reads the same
    // answer this cleanup path does, so neither side can believe the other
    // owns the PR (#3733).
    const taskReviewLoopFollowUp = isTruthyMetaFn(task.metadata?.reviewLoopFollowUp);
    // …but PR-claim verification (#3358) stays keyed on the SLASH-command
    // predicate. A run PortOS still backstops (it re-checks the forge at cleanup
    // and opens the PR itself when the agent skipped it) must not be failed here
    // for a PR that is about to exist — finalize runs before that net.
    const prClaimExpected = taskOpenPR && canTypeSlashCommands({
      providerId: provider?.id,
      providerCommand: provider?.command,
      leanMode,
    });
    // Whether finalize's check ACTUALLY produced a forge answer, filled in from
    // its return below. Deliberately not `prClaimExpected`: finalize substitutes
    // `{ok:true}` for a user-terminated run and for a check that threw, and a
    // throw from finalize itself skips the assignment entirely — in all three
    // cases nothing was verified, so cleanup must ask rather than stand down.
    let prClaimVerified = false;
    let noChangesToShip = false;

    // try/finally so a throw from finalizeAgent (e.g. processAgentCompletion
    // hook crash) still runs the local cleanup — sentinel removal, worktree
    // cleanup, pid unregister, activeAgents delete, session kill. Without
    // this, a memory-extraction crash would strand the worktree and the
    // shell session on disk.
    // The verdict finalizeAgent actually persisted. A PR-claim downgrade (#3358)
    // must reach cleanup too — cleaning up as a success removes the worktree and
    // deletes the local branch, destroying the state the retry needs. Left at
    // `finalSuccess` if finalize threw before returning (the pre-existing
    // best-effort posture).
    let cleanupSuccess = finalSuccess;
    try {
      const finalized = await finalizeAgent({
        agentId,
        task,
        runId,
        providerId: provider?.id,
        success: finalSuccess,
        exitCode,
        duration,
        outputBuffer: getOutputBuffer(),
        errorAnalysis,
        terminatedByUser,
        isTruthyMetaFn,
        error: finalError || undefined,
        completionReason: reason,
        workspacePath: cwd,
        prExpected: prClaimExpected,
        // The run window the commit criterion is evaluated against (#3637).
        startedAt: agentData?.startedAt ?? null,
      });
      if (finalized && typeof finalized.success === 'boolean') cleanupSuccess = finalized.success;
      prClaimVerified = prClaimWasVerified(finalized?.prVerdict);
      noChangesToShip = finalized?.prVerdict?.noChangesToShip === true;
    } finally {
      // This run's sentinel only — a sibling agent sharing this workspace owns
      // its own file and may still be running.
      if (doneSentinelPath) await rm(doneSentinelPath).catch(() => {});

      const prCreation = resolvePrCreation({ taskOpenPR, agentOwnsPr: agentOwnsPR, prClaimVerified, noChangesToShip });
      // Only the two modes that can still open a PR (and thus spawn a follow-up
      // that needs these) pay for the resolve. `never` — the dominant path, an
      // agent that opened and landed its own PR — discards them.
      const reviewOptions = prCreation !== PR_CREATION.NEVER
        ? await resolveReviewLoopOptions(task.metadata, { normalize: normalizeReviewers, isTruthyMeta: isTruthyMetaFn })
          .catch(err => {
            emitLog('warn', `TUI review options unavailable for ${agentId}: ${err.message}`, { agentId });
            return {};
          })
        : {};
      await cleanupWorktreeFn(agentId, cleanupSuccess, {
        prCreation,
        prCompletion: resolvePrCompletion(task.metadata),
        ...reviewOptions,
        skipMerge: taskReviewLoopFollowUp || agentOwnsPR,
        description: task.description,
        agentOutput: getOutputBuffer(),
        originalTask: task
      }).catch(err => emitLog('warn', `TUI worktree cleanup failed for ${agentId}: ${err.message}`, { agentId }));

      // Release the retry hold: flip the failed task back to `pending` carrying a
      // pointer at whatever the run left behind — the branch (or whole worktree)
      // `cleanupWorktreeFn` just preserved because the run failed with commits on
      // it. Without the pointer the retry starts clean and redoes work already
      // sitting on disk (#3368); without the hold that release replaces, the retry
      // could be dequeued before the pointer landed (#3373). Imported lazily for the
      // same reason `cleanupWorktreeFn` is injected: pulling the cleanup graph in at
      // module top level races this file's own init in the agentLifecycle cycle.
      await import('./agentWorktreeCleanup.js')
        .then(({ releaseRetryHold }) => releaseRetryHold({ agentId, task, success: cleanupSuccess }))
        .catch(err => emitLog('warn', `TUI retry-hold release failed for ${agentId}: ${err.message}`, { agentId }));

      if (agentData?.pid) unregisterSpawnedAgent(agentData.pid);
      activeAgents.delete(agentId);
      if (sessionId && shellService.getSession(sessionId)) shellService.killSession(sessionId);
    }
  };

  /**
   * Abandon the run because PortOS itself is going down (#3202).
   *
   * Deliberately NOT `finish()`: finalizing here would record an outcome for a
   * run that never reached one, and its cleanup path removes the `.agent-done`
   * sentinel and hands the worktree to `cleanupWorktreeFn` — destroying exactly
   * the state a resume needs. So this only stops the machinery and flushes what
   * was captured; the agent record stays `running` and the worktree stays on
   * disk. The next boot's orphan sweep reads the host-shutdown marker, sees this
   * agent named in it, and requeues the task as *interrupted* — resumable, and
   * without charging it orphan-retry budget.
   *
   * Sets `finalized` so every other path (provider-signal timer, sentinel watcher, paste
   * retry) becomes a no-op for the rest of this process's life.
   */
  const abandonForHostShutdown = async () => {
    // No `finalized` guard: finish() — the only caller — already returned if it
    // was set, and this sets it below.
    finalized = true;
    stopRunMachinery();

    appendLine('🛑 PortOS restarted while this agent was running — the run was interrupted, not completed. Its worktree is preserved and the task will resume.');
    emitLog('warn', `TUI agent ${agentId} interrupted by a PortOS host restart — preserved for resume`, { agentId, phase: 'interrupted' });
    // Concurrent, not sequential: nothing awaits this function (it runs off the
    // PTY-exit handler, racing the shutdown handler's own process.exit), so the
    // shorter the critical path the more of the transcript actually lands. The
    // three targets are independent — output.txt + the state record, raw.txt, and
    // the metadata patch — and the two that share the state lock still serialize
    // on it. `phase` is a breadcrumb only: the record stays `running` on purpose,
    // because boot recovery owns the transition.
    await Promise.all([
      drainLines().catch(() => {}),
      drainRaw().catch(() => {}),
      updateAgent(agentId, { metadata: { phase: 'interrupted', interruptedBy: HOST_SHUTDOWN_REASON } })
        .catch(err => emitLog('warn', `Could not mark TUI agent ${agentId} interrupted: ${err.message}`, { agentId })),
    ]);
    // NOTE: the activeAgents entry is intentionally left in place — the shutdown
    // handler reads that map to name the agents in the host-shutdown marker, and
    // there is no reason to shrink it on the way out.
  };

  // The single fail-over verdict, reached from two places: a signal with no grace
  // window (immediate) and a grace window that expired without recovery. Sharing
  // it keeps the deferred path provably identical to the immediate one.
  //
  // `immediateFallbackAnalysis` is set HERE and not at arm time on purpose — it is
  // read at finalize by resolveErrorAnalysis, so stamping it when the window opens
  // would tag a run that went on to RECOVER with the banner as its error.
  const failOverToFallback = (analysis) => {
    immediateFallbackAnalysis = analysis;
    appendLine(`⚡ Provider fallback signal: ${analysis.message}`);
    return finish({
      success: false,
      exitCode: 1,
      error: analysis.message || 'Provider requires fallback',
      reason: 'fallback-signal'
    });
  };

  /**
   * Re-deliver the prompt while a self-clearing provider signal's window is open.
   *
   * agy's eligibility banner is the REJECTION of a submission, not a spinner over
   * an in-flight one: the prompt is discarded, the composer goes back to empty
   * and the session sits at its idle footer indefinitely. So the window can only
   * clear if something re-asks — hence a plain re-paste + submit, which is also
   * literally what the banner instructs ("Please try again shortly").
   *
   * Re-pasting the WHOLE prompt is correct precisely because the composer is
   * empty; the gate's 20s cadence keeps this well clear of the reflow that
   * follows the rejected paste. Nothing here re-runs paste VERIFICATION: this
   * prompt already rendered once (its rejection is why we're here), and routing
   * back through `attemptPaste` would spend the startup paste-retry budget and
   * let a verification hiccup mid-handshake finalize the run as
   * `paste-not-rendered`.
   */
  const resubmitAfterSignal = () => {
    // A banner that paints during startup (before the prompt was ever submitted)
    // has nothing to re-send — the ordinary paste path still owns first delivery.
    if (finalized || !promptSubmittedAt) return;
    const attempt = selfClearingGate.takeResubmit(Date.now());
    if (!attempt) return;
    // Only claim the re-submission that actually went out — a false return means
    // the session is already gone, and a transcript line saying otherwise would
    // send a post-mortem looking for a paste the provider never received.
    if (pasteController?.resubmit()) {
      appendLine(`🔁 Provider handshake still open — re-submitted the prompt (attempt ${attempt})`);
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
      if (text) receivedTuiOutput = true;
      const stripped = streamingStrip(text);
      pushRaw(text);
      // Accumulate the ANSI-STRIPPED chunk (not the raw text): the paste marker
      // is rendered with absolute-column cursor moves between glyphs, so it only
      // matches after stripping (see countPasteMarkers). Appending raw text here
      // — as this did before #1229 — left the marker unmatchable and the fast
      // path dead.
      pasteController?.ingestChunk(stripped);
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
      // Startup-idle detection (the promptTimer's non-inputReady branch below)
      // reads lastOutputAt/firstOutputAt to decide the TUI has gone quiet and is
      // ready for the prompt paste. Gate them on commandInjected for the same
      // reason inputReady.observe is gated above: the shell-level readiness
      // probe (posix printf / PowerShell Write-Output) round-trips its own
      // marker through this same onData hook BEFORE the real CLI command is
      // injected, so counting it would seed the idle clock from probe echo
      // instead of the CLI's own output — falsely satisfying "quiet" while a
      // still-loading CLI (e.g. PowerShell's heavier startup) hasn't painted
      // anything yet, and pasting the prompt into it.
      if (commandInjected) {
        lastOutputAt = now;
        if (firstOutputAt === null) firstOutputAt = lastOutputAt;
      }
      recordFirstOutput('tui-pty');

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
      //
      // While a grace window is open, every chunk is evidence about whether the
      // provider came back; the gate closes itself the moment it is. The clock
      // is load-bearing — it lets the gate discount the echo of a prompt IT just
      // re-pasted (see SELF_CLEARING_RESUBMIT_ECHO_MS).
      if (selfClearingGate.observe(stripped, now)) {
        appendLine(`✅ Provider signal cleared — ${tuiConfig.command} is generating again; continuing the run`);
      }

      const fallbackSignal = detectImmediateFallbackSignal(stripped);
      // Branch on the SIGNAL's own grace window, never on gate state: the
      // detector buffers ~512 chars, so a banner keeps matching for many chunks
      // after it has scrolled off. Reading gate state here would let one of those
      // stale matches fall through to an immediate kill the moment the gate
      // closed. A graceful signal can only ever arm a window (or be ignored,
      // when one is already open or the provider already recovered).
      if (fallbackSignal?.graceMs > 0) {
        if (selfClearingGate.arm(fallbackSignal, now)) {
          appendLine(`⏳ Provider signal (self-clearing): ${fallbackSignal.message} — holding the session up to ${Math.round(fallbackSignal.graceMs / 1000)}s for it to clear`);
        }
      } else if (fallbackSignal) {
        await failOverToFallback(fallbackSignal);
        return;
      }

      // A local inference runtime that ran out of GPU memory. The turn is dead
      // but the session is intact, so this arms a nudge instead of killing the
      // run — the provider-signal timer sends it once the session has actually
      // gone quiet. Gated on promptSubmittedAt for the same reason
      // resubmitAfterSignal is: before the prompt is in, there is no turn to
      // resume and the ordinary paste path still owns first delivery.
      const oomSignal = promptSubmittedAt ? detectLocalRuntimeOom(stripped) : null;
      if (oomSignal) {
        const armed = oomNudgeGate.arm(oomSignal, now);
        if (armed === 'armed') {
          appendLine('⏳ Local runtime out of GPU memory — will nudge the session to continue if it goes quiet');
        } else if (armed === 'exhausted') {
          // Nudged its way through OOM_NUDGE_MAX_ATTEMPTS and it came back
          // again: the conversation no longer fits this device, and it only
          // grows from here. Hand the task to a fallback provider.
          await failOverToFallback(oomSignal);
          return;
        }
      }

      if (!promptSentAt) {
        // Only the login-shell path can reach this: it is the shell PRINTING
        // "command not found". A direct PTY resolves the executable before it
        // spawns (createAgentTuiSession), because there is no shell to print it.
        if (detectMissingTuiBinary(stripped, commandName)) {
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

  const handleExit = async ({ exitCode, killed, signal = null, outputTail = '' }) => {
    if (finalized) return;
    // A durable runner can retain a startup error even when its matching
    // `tui:output` socket event lost the race with process exit. Preserve its
    // bounded tail before finish() drains raw.txt for error analysis. Cap again
    // at this trust boundary so a malformed runner event cannot grow the spool.
    if (!receivedTuiOutput && typeof outputTail === 'string' && outputTail) {
      receivedTuiOutput = true;
      pushRaw(outputTail.slice(-16 * 1024));
      recordFirstOutput('tui-exit-tail');
    }
    // A host restart reaches here as a plain PTY exit (pm2's TreeKill walks
    // portos-server's descendants), which the `success` reading below would
    // record as a completed run. finish() intercepts that case — see its
    // host-shutdown guard (#3202).
    const code = typeof exitCode === 'number' ? exitCode : killed ? 130 : 0;
    // A signal-terminated process reports the wait-status exit code — 0 for a
    // plain SIGTERM/SIGHUP — so `code === 0` alone cannot mean "finished
    // normally". Treat any signal as an abnormal end. This is the backstop for
    // the case the host-shutdown guard can't cover: a SIGKILL'd or crashed
    // portos-server never runs its shutdown handler, so the flag is never set,
    // yet the agent's PTY still dies with us (#3202).
    //
    // The reading holds for BOTH session shapes. A login shell carried its
    // hosted CLI's status out via the run-then-exit wrapper; a direct PTY
    // (#6159) simply IS the CLI, so the code and signal are the CLI's own.
    // Reason codes stay `shell-*`: that is what COMPLETION_REASON_ANALYSES
    // registers.
    const signaled = !!signal;
    const outcome = killed
      ? { error: 'TUI session was killed', reason: 'shell-killed' }
      : signaled
        ? { error: `TUI session was terminated by signal ${signal} — the run was cut short, not completed`, reason: 'shell-signaled' }
        : { error: null, reason: 'shell-exit' };
    await finish({ success: code === 0 && !killed && !signaled, exitCode: code, ...outcome });
  };

  // Repo-owner-pinned GH_TOKEN for the agent's own `gh pr create` (see
  // resolveForgeTokenEnv). Resolved here since createAgentTuiSession is sync.
  // Skip when the provider supplies its own GH_TOKEN/GITHUB_TOKEN so its explicit
  // credential wins — and skip for a public-content stage, which must never hold
  // a forge credential (the allowlist in createAgentTuiSession strips it anyway;
  // not resolving it means it is never read out of the keychain to begin with).
  const forgeTokenEnv = providerSuppliesGithubToken(provider) || isPublicReviewRestrictedProfile(safetyProfile)
    ? {}
    : await git.resolveForgeTokenEnv(cwd);

  // Ollama-backed harnesses talk to the daemon directly, so their context
  // window is whatever Ollama loaded the model at — no per-request `num_ctx`
  // reaches them. Hold the daemon at the provider's configured window (or warn
  // when it's below what an agent harness needs) BEFORE the TUI starts: the
  // failure mode otherwise is an hour of work lost to a 400 at 100% context.
  // Gated on the predicate here (not just inside the helper) so a cloud-provider
  // spawn — the overwhelmingly common case — takes no async hop at all.
  const ollamaContext = isOllamaBackedProvider(provider)
    ? await ensureOllamaAgentContext(provider, { model })
    : null;
  if (ollamaContext?.warning) appendLine(ollamaContext.warning);
  if (ollamaContext?.applied) appendLine(`🪟 Reloaded Ollama at a ${ollamaContext.contextLength}-token context window`);

  // A spawn failure here (a runner 400 for a command missing from its allowlist,
  // an unreachable runner, a PTY that won't open) used to propagate raw out of
  // spawnTuiAgent. The caller in subAgentSpawner only logs it, so the agent
  // record stayed `initializing` with the real error nowhere but the server log
  // until the zombie reaper finalized it ~a minute later as the generic "Agent
  // process terminated unexpectedly". Finalize it here instead, carrying the
  // spawn error into the record. Runs outside the Express request lifecycle, so
  // there is no middleware to bubble to.
  //
  // The REASON splits on which half failed. A durable-runner throw is a
  // runner-hop failure (a `fetch failed` mid-restart, or a runner refusal) —
  // no process ever existed, so it is `spawn-rejected` (non-actionable →
  // retry), mirroring the direct-CLI runner path's deliberate split in
  // agentLifecycle.js and the registration in COMPLETION_REASON_ANALYSES. A
  // LOCAL PTY that won't open keeps the actionable `spawn-error`: that is a
  // real host/config problem a retry cannot repair.
  let session;
  try {
    session = await createAgentTuiSession({
      agentId,
      taskId: task.id,
      provider,
      model,
      tuiConfig,
      cwd,
      forgeTokenEnv,
      doneSentinelPath,
      useDurableRunner,
      safetyProfile,
      onData: handleData,
      onExit: handleExit,
      onInitialCommandSent: () => { commandInjected = true; },
    });
  } catch (err) {
    const message = err?.message || String(err);
    appendLine(`❌ Failed to start ${provider.name || provider.id} TUI: ${message}`);
    // The durable runner probes the configured executable before it opens a
    // PTY. Distinguish that deterministic configuration failure from a runner
    // outage/refusal so it is blocked with the existing actionable
    // command-not-found guidance rather than retried as a transient rejection.
    //
    // A LOCAL direct PTY raises the SAME failure with the same prefix — see the
    // pre-spawn resolve in createAgentTuiSession's restricted branch (#6159) —
    // so the test is no longer gated on the runner.
    const reason = /^Command executable unavailable:/i.test(message)
      ? 'command-not-found'
      : useDurableRunner ? 'spawn-rejected' : 'spawn-error';
    if (useDurableRunner) {
      // A handoff that did not land (#4540), recorded like the CLI path's. A
      // LOCAL PTY that won't open is a host problem, not a handoff, so it is
      // deliberately not recorded here.
      //
      // `accepted: false` is reserved for an explicit refusal. An ambiguous
      // transport failure records the `null` sentinel instead — the spawn rpc
      // already asked the runner whether it has the PTY (and would have adopted
      // it), so what is unknown here is the CAUSE, not the outcome (#4615).
      const refused = classifyRunnerSpawnFailure(err) === RUNNER_SPAWN_REFUSED;
      await appendRunEvent({
        kind: 'run.handoff',
        runId,
        agentId,
        taskId: task.id,
        eventId: `handoff:${agentId}:${runId || 'no-run'}:${refused ? 'rejected' : 'unconfirmed'}`,
        data: {
          to: 'none',
          accepted: refused ? false : null,
          outcome: refused ? RUNNER_SPAWN_REFUSED : RUNNER_SPAWN_AMBIGUOUS,
          kind: 'tui',
          reason: message,
        },
      });
    }
    await finish({
      success: false,
      exitCode: 1,
      error: `Failed to start TUI session: ${message}`,
      reason,
    });
    return null;
  }
  sessionId = session.sessionId;
  if (useDurableRunner) {
    // A durable TUI's PTY lives in the CoS Runner, not this server — the same
    // ownership transfer `spawnViaRunner` records for CLI agents (#4540).
    // Without it, the longest-lived runs in the system are the only ones whose
    // ledger never says who owns their process.
    await appendRunEvent({
      kind: 'run.handoff',
      runId,
      agentId,
      taskId: task.id,
      eventId: `handoff:${agentId}:${runId || 'no-run'}:cos-runner`,
      data: {
        to: 'cos-runner',
        accepted: true,
        kind: 'tui',
        providerId: provider.id,
        sessionId: session.sessionId ?? null,
        // The handoff landed but its acknowledgement was lost; the relay was
        // re-attached to the PTY the runner already had (#4615).
        ...(session.adopted ? { outcome: RUNNER_SPAWN_AMBIGUOUS, adopted: true, reason: session.adoptedReason ?? null } : {}),
      },
    });
    if (session.adopted) {
      appendLine(`🔁 Spawn acknowledgement lost (${session.adoptedReason}) — re-attached to the live runner PTY`);
      emitLog('warn', `TUI agent ${agentId} spawn acknowledgement was lost; adopted the live runner PTY`, { agentId, taskId: task.id });
    }
  }

  // A durable runner can emit tui:exit before its spawn POST response reaches
  // this process. handleExit() then finalizes the run while createAgentTuiSession
  // is still awaiting that response. Do not revive the finalized agent by
  // registering its returned session, timers, or active-agent record; release
  // the external shell session that was registered during the late response.
  if (finalized) {
    if (sessionId && shellService.getSession(sessionId)) shellService.killSession(sessionId);
    return null;
  }

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
      workspacePath: cwd,
      prompt: (task.description || '').substring(0, 500)
    });
  }

  // Send the bracketed-paste prompt only after the TUI has finished its initial
  // repaint and gone quiet — pasting during the banner/loading screen is the
  // failure mode that left the input empty. The `\r` is split from the paste
  // write because a fixed delay races Claude Code's paste-commit on large
  // prompts; instead we poll Claude Code's raw output for its
  // provider paste-commit marker, then wait an extra
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
    await flushRaw().catch(() => {});
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

  // Owns the paste-attempt counter, the post-paste accumulator, and the paste
  // timers — see
  // createPasteRetryController's own comment for why that cluster lives
  // outside this closure. `isFinalized`/`markPromptSent`/`markPromptSubmitted`
  // are accessors into THIS closure's `finalized`/`promptSentAt`/
  // `promptSubmittedAt`, which handleData and the provider-signal timer below
  // still read directly.
  pasteController = createPasteRetryController({
    agentId,
    sessionId,
    pid,
    directLaunch,
    prompt,
    tuiConfig,
    mcpBoot,
    appendLine,
    isFinalized: () => finalized,
    markPromptSent: () => { promptSentAt = Date.now(); },
    markPromptSubmitted: () => { if (promptSubmittedAt === null) promptSubmittedAt = Date.now(); },
    finishStartupFailure,
  });

  // Claude Code renders a startup banner and (in unfamiliar folders) a
  // folder-trust gate before its input box exists, and the old "saw output then
  // went quiet" heuristic fired during those lulls — pasting the prompt into the
  // banner / trust menu / a returned shell. For claude we instead gate on its
  // POSITIVE input-ready footer (see createInputReadyTracker), auto-confirm the
  // trust gate, and NEVER blind-paste: if the prompt never appears we surface a
  // failure. Other TUI providers keep the original startup readiness deadline.
  //
  // Antigravity (agy) gets the SAME positive gate (issue #2705), but agy alone
  // needs a second signal on top of paste mode: unlike claude it enables
  // bracketed paste on ALT-SCREEN ENTRY, ~200ms after launch, while it is still
  // signing in and before its trust gate has even painted. Gating on paste mode
  // alone therefore raced agy's sign-in round trip — when that outran the 2.5s
  // prompt delay the prompt was pasted into the still-pending trust gate, which
  // swallowed it and all three retries (`paste-not-rendered`). agy's composer
  // footer (AGY_INPUT_READY_PATTERN) renders only after the trust gate is
  // resolved, so requiring it orders the two correctly. agy DOES have a
  // first-run folder-trust gate ("Do you trust the contents of this project?")
  // and `--dangerously-skip-permissions` does NOT bypass it — the auto-confirm
  // branch below is load-bearing, matching its "Yes, I trust this folder" option
  // via TUI_TRUST_PROMPT_PATTERN. If agy ever fails to signal ready, the
  // requireInputReady path fails fast with a surfaced startup error instead of
  // silently failing at startup.
  const requireInputReady = isClaudeCommand(tuiConfig.command) || isAntigravityCommand(tuiConfig.command);
  // sendPrompt / finishStartupFailure are async and dispatched fire-and-forget
  // from the interval below. A setInterval callback can't await, and an
  // unhandled rejection there (e.g. a finalizeAgent throw inside finish())
  // would crash the process — the callback-boundary hazard AGENTS.md calls out.
  // Wrap each floating call so a rejection is logged, not thrown.
  const safeSendPrompt = (reason) => pasteController.sendPrompt(reason).catch((err) =>
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

    // Every dismissal below rewinds the idle clock (`lastOutputAt`) AND clears
    // `firstOutputAt`, which re-arms the idle path's "has it printed anything?"
    // gate. The idle heuristic that governs codex reads silence as readiness,
    // and a dialog is at its quietest right after it paints — so the dismissal
    // keystroke and an idle paste can otherwise go out inside the same window,
    // landing the prompt in a menu that has not repainted. Demanding fresh
    // output-then-silence AFTER the keystroke makes the paste wait for whatever
    // the dismissal reveals; if the TUI ignores the keystroke entirely,
    // PASTE_DEADLINE_MS still backstops delivery.

    // Claude can discover PortOS's parent AGENTS.md (via CLAUDE.md) from a managed-app worktree
    // nested under data/cos/worktrees, then ask whether to allow that file's
    // external AGENTS.md import. Decline it: the parent repository's instructions
    // must not leak into the target app, and option 2 leaves the target's own
    // instruction files intact. Like the auto-mode offer, arrow-down + Enter
    // avoids accepting the highlighted option 1.
    if (inputReady.needsExternalImportsChoice && !externalImportsDeclined) {
      externalImportsDeclined = true;
      shellService.writeToSession(sessionId, '\x1b[B\r');
      inputReady.ackExternalImportsChoice();
      lastOutputAt = now;
      firstOutputAt = null;
      appendLine(`📟 Declined ${tuiConfig.command} external instruction imports for session ${sessionId.slice(0, 8)}`);
      return;
    }

    // Codex can present a hook-review selector before its composer exists.
    // Do not trust hooks from an unattended run: option 3 keeps them disabled
    // for this session and lets the agent continue without executing code
    // outside its sandbox. This must run for every TUI, not only the positive
    // input-ready providers below — Codex currently uses the idle/deadline path.
    if (inputReady.needsHookReview && !hookReviewDeclined) {
      hookReviewDeclined = true;
      shellService.writeToSession(sessionId, '\x1b[B\x1b[B\r');
      inputReady.ackHookReview();
      lastOutputAt = now;
      firstOutputAt = null;
      appendLine(`📟 Continued ${tuiConfig.command} without trusting startup hooks for session ${sessionId.slice(0, 8)}`);
      return;
    }

    // Auto-confirm the first-run "trust this folder?" gate so agents can run in
    // fresh worktrees. Wait for the choices themselves to paint: Claude Code
    // releases disagree about their ordering, and newer builds can highlight
    // "No, exit" by default. Move to the affirmative option when necessary,
    // then submit it once.
    //
    // Like the hook-review selector this runs for EVERY TUI, not only the
    // positive input-ready providers below: codex takes the idle/deadline path,
    // and its trust dialog goes quiet the instant it paints, so the idle
    // heuristic reads that silence as "ready" and pastes the task straight into
    // the menu — which swallows it and all three paste retries
    // (agent-671af38f, 2026-08-21, `paste-not-rendered`). Answering the dialog
    // first is what lets the composer appear at all.
    if (inputReady.needsTrust && inputReady.trustChoiceReady && !trustAccepted) {
      trustAccepted = true;
      const trustInput = `${inputReady.trustSelectionKey}${SUBMIT_KEY}`;
      shellService.writeToSession(sessionId, trustInput);
      inputReady.ackTrustChoice();
      lastOutputAt = now;
      firstOutputAt = null;
      appendLine(`📟 Auto-confirmed ${tuiConfig.command} folder-trust prompt for session ${sessionId.slice(0, 8)}`);
      return;
    }

    // A recognized trust heading with unknown choices is not an input prompt.
    // Never fall through to either positive-readiness or idle delivery and paste
    // the task into it. Fail explicitly at the provider's normal readiness cap
    // so a future wording change is diagnosable without accepting an unknown
    // highlighted default (which may be "No, exit").
    if (inputReady.needsTrust && !inputReady.trustChoiceReady) {
      const trustDeadlineMs = requireInputReady ? TUI_INPUT_READY_DEADLINE_MS : PASTE_DEADLINE_MS;
      if (elapsed >= trustDeadlineMs) {
        clearInterval(promptTimer);
        safeFinishStartupFailure(
          'tui-trust-choice-unrecognized',
          `${tuiConfig.command} presented a folder-trust prompt whose affirmative choice PortOS could not identify, so no prompt was sent.`,
        );
      }
      return;
    }

    if (requireInputReady) {
      // Decline claude's "make auto mode your default permission mode?" offer
      // (v2.1.233+). Unlike the trust gate this one paints AFTER the composer is
      // live, so it swallows the paste and every retry unless it is cleared
      // first — see TUI_AUTO_MODE_PROMPT_PATTERN. Arrow-down + Enter rather than
      // the digit `2`: it lands on "No, keep don't ask" under both of Ink's
      // selection models (digit-immediate-select and navigate-then-confirm),
      // whereas a bare `\r` would accept the highlighted option 1 and rewrite the
      // user's global permission default.
      if (inputReady.needsAutoModeChoice && !autoModeDeclined) {
        autoModeDeclined = true;
        shellService.writeToSession(sessionId, '\x1b[B\r');
        inputReady.ackAutoModeChoice();
        appendLine(`📟 Declined ${tuiConfig.command} auto-mode default offer for session ${sessionId.slice(0, 8)}`);
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

  // Provider-handshake retry timer. It is deliberately not an idle watchdog:
  // a CoS TUI may remain silent for as long as the provider needs.
  const providerSignalTimer = setInterval(() => {
    if (finalized) return;
    const expired = selfClearingGate.takeExpired(Date.now());
    if (expired) {
      // setInterval can't await, and an unhandled rejection here would crash the
      // process (the callback-boundary hazard AGENTS.md calls out).
      failOverToFallback(expired).catch((err) =>
        emitLog('error', `TUI agent ${agentId} deferred fallback finish failed: ${err?.message || err}`, { agentId }));
      return;
    }
    if (selfClearingGate.armed) {
      resubmitAfterSignal();
      return;
    }
    // Nudge a session a local-GPU OOM parked. Rides this timer rather than one
    // of its own so the nudge cadence and the fail-over verdict stay on the same
    // clock — and so there is one fewer interval to leak past finish().
    const nudge = oomNudgeGate.takeNudge(Date.now(), lastOutputAt);
    if (!nudge) return;
    if (pasteController?.resubmit({ text: OOM_NUDGE_TEXT, label: 'local-runtime OOM nudge' })) {
      appendLine(`🔁 Local runtime OOM — nudged the session to continue (attempt ${nudge}/${OOM_NUDGE_MAX_ATTEMPTS})`);
    }
  }, PROVIDER_SIGNAL_POLL_MS);

  const doneSentinelWatcher = armSentinelWatcher();

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
    providerSignalTimer,
    promptTimer,
    doneSentinelWatcher
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
      executionMode: useDurableRunner ? 'runner-tui' : 'tui',
      tuiSessionId: sessionId,
      tuiCommand: tuiConfig.commandLine,
      tuiKind,
    }
  });

  appendLine(`📟 TUI session started: ${sessionId.slice(0, 8)} (${tuiConfig.commandLine})`);
  appendLine(`💡 Open the Shell tab for live TUI output — this panel only logs lifecycle events.`);
  return agentId;
}
