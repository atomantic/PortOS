import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { sceneTakeList, TAKE_SLOT } from '../../lib/musicVideoTakes.js';
import SceneTakeCard from './SceneTakeCard.jsx';

const KIND_LABEL = { image: 'Frame takes', video: 'Clip takes', endImage: 'End frame takes' };

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
 * `saving` holds the take controls waiting on a reply (useMusicVideoTakes `pending`, keys from `takeControl`):
 * each shows it is saving and stays disabled until the reply, so a slow reply is not pressed twice.
 * `onMove(take, toSceneId)` moves a take the shot is not using to another shot of `project`, to organize takes
 * (a rejected or bad one included); it keeps its status and note there.
 */
export default function SceneTakeStrip({
  scene, project = null, kind, busy = false, saving = null, large = false, grid = false, onSelect, onReview, onOpenPreview, marks = null, onMark = null, pending = [],
  onCheck = null, checking = null, onRefine = null, refineDisabled = false, onMove = null,
}) {
  const [noteFor, setNoteFor] = useState(null);
  const [moveFor, setMoveFor] = useState(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [playingId, setPlayingId] = useState(null);
  const [openVerdict, setOpenVerdict] = useState(null);
  const noteInputRef = useRef(null);
  const copyPointer = useRef(false);
  useEffect(() => {
    if (noteFor) noteInputRef.current?.focus();
  }, [noteFor]);
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
  const moveTargets = onMove ? (project?.scenes || []).filter((entry) => entry.sceneId !== scene.sceneId)
    .slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0)) : [];

  return (
    <div className="space-y-1">
      <div className="text-[11px] text-port-text-muted">
        {KIND_LABEL[kind]} ({takes.length}){rendering.length ? ` · ${rendering.length} rendering` : ''}
      </div>
      <ul className={grid ? 'grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2 sm:grid-cols-[repeat(auto-fill,minmax(6rem,1fr))]' : 'flex gap-2 overflow-x-auto pb-1'} aria-label={`${KIND_LABEL[kind]} for ${scene.label || `scene ${scene.order + 1}`}`}>
        {takes.map((take) => (
          <SceneTakeCard key={take.takeId || `legacy-${take.assetId}`} take={take} scene={scene} project={project}
            kind={kind} thumbClass={thumbClass} isSelected={take.assetId === selected} busy={busy} saving={saving}
            playback={{ playingId, setPlayingId, copyPointer }} verdict={{ openVerdict, setOpenVerdict }}
            notes={{ noteFor, noteDraft, setNoteDraft, noteInputRef, openNote, saveNote }}
            move={{ moveFor, setMoveFor, moveTargets, onMove }}
            actions={{ onSelect, onReview, onOpenPreview, marks, onMark, onCheck, checking, onRefine, refineDisabled }} />
        ))}
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
