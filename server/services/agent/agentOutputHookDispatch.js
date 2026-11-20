
import { isLegacyDeepAudit } from '../../lib/auditWorkflow.js';
import { PR_COMPLETIONS, resolvePrCompletion, } from '../../lib/prDisposition.js';
import { isAuditTaskType } from '../../lib/auditCatalog.js';
import { join } from 'path';
import { PATHS, safeJSONParse, tryReadFile, readFileTail } from '../../lib/fileUtils.js';
import { emitLog } from '../cos/cosEvents.js';
import { getAgent, getAgentRecord, updateAgent, } from '../cos/cosAgentLifecycle.js';
import { resolveTypeFailureSignal, } from './agentErrorAnalysis.js';
import { SKIP_LEARNING_VERDICT } from '../../lib/learningVerdict.js';
import { canRunTaskOutputHookWithoutPayload, getTaskOutputPayloadPredicate, isProgrammaticIoTaskType, resolveTaskHookType, getTaskOutputHook } from '../taskTypeHooks.js';

/**
 * Hard bound on output-hook dispatch (#2727). The hook is only awaited BEFORE
 * `completeAgent` so its verdict can be recorded — but `status: 'running'` is what
 * the CoS concurrency gate counts (`cos.js`, default 3 slots), and that flips in
 * completeAgent. So an un-bounded hook (it shells out to `gh`/`glab` and can walk
 * up to 50 embeddings for semantic dedup) would hold a slot for its whole
 * duration, and a HUNG one would hold it until restart — with the task stuck
 * `in_progress` and the orphan reaper protecting the zombie rather than reaping
 * it, because it too filters on `status === 'running'`.
 *
 * A timeout resolves to the "no verdict" sentinel, NOT a rejection: a hook we
 * stopped waiting for told us nothing about the agent's output, so finalize
 * proceeds and task-learning falls back to the exit code (the pre-#2727
 * behavior). Generous by design — this is a hang backstop, not a latency budget;
 * a slow-but-honest hook should still get to return its real verdict.
 *
 * Timing out only stops us WAITING — it can't cancel the hook, which keeps running
 * and still lands its side effects (filing the issue, recording the run). That's
 * the desired trade: the work completes, it just no longer pins a concurrency slot
 * or gates the completion write. A late rejection is still handled (Promise.race
 * subscribes to both), so it can't surface as an unhandled rejection.
 */
const OUTPUT_HOOK_TIMEOUT_MS = 5 * 60_000;
const outputHookDispatches = new Map();

export function withOutputHookTimeout(promise, { agentId, timeoutMs = OUTPUT_HOOK_TIMEOUT_MS }) {
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => {
      // Resolve BEFORE logging, and never let the log throw out of the callback:
      // this runs outside the request lifecycle, so an uncaught throw here would
      // crash the process — and a throw before `resolve` would leave the race
      // permanently unsettled, wedging the exact finalize this timer exists to
      // rescue.
      resolve({ ran: false, timedOut: true });
      try {
        emitLog('error', `⏱️ processTaskOutput hook timed out after ${timeoutMs}ms for ${agentId} — finalizing with no verdict`, { agentId });
      } catch (err) {
        console.error(`❌ Failed to log output-hook timeout for ${agentId}: ${err.message}`);
      }
    }, timeoutMs);
    // Never let the backstop itself hold the event loop open.
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Run an agent's task-type output hook at most once, including completion paths
 * that bypass finalizeAgent after a restart or orphan reap.
 *
 * The persisted marker closes the sequential normal/recovery gap; the per-agent
 * promise closes the smaller same-process race where two completion paths both
 * observe a running, unmarked agent before either hook finishes.
 *
 * @returns {Promise<
 *   | { ran: false }                                  // no hook for the task type (or audit type)
 *   | { ran: false, recoveryPayloadUnavailable: true } // recovery, payload-dependent hook, no payload
 *   | { ran: false, alreadyDispatched: true }          // persisted marker found
 *   | { ran: true, outcome: * }                        // hook ran
 *   | { ran: true, threw: true }                       // hook threw (logged)
 *   | { timedOut: true }                               // hook still running past the backstop
 * >}
 */
export function dispatchTaskOutputHookOnce({
  agentId,
  task,
  success,
  workspacePath = null,
  recovery = false,
}) {
  const existing = outputHookDispatches.get(agentId);
  if (existing) return existing;

  const persistDispatchMarker = async (result) => {
    if (result.auditAssessment) {
      await updateAgent(agentId, { metadata: { auditAssessment: result.auditAssessment } })
        .catch(err => emitLog('warn', `⚠️ Failed to persist audit assessment status for ${agentId}: ${err.message}`, { agentId }));
    }
    if (!result.ran) return;
    // Best-effort durability: completion must continue if the marker write
    // fails, while the in-flight promise still protects concurrent callers
    // this cycle.
    await updateAgent(agentId, {
      metadata: { outputHookDispatchedAt: new Date().toISOString(),
        outputHookValidationPassed: resolveProgrammaticIoVerdict({ success, hookResult: result }) }
    }).catch(err => {
      emitLog('warn', `⚠️ Failed to persist output-hook dispatch marker for ${agentId}: ${err.message}`, { agentId });
    });
  };

  const dispatch = (async () => {
    const agent = await getAgent(agentId).catch(() => null);
    // A saved assessment survives sentinel/worktree cleanup. Failed writes stay
    // retryable on recovery rather than being mistaken for a successful report.
    const savedAssessment = [agent?.metadata?.auditAssessment, agent?.result?.auditAssessment]
      .find(assessment => assessment?.status === 'recorded');
    if (!isLegacyDeepAudit(task.metadata) && isAuditTaskType(resolveTaskHookType(task)) && savedAssessment?.status === 'recorded'
      && (Number(task.metadata?.auditDispositionVersion) !== 1 || agent?.metadata?.auditFindings?.status === 'complete')) {
      return { ran: false, auditAssessment: savedAssessment,
        ...(Number(task.metadata?.auditDispositionVersion) === 1 ? { auditDisposition: { status: 'complete' } } : {}) };
    }
    if (agent?.metadata?.outputHookDispatchedAt) {
      return { ran: false, alreadyDispatched: true,
        ...(typeof agent.metadata.outputHookValidationPassed === 'boolean' ? { validationPassed: agent.metadata.outputHookValidationPassed } : {}) };
    }

    const hookDispatch = dispatchTaskOutputHook({
      assessedAt: agent?.startedAt,
      agentId,
      task,
      success,
      workspacePath,
      recovery,
    }).catch(err => {
      emitLog('error', `❌ processTaskOutput hook threw for ${agentId} (${task?.taskType}): ${err.message}`, { agentId, error: err.message });
      return { ran: true, threw: true };
    });
    const result = await withOutputHookTimeout(hookDispatch, { agentId });

    if (result.timedOut) {
      // The hook is still running. Keep this dispatch in the in-process map so
      // another completion path cannot start a duplicate, and persist the
      // durable marker only after the original hook actually settles. If the
      // process exits first, restart recovery remains free to retry it.
      hookDispatch
        .then(persistDispatchMarker)
        .finally(() => {
          if (outputHookDispatches.get(agentId) === dispatch) {
            outputHookDispatches.delete(agentId);
          }
        });
    } else {
      await persistDispatchMarker(result);
    }
    return result;
  })();

  outputHookDispatches.set(agentId, dispatch);
  dispatch.then(result => {
    if (!result.timedOut && outputHookDispatches.get(agentId) === dispatch) {
      outputHookDispatches.delete(agentId);
    }
  }).catch(() => {
    if (outputHookDispatches.get(agentId) === dispatch) {
      outputHookDispatches.delete(agentId);
    }
  });
  return dispatch;
}

/**
 * Recovery paths try the agent's persisted workspace when it still exists.
 * When it does not, only hooks whose registry contract says they are
 * payload-independent may run with null output.
 *
 * Returns the deduped dispatch promise ITSELF — concurrent normal/recovery
 * completions must share one, and a timed-out hook stays recoverable until that
 * original settles — so this stays a pass-through with no side effects of its
 * own. Sentinel retirement lives at the two recovery call sites, after the read.
 */
export function dispatchRecoveredTaskOutputHook({ agentId, task, success, workspacePath = null }) {
  return dispatchTaskOutputHookOnce({
    agentId,
    task,
    success,
    workspacePath,
    recovery: true,
  });
}

// Tail of the agent's transcript scanned by the rescue. The deliverable, when
// printed, is the LAST thing the model emits, and a reasoner envelope is a few
// KB at most — but a repaint-heavy TUI spends most of its bytes on escape
// sequences, so the window is generous relative to the payload. Bounded for the
// same reason RAW_TAIL_ANALYSIS_BYTES is: neither transcript file has an upper
// size limit on a long run.
const TRANSCRIPT_RESCUE_TAIL_BYTES = 256 * 1024;

// Transcript spools, in the order the rescue reads them. A PTY/TUI run spools
// its terminal to raw.txt; a direct CLI run (every public-review stage, and any
// cli-typed provider) has ONLY output.txt, so reading raw.txt alone made the
// tool-free Eligibility Gate's printed JSON invisible and a valid decision was
// rejected as eligibility-response-invalid. Each source is tried until one
// yields a payload rather than stopping at the first that merely EXISTS: a
// repaint-heavy raw.txt can interleave the answer past reconstruction while the
// parsed output.txt beside it still holds it intact.
const TRANSCRIPT_RESCUE_FILES = ['raw.txt', 'output.txt'];

/**
 * Recover a programmatic-I/O deliverable the agent PRINTED to its terminal
 * instead of writing to `.agent-done` (#3640). Returns the payload, or null
 * when the type opts out (no shape predicate), the spool is unreadable, or
 * nothing in the transcript matches the hook's expected shape — in which case
 * the caller behaves exactly as it did before this existed.
 *
 * Gated to programmatic-I/O types on purpose: everywhere else the sentinel is a
 * completion SIGNAL rather than the product, and scraping a transcript for one
 * would let an agent that merely discussed finishing be treated as finished.
 */
async function rescueTranscriptPayload({ agentId, taskType }) {
  if (!agentId || !isProgrammaticIoTaskType(taskType)) return null;
  // Sanctioned try/catch (see AGENTS.md — this runs outside the request
  // lifecycle): a best-effort salvage must never be able to make the outcome
  // WORSE than not attempting it. A hook whose own shape predicate throws would
  // otherwise abort the dispatch and skip the hook entirely, turning "we
  // couldn't recover the payload" into "the hook never ran".
  try {
    const isPayload = await getTaskOutputPayloadPredicate(taskType);
    if (!isPayload) return null;
    const { extractSentinelPayloadFromTranscript } = await import('../../lib/agent/agentSentinel.js');
    for (const file of TRANSCRIPT_RESCUE_FILES) {
      const transcript = await readFileTail(join(PATHS.cosAgents, agentId, file), TRANSCRIPT_RESCUE_TAIL_BYTES);
      if (!transcript) continue;
      const { payload } = await extractSentinelPayloadFromTranscript(transcript, isPayload);
      if (payload != null) return payload;
    }
    return null;
  } catch (err) {
    emitLog('warn', `⚠️ Transcript payload rescue failed for ${agentId} (${taskType}): ${err.message}`, { agentId });
    return null;
  }
}

/**
 * Accept a legacy hook payload written directly to the sentinel. The generic
 * sentinel parser intentionally treats an object without `payload` as a plain
 * summary, but older programmatic-I/O prompts (including issue-watcher's first
 * version) told agents to write the hook payload at the top level. Only accept
 * that shape when the task's own predicate confirms it, and never reinterpret a
 * structured envelope or a plain-text summary as a bare payload.
 */
async function recoverBareSentinelPayload(contents, taskType) {
  if (typeof contents !== 'string' || !isProgrammaticIoTaskType(taskType)) return null;
  try {
    const candidate = safeJSONParse(contents, null, { allowArray: false, logError: false });
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
      || Object.hasOwn(candidate, 'summary') || Object.hasOwn(candidate, 'payload')) return null;
    const isPayload = await getTaskOutputPayloadPredicate(taskType);
    return typeof isPayload === 'function' && isPayload(candidate) ? candidate : null;
  } catch (err) {
    // This is a completion boundary, outside the Express request lifecycle. A
    // malformed legacy payload must leave the normal missing-payload verdict
    // intact rather than aborting finalization.
    emitLog('warn', `⚠️ Bare sentinel payload recovery failed for ${taskType}: ${err.message}`, { taskType });
    return null;
  }
}

/**
 * Opt-in only: an app with `publishQualitySnapshot` gets its freshly recorded
 * measurement landed as the repo's `.quality.json` through an
 * immediately-merged pull request. This is a completion boundary outside the Express request
 * lifecycle, so a missing repo, a git failure, or a locked index must log and
 * let finalization finish.
 */
async function publishAppSnapshotFileAfterAudit(appId) {
  if (!appId) return;
  try {
    const { getAppById } = await import('../apps.js');
    const app = await getAppById(appId);
    if (app?.publishQualitySnapshot !== true) return;
    const { publishAppQualitySnapshot } = await import('../appQualitySnapshotFile.js');
    await publishAppQualitySnapshot(app);
  } catch (err) {
    emitLog('error', `❌ Quality snapshot publish failed for app ${appId}: ${err.message}`, { appId });
  }
}

// A run is a clean baseline only when it succeeded, recorded its assessment and
// that assessment verified no material finding (worstSeverity 0) from a real
// scan; anything else drops the baseline so the next launch runs.
async function recordInputGateBaseline({ task, taskType, agentId, success, auditAssessment, workspacePath }) {
  const appId = task?.metadata?.app;
  const { TASK_INPUT_PATHS } = await import('../taskScheduleRegistry.js');
  if (!appId || !TASK_INPUT_PATHS[taskType]) return;
  const { doneSentinelPath, parseSentinelPayload } = await import('../../lib/agent/agentSentinel.js');
  const { parseAuditQualityReport } = await import('../../lib/auditQuality.js');
  const path = workspacePath ? doneSentinelPath(workspacePath, agentId) : null;
  const report = success && auditAssessment.status === 'recorded' && path
    ? parseAuditQualityReport(parseSentinelPayload(await tryReadFile(path)).summary, taskType) : null;
  const clean = report?.worstSeverity === 0 && report.scannedFiles > 0;
  const { readHead } = await import('../taskInputGate.js');
  const { recordCleanInputBaseline } = await import('../taskSchedule.js');
  const head = clean ? await readHead(workspacePath) : null;
  await recordCleanInputBaseline(taskType, appId, head).catch(err => {
    emitLog('warn', `⚠️ Input-gate baseline was not saved for ${taskType}: ${err.message}`, { taskType, agentId });
  });
}

/**
 * Where a hook's `.agent-done` payload may be read from. A live completion falls
 * back to the task's repoPath; a recovery run trusts only the persisted
 * workspace — without it there is nothing safe to read, so no payload.
 */
function hookPayloadDir({ task, workspacePath, recovery }) {
  return recovery
    ? (workspacePath || null)
    : (workspacePath || task?.metadata?.repoPath || null);
}

/**
 * Read this agent's sentinel payload from `cwd`, trying in order: strict parse,
 * lenient JSON salvage, bare legacy payload, then transcript rescue. Returns the
 * payload or null.
 */
async function readHookPayload({ agentId, taskType, cwd }) {
  const { doneSentinelPath, parseSentinelPayload, salvageSentinelPayload } = await import('../../lib/agent/agentSentinel.js');
  // This run's own sentinel (see doneSentinelName) — in a shared workspace a
  // sibling agent's file must not be consumed as this run's deliverable.
  const contents = await tryReadFile(doneSentinelPath(cwd, agentId));
  const strict = parseSentinelPayload(contents).payload;
  if (strict != null) return strict;
  // A less-capable (often local) reasoner can emit an almost-valid
  // `{ summary, payload }` envelope — ```json-fenced, prose-trailed, or with
  // raw newlines in the markdown body — that strict parse rejects, dropping a
  // real proposal as "unparseable-response" and filing nothing. Before giving
  // up, run the robust LLM-JSON extractor over the raw sentinel.
  const salvaged = await salvageSentinelPayload(contents);
  if (salvaged.payload != null) {
    emitLog('info', `Recovered structured .agent-done payload for ${agentId} (${taskType}) via lenient JSON extraction`, { agentId });
    return salvaged.payload;
  }
  if (contents != null) {
    // Compatibility for programmatic-I/O prompts that predate the structured
    // `{ summary, payload }` envelope and wrote the hook payload directly.
    const bare = await recoverBareSentinelPayload(contents, taskType);
    if (bare != null) {
      emitLog('info', `Recovered legacy bare .agent-done payload for ${agentId} (${taskType})`, { agentId });
    }
    return bare;
  }
  // No sentinel at all: the model may have PRINTED its deliverable into the
  // TUI instead of writing the file (#3640). Only when `contents == null` — a
  // sentinel the agent DID write, whose content simply isn't a payload, keeps
  // its own (correct) missing-output verdict.
  const rescued = await rescueTranscriptPayload({ agentId, taskType });
  if (rescued != null) {
    emitLog('info', `Recovered printed payload for ${agentId} (${taskType}) from the transcript — no .agent-done was written`, { agentId });
  }
  return rescued;
}

/**
 * Read the finished agent's `.agent-done` payload and run the task type's
 * `processTaskOutput` hook, if it registers one. No-op for the vast majority of
 * task types (no hook). The hook receives `{ appId, success, payload, ... }` and
 * loads its own app/config — finalizeAgent stays domain-agnostic.
 */
export async function dispatchTaskOutputHook({ agentId, task, success, workspacePath, assessedAt, recovery = false }) {
  // Shared resolver with evaluateSuccessCriteria's gate — "runs a hook" and "gets
  // the programmatic-I/O criterion" must stay the same question (#2727).
  const taskType = resolveTaskHookType(task);
  if (!taskType) return { ran: false };
  if (isAuditTaskType(taskType)) {
    if (taskType === 'security') {
      const { parseSecurityScanEvidence } = await import('../../lib/securityScanEvidence.js');
      const { doneSentinelPath, parseSentinelPayload } = await import('../../lib/agent/agentSentinel.js');
      const cwd = hookPayloadDir({ task, workspacePath, recovery });
      const path = doneSentinelPath(cwd, agentId);
      const summary = path ? parseSentinelPayload(await tryReadFile(path)).summary : null;
      const evidence = parseSecurityScanEvidence(summary);
      // Record even on failed delivery; absence must not erase earlier evidence
      // during completion replay. This stays in the machine-local agent record.
      const existing = await getAgentRecord(agentId);
      if (evidence && existing?.metadata?.securityScan?.source !== 'runner') await updateAgent(agentId, { metadata: { securityScan: evidence } }).catch(err => {
        emitLog('warn', `⚠️ Scanner diagnostics were not saved for ${agentId}: ${err.message}`, { agentId });
      });
    }
    if ((taskType === 'code-quality' || taskType === 'architecture-maintainability') && success) {
      // The triage lane's ranked "Recommended next audits" (#12085) lands on the
      // task's execution record so the Schedule card shows where to look next.
      const { parseRecommendedAudits } = await import('../../lib/auditQuality.js');
      const { doneSentinelPath, parseSentinelPayload } = await import('../../lib/agent/agentSentinel.js');
      const { recordRecommendedAudits } = await import('../taskSchedule.js');
      const path = doneSentinelPath(hookPayloadDir({ task, workspacePath, recovery }), agentId);
      const summary = path ? parseSentinelPayload(await tryReadFile(path)).summary : null;
      await recordRecommendedAudits(taskType, task.metadata?.app || null, parseRecommendedAudits(summary)).catch(err => {
        emitLog('warn', `⚠️ Recommended next audits were not saved for ${agentId}: ${err.message}`, { agentId });
      });
    }
    const auditDisposition = Number(task.metadata?.auditDispositionVersion) === 1
      ? await (await import('../auditFindings.js')).settleAuditFindings({
        task, agentId, workspacePath: hookPayloadDir({ task, workspacePath, recovery }),
      }).catch(() => ({ status: 'incomplete', reason: 'Finding register persistence or verification failed' })) : null;
    const { recordAuditQuality } = await import('../appQuality.js');
    const auditAssessment = await recordAuditQuality({ task, taskType, agentId, success, assessedAt,
      workspacePath: hookPayloadDir({ task, workspacePath, recovery }) })
      .then(recorded => ({ status: recorded === true ? 'recorded' : success ? 'not-recorded' : 'not-attempted' }))
      .catch(err => {
        emitLog('warn', `⚠️ Audit quality was not saved for ${agentId}: ${err.message}`, { agentId });
        return { status: 'persistence-failed' };
      });
    const recorded = auditAssessment.status === 'recorded';
    await recordInputGateBaseline({ task, taskType, agentId, success, auditAssessment, workspacePath: hookPayloadDir({ task, workspacePath, recovery }) })
      .catch(err => emitLog('warn', `⚠️ Input-gate baseline failed for ${agentId}: ${err.message}`, { agentId }));
    // A review-only run must not land a separate snapshot behind the user's back.
    if (!isLegacyDeepAudit(task.metadata) && recorded === true && resolvePrCompletion(task?.metadata) !== PR_COMPLETIONS.LEAVE_OPEN) {
      await publishAppSnapshotFileAfterAudit(task?.metadata?.app);
    }
    // Assessment telemetry never waives commit/PR success criteria for fix mode.
    return { ran: false, auditAssessment, ...(auditDisposition ? { auditDisposition } : {}) };
  }
  const hook = await getTaskOutputHook(taskType);
  if (!hook) return { ran: false };

  const cwd = hookPayloadDir({ task, workspacePath, recovery });
  const payload = cwd ? await readHookPayload({ agentId, taskType, cwd }) : null;
  if (recovery && payload == null && !canRunTaskOutputHookWithoutPayload(taskType)) {
    return { ran: false, recoveryPayloadUnavailable: true };
  }

  const outcome = await hook({
    appId: task?.metadata?.app || null,
    success,
    payload,
    workspacePath: cwd,
    agentId,
    task,
  });
  // The outcome's `reason` is what lets finalizeAgent count a "completed" run
  // that produced nothing usable (`unparseable-response`) as a type-level
  // failure (#2616) — an exit-0 run whose structured output couldn't be parsed.
  return { ran: true, outcome };
}

/**
 * The programmatic-I/O success criterion (#2727): "the agent's structured output
 * parsed and the output hook accepted it". Pure.
 *
 * The question this answers is about the AGENT'S OUTPUT, not about whether the
 * hook's downstream side effect ultimately landed. So a hook that accepted the
 * payload and then couldn't reach the tracker (`file-failed`, `tracker-read-failed`)
 * is NOT a failure of the run: the reasoning was sound and delivered, and a forge
 * outage is environmental. Blaming the run would tank the type's measured success
 * rate — and, through the shared classification below, auto-park the whole task
 * type — every time `gh` has a bad afternoon. Deliberate, not inherited: raised in
 * review on #2727 and kept.
 *
 * Delegates the accept/reject classification to `resolveTypeFailureSignal`, the
 * same pure decision the #2616 type-level failure ledger uses — so the learning
 * verdict and the ledger can never drift apart on what counts as a bad run, and a
 * new benign reason only has to be taught to one function.
 *
 * Sentinel discipline throughout — FOUR distinct answers, never collapsed:
 *   - `false` — the hook ran and REJECTED the output (threw, or `unparseable-response`).
 *   - `null`  — NOTHING evaluated the output (no hook ran, it timed out, or it
 *     returned no structured outcome), so no criterion was declared and
 *     task-learning falls back to the exit code exactly as before. "Not evaluated"
 *     must never become "accepted".
 *   - `true`  — the hook ran and accepted the output.
 *   - `SKIP_LEARNING_VERDICT` — the hook aborted BEFORE it could look at the
 *     output at all (`no-app` / `app-not-found`), so there is nothing to learn
 *     from and the run must not be recorded (#4107). Distinct from `null`,
 *     which still records the run against its exit code.
 *
 * @returns {boolean|null|'skip-learning'} true = accepted, false = rejected,
 *   null = undeclared, SKIP_LEARNING_VERDICT = do not record this run
 */
export function resolveProgrammaticIoVerdict({ success, hookResult }) {
  if (hookResult?.alreadyDispatched && typeof hookResult.validationPassed === 'boolean') return hookResult.validationPassed;
  if (!hookResult?.ran) return null;
  // A thrown hook rejected the output. Classified FIRST: it carries no outcome (so
  // it must precede the outcome-shape guard), and a rejection shouldn't hinge on
  // the exit-code guard below.
  if (hookResult.threw) return false;
  // An absent/non-boolean exit-code verdict can't be weighed against anything.
  if (typeof success !== 'boolean') return null;
  // Ran, but handed back no structured outcome to read: nothing evaluated the
  // output, so declare no verdict rather than defaulting to "accepted".
  if (!hookResult.outcome || typeof hookResult.outcome !== 'object') return null;
  // Ran, but bailed out BEFORE it ever looked at the output (its app was deleted
  // mid-run, or the task carries no app). Nothing evaluated the agent's work and
  // the hook itself recorded nothing, so there is no honest verdict to bank:
  // `false` would blame the model for a user deleting an app mid-run (and poison
  // the #2329 failure-signature window with a non-failure), and the `null`
  // sentinel this used to return still recorded the run against its EXIT CODE —
  // an exit-0 run banked a free success for the task type (#4107). Skip the
  // learning write entirely instead.
  if (HOOK_ABORTED_BEFORE_EVALUATION.has(hookResult.outcome.reason)) return SKIP_LEARNING_VERDICT;
  if (hookResult.outcome.accepted === false) return false;
  if (hookResult.outcome.accepted === true) return true;
  return resolveTypeFailureSignal({ success, hookResult }).record === 'success';
}

// Output-hook outcomes that mean "the hook returned before validating the agent's
// output at all" — distinct from both a rejection and an acceptance.
const HOOK_ABORTED_BEFORE_EVALUATION = new Set(['no-app', 'app-not-found']);
