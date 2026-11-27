/** Decide and finalize TUI run outcomes, including merge-gate retries and host shutdown. */
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { readFile } from 'fs/promises';
import { emitLog } from '../cos/cosEvents.js';
import { HOST_SHUTDOWN_REASON } from '../../lib/hostShutdown.js';
import { missingSentinelLogMessage } from '../../lib/agent/agentSentinel.js';
import { LIFECYCLE_LINES } from '../../lib/agent/agentOutputMarkers.js';
import { resolveMergeGateVerdict, buildMergeGateReprompt } from '../../lib/mergeGateContract.js';
import { stripAnsi } from '../../lib/ansiStrip.js';

export function createSessionTeardown({
  agentId, task, runId, model, provider, tuiConfig, cwd, rawFile, prOwnership, mergeGateIsOwed,
  spooler, session, persistence, sentinel, finalization, probeMergeGatePr, run, sentinelTracker,
  getPromptProvenance, resubmit, stopTimersAndWatcher,
}) {
  const { appendLine, flushRaw, drainLines, drainRaw, getOutputBuffer } = spooler;
  const { sentinelPresent, ingestDoneSentinel } = sentinelTracker;
  /**
   * Where this session is in its lifecycle — the one value every path that
   * ends a run reads and writes.
   *
   *   'running'   — live; finish() accepts a trigger.
   *   'finishing' — a finish() call is mid-decision. The merge-gate contract
   *                 check (#5876) adds awaits before that call can say whether
   *                 it finalizes at all, so this is set SYNCHRONOUSLY to park a
   *                 second trigger arriving in that window. Goes back to
   *                 'running' if the call decides not to finalize after all.
   *   'finalized' — an outcome was recorded.
   *   'abandoned' — PortOS went down mid-run (#3202): no outcome recorded, the
   *                 worktree preserved for the resume.
   *
   * Named `sessionPhase`, not `phase`, because `abandonForHostShutdown` also
   * writes a `phase: 'interrupted'` breadcrumb into the agent RECORD's
   * metadata a few lines from where it sets this — two different phases with
   * two different vocabularies, and collapsing their names is the mistake this
   * value exists to undo.
   */
  let sessionPhase = 'running';
  /**
   * Both end states are terminal: the run is over, and the sentinel watcher,
   * the PTY data handler, the prompt and provider-signal timers and the paste
   * controller must all become no-ops for the rest of this process's life. An
   * abandoned run is no less over than a finalized one — it just has no
   * outcome — so both stop everything.
   */
  const isTerminal = () => sessionPhase === 'finalized' || sessionPhase === 'abandoned';
  // A finish() call's args, parked because the session was already 'finishing'
  // when it arrived — replayed if the call that was deciding ends up NOT
  // finalizing (see finish()'s own comments on both).
  let pendingFinish = null;
  // Caps the merge-gate re-prompt (#5876) at once per run — a local closure
  // counter is enough: the check only ever runs from this same live process,
  // and a fresh spawn (a real retry) starts a fresh closure with its own flag.
  let mergeGateReprompted = false;

  /**
   * Merge Gate contract check (#5876) — runs on a successful sentinel, before
   * ANY teardown, for a run whose own task shape said it owed a merge. Asks
   * the forge whether the PR this run opened actually landed and, if it is
   * still open with no blocker stated in the agent's own summary, re-pastes
   * one corrective nudge into the still-attached session instead of paying
   * for a cold recovery agent (`agentRepoStateVerification.js`) to do the
   * same merge later. See mergeGateContract.js for the decision table.
   *
   * The caller (runFinishDecision) checks `mergeGateIsOwed` and the
   * once-per-run `mergeGateReprompted` cap synchronously before calling, so a
   * run that owes no merge finalizes without an extra await in its path.
   *
   * @returns {Promise<boolean>} true when a re-prompt went out — the caller
   *   must NOT finalize this call; false means finalize normally.
   */
  const checkMergeGateCompliance = async (summary) => {
    const prProbe = await probeMergeGatePr();
    const verdict = resolveMergeGateVerdict({ prProbe, summary });
    if (verdict !== 'needs-reprompt') return false;
    if (run.terminalRefusal) return false;
    if (!resubmit({ text: buildMergeGateReprompt(prProbe.prUrl || '<PR_URL>'), label: 'merge-gate contract nudge' })) {
      // Session is already gone — nothing to nudge; fall through to finalize.
      return false;
    }
    mergeGateReprompted = true;
    // Reopen the completion window: a fresh `.agent-done` write after the
    // nudge must be re-ingested (not silently skipped by the once-only guard)
    // and needs a brand-new watcher — the original already closed itself on
    // its first (this) detection.
    try {
      await sentinel.remove();
    } catch (err) {
      // Re-arming against the old sentinel would read stale completion.
      emitLog('warn', `Could not clear the TUI merge-gate sentinel for ${agentId}: ${err?.message || err}`, { agentId });
      return false;
    }
    sentinelTracker.reopen();
    appendLine(LIFECYCLE_LINES.mergeGateReprompted());
    emitLog('warn', `🔁 Merge-gate contract nudge sent for ${agentId} — PR still OPEN with no stated blocker`, { agentId });
    return true;
  };

  const stopRunMachinery = () => {
    stopTimersAndWatcher();
    return persistence.readRunRecord();
  };

  /**
   * Everything this run held, released in one place: its own `.agent-done`
   * sentinel, the shared completion dispatch, the pid registration, the
   * active-run entry, and the PTY session.
   *
   * Called from `finish()`'s `finally`, so it must run even when `finalizeAgent`
   * threw — a memory-extraction crash would otherwise strand the worktree and
   * the shell session on disk.
   */
  const releaseRunResources = async ({ agentData, cleanupSuccess, prClaimVerified, branchProvenEmpty }) => {
    // Pipeline progression → worktree cleanup with the PR disposition →
    // sentinel removal → retry-hold release, in the one owner every completion
    // path shares. Caught so a throw there cannot skip the in-memory teardown
    // below — this runs off a PTY exit, outside any request lifecycle.
    await finalization.runCompletionCleanup({
      agentId,
      task,
      success: cleanupSuccess,
      prOwnership,
      prClaimVerified,
      branchProvenEmpty,
      outputBuffer: getOutputBuffer(),
    }).catch(err => {
      persistence.markUnsettled?.();
      emitLog('warn', `TUI completion cleanup failed for ${agentId}: ${err.message}`, { agentId });
    });
    if (sentinel.cleanup) {
      await sentinel.cleanup().catch(err => {
        persistence.markUnsettled?.();
        emitLog('warn', `TUI recovery sentinel cleanup failed for ${agentId}: ${err.message}`, { agentId });
      });
    }

    // Stop this finished writer before releasing its execution binding. The
    // adapter then awaits deterministic retirement; no scheduled wake is owed.
    if (run.sessionId && session.isAlive(run.sessionId)) await session.kill(run.sessionId);
    await persistence.releaseRunRecord(agentData?.pid ?? null);
  };

  /**
   * Decide what one finish() call does, as a single explicit verdict. Runs
   * while `sessionPhase` is 'finishing'; finish() interprets the result and
   * owns every phase transition and the parked-trigger replay, so a new exit
   * here cannot strand the run in 'finishing' with its timers already cleared.
   *
   *   { type: 'abandon' }  — PortOS is going down; record no outcome.
   *   { type: 'finalize' } — record the outcome.
   *   { type: 'retry-later' | 'reprompt', replayParked } — NOT finalizing:
   *     the session goes back to 'running', and a trigger parked during this
   *     decision is replayed per `replayParked`:
   *       'always'         — replay it; it may be the only news the session died.
   *       'if-no-sentinel' — replay it only while no sentinel is present. A
   *                          present sentinel means the agent finished, so a
   *                          late exit carries no news; the recovery retry
   *                          re-reads that sentinel instead.
   *
   * Order matters: `ingestDoneSentinel` runs before `checkMergeGateCompliance`,
   * which mutates the sentinel state (clears `sentinelIngested`, deletes the
   * file, re-arms the watcher) — so finish() reopens the phase only after this
   * whole function settles.
   */
  const runFinishDecision = async ({ success, reason }) => {
    if (run.terminalRefusal) return { type: 'finalize' };
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
    // run the user paused already has its own don't-finalize branch in finish(),
    // which owns the paused bookkeeping (pid unregister, active-run delete).
    if (finalization.shouldAbandonRun({ agentId, sentinelPresent: sentinelPresent() })) {
      return { type: 'abandon' };
    }

    // Ingest the .agent-done sentinel BEFORE any teardown decision, so its
    // markdown summary lands in outputBuffer/output.txt regardless of WHICH
    // path finalized the agent, AND so the merge-gate contract check right
    // below reads the same text without a second file read. The completion
    // workflow writes the sentinel and stops; the 2s doneSentinelWatcher is
    // what normally calls finish(). Idempotent via `sentinelIngested`.
    const sentinelSummary = await ingestDoneSentinel();

    if (run.terminalRefusal) return { type: 'finalize' };

    if (sentinelTracker.retryRecoveryIfPending()) {
      return { type: 'retry-later', replayParked: 'if-no-sentinel' };
    }

    // Merge Gate contract check (#5876): only for a run that actually
    // succeeded AND signaled that success via a real `.agent-done` summary —
    // an ordinary clean exit with no sentinel (or one with an empty summary)
    // is not the "the agent believes its Merge Gate is done" signal this
    // reads; re-prompting THAT would paste into a shell whose TUI child may
    // already be gone, parking the run on a nudge that can never land.
    // True (and this call does NOT finalize) exactly once, when the run owed
    // a merge, the PR is open, and the summary names no blocker — see
    // mergeGateContract.js for the full decision table. The re-prompt expects
    // a fresh completion signal; a trigger that arrived while this was
    // deciding is the only thing that could say the session died meanwhile.
    //
    // Never when a PTY exit (`shell-*`) is the deciding trigger: a dead
    // session cannot answer the nudge, and `tui:exit` is already consumed, so
    // nothing would ever finish the run. `resubmit()` cannot be the liveness
    // test — a runner proxy accepts writes after its PTY died (#11861). The
    // still-open PR takes the post-finalize merge path instead.
    const sessionExited = reason?.startsWith('shell-');
    if (success && sentinelSummary !== null && mergeGateIsOwed && !mergeGateReprompted && !sessionExited
      && await checkMergeGateCompliance(sentinelSummary)) {
      return { type: 'reprompt', replayParked: 'always' };
    }

    return { type: 'finalize' };
  };

  const finish = async ({ success, exitCode = 0, error = null, reason = 'completed' }) => {
    // A terminal check alone used to be the whole re-entrancy guard, safe
    // because it was set SYNCHRONOUSLY as this function's first act. The
    // merge-gate check needs `ingestDoneSentinel`'s summary before it can
    // decide whether to finalize at all, which pushes the terminal transition
    // past several awaits — wide enough for a second trigger (the shell exiting
    // right after the sentinel appears) to also pass the gate before the first
    // call sets it, double-firing `finalizeAgent`. 'finishing' closes that
    // window synchronously while staying NON-terminal, which is what
    // `pasteController.resubmit()` depends on: a re-prompt must still be
    // possible while this call is deciding.
    //
    // A trigger parked here while the first call is mid-decision is not
    // discarded outright: the decision's `replayParked` policy says whether
    // it is replayed once that call settles on "not finalizing after all".
    if (isTerminal()) return;
    if (sessionPhase === 'finishing') {
      pendingFinish = { success, exitCode, error, reason };
      return;
    }
    sessionPhase = 'finishing';

    let decision = { type: 'finalize' };
    try {
      decision = await runFinishDecision({ success, reason });
    } catch (err) {
      emitLog('warn', `TUI completion decision failed for ${agentId}: ${err?.message || err}`, { agentId });
    }
    // A refusal observed while a sentinel/probe was awaited outranks its result.
    if (run.terminalRefusal) {
      decision = { type: 'finalize' };
      success = false;
      exitCode = 1;
      error = run.terminalRefusal.message;
      reason = 'content-refusal';
    }

    if (decision.type === 'abandon') {
      await abandonForHostShutdown();
      return;
    }

    // Every other non-finalizing verdict shares this ONE epilogue: reopen the
    // re-entrancy gate for the next completion signal, then replay or drop the
    // parked trigger per the verdict's policy. A verdict without a policy
    // replays — the safe default, since a dropped trigger can park the run.
    if (decision.type !== 'finalize') {
      sessionPhase = 'running';
      const parked = pendingFinish;
      pendingFinish = null;
      const replay = parked && (decision.replayParked !== 'if-no-sentinel' || !sentinelPresent());
      if (replay) return finish(parked);
      return;
    }

    sessionPhase = 'finalized';

    const agentData = stopRunMachinery();

    // Drain pending parsed lines AND raw chunks before the final state
    // writes so completion events don't beat the last output batch to disk.
    // Non-fatal: the phase is already 'finalized', so a rejected drain (e.g.
    // BACKUP_SNAPSHOT_BUSY while a long backup holds the snapshot cut) must not
    // skip the teardown below — a later exit/Kill would find the run terminal
    // and no-op, stranding the lane, the PTY and the worktree until restart.
    for (const [drain, label] of [[drainLines, 'parsed output'], [drainRaw, 'raw PTY spool']]) {
      await drain().catch(err => {
        persistence.markUnsettled?.();
        emitLog('warn', `TUI ${label} drain failed for ${agentId}: ${err.message}`, { agentId });
      });
    }

    // The teardown both in-process spawners share: paused early return, then
    // the host-shutdown abandon gate, the user-termination consume, the final
    // success/error derivation, and the lane release — done before the
    // potentially-slow error-analysis / completeAgent / processAgentCompletion
    // chain, since lanes serialize related work. See agentRunFinalize.js.
    //
    // The abandon gate is consulted a second time here on purpose: the gate at
    // the top of runFinishDecision() ran before ingestDoneSentinel and the merge-gate probe,
    // which can take seconds, and a host restart that begins in that window is
    // still an interruption rather than an outcome (#3202).
    const duration = Date.now() - (agentData?.startedAt || Date.now());
    // Read ONCE: the shared finalize decides the run's outcome from it and the
    // diagnostic below reports on it, and two reads could disagree about the
    // same run.
    const wroteSentinel = sentinelPresent();
    const finalizeOutcome = finalization.finalizeRunCommon({
      agentId,
      agentData,
      success,
      error,
      sentinelPresent: wroteSentinel,
    });

    if (finalizeOutcome.outcome === 'paused') { await persistence.releaseRunRecord(agentData?.pid ?? null); return; }

    if (finalizeOutcome.outcome === 'abandoned') {
      await abandonForHostShutdown();
      return;
    }

    const { finalSuccess, finalError, terminatedByUser } = finalizeOutcome;

    // Name the path the run was supposed to write when it ends without one.
    // The sentinel is the PRIMARY finalize path for a TUI, so reaching here
    // without it means the run either died or talked itself out of the write —
    // and the second shape is otherwise silent, leaving an ordinary "TUI agent
    // ended" line and nothing an operator can grep for (#7405; the prompt-side
    // contract is SENTINEL_WRITE_PERMISSION_NOTE). Deliberately NOT gated on
    // `finalSuccess`: a run that stalls on a question is reaped as a failure,
    // which is exactly the case this exists to name. Placed after the shared
    // finalize, so the paused and host-abandoned paths have already returned
    // and only a user kill — a legitimate no-sentinel exit — needs excluding.
    // A CLI run is out of scope: it signals completion by exiting, so the same
    // warn in `agentRunFinalize` would fire on every headless run.
    // A merge-gate nudge DELETES the sentinel this run already wrote, so
    // "never wrote one" would be a false reading of that path — and the
    // remedy it points at is the opposite one (the nudge never landed).
    if (sentinel.path && !terminatedByUser && !wroteSentinel) {
      emitLog('warn', missingSentinelLogMessage({
        agentId,
        reason,
        sentinelPath: sentinel.path,
        mergeGateReprompted,
        command: tuiConfig.command,
        providerId: provider?.id,
      }), { agentId });
    }

    // output.txt has already been incrementally appended via the spooler;
    // do NOT writeFile() it from the output buffer at finalize — the buffer is
    // capped at OUTPUT_BUFFER_CAP and would silently truncate the on-disk
    // record for long runs. The append-only stream is the authoritative copy.

    // `prOwnership` was resolved once, up front, by the adapter, so the
    // merge-gate contract check above and the completion dispatch below read the
    // same answer (#3733); see `resolvePrOwnership` for why finalize's
    // `prClaimExpected` and cleanup's `agentOpensOwnPr` are two predicates (#3358).
    //
    // Whether finalize's check ACTUALLY produced a forge answer, filled in from
    // its return below. Deliberately not `prClaimExpected`: finalize substitutes
    // `{ok:true}` for a user-terminated run and for a check that threw, and a
    // throw from finalize itself skips the assignment entirely — in all three
    // cases nothing was verified, so cleanup must ask rather than stand down.
    let prClaimVerified = false;
    let branchProvenEmpty = false;

    // try/finally so a throw from finalizeAgent (e.g. processAgentCompletion
    // hook crash) still runs the local cleanup — sentinel removal, the shared
    // completion dispatch (pipeline, worktree, retry hold), pid unregister,
    // active-run delete, session kill. Without this, a memory-extraction
    // crash would strand the worktree and the shell session on disk.
    // The verdict finalizeAgent actually persisted. A PR-claim downgrade (#3358)
    // must reach cleanup too — cleaning up as a success removes the worktree and
    // deletes the local branch, destroying the state the retry needs. Left at
    // `finalSuccess` if finalize threw before returning (the pre-existing
    // best-effort posture).
    let cleanupSuccess = finalSuccess;
    try {
      // Failure analysis reads the raw spool tail and falls back to the capped
      // output buffer. An analyzer error must still let the run finalize.
      let errorAnalysis = null;
      try {
        errorAnalysis = await finalization.resolveErrorAnalysis({
          finalSuccess,
          rawFile,
          fallbackText: getOutputBuffer(),
          task,
          model,
          immediateFallbackAnalysis: run.immediateFallbackAnalysis,
          // The finalize path's own verdict outranks a keyword sweep of the
          // transcript when the analyzer recognizes it (COMPLETION_REASON_ANALYSES).
          completionReason: reason,
          completionError: finalError,
          promptProvenance: getPromptProvenance(),
        });
      } catch (err) {
        emitLog('warn', `TUI error analysis failed for ${agentId}: ${err?.message || err}`, { agentId });
      }

      const finalizeVerdict = await finalization.finalizeAgent({
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
        error: finalError || undefined,
        completionReason: reason,
        ...(run.executionInterruption ? { executionInterruption: run.executionInterruption } : {}),
        workspacePath: cwd,
        prExpected: prOwnership.prClaimExpected,
        // The run window the commit criterion is evaluated against (#3637).
        startedAt: agentData?.startedAt ?? null,
      });
      if (finalizeVerdict && typeof finalizeVerdict.success === 'boolean') cleanupSuccess = finalizeVerdict.success;
      if (finalizeVerdict?.prClaimVerified === true) prClaimVerified = true;
      if (finalizeVerdict?.branchProvenEmpty === true) branchProvenEmpty = true;
    } catch (err) {
      persistence.markUnsettled?.();
      throw err;
    } finally {
      await releaseRunResources({ agentData, cleanupSuccess, prClaimVerified, branchProvenEmpty });
    }
  };

  /**
   * Abandon the run because PortOS itself is going down (#3202).
   *
   * Deliberately NOT `finish()`: finalizing here would record an outcome for a
   * run that never reached one, and its cleanup path removes the `.agent-done`
   * sentinel and hands the worktree to `cleanupAgentWorktree` — destroying exactly
   * the state a resume needs. So this only stops the machinery and flushes what
   * was captured; the agent record stays `running` and the worktree stays on
   * disk. The next boot's orphan sweep reads the host-shutdown marker, sees this
   * agent named in it, and requeues the task as *interrupted* — resumable, and
   * without charging it orphan-retry budget.
   *
   * Moves the session to the terminal 'abandoned' phase so every other path
   * (provider-signal timer, sentinel watcher, paste retry) becomes a no-op for
   * the rest of this process's life — a full stop, under the name that says no
   * outcome was recorded.
   */
  const abandonForHostShutdown = async () => {
    // No terminal guard: finish() — the only caller — already returned if the
    // session had reached one, and this sets it below.
    sessionPhase = 'abandoned';
    stopRunMachinery();

    appendLine(LIFECYCLE_LINES.hostRestarted());
    emitLog('info', `TUI agent ${agentId} interrupted by a PortOS host restart — preserved for resume`, { agentId, phase: 'interrupted' });
    // Concurrent, not sequential: nothing awaits this function (it runs off the
    // PTY-exit handler, racing the shutdown handler's own process.exit), so the
    // shorter the critical path the more of the transcript actually lands. The
    // three targets are independent — output.txt + the state record, raw.txt, and
    // the metadata patch — and the two that share the state lock still serialize
    // on it. `phase` is a breadcrumb only: the record stays `running` on purpose,
    // because boot recovery owns the transition.
    await withBackupAssetPublication(() => Promise.all([
      drainLines().catch(() => {}),
      drainRaw().catch(() => {}),
      persistence.updateAgent(agentId, { metadata: { phase: 'interrupted', interruptedBy: HOST_SHUTDOWN_REASON } })
        .catch(err => emitLog('warn', `Could not mark TUI agent ${agentId} interrupted: ${err.message}`, { agentId })),
    ]));
    // NOTE: the active-run entry is intentionally left in place — the shutdown
    // handler reads that map to name the agents in the host-shutdown marker, and
    // there is no reason to shrink it on the way out.
  };

  // Finalize a startup failure WITHOUT pasting — surfacing whatever the CLI
  // printed (raw.txt tail) so the real cause is visible instead of a wedged
  // shell. Shared by the liveness guard (command exited) and the readiness cap
  // (claude never showed its input prompt).
  const finishStartupFailure = async (reason, summary) => {
    if (isTerminal()) return;
    // Flush any debounced raw-PTY chunks first so the captured tail includes
    // the CLI's most recent output (e.g. claude's final error before exiting),
    // not just whatever happened to be on disk before the pending raw batch.
    await flushRaw().catch(() => {});
    const raw = await readFile(rawFile, 'utf8').catch(() => '');
    const tail = raw
      ? stripAnsi(raw).split('\n').map((s) => s.trimEnd()).filter(Boolean).slice(-12).join('\n')
      : '';
    appendLine(LIFECYCLE_LINES.failure({ summary }));
    await finish({
      success: false,
      exitCode: 1,
      error: `${summary}${tail ? `\nCaptured output:\n${tail}` : ' No output was captured.'}`,
      reason,
    });
  };

  return { finish, finishStartupFailure, isTerminal, isRunning: () => sessionPhase === 'running' };
}
