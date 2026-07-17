/**
 * Render history gallery for a Creative Commission's detail page (#2657).
 *
 * Every scheduled/manual fire records a run pointing at the Creative Director
 * project it produced (`run.projectId`). This gallery resolves each run's project
 * to its representative produced asset (via ProjectPreview / selectProjectPreview)
 * so the user SEES what the commission has made — video/image thumbnails with a
 * play affordance — instead of a list of text rows. Each card also carries the
 * run's status, a "View output" deep link into the Creative Director, and the
 * per-run 👍/👎 + note control that steers the next scheduled run.
 *
 * `projectsById` is a `Map<projectId, project>` the parent page fetches once (the
 * CD list route returns full, non-slim payloads, so previews compute with no
 * extra per-card fetch). A run whose project hasn't loaded yet (or was pruned)
 * degrades to a status-only card — the "View output" link still works.
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, Film, ThumbsUp, ThumbsDown } from 'lucide-react';
import ProjectPreview from '../creative-director/ProjectPreview.jsx';
import { previewAspectClass } from '../../lib/creativeDirectorPreview.js';
import { timeAgo } from '../../utils/formatters';

const STATUS_CLASS = {
  started: 'text-port-accent',
  skipped: 'text-port-warning',
  failed: 'text-port-error',
};

export default function RenderHistory({ runs, feedback, projectsById, projectsLoading, onRate }) {
  // Newest-first, memoized so the copy+reverse doesn't run on every render.
  const orderedRuns = useMemo(() => [...(runs || [])].reverse(), [runs]);
  // Latest reaction per run (last write wins), so the run reflects its most
  // recent rating.
  const feedbackByRun = useMemo(() => {
    const map = {};
    for (const f of feedback || []) { if (f?.runId) map[f.runId] = f; }
    return map;
  }, [feedback]);

  if (orderedRuns.length === 0) {
    return (
      <div className="border border-dashed border-port-border rounded-lg p-10 text-center">
        <Film className="w-8 h-8 text-gray-600 mx-auto mb-3" aria-hidden="true" />
        <p className="text-gray-400 mb-1">No renders yet</p>
        <p className="text-gray-600 text-sm">
          When this commission fires — on its schedule or via “Run now” — each render shows up here.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
      {orderedRuns.map((r) => {
        const project = r.projectId ? projectsById.get(r.projectId) : null;
        return (
          <div key={r.id} className="bg-port-card border border-port-border rounded-lg overflow-hidden flex flex-col">
            {/* Produced-media preview (or a status-only placeholder). */}
            {project ? (
              <ProjectPreview project={project} to={`/creative-director/${encodeURIComponent(r.projectId)}`} />
            ) : (
              // `project` is null in this branch, so the placeholder falls back to
              // the default 16:9 box. Distinguish the transient load window (project
              // list still fetching) from a genuinely pruned/missing render — a real
              // render must not flash "unavailable" before the fetch resolves.
              <div className={`${previewAspectClass()} bg-port-bg flex flex-col items-center justify-center gap-1 text-gray-600 text-xs`}>
                <Film className="w-4 h-4 opacity-50" aria-hidden="true" />
                <span>{r.projectId ? (projectsLoading ? 'loading…' : 'render unavailable') : 'no render'}</span>
              </div>
            )}

            <div className="p-3 flex flex-col gap-2 flex-1">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="text-gray-400 flex items-center gap-1.5">
                  {timeAgo(r.ranAt)}
                  {/* Runs persisted before the trigger field exist only from cron ticks — no badge. */}
                  {r.trigger === 'manual' && (
                    <span className="text-[10px] uppercase px-1 py-0.5 rounded bg-port-accent/20 text-port-accent">manual</span>
                  )}
                </span>
                <span className={STATUS_CLASS[r.status] || 'text-gray-400'}>
                  {r.status}{r.reason ? ` · ${r.reason}` : ''}{r.error ? ` · ${r.error}` : ''}
                </span>
              </div>

              {r.projectId && (
                <Link
                  to={`/creative-director/${encodeURIComponent(r.projectId)}`}
                  className="text-port-accent hover:text-blue-400 inline-flex items-center gap-1 text-xs"
                >
                  <ExternalLink className="w-3 h-3" /> View output
                </Link>
              )}

              {/* Rate/annotate — pushed to the bottom of the card so cards align.
                  Keyed on the persisted reaction's timestamp so an externally-changed
                  note (a federated rating from another machine, arriving via a refetch)
                  remounts the control and re-seeds its local note, instead of leaving a
                  stale empty field that a Save could clobber the peer's note with. */}
              {r.projectId && onRate && (
                <div className="mt-auto pt-1">
                  <RunFeedback
                    key={feedbackByRun[r.id]?.at || 'unrated'}
                    runId={r.id}
                    current={feedbackByRun[r.id]}
                    onRate={onRate}
                  />
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Per-run rate/annotate control (#2657, Phase 2). Thumbs submit immediately,
// carrying whatever note is in the field; the current rating (if any) is shown
// highlighted. Note state is local so typing doesn't re-render the whole gallery.
//
// Note edits use an EXPLICIT Save affordance, not blur/focus autosave. Autosave
// on blur is a nest of edge cases — it races the vote request (blur during a
// busy window never retries), and can't reliably tell "tabbed through a thumb"
// from "clicked a thumb." A visible Save button (shown only while the note is
// dirty) makes the unsaved state obvious and unambiguous, and Enter is a
// shortcut for the same action. A note can't be saved before a rating exists (a
// rating is required), so the affordance only appears once the run is thumbed.
export function RunFeedback({ runId, current, onRate }) {
  const [note, setNote] = useState(current?.note || '');
  const [busy, setBusy] = useState(false);
  const rating = current?.rating;
  const isUp = rating === 'up' || (typeof rating === 'number' && rating > 0);
  const isDown = rating === 'down' || (typeof rating === 'number' && rating < 0);

  const submit = async (value) => {
    setBusy(true);
    try { await onRate(runId, value, note.trim()); }
    finally { setBusy(false); }
  };

  // A note edited after the run was rated is "dirty" until re-saved under the
  // existing rating. The Save button/Enter shortcut is gated on this.
  const noteDirty = !!rating && note.trim() !== (current?.note || '');
  const saveNote = () => { if (noteDirty && !busy) submit(rating); };

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        disabled={busy}
        onClick={() => submit('up')}
        aria-label="Like this result"
        aria-pressed={isUp}
        title="Like — steer future runs toward this"
        className={`p-1 rounded disabled:opacity-50 ${isUp ? 'text-port-success' : 'text-gray-500 hover:text-gray-300'}`}
      >
        <ThumbsUp className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => submit('down')}
        aria-label="Dislike this result"
        aria-pressed={isDown}
        title="Dislike — steer future runs away from this"
        className={`p-1 rounded disabled:opacity-50 ${isDown ? 'text-port-error' : 'text-gray-500 hover:text-gray-300'}`}
      >
        <ThumbsDown className="w-3.5 h-3.5" />
      </button>
      <input
        className="flex-1 min-w-0 bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-port-accent"
        value={note}
        maxLength={1000}
        placeholder={rating ? 'note (Enter to save)' : 'note — rate first'}
        aria-label={`Feedback note for run ${runId}`}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveNote(); } }}
      />
      {noteDirty && (
        <button
          type="button"
          disabled={busy}
          onClick={saveNote}
          aria-label={`Save note for run ${runId}`}
          className="text-xs text-port-accent hover:text-blue-400 disabled:opacity-50 px-1.5 py-1 whitespace-nowrap"
        >
          Save
        </button>
      )}
    </div>
  );
}
