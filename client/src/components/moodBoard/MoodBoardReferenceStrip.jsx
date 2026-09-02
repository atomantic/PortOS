/**
 * Mood Board reference strip (issue #1455, follow-up to #911 part 2).
 *
 * A compact, collapsible reference-image strip for creation flows (New Series,
 * New Universe, scene/treatment entry). It lets the user pick one of their mood
 * boards and see its pinned reference images inline, so collected inspiration is
 * visible at the moment they're describing a new thing — per the original #911
 * spec ("surface relevant board reference images in those entry flows").
 *
 * Read-only on purpose: this is a glance-at-your-inspiration affordance, not a
 * second editor. Clicking a thumbnail opens the full board in a new tab. The
 * pinning direction (media → board) lives in PinToMoodBoardMenu.
 *
 * Self-contained: loads the board list lazily on first expand, remembers the
 * last-picked board per `storageKey` in localStorage so it persists across
 * creation sessions. Renders nothing heavy until expanded.
 *
 * Controlled mode (#4188): pass `value` (a board id, or '' for none) +
 * `onChange` and the selection is owned by the caller instead of localStorage —
 * the Universe Builder persists the pick on the universe record (`moodBoardId`)
 * so it survives reload, is per-universe, and syncs to peers. Controlled mode
 * never falls back to the first board (an unset link stays visibly unset) and
 * offers a "New board" button when `newBoardName` is provided, creating a board
 * named for the caller's record and selecting it in one step.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { LayoutGrid, ChevronDown, ChevronRight, ExternalLink, ImageIcon, Plus, Loader2 } from 'lucide-react';
import toast from '../ui/Toast';
import { listMoodBoards, getMoodBoard, createMoodBoard } from '../../services/api';
import { moodBoardItemSrc } from '../../lib/moodBoardItemSrc';
import { safeReadStorage, safeWriteStorage } from '../../lib/safeStorage';

const MAX_THUMBS = 12;

export default function MoodBoardReferenceStrip({
  storageKey = 'create',
  className = '',
  value = undefined,
  onChange = null,
  newBoardName = '',
}) {
  const controlled = value !== undefined;
  const lsKey = `portos.moodBoardRef.${storageKey}`;
  const [expanded, setExpanded] = useState(false);
  const [boards, setBoards] = useState(null); // null = not loaded, [] = loaded-empty
  const [localId, setLocalId] = useState(() => (controlled ? '' : safeReadStorage(lsKey) || ''));
  const selectedId = controlled ? (value || '') : localId;
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState(null); // full board (with items) for selectedId
  const [loadingDetail, setLoadingDetail] = useState(false);

  // Load the board list lazily the first time the strip is expanded.
  useEffect(() => {
    if (!expanded || boards !== null) return undefined;
    let cancelled = false;
    listMoodBoards({ silent: true }).then(
      (data) => { if (!cancelled) setBoards(Array.isArray(data) ? data : []); },
      () => { if (!cancelled) setBoards([]); },
    );
    return () => { cancelled = true; };
  }, [expanded, boards]);

  // The board actually shown. Uncontrolled: the user's pick when it's still in
  // the list, else the first board. Derived (not state) so display drives off
  // it immediately — no render tick where the <select> value matches no option
  // (which would log a controlled-select warning and flash the empty state
  // before an effect catches up). The remembered id is persisted only on an
  // explicit pick. Controlled: the caller's value is the truth — a missing or
  // deleted board shows as unset rather than silently falling back to another
  // board (the persisted link must never drift from what's displayed).
  const inList = (id) => Array.isArray(boards) && boards.some((b) => b.id === id);
  const effectiveId = controlled
    ? ((selectedId && inList(selectedId)) ? selectedId : '')
    : ((Array.isArray(boards) && boards.length > 0)
      ? (inList(selectedId) ? selectedId : boards[0].id)
      : '');

  // Fetch the shown board's full record (the list payload already carries
  // items, but getMoodBoard guarantees the freshest items).
  useEffect(() => {
    if (!expanded || !effectiveId) { setDetail(null); return undefined; }
    // Fast path: the list entry already has items — show it immediately.
    const fromList = Array.isArray(boards) ? boards.find((b) => b.id === effectiveId) : null;
    if (fromList && Array.isArray(fromList.items)) setDetail(fromList);
    let cancelled = false;
    setLoadingDetail(true);
    getMoodBoard(effectiveId, { silent: true }).then(
      (data) => { if (!cancelled && data) setDetail(data); },
      () => { /* keep the list fallback */ },
    ).finally(() => { if (!cancelled) setLoadingDetail(false); });
    return () => { cancelled = true; };
  }, [expanded, effectiveId, boards]);

  const handleSelect = useCallback((id) => {
    if (controlled) {
      onChange?.(id);
      return;
    }
    setLocalId(id);
    if (id) safeWriteStorage(lsKey, id);
  }, [controlled, onChange, lsKey]);

  // Create-and-link (controlled mode with a suggested name): one click makes a
  // board named for the caller's record and selects it.
  const handleCreate = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    try {
      const created = await createMoodBoard({ name: newBoardName || 'Untitled board' }, { silent: true });
      if (created?.id) {
        setBoards((prev) => (Array.isArray(prev) ? [created, ...prev] : [created]));
        onChange?.(created.id);
      }
    } catch {
      toast.error('Could not create mood board');
    } finally {
      setCreating(false);
    }
  }, [creating, newBoardName, onChange]);

  const thumbs = useMemo(() => {
    const items = Array.isArray(detail?.items) ? detail.items : [];
    return items
      .map((it) => ({ id: it.id, src: moodBoardItemSrc(it), caption: it.caption || '' }))
      .filter((t) => t.src)
      .slice(0, MAX_THUMBS);
  }, [detail]);

  return (
    <div className={`bg-port-bg border border-port-border rounded ${className}`}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-2.5 py-2 text-xs text-gray-300 hover:text-white"
        aria-expanded={expanded}
      >
        {expanded
          ? <ChevronDown className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          : <ChevronRight className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
        <LayoutGrid className="w-3.5 h-3.5 text-port-accent shrink-0" aria-hidden="true" />
        <span>Mood board reference</span>
      </button>

      {expanded && (
        <div className="px-2.5 pb-2.5 space-y-2">
          {boards === null ? (
            <p className="text-[11px] text-gray-500">Loading boards…</p>
          ) : boards.length === 0 ? (
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-[11px] text-gray-500">
                No mood boards yet.{' '}
                <a href="/mood-boards" target="_blank" rel="noopener noreferrer" className="text-port-accent hover:underline">
                  Create one
                </a>{' '}
                to collect reference images.
              </p>
              {controlled && newBoardName && (
                <button
                  type="button"
                  onClick={handleCreate}
                  disabled={creating}
                  className="flex items-center gap-1 px-2 py-1 text-[11px] text-port-accent border border-port-accent/40 rounded hover:bg-port-accent/15 disabled:opacity-50"
                >
                  {creating ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : <Plus className="w-3 h-3" aria-hidden="true" />}
                  New board “{newBoardName}”
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <label htmlFor={`mb-ref-${storageKey}`} className="text-[11px] text-gray-500 shrink-0">Board</label>
                <select
                  id={`mb-ref-${storageKey}`}
                  value={effectiveId}
                  onChange={(e) => handleSelect(e.target.value)}
                  className="flex-1 min-w-0 bg-port-card border border-port-border rounded px-2 py-1 text-[12px] text-white focus:outline-none focus:border-port-accent"
                >
                  {controlled && <option value="">— no board linked —</option>}
                  {boards.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
                {controlled && newBoardName && (
                  <button
                    type="button"
                    onClick={handleCreate}
                    disabled={creating}
                    title={`Create a board named “${newBoardName}” and link it`}
                    className="shrink-0 flex items-center gap-1 px-2 py-1 text-[11px] text-port-accent border border-port-accent/40 rounded hover:bg-port-accent/15 disabled:opacity-50"
                  >
                    {creating ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : <Plus className="w-3 h-3" aria-hidden="true" />}
                    New
                  </button>
                )}
                {effectiveId && (
                  <a
                    href={`/mood-boards/${encodeURIComponent(effectiveId)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Open board in new tab"
                    aria-label="Open board in new tab"
                    className="shrink-0 p-1 text-gray-400 hover:text-port-accent"
                  >
                    <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                  </a>
                )}
              </div>

              {thumbs.length === 0 ? (
                <div className="flex items-center gap-1.5 text-[11px] text-gray-500 py-2">
                  <ImageIcon className="w-3.5 h-3.5" aria-hidden="true" />
                  {!effectiveId
                    ? 'No board linked — pick one above to surface its references here.'
                    : loadingDetail ? 'Loading reference images…' : 'No reference images pinned on this board yet.'}
                </div>
              ) : (
                <div className="grid grid-cols-4 sm:grid-cols-6 gap-1.5">
                  {thumbs.map((t) => (
                    <a
                      key={t.id}
                      href={`/mood-boards/${encodeURIComponent(effectiveId)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={t.caption || 'Open board'}
                      className="block aspect-square rounded overflow-hidden bg-port-card border border-port-border hover:border-port-accent"
                    >
                      <img src={t.src} alt={t.caption} loading="lazy" className="w-full h-full object-cover" />
                    </a>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
