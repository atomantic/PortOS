import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Circle, CircleDot, Loader2, Pause, Play, Wand2, X, XCircle } from 'lucide-react';
import {
  AUTONOMOUS_CHECKPOINT_LABELS, AUTONOMOUS_STATUS_LABELS, autonomousStageRows, isAutonomousLive,
} from '../../lib/musicVideoAutonomous.js';

const STATUS_TONES = {
  running: 'text-port-accent', 'awaiting-approval': 'text-port-warning', 'needs-human': 'text-port-warning', stopped: 'text-port-warning',
  completed: 'text-port-success', failed: 'text-port-error', canceled: 'text-port-text-muted',
};
const STAGE_MARKS = {
  done: { Icon: CheckCircle2, cls: 'text-port-success', label: 'done' },
  running: { Icon: Loader2, cls: 'text-port-accent animate-spin', label: 'running' },
  failed: { Icon: XCircle, cls: 'text-port-error', label: 'failed' },
  pending: { Icon: Circle, cls: 'text-port-text-muted', label: 'not started' },
};
const inputClass = 'w-full min-w-0 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm';
const buttonClass = 'flex items-center gap-1 rounded border border-port-border bg-port-bg px-3 py-1.5 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50';

/**
 * The fully-autonomous run on a project: where it is in the pipeline, what it is
 * waiting for, and the few things the director can do — approve a checkpoint
 * (optionally with edited lyrics or Suno style), retry the stage that stopped,
 * pause, or cancel. Progress arrives over `music-video:autonomous` through
 * `useAutonomousMusicVideo`; this panel only renders the run it is given.
 */
export default function AutonomousRunPanel({ project, auto }) {
  const run = project?.autonomousRun;
  const [edit, setEdit] = useState(null); // { for: stage, value } — the director's edit at a checkpoint
  if (!run) return null;
  const rows = autonomousStageRows(run);
  const live = isAutonomousLive(run);
  const awaiting = run.status === 'awaiting-approval' ? run.awaiting : null;
  // The one editable output each checkpoint offers: lyrics before the style
  // stage, the Suno style line before the song is made.
  const editable = awaiting === 'lyrics' ? { key: 'lyrics', label: 'Lyrics', value: run.output?.lyrics || '' }
    : awaiting === 'style' ? { key: 'style', label: 'Suno style', value: run.output?.sunoStyle || '' } : null;
  const draft = edit && edit.for === awaiting ? edit.value : editable?.value;
  const changed = editable && draft !== editable.value;
  const canRetry = ['needs-human', 'failed', 'stopped'].includes(run.status) || run.interrupted;
  const tone = STATUS_TONES[run.status] || '';

  return (
    <section className="bg-port-card border border-port-border rounded-lg p-3 space-y-3 min-w-0" aria-label="Autonomous run">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex items-center gap-1 text-sm font-medium"><Wand2 size={15} className="text-port-accent" aria-hidden="true" /> Autonomous run</span>
        <span className={`text-sm ${tone}`}>{run.interrupted ? 'Interrupted — resume to continue' : AUTONOMOUS_STATUS_LABELS[run.status] || run.status}</span>
        {run.brief?.origin?.kind === 'schedule' && (
          <span className="text-xs text-port-text-muted">Scheduled{run.brief.origin.ideaTitle ? ` · from “${run.brief.origin.ideaTitle}”` : ''}</span>
        )}
      </div>

      <ol aria-label="Autonomous stages" className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,11rem),1fr))] gap-x-3 gap-y-1 text-xs">
        {rows.map((row) => {
          const { Icon, cls, label } = STAGE_MARKS[row.status] || STAGE_MARKS.pending;
          return (
            <li key={row.id} aria-current={row.current ? 'step' : undefined} className={`flex min-w-0 items-center gap-1 ${row.current ? 'font-medium text-port-text' : 'text-port-text-muted'}`}>
              {row.current && row.status === 'pending' ? <CircleDot size={13} className="shrink-0 text-port-accent" aria-hidden="true" /> : <Icon size={13} className={`shrink-0 ${cls}`} aria-hidden="true" />}
              <span className="truncate">{row.label}</span>
              <span className="sr-only">({label})</span>
            </li>
          );
        })}
      </ol>

      {run.error && (
        <p role="status" className="flex items-start gap-1 text-xs text-port-warning break-words min-w-0">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" /> <span className="min-w-0">{run.error}</span>
        </p>
      )}

      {awaiting && (
        <div className="rounded border border-port-border p-2 space-y-2">
          <p className="text-xs text-port-text-muted">
            Paused after <strong className="text-port-text">{AUTONOMOUS_CHECKPOINT_LABELS[awaiting] || awaiting}</strong> — nothing further runs until you approve.
          </p>
          {editable && (
            <div>
              <label htmlFor="mv-auto-edit" className="block text-xs text-port-text-muted mb-1">{editable.label} (edit before continuing)</label>
              <textarea
                id="mv-auto-edit"
                rows={editable.key === 'lyrics' ? 10 : 3}
                value={draft}
                onChange={(e) => setEdit({ for: awaiting, value: e.target.value })}
                className={`${inputClass} font-mono text-xs`}
              />
            </div>
          )}
          <button type="button" disabled={auto.busy} onClick={() => auto.resume(changed ? { [editable.key]: draft } : {})} className={`${buttonClass} bg-port-accent text-white border-port-accent`}>
            <Play size={14} aria-hidden="true" /> {changed ? 'Save edit & approve' : 'Approve & continue'}
          </button>
        </div>
      )}

      {live || run.status === 'failed' ? (
        <div className="flex flex-wrap gap-2">
          {canRetry && !awaiting && (
            <button type="button" disabled={auto.busy} onClick={() => auto.resume()} className={buttonClass}>
              <Play size={14} aria-hidden="true" /> {run.status === 'failed' ? 'Retry' : 'Resume'}
            </button>
          )}
          {run.status === 'running' && !run.interrupted && (
            <button type="button" disabled={auto.busy} onClick={() => auto.stop()} className={buttonClass}><Pause size={14} aria-hidden="true" /> Pause</button>
          )}
          <button type="button" disabled={auto.busy} onClick={() => auto.cancel()} className={`${buttonClass} text-port-error`}><X size={14} aria-hidden="true" /> Cancel</button>
        </div>
      ) : null}
    </section>
  );
}
