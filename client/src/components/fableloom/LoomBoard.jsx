import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Check, CornerUpLeft, GitBranch, ImageIcon, LayoutPanelLeft, Loader2 } from 'lucide-react';
import MediaImage from '../MediaImage';
import { listStoryboards, makeStoryboardFromFableLoom } from '../../services/api';
import { aspectClass } from '../storyboards/storyboardArt';
import { formatCount, formatTimecode } from '../../utils/formatters';
import { fableLoomBoardPath } from '../../../../server/lib/fableLoomBoard.js';

const END_LABELS = {
  ending: 'The path reaches an ending.',
  loop: 'The path loops back to an earlier scene.',
  open: 'The path stops at a scene with no way on.',
};
const thumb = (image) => `/data/images/${encodeURIComponent(image)}`;

/**
 * One path through an episode as storyboard panels, grouped by dramatic scene.
 * A fork's other choices sit under its panel; picking one moves the path
 * (`via`, in the URL). Tapping a panel opens the scene in the graph.
 * "Make storyboard from this path" copies the path into Create › Storyboards,
 * where recipes make panel art that "Use as scene art" sends back here.
 */
export default function LoomBoard({ loomId, episode, aspectRatio, via, onPick, onOpenNode }) {
  const navigate = useNavigate();
  const path = useMemo(() => fableLoomBoardPath(episode, via), [episode, via]);
  const [boardList, setBoardList] = useState(null);
  const boards = boardList?.loomId === loomId && boardList?.episodeId === episode.id ? boardList.rows : [];
  const [making, setMaking] = useState(false);
  useEffect(() => {
    let active = true;
    listStoryboards({ silent: true })
      .then((rows) => { if (active) setBoardList({ loomId, episodeId: episode.id,
        rows: (rows || []).filter((b) => b.source?.loomId === loomId && b.source?.episodeId === episode.id) }); })
      .catch(() => {});
    return () => { active = false; };
  }, [loomId, episode.id]);
  const makeBoard = async () => {
    setMaking(true);
    const board = await makeStoryboardFromFableLoom(loomId, episode.id, via).catch(() => null);
    setMaking(false);
    if (board?.id) navigate(`/storyboards/${encodeURIComponent(board.id)}`);
  };
  const scenes = path.beats.reduce((sum, beat) => sum + beat.panels.length, 0);
  const titleOf = (id) => episode.nodes.find((node) => node.id === id)?.title || 'an earlier scene';

  if (path.end === 'empty') return <p className="p-6 text-sm text-port-text-muted">This episode has no start scene yet.</p>;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2 sm:p-4 space-y-4" aria-label="Episode board">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={makeBoard} disabled={making}
          className="min-h-[44px] inline-flex items-center gap-1.5 rounded border border-port-border px-3 text-sm text-port-text hover:border-port-accent/60 disabled:opacity-50">
          {making ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <LayoutPanelLeft size={16} aria-hidden="true" />} Make storyboard from this path
        </button>
        {boards.map((board) => (
          <Link key={board.id} to={`/storyboards/${encodeURIComponent(board.id)}`}
            className="min-h-[44px] inline-flex items-center rounded px-2 text-sm text-port-accent hover:underline">
            {board.name}
          </Link>
        ))}
      </div>
      <p className="text-xs text-port-text-muted">
        {formatCount(scenes)} scene{scenes === 1 ? '' : 's'} on this path
        {path.totalSeconds > 0 && <>, <span className="tabular-nums">{formatTimecode(path.totalSeconds)}</span></>}. {END_LABELS[path.end]}
      </p>
      {path.beats.map((beat) => (
        <section key={`${beat.id}-${beat.panels[0].number}`} aria-label={beat.title || `Scene ${beat.panels[0].number}`} className="space-y-1.5">
          {beat.title && <h3 className="text-sm font-medium text-port-text">{beat.title}</h3>}
          <ol className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2">
            {beat.panels.map(({ node, number, seconds, choices, loopsTo }) => (
              <li key={node.id} className="space-y-1">
                <button type="button" onClick={() => onOpenNode(node.id)} aria-label={`Open scene ${number}: ${node.title || 'Untitled'}`}
                  className="block w-full overflow-hidden rounded-lg border border-port-border bg-port-card text-left hover:border-port-accent/50">
                  <div className={`${aspectClass(aspectRatio)} relative flex w-full items-center justify-center overflow-hidden bg-port-bg`}>
                    {node.image ? (
                      <MediaImage src={thumb(node.image)} alt="" className="h-full w-full object-cover" />
                    ) : node.prose ? (
                      <p className="line-clamp-4 p-2 text-xs text-port-text-muted">{node.prose}</p>
                    ) : (
                      <ImageIcon className="h-6 w-6 text-port-text-muted" aria-hidden="true" />
                    )}
                    {node.isEnding && <span className="port-media-overlay-strong absolute left-1 top-1 rounded px-1 text-[10px]">{node.endingLabel || 'Ending'}</span>}
                  </div>
                  <div className="flex min-w-0 items-center gap-1.5 px-2 py-1 text-[11px] text-port-text-muted">
                    <span className="font-semibold tabular-nums text-port-text">{number}</span>
                    <span className="truncate">{node.title || 'Untitled'}</span>
                    {seconds ? <span className="ml-auto shrink-0 tabular-nums">{seconds}s</span> : null}
                  </div>
                </button>
                {choices.length > 1 && (
                  <ul aria-label={`Choices after scene ${number}`} className="space-y-1">
                    {choices.map((choice) => (
                      <li key={choice.transitionId}>
                        <button type="button" onClick={() => onPick(choice.transitionId)} disabled={choice.picked} aria-pressed={choice.picked}
                          className={`flex min-h-[44px] w-full items-center gap-1.5 rounded border px-1.5 text-left text-[11px] ${choice.picked ? 'border-port-accent/60 text-port-text' : 'border-port-border text-port-text-muted hover:border-port-accent/50'}`}>
                          {choice.picked ? <Check size={12} className="shrink-0 text-port-accent" aria-hidden="true" /> : <GitBranch size={12} className="shrink-0" aria-hidden="true" />}
                          {choice.image && <img src={thumb(choice.image)} alt="" loading="lazy" className="h-6 w-8 shrink-0 rounded object-cover" />}
                          <span className="min-w-0 flex-1 truncate">{choice.intent || choice.title || 'Untitled'}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {loopsTo && (
                  <p className="flex items-center gap-1 text-[11px] text-port-text-muted">
                    <CornerUpLeft size={12} aria-hidden="true" /> Back to {titleOf(loopsTo)}
                  </p>
                )}
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
