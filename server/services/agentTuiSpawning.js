/**
 * Agent TUI Spawning
 *
 * Runs CoS agents inside an interactive PTY-backed shell session. This is for
 * providers whose useful interface is a terminal UI rather than a headless CLI
 * or HTTP API.
 *
 * This module is the PUBLIC ADAPTER the rest of the agent cluster consumes
 * (`agentLifecycle.js`). It owns three things and delegates the rest:
 *
 *   - `resolveTuiLaunchShape` / `createAgentTuiSession` — which of the three PTY
 *     shapes a run gets, and the environment each one is opened with.
 *   - `spawnTuiAgent` — the orchestration: resolve the run's cwd, sentinel path,
 *     PR ownership and credentials; open the PTY; wire the live state machine to
 *     it; record the handoff and the agent registration.
 *   - The compatibility surface: `buildTuiSpawnConfig` is re-exported from
 *     `agentTuiSpawning/spawnConfig.js` so existing callers need no migration.
 *
 * The live session state machine — session phase, prompt delivery and its retry
 * ladder, the sentinel watcher, the provider-signal/idle gates, and the single
 * teardown path — lives in `agentTuiSpawning/sessionController.js` (#8021).
 * Output spooling (`outputSpooler.js`) and failure analysis
 * (`finalizeHelpers.js`) are the earlier extractions from #2833.
 */

import { join } from 'path';
import { existsSync } from 'fs';
import { readFile, rm } from 'fs/promises';
import * as shellService from './shell.js';
import { emitLog } from './cosEvents.js';
import { updateAgent } from './cosAgentLifecycle.js';
import { createOutputSpooler } from './agentTuiSpawning/outputSpooler.js';
import { resolveErrorAnalysis } from './agentTuiSpawning/finalizeHelpers.js';
import { createTuiSessionController } from './agentTuiSpawning/sessionController.js';
import { buildTuiSpawnConfig } from './agentTuiSpawning/spawnConfig.js';
import { finalizeAgent } from './agentFinalization.js';
import { runSpawnerCompletionCleanup } from './agentCompletionCleanup.js';
import { activeAgents, registerSpawnedAgent, unregisterSpawnedAgent } from './agentState.js';
import { PATHS, watchForFile } from '../lib/fileUtils.js';
import { resolveAgentCliCwd } from '../lib/spawnCwd.js';
import { doneSentinelPath as resolveDoneSentinelPath } from '../lib/agentSentinel.js';
import { PTY_UNAVAILABLE_PREFIX } from '../lib/ptySpawnDiagnostics.js';
import { finalizeAgentRunCommon, shouldAbandonAgentRun } from './agentRunFinalize.js';
import { leavesPrForHuman } from '../lib/prDisposition.js';
import { resolvePrOwnership, PR_OPENED_BY } from '../lib/slashdoInvocation.js';
import { mergeGateOwed } from '../lib/mergeGateContract.js';
import { probePrForBranch } from './prProbe.js';
import * as git from './git.js';
import { spawnTuiSessionViaRunner, classifyRunnerSpawnFailure, RUNNER_SPAWN_REFUSED, RUNNER_SPAWN_AMBIGUOUS } from './cosRunnerClient.js';
import { providerSuppliesGithubToken } from '../lib/providerModels.js';
import { isPublicReviewRestrictedProfile } from '../lib/agentExecutionProfiles.js';
import { agentGuardEnv } from '../lib/agentGuard/index.js';
import { buildCliChildEnv, composeProviderEnv } from '../lib/cliChildEnv.js';
import { cliProviderAuthDescriptor } from '../lib/processEnv.js';
import { resolveAgentApiEnv } from './agentApiAuth.js';
import { ensureOllamaAgentContext } from './ollamaAgentContext.js';
import { isOllamaBackedProvider } from './providers.js';
import { shellHasLiveChild } from '../lib/shellLivenessProbe.js';
import { appendRunEvent } from './agentRunEventLog.js';

// The pure launch-shape builder. Re-exported rather than moved outright so
// `agentLifecycle.js` and the existing tests keep their entry point (#8021).
export { buildTuiSpawnConfig };

// Sentinel-file watching. TUI agents write `.agent-done` in their workspace
// when they've finished /simplify + /do:pr (or /do:push) — the session
// controller watches for it so the agent gets cleanly finalized as soon as the
// work is done, without waiting for a shell exit or repeatedly touching the
// filesystem.
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
  agentApiEnv = {},
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
  // The credential overlay both branches start from: the repo-owner GH_TOKEN and
  // the loopback PortOS API token (agentApiAuth.js). Both are resolved by the
  // caller and both are `{}` for a public-content stage, whose allowlist would
  // strip them regardless.
  const credentialEnv = { ...forgeTokenEnv, ...agentApiEnv };
  const env = restricted
    ? buildCliChildEnv({ before: credentialEnv, provider, model, cwd, guard: true, safetyProfile })
    : { ...composeProviderEnv({ before: credentialEnv, provider, model }), ...agentGuardEnv() };
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
      command: tuiConfig.spawnCommand,
      args: tuiConfig.spawnArgs,
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
    sessionId = shellService.spawnCommandSession(tuiConfig.spawnCommand, tuiConfig.spawnArgs, {
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
  isTruthyMetaFn,
  prOpenedBy,
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
  // the session controller's sentinel watcher) and then stops — it does NOT run
  // `/quit` (that is a UI command the agent can't invoke). The file watcher is
  // the primary finalize path; the controller's finish() also ingests the
  // sentinel directly so the summary is captured even if some other path (shell
  // exit) finalizes first. Resolved from the shared helper, so this is
  // byte-identical to the path the prompt told the agent to write.
  const doneSentinelPath = resolveDoneSentinelPath(cwd, agentId);
  // Every TUI that is a real coding harness drives its own push → PR → review
  // → merge, whether or not it can type `/do:pr` (#3733) — a Claude TUI runs
  // the slashdo command (`prOpenedBy: 'agent-slashdo'`),
  // codex/antigravity/grok/OpenCode run the plain `git`/`gh` equivalent from
  // the same prompt (`'agent-inline'`). A lean `--bare` session, and any task
  // shape whose prompt says "do NOT open a PR", hands the lifecycle back to
  // PortOS (`'portos'`). Resolved once up front (rather than inside finish())
  // so the merge-gate contract check and the completion dispatch finish() hands
  // off to read the same answer.
  const prOwnership = resolvePrOwnership({
    task,
    isTruthyMeta: isTruthyMetaFn,
    persistedPrOpenedBy: prOpenedBy,
    providerId: provider?.id,
    providerCommand: provider?.command,
    leanMode,
  });
  // Does this run's own task shape say it owed a merge (#5876)? Only the inline
  // prompt carries a **Merge Gate** section to hold it to — a `/do:pr` run
  // merges inside that one command, and a run PortOS backstops or that hands
  // the PR to a human (JIRA, claim flow) never owed one. So the contract check
  // in the controller is inert for all three — see mergeGateContract.js.
  const mergeGateIsOwed = mergeGateOwed({
    taskOpenPR: prOwnership.taskOpenPR,
    rendersInlinePrLifecycle: prOwnership.prOpenedBy === PR_OPENED_BY.AGENT_INLINE,
    leaveOpen: leavesPrForHuman(task),
  });

  // Output buffering + raw PTY spooling (parsed-line → output.txt/state,
  // raw bytes → raw.txt, both debounced) live in the extracted spooler so
  // this function stays orchestration. `appendLine` records a status line,
  // `pushRaw` queues a raw chunk, `drainLines`/`drainRaw` flush at finalize,
  // and `getOutputBuffer` reads the capped buffer for failure-analysis fallback.
  const spooler = createOutputSpooler({ agentId, outputFile, rawFile });
  const { appendLine } = spooler;

  // The live state machine. Created BEFORE the PTY, because its `handleData` /
  // `handleExit` are what open it; `attachSession` arms prompt delivery and the
  // polling timers once a session id exists. Every collaborator it needs from
  // the SERVICE layer is threaded in here — that is what keeps
  // `sessionController.js` a leaf with no edge back into this cluster, and what
  // makes the state machine drivable without a live PTY in a test.
  const controller = createTuiSessionController({
    agentId,
    task,
    runId,
    model,
    provider,
    prompt,
    tuiConfig,
    cwd,
    rawFile,
    executionId,
    laneName,
    isTruthyMetaFn,
    directLaunch,
    prOwnership,
    mergeGateIsOwed,
    spooler,
    session: {
      write: (sessionId, keys) => shellService.writeToSession(sessionId, keys),
      paste: (sessionId, text, options) => shellService.pasteToSession(sessionId, text, options),
      isAlive: (sessionId) => !!shellService.getSession(sessionId),
      kill: (sessionId) => shellService.killSession(sessionId),
      hasLiveChild: (pid) => shellHasLiveChild(pid),
    },
    persistence: {
      updateAgent,
      appendRunEvent,
      readRunRecord: () => activeAgents.get(agentId),
      releaseRunRecord: (pid) => {
        if (pid) unregisterSpawnedAgent(pid);
        activeAgents.delete(agentId);
      },
    },
    sentinel: {
      path: doneSentinelPath,
      exists: () => !!doneSentinelPath && existsSync(doneSentinelPath),
      read: () => readFile(doneSentinelPath, 'utf8'),
      remove: () => (doneSentinelPath ? rm(doneSentinelPath).catch(() => {}) : Promise.resolve()),
      watch: (onDetect) => (doneSentinelPath ? watchForFile(doneSentinelPath, onDetect) : null),
    },
    finalization: {
      finalizeAgent,
      finalizeRunCommon: finalizeAgentRunCommon,
      shouldAbandonRun: shouldAbandonAgentRun,
      resolveErrorAnalysis,
      runCompletionCleanup: runSpawnerCompletionCleanup,
    },
    // The forge lookup behind the Merge Gate contract check (#5876). Non-throwing:
    // a branch or PR probe that fails answers `null`, which the decision table
    // reads as "unreadable" and finalizes normally.
    probeMergeGatePr: async () => {
      const branchName = await git.getBranch(cwd).catch(() => null);
      if (!branchName) return null;
      return probePrForBranch(cwd, branchName).catch(() => null);
    },
  });

  // Repo-owner-pinned GH_TOKEN for the agent's own `gh pr create` (see
  // resolveForgeTokenEnv). Resolved here since createAgentTuiSession is sync.
  // Skip when the provider supplies its own GH_TOKEN/GITHUB_TOKEN so its explicit
  // credential wins — and skip for a public-content stage, which must never hold
  // a forge credential (the allowlist in createAgentTuiSession strips it anyway;
  // not resolving it means it is never read out of the keychain to begin with).
  const forgeTokenEnv = providerSuppliesGithubToken(provider) || isPublicReviewRestrictedProfile(safetyProfile)
    ? {}
    : await git.resolveForgeTokenEnv(cwd);

  // The loopback PortOS session token this agent's own `curl` snippets need when
  // the install has an instance password set (agentApiAuth.js). `buildSafeEnv`
  // allowlist-filters the inherited env for a login-shell PTY, so like GH_TOKEN
  // it only reaches the agent by riding the explicit delta below.
  const agentApiEnv = await resolveAgentApiEnv({ safetyProfile });

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
      agentApiEnv,
      doneSentinelPath,
      useDurableRunner,
      safetyProfile,
      onData: controller.handleData,
      onExit: controller.handleExit,
      onInitialCommandSent: controller.markCommandInjected,
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
    //
    // An unusable PTY LAYER joins that actionable set for the same reason: it
    // reproduces on every attempt, so retrying it as a transient rejection burns
    // MAX_TASK_RETRIES on every task in the fleet and buries the one line naming
    // the repair (see lib/ptySpawnDiagnostics.js).
    //
    // The runner's OTHER named fault — a workspace that vanished — deliberately
    // does NOT join it. Each retry provisions a fresh worktree at a fresh path, so
    // a reaped one is exactly the transient case `spawn-rejected` exists for;
    // blocking on it would park work a retry fixes. A cwd that is missing because
    // it is misconfigured (a managed app whose directory is gone) still surfaces —
    // it fails identically every attempt and blocks on MAX_TASK_RETRIES carrying
    // the runner's message, which is that reason's documented behavior.
    const reason = /^Command executable unavailable:/i.test(message)
      ? 'command-not-found'
      : message.startsWith(PTY_UNAVAILABLE_PREFIX)
        ? 'runner-pty-unavailable'
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
    await controller.finish({
      success: false,
      exitCode: 1,
      error: `Failed to start TUI session: ${message}`,
      reason,
    });
    return null;
  }
  const sessionId = session.sessionId;
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
  // this process. The controller's handleExit then finalizes the run while
  // createAgentTuiSession is still awaiting that response. Do not revive the
  // finalized agent by registering its returned session, timers, or active-agent
  // record; release the external shell session that was registered during the
  // late response.
  if (controller.isTerminal()) {
    if (sessionId && shellService.getSession(sessionId)) shellService.killSession(sessionId);
    return null;
  }

  if (!sessionId) {
    await controller.finish({ success: false, exitCode: 1, error: 'Failed to create TUI shell session', reason: 'spawn-error' });
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
  });

  // Arm prompt delivery, the provider-signal gates and the sentinel watcher.
  // AFTER the active-run entry exists: the controller's teardown reads that
  // record for the run's `startedAt`/`pid`, and a timer that fired between the
  // two would finalize against a record that wasn't there yet.
  controller.attachSession({ sessionId, pid });

  // Identify which TUI binary this session is running so consumers can gate
  // features that aren't universal — e.g. only Claude Code supports
  // bracketed-paste injection of post-spawn BTW messages; codex/gemini/lm-studio
  // TUIs don't.
  const tuiKind = tuiConfig.spawnCommand.split('/').pop().toLowerCase();
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
