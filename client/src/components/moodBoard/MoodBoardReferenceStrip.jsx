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
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { LayoutGrid, ChevronDown, ChevronRight, ExternalLink, ImageIcon } from 'lucide-react';
import { listMoodBoards, getMoodBoard } from '../../services/api';
import { moodBoardItemSrc } from '../../lib/moodBoardItemSrc';
import { safeReadStorage, safeWriteStorage } from '../../lib/safeStorage';

const MAX_THUMBS = 12;

export default function MoodBoardReferenceStrip({ storageKey = 'create', className = '' }) {
  const lsKey = `portos.moodBoardRef.${storageKey}`;
  const [expanded, setExpanded] = useState(false);
  const [boards, setBoards] = useState(null); // null = not loaded, [] = loaded-empty
  const [selectedId, setSelectedId] = useState(() => safeReadStorage(lsKey) || '');
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

  // The board actually shown: the user's pick when it's still in the list, else
  // the first board. Derived (not state) so display drives off it immediately —
  // no render tick where the <select> value matches no option (which would log
  // a controlled-select warning and flash the empty state before an effect
  // catches up). The remembered id is persisted only on an explicit pick.
  const effectiveId = (Array.isArray(boards) && boards.length > 0)
    ? ((selectedId && boards.some((b) => b.id === selectedId)) ? selectedId : boards[0].id)
    : '';

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
    setSelectedId(id);
    if (id) safeWriteStorage(lsKey, id);
  }, [lsKey]);

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
            <p className="text-[11px] text-gray-500">
              No mood boards yet.{' '}
              <a href="/mood-boards" target="_blank" rel="noopener noreferrer" className="text-port-accent hover:underline">
                Create one
              </a>{' '}
              to collect reference images.
            </p>
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
                  {boards.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
                {effectiveId && (
                  <a
                    href={`/mood-boards/${encodeURIComponent(effectiveId)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Open board in new tab"
                    className="shrink-0 p-1 text-gray-400 hover:text-port-accent"
                  >
                    <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                  </a>
                )}
              </div>

              {thumbs.length === 0 ? (
                <div className="flex items-center gap-1.5 text-[11px] text-gray-500 py-2">
                  <ImageIcon className="w-3.5 h-3.5" aria-hidden="true" />
                  {loadingDetail ? 'Loading reference images…' : 'No reference images pinned on this board yet.'}
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
