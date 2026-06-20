/**
 * Mood Boards page — board index (issue #911).
 *
 * Lists every mood board (an inspiration/reference canvas that feeds the Create
 * suite) and lets the user create, open, or delete one. The heavy canvas lives
 * at `/mood-boards/:id`; "New Board" creates a blank board and drops into it.
 * Mirrors the Universes index (list/table → detail editor) but simpler — boards
 * are local-only with no sync/duplicate machinery.
 */

import { useEffect, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Palette, Trash2, ImageIcon, FileText } from 'lucide-react';
import toast from '../components/ui/Toast';
import InlineConfirmRow from '../components/ui/InlineConfirmRow';
import { timeAgo } from '../utils/formatters';
import { listMoodBoards, createMoodBoard, deleteMoodBoard } from '../services/api';

const itemCounts = (board) => {
  const items = Array.isArray(board?.items) ? board.items : [];
  let images = 0;
  let texts = 0;
  for (const it of items) {
    if (it?.type === 'image') images += 1;
    else if (it?.type === 'text') texts += 1;
  }
  return { images, texts, total: items.length };
};

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
    <div className="max-w-5xl mx-auto">
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
        <div className="text-gray-400 text-sm py-8 text-center">Loading…</div>
      ) : boards.length === 0 ? (
        <div className="text-gray-400 text-sm py-12 text-center border border-dashed border-port-border rounded">
          No mood boards yet. Create one to start pinning references.
        </div>
      ) : (
        <ul className="space-y-2">
          {boards.map((board) => {
            const { images, texts, total } = itemCounts(board);
            return (
              <li
                key={board.id}
                className="bg-port-card border border-port-border rounded-md overflow-hidden"
              >
                {confirmingId === board.id ? (
                  <InlineConfirmRow
                    variant="separator"
                    question={`Delete "${board.name}"? This can't be undone.`}
                    onConfirm={() => handleDelete(board.id)}
                    onCancel={() => setConfirmingId(null)}
                  />
                ) : null}
                <div className="flex items-center gap-3 p-3">
                  <Link
                    to={`/mood-boards/${board.id}`}
                    className="flex-1 min-w-0"
                  >
                    <div className="text-white font-medium truncate">{board.name}</div>
                    {board.description ? (
                      <div className="text-xs text-gray-400 truncate">{board.description}</div>
                    ) : null}
                    <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                      <span className="flex items-center gap-1">
                        <ImageIcon className="w-3 h-3" aria-hidden="true" /> {images}
                      </span>
                      <span className="flex items-center gap-1">
                        <FileText className="w-3 h-3" aria-hidden="true" /> {texts}
                      </span>
                      <span>{total} item{total === 1 ? '' : 's'}</span>
                      <span>· {timeAgo(board.updatedAt)}</span>
                    </div>
                  </Link>
                  <button
                    type="button"
                    onClick={() => setConfirmingId(board.id)}
                    title="Delete board"
                    aria-label={`Delete ${board.name}`}
                    className="p-1.5 text-gray-500 hover:text-port-error transition-colors"
                  >
                    <Trash2 className="w-4 h-4" aria-hidden="true" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
