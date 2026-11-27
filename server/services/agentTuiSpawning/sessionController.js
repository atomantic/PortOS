/** Coordinate prompt delivery, PTY signals, sentinel recovery and teardown for one TUI agent run. */
import { isCodexCommand } from '../../lib/codex.js';
import { createPromptDelivery } from './promptDelivery.js';
import { createPtyEventHandlers } from './ptyEventHandlers.js';
import { createSentinelTracker } from './sentinelTracker.js';
import { createSessionTeardown } from './sessionTeardown.js';

/**
 * Create the live session controller for one TUI agent run.
 *
 * Created BEFORE the PTY exists, because `handleData`/`handleExit` are what the
 * launcher needs to open it. `attachSession()` is the second half: once a
 * session id is known it arms prompt delivery, the provider-signal gates and
 * the sentinel watcher. A run that never gets that far (a spawn throw) still
 * finalizes correctly through `finish()`.
 *
 * @returns {{
 *   handleData: (data: unknown) => Promise<void>,
 *   handleExit: (event: object) => Promise<void>,
 *   markCommandInjected: () => void,
 *   refuseScanner: () => Promise<void>,
 *   isTerminal: () => boolean,
 *   finish: (outcome: object) => Promise<void>,
 *   attachSession: (session: { sessionId: string, pid: number|null }) => void,
 * }}
 */
export function createTuiSessionController({
  agentId,
  task,
  runId,
  model,
  provider,
  securityScanGrant,
  prompt,
  tuiConfig,
  cwd,
  rawFile,
  launchShape,
  prOwnership,
  mergeGateIsOwed,
  spooler,
  session,
  persistence,
  sentinel,
  finalization,
  probeMergeGatePr,
}) {
  const { appendLine } = spooler;
  // An exit can arrive before attachment. Refusals and failure evidence must
  // also remain visible across awaits in the completion decision.
  const run = { sessionId: null, terminalRefusal: null, immediateFallbackAnalysis: null, executionInterruption: null };
  let rawOutputBytes = 0;
  let submissionOutputBytes = null;
  const pushRaw = (text) => {
    rawOutputBytes += Buffer.byteLength(text, 'utf8');
    spooler.pushRaw(text);
  };
  const isCodexSession = isCodexCommand(tuiConfig.command);

  // Construction only wires the callbacks. The PTY, timers and watcher are
  // armed after all four collaborators exist.
  const sentinelTracker = createSentinelTracker({
    sentinel, appendLine,
    isTerminal: () => teardown.isTerminal(),
    hasRefusal: () => !!run.terminalRefusal,
    onDone: () => teardown.finish({ success: true, exitCode: 0, reason: 'agent-signaled-done' }),
  });
  const teardown = createSessionTeardown({
    agentId, task, runId, model, provider, tuiConfig, cwd, rawFile, prOwnership, mergeGateIsOwed,
    spooler, session, persistence, sentinel, finalization, probeMergeGatePr, run, sentinelTracker,
    resubmit: options => delivery.resubmit(options),
    getPromptProvenance: () => ({
      submitted: submissionOutputBytes !== null,
      bytesSinceSubmission: submissionOutputBytes === null ? null : rawOutputBytes - submissionOutputBytes,
      suppliedPrompt: prompt,
    }),
    stopTimersAndWatcher: () => {
      pty.stopTimers();
      delivery.stopTimer();
      sentinelTracker.stop();
      delivery.cancelPaste();
    },
  });
  const delivery = createPromptDelivery({
    agentId, prompt, tuiConfig, model, launchShape, session, run, isCodexSession, appendLine,
    isTerminal: teardown.isTerminal, finishStartupFailure: teardown.finishStartupFailure,
    recordSubmission: () => { submissionOutputBytes = rawOutputBytes; },
  });
  const pty = createPtyEventHandlers({
    agentId, task, runId, model, provider, securityScanGrant, tuiConfig, launchShape, session,
    persistence, appendLine, pushRaw, run, isCodexSession, delivery, teardown,
    sentinelPresent: sentinelTracker.sentinelPresent,
  });

  return {
    handleData: pty.handleData,
    handleExit: pty.handleExit,
    refuseScanner: () => {
      run.terminalRefusal = { category: 'content-refusal', origin: 'provider', permanent: true, actionable: false, requiresFallback: false,
        message: 'Security scanner safety refusal; automatic continuation, retries and provider fallback are disabled.' };
      run.executionInterruption = { category: 'content-refusal', source: 'security-scanner' };
      run.immediateFallbackAnalysis = run.terminalRefusal;
      delivery.cancelPaste();
      return teardown.finish({ success: false, exitCode: 1, error: run.terminalRefusal.message, reason: 'content-refusal' });
    },
    markCommandInjected: delivery.markCommandInjected,
    isTerminal: teardown.isTerminal,
    finish: teardown.finish,
    attachSession({ sessionId, pid }) {
      run.sessionId = sessionId;
      delivery.attach(pid);
      pty.startProviderTimer(pid);
      sentinelTracker.watch();
    },
  };
}
