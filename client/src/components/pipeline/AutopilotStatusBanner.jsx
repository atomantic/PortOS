import { AlertCircle, CheckCircle2, PauseCircle, ChevronRight, ChevronDown } from 'lucide-react';
import Pill from '../ui/Pill';
import { autopilotStepLabel } from '../../lib/autopilotMilestones';
import { severityColor } from './constants.js';

// Pause kinds worth calling out beside the status line — the ones where "Paused"
// alone doesn't tell the user what state the draft is in. A kind with no entry
// (maxRounds, childFailed, planningOscillation) is fully explained by the reason
// text below it.
const PAUSE_BADGES = {
  divergence: {
    label: 'not converging',
    title: 'Auto-resolve stopped reducing blocking findings — needs a human edit, not more rounds',
  },
  regression: {
    label: 'round reverted',
    title: 'An auto-resolve round left more blocking findings than it was given — its edits were reverted and the draft is back to its pre-round state',
  },
  checkFindings: {
    label: 'high findings',
    title: 'Editorial checks surfaced too many High findings — address them (or raise the threshold) and resume',
  },
  providerFailed: {
    label: 'provider failed',
    title: 'An AI repair call failed outright (provider timeout, dead CLI, rate limit) — the run kept everything it had finished; resume to retry, or switch the provider/model first',
  },
  inapplicable: {
    label: 'nothing to fix',
    title: "The owning service had nothing it was allowed to change — no linked universe, or every target is locked. Auto-resolve can't proceed without a human edit",
  },
  budget: {
    label: 'budget reached',
    title: 'The daily spend cap was reached mid-run — the run stopped where it was and resumes once the budget resets or is raised',
  },
};

// #1572 — shared caution tail for a `done` run that filed blocking script-craft
// gaps, so the completion toast and the persisted-status banner can't drift.
export const craftGapCaution = (n) => `${n} filed script-craft gap${n === 1 ? '' : 's'} — resolve before rendering`;
// #1573 — a `done` run where an editorial check threw never evaluated that
// dimension, so "complete" is qualified rather than "production-ready".
export const editorialCheckCaution = (n) => `${n} editorial check${n === 1 ? '' : 's'} errored — review before trusting "clean"`;

// One line for a pipeline self-improvement verdict, shared by the run-ended
// toast and the persisted-marker banner so the two can't drift. Null when the
// pass didn't run or found nothing worth filing — there's nothing to say then.
export function selfImproveLine(si) {
  if (!si || si.verdict !== 'pipeline') return null;
  const what = si.title ? `: ${si.title}` : '';
  if (si.duplicate) return `Pipeline fix already tracked (${si.area})${what}`;
  if (!si.filed) return `Pipeline defect diagnosed (${si.area})${what} — filing it failed`;
  return `Filed a PortOS fix task (${si.area})${what} — approve it in CoS to start the work`;
}

// One line for the observing orchestrator's run summary, shared by the run-ended
// toast and the persisted-marker banner so the two can't drift. Null when the
// observer dispatched nothing — there's nothing to say then.
export function observerLine(ob) {
  const n = ob?.filed?.length || 0;
  if (n === 0) return null;
  const fresh = ob.filed.filter((f) => f.filed).length;
  if (fresh === 0) return `Orchestrator: ${n} pipeline fix${n === 1 ? '' : 'es'} already tracked in CoS`;
  return `Orchestrator dispatched ${fresh} pipeline fix${fresh === 1 ? '' : 'es'} — PRs will review and merge on their own`;
}

function Findings({ items }) {
  if (!items?.length) return null;
  return (
  <ul className="space-y-1.5 mt-2">
    {items.map((f, i) => (
      <li key={i} className={`text-xs p-2 rounded border ${severityColor(f.severity)}`}>
        <div className="flex items-center gap-2">
          <AlertCircle size={12} />
          <span className="uppercase tracking-wider font-semibold">{f.severity || 'note'}</span>
          {f.location ? <span className="text-gray-500">— {f.location}</span> : null}
        </div>
        <p className="text-gray-200 mt-0.5">{f.problem}</p>
      </li>
    ))}
  </ul>
);
}

/**
 * Persisted status banner (paused / done / error) for `series.autopilot`. A
 * `done` run that filed blocking script-craft gaps (#1572) is shown as a
 * caution, not "production-ready" — those gaps still block downstream rendering.
 * Renders nothing for an idle/running/absent marker.
 */
export default function AutopilotStatusBanner({ ap }) {
  if (!ap || !ap.status || ap.status === 'idle' || ap.status === 'running') return null;
  const doneWithGaps = ap.status === 'done' && ap.craftGapIssues > 0;
  // #1573 — a done run with errored editorial checks is a caution too (the
  // craft-gap message takes precedence when both are present).
  const doneWithCheckErrors = ap.status === 'done' && !doneWithGaps && ap.editorialCheckErrors > 0;
  const tone = ap.status === 'paused' || doneWithGaps || doneWithCheckErrors ? 'warning' : ap.status === 'error' ? 'error' : 'success';
  const siLine = selfImproveLine(ap.selfImprove);
  const obLine = observerLine(ap.observer);
  return (
    <div className={`px-3 pb-3 border-t pt-2 ${tone === 'warning' ? 'border-port-warning/30' : tone === 'error' ? 'border-port-error/30' : 'border-port-success/30'}`}>
      <div className="flex items-center gap-2 text-xs">
        {ap.status === 'paused' ? <PauseCircle size={13} className="text-port-warning" />
          : doneWithGaps || doneWithCheckErrors ? <AlertCircle size={13} className="text-port-warning" />
            : ap.status === 'done' ? <CheckCircle2 size={13} className="text-port-success" />
              : <AlertCircle size={13} className="text-port-error" />}
        <span className={tone === 'warning' ? 'text-port-warning' : tone === 'success' ? 'text-port-success' : 'text-port-error'}>
          {ap.status === 'paused' ? (ap.currentStep ? `Paused at ${autopilotStepLabel(ap.currentStep)}` : 'Paused')
            : doneWithGaps ? `Completed with ${craftGapCaution(ap.craftGapIssues)}`
              : doneWithCheckErrors ? `Completed — ${editorialCheckCaution(ap.editorialCheckErrors)}`
                : ap.status === 'done' ? 'Last run completed — selected production pass finished' : 'Last run errored'}
        </span>
        {ap.status === 'paused' && PAUSE_BADGES[ap.pauseKind] ? (
          <Pill tone="warning" size="xs" title={PAUSE_BADGES[ap.pauseKind].title}>
            {PAUSE_BADGES[ap.pauseKind].label}
          </Pill>
        ) : null}
      </div>
      {ap.lastError && ap.status !== 'done' ? <p className="text-[11px] text-gray-400 mt-1">{ap.lastError}</p> : null}
      {/* Pipeline self-improvement verdict for that run — the run's trouble
          was the automation, and a PortOS fix task exists for it. */}
      {siLine ? <p className="text-[11px] text-port-accent mt-1">🔧 {siLine}</p> : null}
      {/* Observing-orchestrator summary — fixes are already dispatched and
          merging on their own; list what was filed. */}
      {obLine ? (
        <div className="mt-1">
          <p className="text-[11px] text-port-accent">👁️ {obLine}</p>
          {ap.observer.filed.map((f, i) => (
            <p key={i} className="text-[11px] text-gray-500 ml-4">{f.area}{f.title ? ` — ${f.title}` : ''}</p>
          ))}
        </div>
      ) : null}
      <Findings items={ap.residualFindings} />
      {/* Collapsed: the restored set above is the actual work queue, while
          these are what the rewound round produced — context for judging
          whether the rollback was the right call, not tasks to act on. */}
      {ap.discardedFindings?.length ? (
        <details className="mt-2 group">
          <summary className="cursor-pointer list-none flex items-center gap-1 text-[10px] uppercase tracking-wider text-gray-500 hover:text-gray-300">
            <ChevronRight size={11} className="group-open:hidden" />
            <ChevronDown size={11} className="hidden group-open:inline" />
            Discarded — what the reverted round produced ({ap.discardedFindings.length})
          </summary>
          <Findings items={ap.discardedFindings} />
        </details>
      ) : null}
    </div>
  );
}
