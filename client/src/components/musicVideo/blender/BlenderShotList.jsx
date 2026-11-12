import { memo, useEffect, useRef, useState } from 'react';
import Pill from '../../ui/Pill';
import BlenderStatusChip from './BlenderStatusChip.jsx';
import { BLENDER_NOTE_STATUSES, blenderShotRenderStatus, blenderShotThumbPath, blenderShotTiming } from '../../../lib/musicVideoBlender.js';
import { useFilmApi } from './FilmApiContext.jsx';

const NOTE_LABELS = Object.fromEntries(BLENDER_NOTE_STATUSES);
const NOTE_TONES = { todo: 'muted', wip: 'accent', review: 'warning', approved: 'success' };

// A frame the layout says should exist may not (a partial render, a changed frame rate): fall back to the placeholder.
function ShotThumb({ src }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  if (!src || failed) return <span aria-hidden="true" className="h-9 w-16 shrink-0 rounded bg-port-bg" />;
  return <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} className="h-9 w-16 shrink-0 rounded bg-black object-cover" />;
}

/**
 * Every shot of the film, dense: thumbnail, id, label, where it sits in the
 * song, and its preview and final render as colour-plus-text chips, with the
 * director's note status. A row is the button that selects its shot; the
 * selected row scrolls into view when the timeline or a key moved it.
 */
function BlenderShotList({ projectId, state, selectedId, onSelect, noteDrafts = {} }) {
  const { musicVideoBlenderMediaUrl } = useFilmApi();
  const shots = state.manifest?.shots || [];
  const listRef = useRef(null);
  const rows = useRef(new Map());
  // Scrolls the list only: `scrollIntoView` would also move the page under a director stepping shots from the timeline.
  useEffect(() => {
    const list = listRef.current;
    const row = rows.current.get(selectedId);
    if (!list || !row) return;
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
  }, [selectedId]);

  return (
    <ul ref={listRef} aria-label="Shots" className="relative max-h-[45dvh] min-w-0 divide-y divide-port-border overflow-y-auto rounded border border-port-border @2xl:max-h-[70dvh]">
      {shots.map((shot) => {
        const selected = shot.id === selectedId;
        const thumb = blenderShotThumbPath(state, shot);
        const note = state.notes?.[shot.id];
        const noteStatus = noteDrafts[shot.id]?.status || note?.status;
        return (
          <li key={shot.id}>
            <button
              type="button"
              ref={(node) => { if (node) rows.current.set(shot.id, node); else rows.current.delete(shot.id); }}
              aria-pressed={selected}
              onClick={() => onSelect(shot.id)}
              className={`flex min-h-[44px] w-full min-w-0 items-center gap-2 px-2 py-1.5 text-left hover:bg-port-bg focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-port-accent ${selected ? 'bg-port-accent/10' : ''}`}
            >
              <ShotThumb src={thumb ? musicVideoBlenderMediaUrl(projectId, thumb) : null} />
              <span className="min-w-0 flex-1 space-y-0.5">
                <span className="flex min-w-0 items-baseline gap-1.5 text-sm">
                  <span className="shrink-0 font-mono text-xs text-port-text-muted">{shot.id}</span>
                  <span className="min-w-0 truncate">{shot.label || 'Untitled shot'}</span>
                </span>
                <span className="block truncate text-[11px] text-port-text-muted">{blenderShotTiming(shot)}</span>
                <span className="flex min-w-0 flex-wrap items-center gap-1">
                  <BlenderStatusChip label="Preview" view={blenderShotRenderStatus(state, shot.id, 'preview')} />
                  <BlenderStatusChip label="Final" view={blenderShotRenderStatus(state, shot.id, 'final')} />
                  {noteStatus && (note?.text || noteDrafts[shot.id] || noteStatus !== 'todo') && (
                    <Pill size="xs" tone={NOTE_TONES[noteStatus] || 'muted'}>Note {NOTE_LABELS[noteStatus]?.toLowerCase() || noteStatus}</Pill>
                  )}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// The Shots tab re-renders as the player reports its position; the rows only change with the state or the selection.
export default memo(BlenderShotList);
