/**
 * Storyboards index — Create › Storyboards.
 *
 * A storyboard plans a production as beats of panels before (or without) a
 * song or an edit; Music Video, Video, FableLoom and Series Pipeline link one
 * rather than keeping a private plan. "New" creates a blank board and opens it.
 */

import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { LayoutPanelLeft, Plus, Trash2 } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import PageSkeleton from '../components/ui/PageSkeleton';
import EmptyState from '../components/EmptyState';
import InlineConfirmRow from '../components/ui/InlineConfirmRow';
import CollapsibleListItem from '../components/ui/CollapsibleListItem';
import ListLoadError from '../components/ui/ListLoadError';
import toast from '../components/ui/Toast';
import useListResource from '../hooks/useListResource';
import { createStoryboard, deleteStoryboard, listStoryboards } from '../services/api';
import { formatCount, formatTimecode, timeAgo } from '../utils/formatters';
import { aspectClass, takeSrc } from '../components/storyboards/storyboardArt';

const fetchStoryboards = () => listStoryboards({ silent: true });

function StoryboardCard({ board, mountNonce, confirming, onAskDelete, onCancelDelete, onDelete }) {
  const cover = takeSrc(board.cover, mountNonce);
  return (
    <div className="h-full bg-port-card border border-port-border rounded-xl overflow-hidden flex flex-col hover:border-port-accent/40 transition-colors">
      {confirming ? (
        <InlineConfirmRow
          variant="separator"
          question={`Delete "${board.name}"?`}
          onConfirm={() => onDelete(board.id)}
          onCancel={onCancelDelete}
          autoFocus
        />
      ) : null}
      <Link to={`/storyboards/${board.id}`} className={`block ${aspectClass(board.aspectRatio)} max-h-56 w-full bg-port-bg overflow-hidden`}>
        {cover ? (
          <img src={cover} alt="" loading="lazy" className="w-full h-full object-cover" />
        ) : (
          <span className="w-full h-full flex items-center justify-center">
            <LayoutPanelLeft className="w-10 h-10 text-gray-600 stroke-[1.5]" aria-hidden="true" />
          </span>
        )}
      </Link>
      <div className="p-3 flex-1 flex flex-col gap-1.5">
        <Link to={`/storyboards/${board.id}`} className="text-white font-medium hover:text-port-accent line-clamp-1">{board.name}</Link>
        {board.logline ? <p className="text-xs text-gray-400 line-clamp-2">{board.logline}</p> : null}
        <div className="mt-auto flex items-center gap-2 pt-1 text-xs text-gray-500">
          <span className="tabular-nums">{formatCount(board.beatCount, { fallback: '0' })} beats · {formatCount(board.panelCount, { fallback: '0' })} panels · {formatTimecode(board.runtimeSec)}</span>
          <span className="truncate">· {timeAgo(board.updatedAt)}</span>
          <button type="button" onClick={() => onAskDelete(board.id)} aria-label={`Delete ${board.name}`}
            className="ml-auto min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded text-gray-500 hover:text-port-error">
            <Trash2 className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Storyboards() {
  const navigate = useNavigate();
  const { items: boards, state, error, retry, setItems: setBoards } = useListResource(fetchStoryboards);
  const [creating, setCreating] = useState(false);
  const [confirmingId, setConfirmingId] = useState(null);
  const [removingIds, setRemovingIds] = useState(() => new Set());
  const mountNonceRef = useRef(Date.now());

  const handleCreate = async () => {
    if (creating) return;
    setCreating(true);
    const board = await createStoryboard({}, { silent: true }).catch(() => null);
    setCreating(false);
    if (!board) { toast.error('Failed to create storyboard'); return; }
    navigate(`/storyboards/${board.id}`);
  };

  const handleDelete = async (id) => {
    setConfirmingId(null);
    const ok = await deleteStoryboard(id, { silent: true }).then(() => true).catch(() => false);
    if (!ok) { toast.error('Failed to delete storyboard'); return; }
    setRemovingIds((prev) => new Set(prev).add(id));
  };

  const newButton = (
    <button type="button" onClick={handleCreate} disabled={creating}
      className="min-h-[44px] flex items-center gap-1.5 px-3 text-sm rounded bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50">
      <Plus className="w-4 h-4" aria-hidden="true" /> New
    </button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader icon={LayoutPanelLeft} title="Storyboards" subtitle="Plan story beats and panels before the song or the edit." actions={newButton} />
      <div className="flex-1 min-h-0 overflow-auto p-3 sm:p-4">
        {state === 'error' ? (
          <ListLoadError what="storyboards" error={error} onRetry={retry} />
        ) : state === 'loading' ? (
          <PageSkeleton header="none" label="Loading storyboards" cards={4} sidebar={false} />
        ) : boards.length === 0 ? (
          <EmptyState
            icon={LayoutPanelLeft}
            title="No storyboards yet"
            message="Lay out the beats of a story as panels, then link the board to a music video or video."
            actionLabel="New storyboard"
            onAction={handleCreate}
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4">
            {boards.map((board) => (
              <CollapsibleListItem
                key={board.id}
                removing={removingIds.has(board.id)}
                spacing="1rem"
                onExited={() => setBoards((prev) => prev.filter((b) => b.id !== board.id))}
              >
                <StoryboardCard
                  board={board}
                  mountNonce={mountNonceRef.current}
                  confirming={confirmingId === board.id}
                  onAskDelete={setConfirmingId}
                  onCancelDelete={() => setConfirmingId(null)}
                  onDelete={handleDelete}
                />
              </CollapsibleListItem>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
