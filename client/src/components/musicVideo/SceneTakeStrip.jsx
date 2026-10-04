import { useState } from 'react';
import { Check, RotateCcw, X, MessageSquare } from 'lucide-react';
import { sceneTakeList, takePreviewKey, takeThumbUrl, takeClipUrl, takeProvenance, TAKE_SLOT } from '../../lib/musicVideoTakes.js';
import { plateVerdict } from './PlateComparison.jsx';

const VERDICT_TONE = { pass: 'bg-port-success/20 text-port-success', fail: 'bg-port-error/20 text-port-error', unverified: 'bg-port-warning/20 text-port-warning' };
const KIND_LABEL = { image: 'Frame takes', video: 'Clip takes' };

/**
 * Side-by-side review of one scene slot's takes (#8965): every render or
 * import is a candidate; the director explicitly picks the one the render uses,
 * rejects the ones that miss (with a note for the next attempt), and restores a
 * rejected take by selecting it. Used compactly on each SceneCard and at a
 * larger size in the project contact sheet.
 *
 * A legacy take (a pre-takes selection the server hasn't materialized yet) is
 * shown but has no actions — it has no take id to address.
 */
export default function SceneTakeStrip({
  scene, kind, busy = false, large = false, onSelect, onReview, onOpenPreview,
}) {
  const [noteFor, setNoteFor] = useState(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [playingId, setPlayingId] = useState(null);
  const takes = sceneTakeList(scene, kind);
  const selected = scene[TAKE_SLOT[kind]] || null;
  if (takes.length === 0) return null;

  const openNote = (take) => { setNoteFor(take.takeId); setNoteDraft(take.note || ''); };
  const saveNote = (take) => {
    setNoteFor(null);
    if ((take.note || '') !== noteDraft.trim()) onReview?.(take, { note: noteDraft.trim() || null });
  };
  const thumbClass = large ? 'w-40' : 'w-24';
  const noteInputId = (take) => `mv-take-note-${scene.sceneId}-${take.takeId}`;

  return (
    <div className="space-y-1">
      <div className="text-[11px] text-port-text-muted">
        {KIND_LABEL[kind]} ({takes.length})
      </div>
      <ul className="flex gap-2 overflow-x-auto pb-1" aria-label={`${KIND_LABEL[kind]} for ${scene.label || `scene ${scene.order + 1}`}`}>
        {takes.map((take) => {
          const isSelected = take.assetId === selected;
          const rejected = take.status === 'rejected';
          const verdict = kind === 'image' ? plateVerdict(scene, take) : null;
          const playKey = take.takeId || take.assetId;
          const playing = kind === 'video' && playingId === playKey;
          return (
            <li key={take.takeId || `legacy-${take.assetId}`} className={`${thumbClass} shrink-0 space-y-1`}>
              <button
                type="button"
                data-take-focus=""
                onClick={() => onOpenPreview?.(takePreviewKey(take))}
                onMouseEnter={() => setPlayingId(playKey)}
                onMouseLeave={() => setPlayingId(null)}
                onFocus={() => setPlayingId(playKey)}
                onBlur={() => setPlayingId(null)}
                aria-label={`View ${kind === 'image' ? 'frame' : 'clip'} take full size`}
                className={`relative block w-full rounded overflow-hidden border focus:outline-none focus:ring-2 focus:ring-port-accent ${isSelected ? 'border-port-accent ring-2 ring-port-accent' : 'border-port-border'} ${rejected ? 'opacity-40' : ''}`}
              >
                <img src={takeThumbUrl(take)} alt="" loading="lazy" className="w-full aspect-video object-cover block bg-black" />
                {playing && <video src={takeClipUrl(take)} autoPlay muted loop playsInline aria-hidden="true" className="absolute inset-0 w-full h-full object-cover bg-black" />}
              </button>
              <div className="text-[10px] text-port-text-muted truncate" title={take.originalName || take.prompt || takeProvenance(take)}>
                {verdict && <span className={`mr-1 rounded px-1 ${VERDICT_TONE[verdict.tone]}`} title="Plate preflight verdict">{verdict.label}</span>}
                {isSelected ? <span className="text-port-accent">Selected · </span> : null}
                {rejected ? 'rejected · ' : ''}{takeProvenance(take)}
              </div>
              {take.note && noteFor !== take.takeId && (
                <p className="text-[10px] text-port-warning break-words">{take.note}</p>
              )}
              {take.takeId && (
                <div className="flex flex-wrap gap-1">
                  {!isSelected && (
                    <button type="button" disabled={busy} onClick={() => onSelect?.(take)}
                      className="inline-flex items-center gap-0.5 rounded bg-port-accent/20 text-port-accent px-1.5 py-0.5 text-[10px] min-h-[32px] sm:min-h-0 disabled:opacity-50"
                      title="Use this take for the scene">
                      <Check size={11} /> Use
                    </button>
                  )}
                  {rejected ? (
                    <button type="button" disabled={busy} onClick={() => onReview?.(take, { status: 'candidate' })}
                      className="inline-flex items-center gap-0.5 rounded bg-port-border px-1.5 py-0.5 text-[10px] min-h-[32px] sm:min-h-0 disabled:opacity-50"
                      title="Restore this take as a candidate">
                      <RotateCcw size={11} /> Restore
                    </button>
                  ) : (
                    <button type="button" disabled={busy} onClick={() => { onReview?.(take, { status: 'rejected' }); openNote(take); }}
                      className="inline-flex items-center gap-0.5 rounded bg-port-border px-1.5 py-0.5 text-[10px] min-h-[32px] sm:min-h-0 disabled:opacity-50"
                      title={isSelected ? 'Reject — clears the selection so the next render fills it' : 'Reject this take'}>
                      <X size={11} /> Reject
                    </button>
                  )}
                  <button type="button" disabled={busy} onClick={() => openNote(take)}
                    aria-label="Edit take note"
                    className="inline-flex items-center rounded bg-port-border px-1.5 py-0.5 text-[10px] min-h-[32px] sm:min-h-0 disabled:opacity-50"
                    title="Note what to change on the next attempt">
                    <MessageSquare size={11} />
                  </button>
                </div>
              )}
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
                    className="w-full bg-port-bg border border-port-border rounded px-1 py-0.5 text-[11px] min-h-[44px] sm:min-h-0"
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
