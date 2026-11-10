import { currentPlateEvidence, renderQualityAcknowledged } from '../../../../server/lib/musicVideoPlateEvidence.js';
import { useRef, useState } from 'react';
import { Ban, Check, Loader2, RotateCcw, Eye, X, MessageSquare, PencilLine } from 'lucide-react';
import { sceneTakeList, takePreviewKey, takeThumbUrl, takeClipUrl, takeProvenance, TAKE_SLOT } from '../../lib/musicVideoTakes.js';
import { plateVerdict } from './PlateComparison.jsx';
import AssetReferenceActions from '../media/AssetReferenceActions.jsx';
import { getVideoHistoryItem } from '../../services/apiImageVideo.js';

const VERDICT_TONE = { pass: 'bg-port-success/20 text-port-success', fail: 'bg-port-error/20 text-port-error', unverified: 'bg-port-warning/20 text-port-warning' };
// The project's asset marks are keyed by media kind: an end frame is a still like any other.
const takeMarkKey = (take) => `${take.kind === 'video' ? 'video' : 'image'}:${take.assetId}`;
const KIND_LABEL = { image: 'Frame takes', video: 'Clip takes', endImage: 'End frame takes' };

async function videoTakeUrl(take) {
  const record = await getVideoHistoryItem(take.assetId, { silent: true });
  const filename = record?.filename;
  if (record?.id !== take.assetId || typeof filename !== 'string' || !filename || /[/\\]/.test(filename) || filename === '.' || filename === '..') return null;
  return `/data/videos/${encodeURIComponent(filename)}`;
}

/**
 * Side-by-side review of one scene slot's takes (#8965): every render or
 * import is a candidate; the director explicitly picks the one the render uses,
 * rejects the ones that miss (with a note for the next attempt), and restores a
 * rejected take by selecting it. Used compactly on each SceneCard and at a
 * larger size in the project contact sheet.
 *
 * Rejecting a take only says it is not for this shot: it stays available to
 * other shots in Swap. Bad is a separate mark (`marks`, the project's
 * assetMarks; `onMark(take, 'bad' | null)`) for files to clean up later; the
 * server also rejects a bad file's takes on the shots not using it.
 *
 * A legacy take (a pre-takes selection the server hasn't materialized yet)
 * has copy actions but no review actions, because it has no take id to address.
 * `grid` lays the takes out in rows that fit the width instead of one scrolling row.
 * `pending` lists renders still in flight for this slot (`{ key, label, running, progress }`):
 * each shows as a "Rendering grok…" placeholder after the takes until its take lands.
 * `onCheck(take)` runs a vision check of a start or end frame take against its shot; `checking` holds
 * the take ids in flight. A checked take wears its verdict, which opens to the misses.
 */
export default function SceneTakeStrip({
  scene, kind, busy = false, large = false, grid = false, onSelect, onReview, onOpenPreview, marks = null, onMark = null, pending = [],
  onCheck = null, checking = null, onRefine = null, refineDisabled = false,
}) {
  const [noteFor, setNoteFor] = useState(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [playingId, setPlayingId] = useState(null);
  const [openVerdict, setOpenVerdict] = useState(null);
  const copyPointer = useRef(false);
  const takes = sceneTakeList(scene, kind);
  const selected = scene[TAKE_SLOT[kind]] || null;
  const rendering = Array.isArray(pending) ? pending : [];
  if (takes.length === 0 && rendering.length === 0) return null;

  const openNote = (take) => { setNoteFor(take.takeId); setNoteDraft(take.note || ''); };
  const saveNote = (take) => {
    setNoteFor(null);
    if ((take.note || '') !== noteDraft.trim()) onReview?.(take, { note: noteDraft.trim() || null });
  };
  const thumbClass = grid ? 'min-w-0' : `${large ? 'w-40' : 'w-24'} shrink-0`;
  const noteInputId = (take) => `mv-take-note-${scene.sceneId}-${take.takeId}`;

  return (
    <div className="space-y-1">
      <div className="text-[11px] text-port-text-muted">
        {KIND_LABEL[kind]} ({takes.length}){rendering.length ? ` · ${rendering.length} rendering` : ''}
      </div>
      <ul className={grid ? 'grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2 sm:grid-cols-[repeat(auto-fill,minmax(6rem,1fr))]' : 'flex gap-2 overflow-x-auto pb-1'} aria-label={`${KIND_LABEL[kind]} for ${scene.label || `scene ${scene.order + 1}`}`}>
        {takes.map((take) => {
          const isSelected = take.assetId === selected;
          const rejected = take.status === 'rejected';
          const bad = marks?.[takeMarkKey(take)] === 'bad';
          const frameTake = kind === 'image' || kind === 'endImage';
          const verdict = frameTake ? plateVerdict(scene, take) : null;
          const verdictOpen = openVerdict === take.takeId && verdict?.issues.length > 0;
          const takeChecking = Boolean(take.takeId && checking?.has(take.takeId));
          const playKey = take.takeId || take.assetId;
          const playing = kind === 'video' && playingId === playKey;
          return (
            <li key={take.takeId || `legacy-${take.assetId}`} className={`${thumbClass} space-y-1`}
              onPointerDownCapture={(event) => { copyPointer.current = Boolean(event.target.closest('[data-asset-copy-trigger]')); }}
              onPointerUpCapture={() => { if (copyPointer.current) setTimeout(() => { copyPointer.current = false; }, 0); }}
              onPointerCancelCapture={() => { copyPointer.current = false; }}
              onMouseLeave={() => setPlayingId(null)}
              onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget) && !copyPointer.current) setPlayingId(null); }}>
              <button
                type="button"
                data-take-focus=""
                onClick={() => onOpenPreview?.(takePreviewKey(take))}
                onMouseEnter={() => setPlayingId(playKey)}
                onFocus={() => setPlayingId(playKey)}
                aria-label={`View ${kind === 'video' ? 'clip' : 'frame'} take full size`}
                className={`relative block w-full rounded overflow-hidden focus:outline-none focus:ring-2 focus:ring-port-accent ${isSelected ? 'border-2 border-port-accent ring-4 ring-port-accent/50' : 'border border-port-border'} ${rejected ? 'opacity-40' : ''}`}
              >
                <img src={takeThumbUrl(take)} alt="" loading="lazy" className="w-full aspect-video object-cover block bg-black" />
                {playing && <video src={takeClipUrl(take)} autoPlay muted loop playsInline className="absolute inset-0 w-full h-full object-cover bg-black" />}
                {/* The take the render uses wears a badge, so it reads at a glance among the others. */}
                {bad && (
                  <span className="port-media-overlay-strong absolute right-1 top-1 inline-flex items-center gap-0.5 rounded px-1 text-[10px] text-port-error">
                    <Ban size={10} aria-hidden="true" /> Bad
                  </span>
                )}
                {isSelected && (
                  <span className="absolute left-1 top-1 inline-flex items-center gap-0.5 rounded bg-port-accent px-1.5 py-0.5 text-[10px] font-semibold text-white shadow">
                    <Check size={11} aria-hidden="true" /> In use
                  </span>
                )}
              </button>
              {/* Only what the director acts on: how a take was made stays in the hover title. */}
              {/* "In use" is already on the thumbnail; a rejected take reads from its dimmed thumbnail and Restore. */}
              {verdict && (
                <div className="flex flex-wrap items-center gap-1 text-[10px] text-port-text-muted" title={take.originalName || take.prompt || takeProvenance(take)}>
                  {verdict.issues.length ? (
                    <button type="button" onClick={() => setOpenVerdict(verdictOpen ? null : take.takeId)} aria-expanded={verdictOpen}
                      className={`rounded px-1 pointer-coarse:min-h-8 ${VERDICT_TONE[verdict.tone]}`} title="Show what the check found">
                      {verdict.label} ({verdict.issues.length})
                    </button>
                  ) : <span className={`rounded px-1 ${VERDICT_TONE[verdict.tone]}`} title="A vision check found it matches the shot">{verdict.label}</span>}
                </div>
              )}
              {verdictOpen && (
                <ul className="space-y-0.5 text-[10px] text-port-warning">
                  {verdict.issues.map((check) => <li key={check.id} className="break-words">{check.note}</li>)}
                </ul>
              )}
              {take.note && noteFor !== take.takeId && (
                <p className="text-[10px] text-port-warning break-words">{take.note}</p>
              )}
              {take.dependencies?.references?.some((ref) => ref.role === 'clipReferences' && ref.untrackedCastGuides) && (
                <p className="text-[10px] text-port-warning break-words">Cast guide changes are not tracked. Review this take before use.</p>
              )}
              {frameTake && onRefine && (
                <button type="button" disabled={busy || refineDisabled} onClick={() => onRefine(take)}
                  className="inline-flex items-center gap-0.5 rounded border border-port-border bg-port-bg px-1.5 py-0.5 text-[10px] pointer-coarse:min-h-11 min-h-[32px] sm:min-h-0 disabled:opacity-50"
                  title="Refine this image with an instruction without selecting it">
                  <PencilLine size={11} /> Refine take
                </button>
              )}
              {take.takeId && (
                <div className="flex flex-wrap gap-1">
                  {!isSelected && (
                    <button type="button" disabled={busy} onClick={() => onSelect?.(take)}
                      className="inline-flex items-center gap-0.5 rounded bg-port-accent/20 text-port-accent px-1.5 py-0.5 text-[10px] pointer-coarse:min-h-11 min-h-[32px] sm:min-h-0 disabled:opacity-50"
                      title="Use this take for the scene">
                      <Check size={11} /> Use
                    </button>
                  )}
                  {rejected ? (
                    <button type="button" disabled={busy} onClick={() => onReview?.(take, { status: 'candidate' })}
                      className="inline-flex items-center gap-0.5 rounded bg-port-border px-1.5 py-0.5 text-[10px] pointer-coarse:min-h-11 min-h-[32px] sm:min-h-0 disabled:opacity-50"
                      title="Restore this take as a candidate">
                      <RotateCcw size={11} /> Restore
                    </button>
                  ) : (
                    <button type="button" disabled={busy} onClick={() => { onReview?.(take, { status: 'rejected' }); openNote(take); }}
                      className="inline-flex items-center gap-0.5 rounded bg-port-border px-1.5 py-0.5 text-[10px] pointer-coarse:min-h-11 min-h-[32px] sm:min-h-0 disabled:opacity-50"
                      title={isSelected ? 'Not for this shot: clears the selection so the next render fills it. Other shots can still use it.' : 'Not for this shot. Other shots can still use it.'}>
                      <X size={11} /> Reject
                    </button>
                  )}
                  {onMark && (
                    <button type="button" disabled={busy} onClick={() => onMark(take, bad ? null : 'bad')} aria-pressed={bad}
                      className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] pointer-coarse:min-h-11 min-h-[32px] sm:min-h-0 disabled:opacity-50 ${bad ? 'bg-port-error/20 text-port-error' : 'bg-port-border'}`}
                      title={bad ? 'Clear the bad mark' : 'Mark this file bad, to clean up when the project is done. It is also rejected on every shot not using it, and stays counted in the stats.'}>
                      <Ban size={11} /> Bad
                    </button>
                  )}
                  {onCheck && frameTake && !rejected && (
                    <button type="button" disabled={takeChecking} onClick={() => onCheck(take)}
                      className="inline-flex items-center gap-0.5 rounded bg-port-border px-1.5 py-0.5 text-[10px] pointer-coarse:min-h-11 min-h-[32px] sm:min-h-0 disabled:opacity-50"
                      title={kind === 'endImage' ? 'A vision model checks this end frame against its end-frame prompt and for render defects' : 'A vision model checks this frame against the shot prompt and for render defects'}>
                      {takeChecking ? <Loader2 size={11} className="animate-spin" aria-hidden="true" /> : <Eye size={11} aria-hidden="true" />} {takeChecking ? 'Checking' : 'Check'}
                    </button>
                  )}
                  <button type="button" disabled={busy} onClick={() => openNote(take)}
                    aria-label="Edit take note"
                    className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 inline-flex items-center rounded bg-port-border px-1.5 py-0.5 text-[10px] min-h-[32px] sm:min-h-0 disabled:opacity-50"
                    title="Note what to change on the next attempt">
                    <MessageSquare size={11} />
                  </button>
                </div>
              )}
              {/* Secondary: copy the file's ID or URL, after the review actions. */}
              <AssetReferenceActions assetId={take.assetId} compact
                url={kind === 'video' ? null : takeThumbUrl(take)}
                resolveUrl={kind === 'video' ? () => videoTakeUrl(take) : null} />
              {frameTake && currentPlateEvidence(scene, take)?.checks.filter((check) => check.id === 'render-quality' && check.status === 'fail').map((check) => (
                <div key={check.id} className="space-y-1 text-xs text-port-warning">
                  <p className="break-words">Rendering defect: {check.note}</p>
                  {renderQualityAcknowledged(scene, take) ? <p>Explicitly acknowledged for this image.</p> : onReview && take.takeId && (
                    <button type="button" disabled={busy} className="min-h-11 rounded border border-port-warning px-2 py-1 disabled:opacity-50"
                      onClick={() => onReview(take, { acknowledgeRenderQuality: { basis: take.plateEvidence.basis, note: check.note } })}>
                      Acknowledge rendering defect
                    </button>
                  )}
                </div>
              ))}
              {noteFor === take.takeId && (
                <div>
                  <label htmlFor={noteInputId(take)} className="sr-only">Take note</label>
                  <input
                    id={noteInputId(take)}
                    value={noteDraft}
                    maxLength={1000}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    onBlur={() => saveNote(take)}
                    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                    placeholder="What to change next time"
                    className="w-full bg-port-bg border border-port-border rounded px-1 py-0.5 text-[11px] min-h-[44px] pointer-fine:sm:min-h-0"
                  />
                </div>
              )}
            </li>
          );
        })}
        {rendering.map((job) => {
          const pct = job.running && typeof job.progress === 'number' ? Math.round(job.progress * 100) : null;
          return (
            <li key={`pending-${job.key}`} className={thumbClass} data-testid="pending-take">
              <div role="status" className="flex aspect-video w-full flex-col items-center justify-center gap-1 rounded border border-dashed border-port-accent/60 bg-port-bg px-1 text-center text-[10px] text-port-text-muted">
                <Loader2 size={14} className="animate-spin text-port-accent" aria-hidden="true" />
                <span className="text-port-text">Rendering{job.label ? ` ${job.label}` : ''}…</span>
                <span>{job.running ? (pct != null ? `${pct}%` : 'Running') : 'Queued'}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
