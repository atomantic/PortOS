import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ExternalLink, LayoutPanelLeft, Loader2, Unlink } from 'lucide-react';
import { createStoryboard, getStoryboard, listStoryboards, makeStoryboardFromMusicVideo } from '../../services/api';
import { formatCount, formatTimecode } from '../../utils/formatters';
import { selectedTake, takeSrc } from '../storyboards/storyboardArt';

const actionButton = 'min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-lg border border-port-border px-3 text-sm text-gray-200 hover:border-port-accent/60 hover:text-white disabled:opacity-40';
const plural = (n, word) => `${formatCount(n)} ${word}${n === 1 ? '' : 's'}`;
const STRIP_PANELS = 8;

/**
 * Links (or unlinks) the video's storyboard through the step's board object;
 * `saved` means the server already linked it (Make storyboard from this video).
 */
export function useStoryboardLink(board) {
  const [linkError, setLinkError] = useState('');
  const linkStoryboard = (storyboardId, { saved = false } = {}) => {
    setLinkError('');
    if (saved) { board.editProjectLocal({ storyboardId }); return Promise.resolve(true); }
    return board.saveStoryLink(storyboardId).then(() => true).catch((err) => {
      setLinkError(err?.message || 'Could not link the storyboard.'); return false;
    });
  };
  return { linkStoryboard, linkError };
}

/**
 * A music video's link to a Create › Storyboards board: pick one, make one from
 * this video's shots, or start an empty one in the production sketch style,
 * then see it at a glance and open it (`openPath`, the video's Storyboard step
 * by default). Linking changes no shot; only Fit to song on the Storyboard
 * step writes them.
 */
export default function StoryboardLinkPanel({ project, onLink, openPath, refreshKey = 0 }) {
  const linkedId = project.storyboardId || null;
  // undefined = loading, null = missing on this machine.
  const [board, setBoard] = useState(undefined);
  // null = not read yet, undefined = reading.
  const [boards, setBoards] = useState(null);
  const [listError, setListError] = useState(false);
  const [making, setMaking] = useState(false);
  const [makeError, setMakeError] = useState('');

  useEffect(() => {
    if (!linkedId) return undefined;
    let active = true;
    // A re-read of the same board keeps it on screen; another board shows as loading.
    setBoard((current) => (current?.id === linkedId ? current : undefined));
    getStoryboard(linkedId, { silent: true })
      .then((next) => { if (active) setBoard(next); })
      .catch(() => { if (active) setBoard(null); });
    return () => { active = false; };
  }, [linkedId, refreshKey]);

  // The board list is read when the picker is first touched, not on every Plan visit.
  const loadBoards = () => {
    if (boards !== null) return;
    setBoards(undefined);
    setListError(false);
    listStoryboards({ silent: true })
      .then((rows) => setBoards(Array.isArray(rows) ? rows : []))
      // A failed read says so; it must not look like there are no boards.
      .catch(() => { setBoards(null); setListError(true); });
  };

  const makeFromVideo = async () => {
    setMaking(true);
    const res = await makeStoryboardFromMusicVideo(project.id).catch(() => null);
    setMaking(false);
    if (res?.board) {
      setBoard(res.board);
      onLink(res.board.id, { saved: true });
    }
  };

  const makeEmpty = async () => {
    setMaking(true);
    setMakeError('');
    const next = await createStoryboard({ name: (project.name || 'Storyboard').slice(0, 120), artStyle: 'production-sketch' }, { silent: true }).catch((err) => { setMakeError(err?.message || 'Could not create the storyboard.'); return null; });
    if (next?.id) {
      setBoard(next);
      if (!(await onLink(next.id))) setMakeError('The storyboard was created but could not be linked. Find it in Create › Storyboards.');
    }
    setMaking(false);
  };

  if (linkedId) {
    if (board === undefined) return <p role="status" className="text-xs text-gray-500">Reading the storyboard…</p>;
    if (board === null) {
      return (
        <div className="flex flex-wrap items-center gap-2">
          <p role="status" className="flex-1 text-xs text-port-warning">The linked storyboard isn't on this machine, or was deleted.</p>
          <button type="button" onClick={() => onLink(null)} className={actionButton}><Unlink size={16} aria-hidden="true" /> Unlink</button>
        </div>
      );
    }
    const panels = board.beats.flatMap((beat) => beat.panels);
    const runtime = panels.reduce((sum, panel) => sum + (panel.seconds || 0), 0);
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <LayoutPanelLeft size={16} className="shrink-0 text-port-accent" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-white">{board.name}</p>
            <p className="text-[11px] text-gray-400 tabular-nums">{plural(board.beats.length, 'beat')} · {plural(panels.length, 'panel')} · {formatTimecode(runtime)}</p>
          </div>
          <Link to={openPath || `/storyboards/${board.id}`} className={actionButton}><ExternalLink size={16} aria-hidden="true" /> Open</Link>
          <button type="button" onClick={() => onLink(null)} className={actionButton}><Unlink size={16} aria-hidden="true" /> Unlink</button>
        </div>
        {panels.length > 0 && (
          <ol className="flex gap-1 overflow-x-auto" aria-label="Storyboard panels">
            {panels.slice(0, STRIP_PANELS).map((panel, index) => {
              const src = takeSrc(selectedTake(panel));
              return (
                <li key={panel.id} className="h-12 w-20 shrink-0 overflow-hidden rounded bg-port-bg">
                  {src ? <img src={src} alt={panel.action || `Panel ${index + 1}`} loading="lazy" className="h-full w-full object-cover" />
                    : <p className="p-1 text-[10px] leading-tight text-gray-500 line-clamp-3">{panel.action || `Panel ${index + 1}`}</p>}
                </li>
              );
            })}
            {panels.length > STRIP_PANELS && <li className="flex h-12 shrink-0 items-center px-1 text-[11px] text-gray-500">+{formatCount(panels.length - STRIP_PANELS)}</li>}
          </ol>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-gray-400">Plan the story on a storyboard: beats and panels you can sketch and play before the song is final.</p>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="mv-storyboard-link" className="sr-only">Link a storyboard</label>
        <select id="mv-storyboard-link" value="" onFocus={loadBoards} onPointerDown={loadBoards} onChange={(e) => e.target.value && onLink(e.target.value)}
          className="min-h-[44px] min-w-0 flex-1 bg-port-bg border border-port-border rounded px-2 text-sm text-white">
          <option value="">{boards === undefined ? 'Reading storyboards…' : boards && !boards.length ? 'No storyboards yet' : 'Link a storyboard…'}</option>
          {(boards || []).map((row) => <option key={row.id} value={row.id}>{row.name} ({plural(row.panelCount, 'panel')})</option>)}
        </select>
        {(project.scenes || []).length > 0 && (
          <button type="button" onClick={makeFromVideo} disabled={making} className={actionButton}>
            {making ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <LayoutPanelLeft size={16} aria-hidden="true" />} Make storyboard from this video
          </button>
        )}
        <button type="button" onClick={makeEmpty} disabled={making} className={actionButton}>
          <LayoutPanelLeft size={16} aria-hidden="true" /> {making ? 'Creating…' : 'Create storyboard'}
        </button>
      </div>
      {listError && <p role="status" className="text-xs text-port-warning">Storyboards could not be read. Tap the picker to try again.</p>}
      {makeError && <p role="alert" className="text-xs text-port-error">{makeError}</p>}
    </div>
  );
}
