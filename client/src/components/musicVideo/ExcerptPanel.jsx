import { useRef, useState } from 'react';
import { Film, Flag, CheckCircle2, Trash2, X, Clapperboard, RotateCcw } from 'lucide-react';
import RevisionPanel, { currentRevision } from './RevisionPanel.jsx';

const VERDICT_STYLES = {
  flagged: 'bg-port-error/20 text-port-error',
  approved: 'bg-port-success/20 text-port-success',
};
const STATUS_LABELS = { rendering: 'Rendering…', complete: 'Ready', error: 'Failed', canceled: 'Cancelled' };

const fmt = (sec) => {
  const s = Math.max(0, Math.round(sec * 10) / 10);
  const m = Math.floor(s / 60);
  const r = (s % 60).toFixed(1).padStart(4, '0');
  return `${m}:${r}`;
};

function NoteRow({ excerptId, note, busy, onEdit, onDelete, onSeek }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.note);
  if (editing) {
    return (
      <li className="flex flex-wrap items-center gap-1.5 text-xs">
        <input value={draft} maxLength={2000} onChange={(e) => setDraft(e.target.value)}
          aria-label="Edit review note"
          className="min-w-0 flex-1 bg-port-bg border border-port-border rounded px-1.5 py-1" />
        <button type="button" disabled={busy || !draft.trim()}
          onClick={() => { onEdit(excerptId, note.id, { note: draft.trim() }); setEditing(false); }}
          className="text-port-accent disabled:opacity-50 min-h-[44px] sm:min-h-0 px-1">Save</button>
        <button type="button" onClick={() => setEditing(false)} className="text-port-text-muted min-h-[44px] sm:min-h-0 px-1">Cancel</button>
      </li>
    );
  }
  return (
    <li className="flex flex-wrap items-start gap-1.5 text-xs">
      <button type="button" onClick={() => onSeek(note.atSec)} className="text-port-accent font-mono shrink-0 min-h-[44px] sm:min-h-0" title="Jump to this moment">
        {fmt(note.atSec)}
      </button>
      <span className="min-w-0 flex-1 break-words">{note.note}</span>
      {note.verdict && <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase shrink-0 ${VERDICT_STYLES[note.verdict] || ''}`}>{note.verdict}</span>}
      <div className="flex items-center gap-1 shrink-0">
        <button type="button" title="Flag an issue" aria-label="Flag an issue"
          onClick={() => onEdit(excerptId, note.id, { verdict: note.verdict === 'flagged' ? null : 'flagged' })}
          disabled={busy} className={`p-1 rounded min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 ${note.verdict === 'flagged' ? 'text-port-error' : 'text-port-text-muted'}`}>
          <Flag size={12} />
        </button>
        <button type="button" title="Approve" aria-label="Approve"
          onClick={() => onEdit(excerptId, note.id, { verdict: note.verdict === 'approved' ? null : 'approved' })}
          disabled={busy} className={`p-1 rounded min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 ${note.verdict === 'approved' ? 'text-port-success' : 'text-port-text-muted'}`}>
          <CheckCircle2 size={12} />
        </button>
        <button type="button" title="Edit" aria-label="Edit note" onClick={() => setEditing(true)} disabled={busy}
          className="p-1 rounded min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 text-port-text-muted">Edit</button>
        <button type="button" title="Delete note" aria-label="Delete note" onClick={() => onDelete(excerptId, note.id)} disabled={busy}
          className="p-1 rounded min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 text-port-error">
          <Trash2 size={12} />
        </button>
      </div>
    </li>
  );
}

function ExcerptCard({ excerpt, deleting, noteBusy, onDelete, onCancel, onAddNote, onEditNote, onDeleteNote, canRevise, onRevise }) {
  const videoRef = useRef(null);
  const [draft, setDraft] = useState('');
  const seek = (t) => { if (videoRef.current) { videoRef.current.currentTime = t; videoRef.current.play?.().catch(() => {}); } };
  const addNoteHere = () => {
    if (!draft.trim()) return;
    // Only clear the draft once the note actually saved — `addNote` resolves
    // null on failure — so a transient request error doesn't silently discard
    // what the reviewer typed.
    onAddNote(excerpt.id, { atSec: videoRef.current?.currentTime ?? 0, note: draft.trim() }).then((result) => {
      if (result) setDraft('');
    });
  };
  return (
    <li className="rounded border border-port-border p-2 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="font-medium">{fmt(excerpt.startSec)} – {fmt(excerpt.endSec)} <span className="text-port-text-muted">({STATUS_LABELS[excerpt.status] || excerpt.status})</span></span>
        <div className="flex items-center gap-2">
          {/* #8987: regenerate ONLY the sections holding a flagged note; the rest stay as approved. */}
          {excerpt.status === 'complete' && excerpt.sections?.length > 0 && excerpt.notes?.some((n) => n.verdict === 'flagged') && (
            <button type="button" disabled={!canRevise} onClick={() => onRevise(excerpt.id)}
              title="Reject the flagged sections and regenerate only those"
              className="text-port-accent flex items-center gap-1 disabled:opacity-50 min-h-[44px] sm:min-h-0"><RotateCcw size={12} /> Revise flagged</button>
          )}
          {excerpt.status === 'rendering'
            ? <button type="button" onClick={() => onCancel(excerpt.id)} className="text-port-error flex items-center gap-1 min-h-[44px] sm:min-h-0"><X size={12} /> Cancel</button>
            : <button type="button" disabled={deleting} onClick={() => onDelete(excerpt.id)} className="text-port-error flex items-center gap-1 disabled:opacity-50 min-h-[44px] sm:min-h-0"><Trash2 size={12} /> Delete</button>}
        </div>
      </div>
      {excerpt.status === 'error' && excerpt.error && <p role="alert" className="text-xs text-port-error">{excerpt.error}</p>}
      {excerpt.status === 'complete' && excerpt.filename && (
        <div className="space-y-2">
          <video ref={videoRef} src={`/data/videos/${excerpt.filename}`} controls playsInline preload="metadata"
            className="w-full aspect-video max-h-[45vh] object-contain rounded bg-black border border-port-border"
            aria-label={`Play excerpt ${fmt(excerpt.startSec)} to ${fmt(excerpt.endSec)}`} />
          {excerpt.contactSheetFilename && (
            <details className="text-xs">
              <summary className="cursor-pointer text-port-text-muted flex items-center gap-1"><Clapperboard size={12} /> Contact sheet (cut/cue frames)</summary>
              <img src={`/data/video-thumbnails/${excerpt.contactSheetFilename}`} alt="Excerpt contact sheet — one frame per cut and cue boundary" className="mt-1 w-full rounded border border-port-border" />
            </details>
          )}
          <div className="space-y-1">
            <span className="text-[11px] text-port-text-muted">Review notes — frame checks alone can't prove motion/audio sync; watch alongside the sheet</span>
            {excerpt.notes?.length > 0 && (
              <ul className="space-y-1">
                {excerpt.notes.map((note) => (
                  <NoteRow key={note.id} excerptId={excerpt.id} note={note} busy={noteBusy === excerpt.id}
                    onEdit={onEditNote} onDelete={onDeleteNote} onSeek={seek} />
                ))}
              </ul>
            )}
            <div className="flex items-center gap-1.5">
              <input value={draft} maxLength={2000} onChange={(e) => setDraft(e.target.value)}
                placeholder="Note at the current playhead…" aria-label="New review note"
                className="min-w-0 flex-1 bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs" />
              <button type="button" onClick={addNoteHere} disabled={noteBusy === excerpt.id || !draft.trim()}
                className="text-port-accent disabled:opacity-50 text-xs min-h-[44px] sm:min-h-0 px-2">Add</button>
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * Draft excerpt render (#8986): pick a `[startSec, endSec)` window and render
 * it through the same composed pipeline as a full render, at a size a fast
 * iteration loop can afford. Each excerpt keeps its own cut/cue contact sheet
 * and timecoded review notes against its OWN timeline (0 = the excerpt's
 * start) — a frame check alone can't prove motion/audio sync, so the video
 * plays alongside the sheet rather than replacing it.
 */
export default function ExcerptPanel({ project, rendering, progress, excerpts, revision = null, ...actions }) {
  const activeRevision = currentRevision(project);
  const canRevise = !!revision && !revision.busy && !rendering
    && !(activeRevision && (activeRevision.status === 'open' || activeRevision.status === 'rendering'));
  const durationSec = project?.audioAnalysis?.durationSec ?? null;
  const [startSec, setStartSec] = useState(0);
  const [endSec, setEndSec] = useState(durationSec ? Math.min(15, durationSec) : 15);
  const idFor = (s) => `mv-excerpt-${project?.id}-${s}`;
  const valid = Number.isFinite(startSec) && Number.isFinite(endSec) && endSec > startSec;

  return (
    <div className="space-y-2">
      <span className="text-xs text-port-text-muted flex items-center gap-1"><Film size={12} /> Draft excerpt</span>
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor={idFor('start')} className="block text-[10px] text-port-text-muted">Start (sec)</label>
          <input id={idFor('start')} type="number" min={0} step={0.5} value={startSec}
            onChange={(e) => setStartSec(Number(e.target.value))}
            className="w-24 bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs" />
        </div>
        <div>
          <label htmlFor={idFor('end')} className="block text-[10px] text-port-text-muted">End (sec)</label>
          <input id={idFor('end')} type="number" min={0} step={0.5} value={endSec}
            onChange={(e) => setEndSec(Number(e.target.value))}
            className="w-24 bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs" />
        </div>
        <button type="button" disabled={rendering || !valid}
          onClick={() => actions.startExcerpt(startSec, endSec)}
          className="flex items-center gap-1 bg-port-accent/20 text-port-accent disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0">
          <Film size={13} /> Render excerpt
        </button>
      </div>
      {rendering && (
        <div>
          <div className="h-1.5 bg-port-bg rounded overflow-hidden">
            <div className="h-full bg-port-accent transition-all" style={{ width: `${progress}%` }} />
          </div>
          <p className="text-xs text-port-text-muted mt-1">Rendering excerpt — {Math.round(progress)}%</p>
        </div>
      )}
      {revision && (
        <RevisionPanel project={project} busy={revision.busy || rendering}
          genScenes={revision.genScenes} genVideoScenes={revision.genVideoScenes}
          onResume={revision.resume} onCancel={revision.cancel} />
      )}
      {excerpts.length > 0 && (
        <ul className="space-y-2">
          {[...excerpts].reverse().map((excerpt) => (
            <ExcerptCard key={excerpt.id} excerpt={excerpt} deleting={actions.deletingId === excerpt.id} noteBusy={actions.noteBusyId}
              onDelete={actions.deleteExcerpt} onCancel={actions.cancelExcerpt}
              onAddNote={actions.addNote} onEditNote={actions.editNote} onDeleteNote={actions.deleteNote}
              canRevise={canRevise} onRevise={revision?.revise} />
          ))}
        </ul>
      )}
    </div>
  );
}
