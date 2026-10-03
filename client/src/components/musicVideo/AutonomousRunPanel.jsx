import { useState } from 'react';
import { Link } from 'react-router';
import { AlertTriangle, CheckCircle2, Circle, CircleDot, ExternalLink, Loader2, Pause, Play, RotateCcw, Wand2, X, XCircle } from 'lucide-react';
import {
  AUTONOMOUS_CHECKPOINT_LABELS, AUTONOMOUS_LYRICS_STEP_LABELS, AUTONOMOUS_SONG_STEP_LABELS, AUTONOMOUS_STATUS_LABELS, AUTONOMOUS_VIEWABLE_STAGES,
  autonomousStageOutput, autonomousStageRows, isAutonomousLive,
} from '../../lib/musicVideoAutonomous.js';
import AutoApproveFields from './AutoApproveFields.jsx';

// The stages that report a sub-step while they run (the server's `stages[id].step`).
const STEP_LABELS = { lyrics: AUTONOMOUS_LYRICS_STEP_LABELS, song: AUTONOMOUS_SONG_STEP_LABELS };

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

/** The read-only output of one stage the director opened from the checklist. */
function StageOutput({ run, row, editableBelow }) {
  const fields = autonomousStageOutput(run, row.id);
  return (
    <div id={`mv-run-stage-${row.id}`} role="region" aria-label={`${row.label} output`} className="rounded border border-port-border bg-port-bg p-2 space-y-2 min-w-0">
      {fields.length === 0 && <p className="text-xs text-port-text-muted">This stage did not store anything to show.</p>}
      {fields.map((field) => (
        <div key={field.key} className="min-w-0">
          <div className="text-xs text-port-text-muted">{field.label}</div>
          {field.href ? (
            <Link to={field.href} className="inline-flex items-center gap-1 text-sm text-port-accent hover:underline min-h-[44px] sm:min-h-0">
              {field.text} <ExternalLink size={12} aria-hidden="true" />
            </Link>
          ) : (
            <p className={`text-sm break-words ${field.multiline ? 'whitespace-pre-wrap' : ''} ${field.mono ? 'font-mono text-xs' : ''}`}>{field.text}</p>
          )}
        </div>
      ))}
      {editableBelow && <p className="text-xs text-port-text-muted">Edit this in the approval box below before continuing.</p>}
    </div>
  );
}

/**
 * The fully-autonomous run on a project: where it is in the pipeline, what it is
 * waiting for, and the few things the director can do — approve a checkpoint
 * (optionally with edited lyrics or Suno style), retake the song at the song
 * checkpoint, retry the stage that stopped,
 * pause, or cancel. A finished stage's output (brief, lyrics, style, song) opens
 * read-only from its checklist row; the open row is the caller's URL state
 * (`selectedStage` / `onSelectStage`). Progress arrives over `music-video:autonomous` through
 * `useAutonomousMusicVideo`; this panel only renders the run it is given.
 * `framed={false}` drops the card chrome and title for a host that supplies them.
 */
export default function AutonomousRunPanel({ project, auto, selectedStage = null, onSelectStage, framed = true }) {
  const run = project?.autonomousRun;
  const [edit, setEdit] = useState(null); // { for: stage, value } — the director's edit at a checkpoint
  // Planning approval authority is granted with the next explicit resume.
  const [autoApproveEdit, setAutoApproveEdit] = useState(null);
  const autoApprove = autoApproveEdit && autoApproveEdit.runId === run?.id ? autoApproveEdit.value : (run?.brief?.autoApprove || []).filter(stage => stage !== 'proof');
  const [grantError, setGrantError] = useState(null);
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
  // A stale or hand-edited `?run-stage=` that names no finished, viewable stage opens nothing.
  const selectedRow = rows.find((row) => row.id === selectedStage && row.status === 'done' && AUTONOMOUS_VIEWABLE_STAGES.includes(row.id)) || null;
  const selected = selectedRow?.id || null;
  // Every resume path carries the selected grant and shows authorization failures inline.
  const resume = (edits = {}) => {
    if (!autoApproveEdit || autoApproveEdit.runId !== run.id) return auto.resume(edits);
    setGrantError(null);
    return auto.resume({ ...edits, autoApprove }, { inline: true })
      .then((res) => { setAutoApproveEdit(null); return res; })
      .catch((err) => { setGrantError(err?.message || 'Could not grant auto-approval'); });
  };

  return (
    <section className={`${framed ? 'bg-port-card border border-port-border rounded-lg p-3 ' : ''}space-y-3 min-w-0`} aria-label="Autonomous run">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {framed && <span className="flex items-center gap-1 text-sm font-medium"><Wand2 size={15} className="text-port-accent" aria-hidden="true" /> Autonomous run</span>}
        <span className={`text-sm ${tone}`}>{run.interrupted ? 'Interrupted — resume to continue' : AUTONOMOUS_STATUS_LABELS[run.status] || run.status}</span>
        {run.brief?.origin?.kind === 'schedule' && (
          <span className="text-xs text-port-text-muted">Scheduled{run.brief.origin.ideaTitle ? ` · from “${run.brief.origin.ideaTitle}”` : ''}</span>
        )}
      </div>

      <ol aria-label="Autonomous stages" className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,11rem),1fr))] gap-x-3 gap-y-1 text-xs">
        {rows.map((row) => {
          const { Icon, cls, label } = STAGE_MARKS[row.status] || STAGE_MARKS.pending;
          const mark = row.current && row.status === 'pending' ? <CircleDot size={13} className="shrink-0 text-port-accent" aria-hidden="true" /> : <Icon size={13} className={`shrink-0 ${cls}`} aria-hidden="true" />;
          const content = (
            <>
              {mark}
              <span className="truncate">{row.label}</span>
              <span className="sr-only">({label})</span>
            </>
          );
          const tone = row.current ? 'font-medium text-port-text' : 'text-port-text-muted';
          // Only a stage that finished and keeps something to show opens.
          const openable = row.status === 'done' && AUTONOMOUS_VIEWABLE_STAGES.includes(row.id) && onSelectStage;
          return (
            <li key={row.id} aria-current={row.current ? 'step' : undefined} className="min-w-0">
              {openable ? (
                <button
                  type="button"
                  aria-expanded={selected === row.id}
                  aria-controls={`mv-run-stage-${row.id}`}
                  onClick={() => onSelectStage(selected === row.id ? null : row.id)}
                  className={`flex w-full min-w-0 items-center gap-1 rounded px-1 -mx-1 min-h-[44px] sm:min-h-0 hover:bg-port-bg ${selected === row.id ? 'bg-port-bg' : ''} ${tone}`}
                >
                  {content}
                </button>
              ) : (
                <span className={`flex min-w-0 items-center gap-1 ${tone}`}>{content}</span>
              )}
              {STEP_LABELS[row.id] && row.status === 'running' && row.step && (
                <p role="status" className="pl-[17px] text-port-accent break-words">{STEP_LABELS[row.id][row.step] || row.step}…</p>
              )}
            </li>
          );
        })}
      </ol>

      {selectedRow && <StageOutput run={run} row={selectedRow} editableBelow={!!editable && awaiting === selectedRow.id} />}

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
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={auto.busy} onClick={() => resume(changed ? { [editable.key]: draft } : {})} className={`${buttonClass} bg-port-accent text-white border-port-accent`}>
              <Play size={14} aria-hidden="true" /> {changed ? 'Save edit & approve' : 'Approve & continue'}
            </button>
            {awaiting === 'song' && (
              // Discards this song and makes a new one (a new Suno generation spends credits), then pauses here again.
              <button type="button" disabled={auto.busy} onClick={() => resume({ retakeSong: true })} className={buttonClass}>
                <RotateCcw size={14} aria-hidden="true" /> Retake song
              </button>
            )}
          </div>
        </div>
      )}

      {(awaiting || canRetry) && (live || run.status === 'failed') && (
        <AutoApproveFields
          idPrefix="mv-run"
          value={autoApprove}
          onChange={(next) => { setAutoApproveEdit({ runId: run.id, value: next }); setGrantError(null); }}
          error={grantError}
          granted={run.brief?.autoApprove || []}
        />
      )}

      {live || run.status === 'failed' ? (
        <div className="flex flex-wrap gap-2">
          {canRetry && !awaiting && (
            <button type="button" disabled={auto.busy} onClick={() => resume()} className={buttonClass}>
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
