/**
 * Mood Boards page — board index (issue #911).
 *
 * Lists every mood board (an inspiration/reference canvas that feeds the Create
 * suite) and lets the user create, open, or delete one. The heavy canvas lives
 * at `/mood-boards/:id`; "New Board" creates a blank board and drops into it.
 * Redesigned as cards with a cover image and smaller thumbnails of items within
 * the board.
 */

import { useEffect, useState, useCallback, useMemo } from 'react';
import { Link, useNavigate } from 'react-router';
import { Plus, Palette, Trash2, ImageIcon, FileText, Film } from 'lucide-react';
import PageSkeleton from '../components/ui/PageSkeleton';
import toast from '../components/ui/Toast';
import InlineConfirmRow from '../components/ui/InlineConfirmRow';
import EmptyState from '../components/EmptyState';
import { timeAgo } from '../utils/formatters';
import { listMoodBoards, createMoodBoard, deleteMoodBoard } from '../services/api';
import { moodBoardItemSrc } from '../lib/moodBoardItemSrc';

const itemCounts = (board) => {
  const items = Array.isArray(board?.items) ? board.items : [];
  let images = 0;
  let videos = 0;
  let texts = 0;
  for (const it of items) {
    if (it?.type === 'image') images += 1;
    else if (it?.type === 'video') videos += 1;
    else if (it?.type === 'text') texts += 1;
  }
  return { images, videos, texts, total: items.length };
};

const MAX_THUMBNAILS = 4;

function MoodBoardCard({ board, onDelete, isConfirming, onConfirmDelete, onCancelDelete }) {
  const { images, videos, texts, total } = useMemo(() => itemCounts(board), [board]);

  // Extract visual items (images or videos with a resolvable thumbnail/poster)
  const visualItems = useMemo(() => {
    const items = Array.isArray(board?.items) ? board.items : [];
    return items
      .map((it) => ({
        id: it.id,
        src: moodBoardItemSrc(it),
        type: it.type,
        caption: it.caption || '',
      }))
      .filter((it) => Boolean(it.src));
  }, [board]);

  const coverItem = visualItems[0] || null;
  const subThumbnails = visualItems.slice(1, 1 + MAX_THUMBNAILS);
  const remainingVisualsCount = visualItems.length - (1 + subThumbnails.length);

  return (
    <li className="bg-port-card border border-port-border rounded-xl overflow-hidden flex flex-col hover:border-port-accent/40 transition-colors">
      {isConfirming ? (
        <InlineConfirmRow
          variant="separator"
          question={`Delete "${board.name}"? This can't be undone.`}
          onConfirm={() => onConfirmDelete(board.id)}
          onCancel={onCancelDelete}
        />
      ) : null}

      {/* Cover and Thumbnail Preview Area */}
      <Link
        to={`/mood-boards/${board.id}`}
        className="block bg-port-bg border-b border-port-border/60 group relative"
      >
        <div className="aspect-[16/10] w-full overflow-hidden relative bg-port-bg flex items-center justify-center">
          {coverItem ? (
            <img
              src={coverItem.src}
              alt={board.name}
              loading="lazy"
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
            />
          ) : (
            <div className="flex flex-col items-center justify-center text-gray-600 gap-1 p-4">
              <Palette className="w-10 h-10 stroke-[1.5]" aria-hidden="true" />
              <span className="text-xs text-gray-500 font-medium">Empty Board</span>
            </div>
          )}
        </div>

        {/* Smaller thumbnails row beneath the main cover */}
        {subThumbnails.length > 0 ? (
          <div className="grid grid-cols-4 sm:grid-cols-4 gap-1 p-1.5 bg-port-card/80 border-t border-port-border/40">
            {subThumbnails.map((thumb, idx) => {
              const isLast = idx === subThumbnails.length - 1;
              const showOverflow = isLast && remainingVisualsCount > 0;
              return (
                <div
                  key={thumb.id}
                  className="relative aspect-square rounded-md overflow-hidden bg-port-bg border border-port-border/50"
                >
                  <img
                    src={thumb.src}
                    alt={thumb.caption || `Item ${idx + 2}`}
                    loading="lazy"
                    className="w-full h-full object-cover"
                  />
                  {showOverflow ? (
                    <div className="absolute inset-0 bg-black/60 flex items-center justify-center text-white text-[11px] font-semibold">
                      +{remainingVisualsCount}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </Link>

      {/* Card Body & Details */}
      <div className="p-3.5 flex-1 flex flex-col justify-between gap-2.5">
        <div>
          <Link
            to={`/mood-boards/${board.id}`}
            className="text-white font-medium text-base hover:text-port-accent line-clamp-1 block transition-colors"
            title={board.name}
          >
            {board.name}
          </Link>
          {board.description ? (
            <p className="text-xs text-gray-400 line-clamp-2 mt-1" title={board.description}>
              {board.description}
            </p>
          ) : null}
        </div>

        <div className="flex items-center justify-between pt-2 border-t border-port-border/40 text-xs text-gray-500">
          <div className="flex items-center gap-2.5">
            {images > 0 ? (
              <span className="flex items-center gap-1" title={`${images} image${images === 1 ? '' : 's'}`}>
                <ImageIcon className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{images}</span>
              </span>
            ) : null}
            {videos > 0 ? (
              <span className="flex items-center gap-1" title={`${videos} video${videos === 1 ? '' : 's'}`}>
                <Film className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{videos}</span>
              </span>
            ) : null}
            {texts > 0 ? (
              <span className="flex items-center gap-1" title={`${texts} note${texts === 1 ? '' : 's'}`}>
                <FileText className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{texts}</span>
              </span>
            ) : null}
            {total === 0 ? (
              <span>0 items</span>
            ) : (
              <span>{total} item{total === 1 ? '' : 's'}</span>
            )}
            <span>· {timeAgo(board.updatedAt)}</span>
          </div>

          <button
            type="button"
            onClick={() => onDelete(board.id)}
            title="Delete board"
            aria-label={`Delete ${board.name}`}
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-500 hover:text-port-error transition-colors rounded"
          >
            <Trash2 className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </li>
  );
}

export default function MoodBoards() {
  const navigate = useNavigate();
  const [boards, setBoards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [confirmingId, setConfirmingId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await listMoodBoards({ silent: true }).catch(() => null);
    if (data) setBoards(Array.isArray(data) ? data : []);
    else toast.error('Failed to load mood boards');
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    // The header button is disabled while a create is in flight, but the empty
    // state's call to action has no disabled state — guard here so a double
    // click can't mint two boards.
    if (creating) return;
    setCreating(true);
    const board = await createMoodBoard({ name: 'Untitled board' }, { silent: true }).catch(() => null);
    setCreating(false);
    if (!board) { toast.error('Failed to create board'); return; }
    navigate(`/mood-boards/${board.id}`);
  };

  const handleDelete = async (id) => {
    setConfirmingId(null);
    const ok = await deleteMoodBoard(id, { silent: true }).then(() => true).catch(() => false);
    if (!ok) { toast.error('Failed to delete board'); return; }
    setBoards((prev) => prev.filter((b) => b.id !== id));
    toast.success('Board deleted');
  };

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Palette className="w-6 h-6 text-port-accent" aria-hidden="true" />
          <h1 className="text-xl font-semibold text-white">Mood Boards</h1>
        </div>
        <button
          type="button"
          onClick={handleCreate}
          disabled={creating}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50 transition-colors"
        >
          <Plus className="w-4 h-4" aria-hidden="true" />
          New Board
        </button>
      </div>

      <p className="text-sm text-gray-400 mb-4">
        Collect visual and textual references for your universes, scenes, and treatments.
      </p>

      {loading ? (
        <PageSkeleton header="none" label="Loading mood boards" cards={4} sidebar={false} />
      ) : boards.length === 0 ? (
        <EmptyState
          icon={Palette}
          title="No mood boards yet"
          message="A board is a canvas of image and text references that feeds the Create suite. Make one to start pinning."
          actionLabel="Create your first board"
          onAction={handleCreate}
        />
      ) : (
        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {boards.map((board) => (
            <MoodBoardCard
              key={board.id}
              board={board}
              onDelete={(id) => setConfirmingId(id)}
              isConfirming={confirmingId === board.id}
              onConfirmDelete={handleDelete}
              onCancelDelete={() => setConfirmingId(null)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
