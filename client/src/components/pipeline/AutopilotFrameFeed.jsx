import { useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import { autopilotStepLabel, describeAutopilotVerification, autopilotMarkerTerminal } from '../../lib/autopilotMilestones';
import { providerModelLabel } from '../../utils/providers';
import AutopilotMilestones from './AutopilotMilestones';

// Step labels are shared with the milestone map (lib/autopilotMilestones.js) so
// the live status line and the map can't name the same step differently.
const stepLabel = autopilotStepLabel;

// The record kinds one auto-resolve round can rewrite, in the order a reader
// scans them: the arc first, then down to the episodes.
const MUTATION_LABELS = [
  ['arcFieldsEdited', 'arc field'],
  ['volumesEdited', 'volume'],
  ['characterArcsEdited', 'character arc'],
  ['episodesEdited', 'episode'],
];

// Plain English for the resolver's categorical no-change reasons (the server's
// RESOLVE_NO_CHANGE_REASONS). An unmapped value falls through to the raw token
// rather than vanishing — a reason nobody can read still beats none at all.
const NO_CHANGE_LABELS = {
  'no-findings': 'there was nothing to resolve',
  'isolated-candidate-rejected': 'the candidate was too broad to be an isolated repair',
  'exact-edits-rejected': 'its exact text edits no longer matched the draft',
  'edits-matched-existing': 'it re-authored text the plan already had',
  'edits-out-of-scope': 'it answered at an altitude this gate cannot apply',
  'edits-named-no-finding': 'its edits named none of the findings it was given',
  'no-edits-returned': 'it proposed no edits at all',
};

// Turn an SSE frame into a one-line status string. Null means "nothing to say" —
// the frame is state for another surface, not activity worth a status line.
function frameLabel(f) {
  if (!f) return null;
  switch (f.type) {
    // The milestone map's cursor (server: seriesAutopilot/state.js). It follows
    // the frame that moved it, so labeling it would just overwrite that frame's
    // own status line with a duplicate.
    case 'progress': return null;
    case 'start': return f.mode === 'dry-run' ? 'Planning (dry-run)…' : 'Starting…';
    case 'note': return f.message;
    case 'step:start': return `${stepLabel(f.kind)}…`;
    case 'step:complete': return `${stepLabel(f.kind)} done`;
    case 'step:skip': return `Skipped ${stepLabel(f.kind)}${f.reason ? ` — ${f.reason}` : ''}`;
    // Same formatter the milestone row uses — the two render the SAME telemetry
    // in one card, so a second phrasing of it here is drift waiting to happen.
    case 'verify:round': return `${f.scope} check — ${describeAutopilotVerification(f.scope, f)}`;
    // What the auto-resolve round actually wrote. An episode count alone was
    // meaningless at the arc-spine gate (whose resolver may not touch episodes),
    // so name every record kind that moved — and when nothing moved, say why
    // rather than falling through to a raw `resolve:no-change` frame type.
    case 'resolve:round':
    case 'resolve:no-change': {
      const wrote = MUTATION_LABELS
        .filter(([key]) => f[key])
        .map(([key, noun]) => `${f[key]} ${noun}(s)`);
      const lead = `${f.scope} auto-resolve${f.retry ? ' (retry)' : ''} round ${f.round}`;
      if (wrote.length) return `${lead} — rewrote ${wrote.join(', ')}`;
      const why = f.noChangeReason ? ` — ${NO_CHANGE_LABELS[f.noChangeReason] || f.noChangeReason}` : '';
      const rejected = f.rejectedExactEdits ? ` · ${f.rejectedExactEdits} exact text edit(s) rejected` : '';
      return `${lead} — wrote nothing${why}${rejected}`;
    }
    // An auto-resolve round that left the draft worse was undone — say so live,
    // or the round's edits appear to still be in place while the run pauses.
    // A revert is not necessarily the end of the gate: when a corrective pass is
    // left, the run retries from the restored state, so say which one happened
    // or the user reads every rollback as "this run is about to stop".
    case 'resolve:rollback': return `${f.scope} auto-resolve went from ${f.before} to ${f.after} blocking finding(s) — `
      + `${f.reverted ? 'reverted that round' : 'could not revert that round'}`
      + `${f.retrying ? ', retrying from the best state' : ''}`;
    // Per-finding isolation: each attempt is its own kept-or-reverted decision,
    // so name the finding it was spent on — a bare "attempt 2 reverted" reads as
    // the whole gate rolling back again rather than one candidate being dropped.
    // A candidate too broad to BE an isolated repair is dropped before it is
    // applied, so it never edited the plan and its blocker counts never moved —
    // reporting that as "reverted" would describe an undo that never happened.
    case 'resolve:isolate': return `${f.scope} isolated fix ${f.attempt}${f.target ? ` (${f.target})` : ''} — `
      + (f.reason
        ? `discarded before it was applied: ${f.reason}`
        : `${f.before} → ${f.after} blocking finding(s), ${f.kept ? 'kept' : 'reverted'}`);
    // #2176 — foundation-gate telemetry.
    case 'foundation:round': return `Foundation round ${f.round} — ${describeAutopilotVerification('foundationGate', f)}`;
    case 'foundation:fix': return `${f.phase === 'pre-arc' ? 'Pre-arc foundation' : 'Foundation fix'} — ${f.dimension}${f.applied ? ' applied' : ` skipped${f.reason ? ` (${f.reason})` : ''}`}`;
    // A repair whose re-judge showed no gain is rewound. Like resolve:rollback,
    // say whether the gate is retrying from the restored checkpoint — otherwise
    // every revert reads as "this run is about to stop".
    case 'foundation:rollback': return `Foundation ${f.dimension} repair did not improve its target `
      + `(${f.targetBefore} → ${f.targetAfter}) — ${f.reverted ? 'reverted that repair' : 'could not revert that repair'}`
      + `${f.retrying ? ', retrying from the checkpoint' : ''}`;
    // #1578 — per-check telemetry forwarded from the editorial-checks runner.
    case 'check:start': return `Editorial check: ${f.label || f.checkId}…`;
    case 'check:complete': {
      const name = f.label || f.checkId;
      if (f.error) return `Editorial check: ${name} — ⚠️ errored`;
      if (f.skipped) return `Editorial check: ${name} — skipped`;
      const s = f.bySeverity;
      const sev = s && (s.high || s.medium || s.low) ? ` (${s.high}H/${s.medium}M/${s.low}L)` : '';
      return `Editorial check: ${name} — ${f.count} finding(s)${sev}`;
    }
    // Unlock pre-pass: report what it actually cleared (and what it deliberately
    // left frozen), so "unlocked everything" is never an unverifiable claim.
    case 'unlock:applied': {
      const parts = [];
      if (f.arc) parts.push('arc');
      if (f.arcFields) parts.push(`${f.arcFields} arc field(s)`);
      if (f.seasons) parts.push(`${f.seasons} volume(s)`);
      if (f.stages) parts.push(`${f.stages} stage(s)`);
      if (f.canon) parts.push(`${f.canon} canon entr${f.canon === 1 ? 'y' : 'ies'}`);
      if (f.worldFields) parts.push(`${f.worldFields} world field(s)`);
      if (parts.length === 0) return 'Unlock — nothing was locked';
      const kept = [
        f.canonForeignKept ? `${f.canonForeignKept} other series' canon` : '',
        f.worldFieldsKept ? `${f.worldFieldsKept} shared world field(s)` : '',
      ].filter(Boolean);
      return `Unlocked ${parts.join(', ')}${kept.length ? ` · kept ${kept.join(' + ')} locked` : ''}`;
    }
    case 'render:queued': return `Queued draft render: ${f.target}`;
    case 'canon:repair': return `Canon repair: ${f.filled || 0} described from prose${f.unsupported ? ` · ${f.unsupported} unsupported` : ''}`;
    case 'gap:filed': return `Filed CoS task (${f.gapKind})`;
    // Pipeline self-improvement post-mortem. Only the START frame is live — the
    // verdict rides the terminal frame (a client tears its stream down there).
    case 'selfimprove:start': return `Diagnosing the pipeline (${f.signals} signal${f.signals === 1 ? '' : 's'})…`;
    // Observing orchestrator — its passes ARE live (mid-run), so both frames show.
    case 'observer:start': return `Orchestrator observing the pipeline (${f.signals} signal${f.signals === 1 ? '' : 's'})…`;
    case 'observer:filed': return f.duplicate
      ? `Orchestrator: pipeline fix already tracked (${f.area})`
      : `Orchestrator dispatched a pipeline fix (${f.area})${f.title ? `: ${f.title}` : ''}`;
    // #1617 — immediate cancel ack; the active step finishes before `canceled`.
    case 'cancel:acknowledged': return 'Cancelling — finishing the active step…';
    case 'pause:acknowledged': return 'Pausing safely — finishing the active step…';
    case 'paused': return `Paused — ${f.reason}`;
    case 'complete': return f.dryRun ? 'Plan ready' : 'Complete';
    case 'canceled': return 'Canceled';
    case 'error': return `Failed — ${f.error}`;
    default: return f.type;
  }
}
// How many recent frames the live activity log shows. Also the stopping point
// for the backward frame walk that builds it.
const ACTIVITY_LINES = 6;

export default function AutopilotFrameFeed({
  ap, active, latest, frames, mode, plan, planTotals, seedProgress, terminal, runLlm, providers, activeProviderId,
}) {
  // `frames` is the hook's bounded history (useSseProgress `maxFrames`), so a
  // full pass per frame batch stays cheap: the newest `progress` frame is the
  // milestone map's cursor; the last few labelled frames are the activity log,
  // whose last line is also the status line.
  const { snapshot, activityLines } = useMemo(() => ({
    snapshot: frames.findLast((f) => f?.type === 'progress') ?? null,
    activityLines: frames.map(frameLabel).filter(Boolean).slice(-ACTIVITY_LINES),
  }), [frames]);
  // Fall back to the status route's snapshot until this stream emits one of its
  // own — a panel attaching mid-run has no frames yet.
  const progress = snapshot || seedProgress;
  // A `progress` frame is deliberately label-less, so the status line keeps
  // naming the last frame that had something to say. `latest` covers a stream
  // whose frames were never collected.
  const latestLabel = activityLines.at(-1) || frameLabel(latest);
  const liveLabel = active ? (latestLabel || 'Working…') : null;

  // Milestone map (#4140). The live halves — the plan off the run's `start`
  // frame and the progress the stream folds — only exist while this panel has a
  // run to watch, so a reload the morning after a pause used to show the resume
  // banner with nothing beside it. The marker the run stamped carries both;
  // fall back to it only when there is no live plan to draw, so a dry-run
  // preview and a run in flight both keep the fresher in-memory copy.
  const markerPlan = !active && !plan && ap?.plan?.length ? ap.plan : null;
  const mapPlan = markerPlan || plan;
  const mapProgress = markerPlan ? ap.progress : progress;
  // A marker records how the run ended as a STATUS; the fold reads a terminal
  // frame type, so translate. Without this the step a paused run stopped on
  // would redraw as still running.
  const mapTerminal = markerPlan ? autopilotMarkerTerminal(ap.status) : terminal;

  return (
    <>
      {/* Live progress */}
      {active ? (
        <div className="px-3 pb-3 border-t border-port-border pt-2">
          <div className="text-xs text-gray-300 flex items-center gap-2">
            <Loader2 size={12} className="animate-spin text-port-accent" />
            {mode === 'dry-run' ? <span className="uppercase tracking-wider text-[10px] text-port-accent">dry-run</span> : null}
            {liveLabel}
          </div>
          {/* Name the provider/model this run resolved to, so an in-flight run
              (including one the scheduler started) says what it is spending on.
              A null run provider means it fell through to the active provider;
              with neither known there is nothing truthful to name, so say nothing. */}
          {runLlm?.provider || activeProviderId ? (
            <div className="mt-1 text-[11px] text-gray-500">
              create/repair on {providerModelLabel(providers, runLlm?.provider || activeProviderId, runLlm?.model)}
              {runLlm?.effort ? ` at ${runLlm.effort} effort` : ''}
              {runLlm?.judge ? (
                <> · judge/verify on {providerModelLabel(
                  providers,
                  runLlm.judge.provider || runLlm?.provider || activeProviderId,
                  runLlm.judge.model,
                )}{runLlm.judge.effort ? ` at ${runLlm.judge.effort} effort` : ''}</>
              ) : null}
            </div>
          ) : null}
          {activityLines.length ? (
            <div className="mt-2 max-h-28 overflow-y-auto text-[11px] text-gray-500 space-y-0.5">
              {activityLines.map((line, i) => <div key={i}>{line}</div>)}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Milestone map — the run's whole job (the plan its `start` frame
          projected) measured against where it actually is. Rendered whenever a
          plan exists, so it survives after the stream closes: a dry-run persists
          no marker and completes immediately, and a run that pauses while the
          panel is open keeps its map beside the banner. Both halves are
          in-memory on the server, so a reload after the run ended falls back to
          the copy the run stamped on its marker (#4140) — see `markerPlan`.
          Cleared when the next run starts. `planTotals` carries the #1576
          estimated cos-action budget so a large series on a small daily cap can
          see, before starting, whether it will run out before editorial; it and
          `mode` are set from the same start frame as the live `plan`, so a
          marker-drawn map (which only happens when there is no live plan) has
          neither — no estimate and no dry-run badge, both correct for a run
          that has already spent its budget. */}
      <AutopilotMilestones
        plan={mapPlan}
        planTotals={planTotals}
        progress={mapProgress}
        terminal={mapTerminal}
        dryRun={mode === 'dry-run'}
      />

    </>
  );
}
