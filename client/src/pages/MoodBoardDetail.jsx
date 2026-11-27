import { useState, useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useParams, useNavigate, useSearchParams, useLocation, Link } from 'react-router';
import { ArrowLeft, Download, ImageIcon, LayoutGrid, Palette, Plus, Save, Sparkles } from 'lucide-react';
import Drawer from '../components/Drawer';
import MediaImage from '../components/MediaImage';
import PageSkeleton from '../components/ui/PageSkeleton';
import LoadFailedState from '../components/ui/LoadFailedState';
import TabPills from '../components/ui/TabPills';
import InlineConfirmRow from '../components/ui/InlineConfirmRow';
import { PromptFromMediaModal } from '../components/media/PromptFromMedia';
import MediaLightbox from '../components/media/MediaLightbox';
import MoodBoardAddPanel from '../components/moodBoard/MoodBoardAddPanel';
import MoodBoardImportPanel from '../components/moodBoard/MoodBoardImportPanel';
import MoodBoardItemCard from '../components/moodBoard/MoodBoardItemCard';
import SavedAnalysisCard from '../components/moodBoard/SavedAnalysisCard';
import MoodBoardGeneratePanel from '../components/moodBoard/MoodBoardGeneratePanel';
import MoodBoardStylePanel from '../components/moodBoard/MoodBoardStylePanel';
import MoodBoardCollagePanel from '../components/moodBoard/MoodBoardCollagePanel';
import VideoFramePicker from '../components/moodBoard/VideoFramePicker';
import useMoodBoardData from '../components/moodBoard/useMoodBoardData';
import usePreviewRoute from '../hooks/usePreviewRoute';
import useContainerWidth from '../hooks/useContainerWidth';
import { safeReadStorage, safeWriteStorage } from '../lib/safeStorage';
import { moodBoardItemSrc, moodBoardItemVideoSrc, moodBoardItemAnalysisSource, moodBoardPosterSrc } from '../lib/moodBoardItemSrc';
import { moodBoardItemPrompt, isMoodBoardItemAnalyzed } from '../lib/moodBoardAnalysis';
import { formatCount } from '../utils/formatters';

const NO_ITEMS = [];
// Board tools share one panel: a side rail on wide boards, a sheet on phones.
// The open tool is `?tool=` so it is linkable; the last one used is remembered.
const BOARD_TOOLS = [
  { id: 'add', label: 'Add', icon: Plus },
  { id: 'import', label: 'Import', icon: Download },
  { id: 'style', label: 'Style', icon: Palette },
  { id: 'generate', label: 'Generate', icon: Sparkles },
  { id: 'collage', label: 'Collage', icon: LayoutGrid },
];
const BOARD_TOOL_IDS = BOARD_TOOLS.map((t) => t.id);
const BOARD_TOOL_STORAGE_KEY = 'portos.moodBoard.tool';
// Matches `@4xl/board` (56rem), where the rail column appears.
const WIDE_BOARD_PX = 896;

export default function MoodBoardDetail() {
  const { id } = useParams();
  // Route changes replace the editor so every draft, modal and pending-action
  // flag belongs to one board, including when the next board fails to load.
  return <MoodBoardEditor key={id} id={id} />;
}


function BoardToolSurface({ wide, sheetOpen, onClose, children }) {
  const railRef = useRef(null);
  const drawerRef = useRef(null);
  // The portal target stays stable so drafts, uploads and generations survive
  // closing the drawer or moving the tools between the drawer and the rail.
  const [host] = useState(() => typeof document === 'undefined' ? null : document.createElement('div'));

  useLayoutEffect(() => {
    const outlet = sheetOpen ? drawerRef.current : railRef.current;
    if (host && outlet) outlet.appendChild(host);
  }, [host, sheetOpen]);

  return (
    <>
      <aside
        aria-label="Board tools"
        hidden={!wide}
        className="min-w-0 sticky top-0 max-h-[calc(100dvh-2rem)] overflow-y-auto"
      >
        <div ref={railRef}>{host ? null : children}</div>
      </aside>
      <Drawer open={sheetOpen} onClose={onClose} title="Board tools" closeLabel="Close board tools" placement="bottom">
        <div ref={drawerRef} />
      </Drawer>
      {host ? createPortal(children, host) : null}
    </>
  );
}

function MoodBoardEditor({ id }) {
  const navigate = useNavigate();
  const {
    board, setBoard, loading, loadError, load,
    name, setName, description, setDescription, nameDirty, descriptionDirty, metaDirty, savingMeta,
    extractingItemId, renderingItemId,
    handleSaveMeta, handleUpdateItemText, persistAnalysis, handleClearAnalysis,
    handleExtractFrames, handleAddPickedFrames, handleRenderItem, handleRemoveItem,
  } = useMoodBoardData(id);

  const [replacePrompt, setReplacePrompt] = useState(false);
  const [confirmingItemId, setConfirmingItemId] = useState(null);
  const removeItemTriggerRef = useRef(null);
  const cancelItemRemoval = () => {
    setConfirmingItemId(null);
    removeItemTriggerRef.current?.focus();
  };

  const [playingItemId, setPlayingItemId] = useState(null);

  // Per-item prompt-from-media analysis (#4188 Phase 3). Track the item by id
  // (not a snapshot) so the modal's stored-analysis view stays fresh after the
  // persist PATCH updates the board state.
  const [analyzeItemId, setAnalyzeItemId] = useState(null);

  // The frame picker's video is in the URL (?frames=<itemId>), so it is reload-safe and linkable.
  const [searchParams, setSearchParams] = useSearchParams();
  const pickingFramesItemId = searchParams.get('frames');
  const setPickingFramesItemId = useCallback((itemId) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    if (itemId) next.set('frames', itemId); else next.delete('frames');
    return next;
  }, { replace: !itemId }), [setSearchParams]);

  // Before the first measurement, guess from the viewport so a phone never
  // flashes the rail.
  const [rootRef, rootWidth] = useContainerWidth();
  const wide = rootWidth ? rootWidth >= WIDE_BOARD_PX : (typeof window === 'undefined' || window.innerWidth >= 1024);
  const toolParam = searchParams.get('tool');
  const urlTool = BOARD_TOOL_IDS.includes(toolParam) ? toolParam : null;
  const [lastTool, setLastTool] = useState(() => {
    const saved = safeReadStorage(BOARD_TOOL_STORAGE_KEY);
    return BOARD_TOOL_IDS.includes(saved) ? saved : 'add';
  });
  const activeTool = urlTool || lastTool;
  // The sheet is open only on the history entry the phone tool row pushed, so
  // a `?tool=` written by the desktop rail (or a shared link) never pops it
  // open, and closing it is always one step back.
  const location = useLocation();
  const sheetEntry = Boolean(location.state?.boardToolSheet);
  const sheetOpen = !wide && Boolean(urlTool) && sheetEntry;
  const selectTool = useCallback((tool) => {
    setLastTool(tool);
    safeWriteStorage(BOARD_TOOL_STORAGE_KEY, tool);
    const opening = !wide && !sheetOpen;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tool', tool);
      return next;
    }, opening
      ? { state: { boardToolSheet: true } }
      : { replace: true, state: sheetOpen ? { boardToolSheet: true } : undefined });
  }, [setSearchParams, wide, sheetOpen]);
  const closeSheet = useCallback(() => navigate(-1), [navigate]);

  const items = Array.isArray(board?.items) ? board.items : NO_ITEMS;

  // The item under analysis (#4188 Phase 3), re-derived from board state so the
  // modal's stored-analysis view stays fresh after the persist PATCH. The
  // source is memoized on the item's identity: PromptFromMedia resets its panel
  // when its `initialSource` identity changes, so a fresh object every render
  // would wipe an in-flight run on unrelated re-renders. (Lives above the
  // loading/not-found early returns — hooks must run unconditionally.)
  const pickingFramesItem = pickingFramesItemId
    ? items.find((it) => it.id === pickingFramesItemId && moodBoardItemVideoSrc(it)) || null
    : null;
  const analyzeItem = analyzeItemId
    ? items.find((it) => it.id === analyzeItemId) || null
    : null;
  const analyzeSource = useMemo(() => moodBoardItemAnalysisSource(analyzeItem), [analyzeItem]);

  // Still images only (videos play inline); prev/next walks this subset.
  // Lives above early returns so hooks run unconditionally.
  const previewables = useMemo(() => {
    return items
      .filter((it) => it.type === 'image' && moodBoardItemSrc(it))
      .map((it) => {
        const url = moodBoardItemSrc(it);
        return {
          kind: 'image',
          key: `moodboard:${it.id}`,
          id: it.id,
          filename: decodeURIComponent(url.split(/[?#]/)[0].split('/').pop() || ''),
          previewUrl: url,
          downloadUrl: url,
          prompt: moodBoardItemPrompt(it) || it.caption || '',
        };
      });
  }, [items]);
  const resolvePreview = useCallback(async () => null, []);
  const [preview, setPreview] = usePreviewRoute(previewables, { resolveItem: resolvePreview });
  const previewIndex = preview ? previewables.findIndex((it) => it.id === preview.id || it.key === preview.key || it.filename === preview.filename) : -1;


  const openPreview = (itemId) => {
    const target = previewables.find((item) => item.id === itemId);
    if (target) setPreview(target);
  };
  const requestRemoveItem = (itemId, trigger) => {
    removeItemTriggerRef.current = trigger;
    setConfirmingItemId(itemId);
  };
  const removeItem = (itemId) => {
    setConfirmingItemId(null);
    return handleRemoveItem(itemId);
  };
  const addItem = (item) => {
    setBoard((prev) => prev ? {
      ...prev,
      items: [...(prev.items || []).filter((existing) => existing.id !== item.id), item],
    } : prev);
  };

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto">
        <PageSkeleton
          label="Loading mood board"
          titleWidthClass="w-56"
          layout="grid"
          cards={8}
          gridColsClass="grid-cols-2 md:grid-cols-3 lg:grid-cols-4"
        />
      </div>
    );
  }
  if (!board && loadError) {
    return (
      <div className="max-w-4xl mx-auto">
        <LoadFailedState title="Couldn’t load this mood board" hint={loadError.message} onRetry={load} />
        <div className="text-center">
          <Link to="/mood-boards" className="text-port-accent hover:underline">Back to boards</Link>
        </div>
      </div>
    );
  }
  if (!board) {
    return (
      <div className="max-w-4xl mx-auto text-center py-12">
        <p className="text-gray-400 mb-4">This mood board doesn’t exist.</p>
        <Link to="/mood-boards" className="text-port-accent hover:underline">Back to boards</Link>
      </div>
    );
  }

  const analyzedCount = items.filter(isMoodBoardItemAnalyzed).length;
  const posterSrc = moodBoardPosterSrc(board);

  const toolPanels = {
    add: <MoodBoardAddPanel id={id} onItemAdded={addItem} />,
    import: <MoodBoardImportPanel board={board} onBoardChange={setBoard} />,
    style: <MoodBoardStylePanel board={board} onBoardChange={setBoard} />,
    generate: <MoodBoardGeneratePanel key={id} board={board} disabled={Boolean(metaDirty || savingMeta)} embedded />,
    collage: <MoodBoardCollagePanel board={board} onBoardChange={setBoard} />,
  };

  return (
    <div ref={rootRef} className="@container/board min-w-0 max-w-7xl mx-auto space-y-4">
      {/* One compact header: the pins start right below it. */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button
          type="button"
          onClick={() => navigate('/mood-boards')}
          aria-label="Back to boards"
          className="min-h-[44px] min-w-[44px] -ml-2 flex items-center justify-center rounded text-gray-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="w-5 h-5" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => selectTool('style')}
          aria-label="Board style and poster"
          className="w-11 h-11 shrink-0 rounded overflow-hidden border border-port-border bg-port-bg flex items-center justify-center text-gray-600"
        >
          {posterSrc
            ? <MediaImage thumbnail src={posterSrc} alt="" className="w-full h-full object-cover" />
            : <ImageIcon className="w-5 h-5" aria-hidden="true" />}
        </button>
        <div className="min-w-0 flex-[1_1_14rem]">
          <label htmlFor="board-name" className="sr-only">Name</label>
          <input
            id="board-name"
            type="text"
            value={name}
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
            className="block w-full bg-transparent border border-transparent hover:border-port-border focus:border-port-accent rounded px-1.5 py-0.5 -ml-1.5 text-lg font-semibold text-white outline-none"
          />
          <p className="text-xs text-gray-400">
            {formatCount(items.length)} item{items.length === 1 ? '' : 's'} · {formatCount(analyzedCount)} analyzed
          </p>
        </div>
        {nameDirty || (savingMeta && !descriptionDirty) ? (
          <button
            type="button"
            onClick={handleSaveMeta}
            disabled={savingMeta}
            className="min-h-[40px] flex items-center justify-center gap-1.5 px-3 py-1.5 text-sm rounded bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50 transition-colors"
          >
            <Save className="w-4 h-4" aria-hidden="true" /> Save
          </button>
        ) : null}
      </header>

      {!wide ? (
        // Phones reach every tool from one row that stays put while pins scroll.
        <nav aria-label="Board tools" className="sticky top-0 z-20 -mx-1 flex bg-port-bg/95 border-b border-port-border">
          {BOARD_TOOLS.map(({ id: toolId, label, icon: Icon }) => (
            <button
              key={toolId}
              type="button"
              onClick={() => selectTool(toolId)}
              className="flex-1 min-h-[52px] flex flex-col items-center justify-center gap-0.5 text-[11px] text-gray-400 hover:text-white"
            >
              <Icon className="w-5 h-5" aria-hidden="true" />
              {label}
            </button>
          ))}
        </nav>
      ) : null}

      <div className="grid grid-cols-1 @4xl/board:grid-cols-[minmax(0,1fr)_24rem] gap-6 items-start">
        <section aria-label="Mood board items" className="min-w-0 space-y-3">
          {items.length === 0 ? (
            <div className="text-gray-400 text-sm py-12 text-center border border-dashed border-port-border rounded">
              No items yet. Pin an image or note to get started.
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:gap-3 sm:grid-cols-[repeat(auto-fill,minmax(min(100%,11rem),1fr))]">
              {items.map((item, index) => (
                <MoodBoardItemCard
                  key={item.id}
                  item={item}
                  position={index + 1}
                  playing={playingItemId === item.id}
                  confirmingRemoval={confirmingItemId === item.id}
                  extracting={extractingItemId === item.id}
                  rendering={renderingItemId === item.id}
                  onPlay={setPlayingItemId}
                  onPreview={openPreview}
                  onUpdateText={handleUpdateItemText}
                  onRequestRemove={requestRemoveItem}
                  onRemove={removeItem}
                  onCancelRemove={cancelItemRemoval}
                  onExtractFrames={handleExtractFrames}
                  onPickFrames={setPickingFramesItemId}
                  onRender={handleRenderItem}
                  onAnalyze={setAnalyzeItemId}
                />
              ))}
            </div>
          )}
        </section>

        <BoardToolSurface wide={wide} sheetOpen={sheetOpen} onClose={closeSheet}>
          <div className="space-y-3">
            {/* The board-wide prompt is long prose, so it gets a real multi-line
                field beside the tools rather than a line in the header. */}
            <details className="bg-port-card border border-port-border rounded-md p-3 space-y-2">
              <summary className="cursor-pointer rounded border border-port-border px-3 py-2 text-sm text-gray-300 hover:bg-port-bg focus-visible:outline focus-visible:outline-port-accent">Board prompt</summary>
              <label htmlFor="board-description" className="block text-xs text-gray-400">Board prompt</label>
              <textarea
                id="board-description"
                value={description}
                maxLength={5000}
                rows={5}
                placeholder="Describe the board’s story, mood and look…"
                onChange={(e) => setDescription(e.target.value)}
                className="block w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white focus:border-port-accent outline-none resize-y"
              />
              <p className="text-xs text-gray-400">Your creative direction. Composing a style updates the separate Style prompt.</p>
              {board.style?.prompt && board.style.prompt !== description ? (
                replacePrompt ? (
                  <InlineConfirmRow
                    question="Replace your current Board prompt with the composed style?"
                    confirmText="Replace prompt"
                    onConfirm={() => { setDescription(board.style.prompt); setReplacePrompt(false); }}
                    onCancel={() => setReplacePrompt(false)}
                  />
                ) : (
                  <button
                    type="button"
                    disabled={board.style.prompt.length > 5000}
                    onClick={() => description.trim() ? setReplacePrompt(true) : setDescription(board.style.prompt)}
                    className="min-h-[40px] px-3 py-1.5 text-xs rounded border border-port-border text-port-accent hover:bg-port-bg disabled:opacity-50"
                  >Use style as Board prompt</button>
                )
              ) : null}
              {board.style?.prompt?.length > 5000 ? (
                <p className="text-xs text-gray-400">Shorten the Style prompt to 5,000 characters or fewer before using it as the Board prompt.</p>
              ) : null}
              {descriptionDirty || (savingMeta && !nameDirty) ? (
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={handleSaveMeta}
                    disabled={savingMeta}
                    className="min-h-[40px] flex items-center justify-center gap-1.5 px-3 py-1.5 text-sm rounded bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50 transition-colors"
                  >
                    <Save className="w-4 h-4" aria-hidden="true" /> Save prompt
                  </button>
                </div>
              ) : null}
            </details>
            <TabPills
              variant="pills"
              size="xs"
              stretch
              mobileCompact
              tabs={BOARD_TOOLS}
              activeTab={activeTool}
              onChange={selectTool}
              ariaLabel="Board tool"
              controlsIdPrefix="board-tool"
            />
            {BOARD_TOOLS.map(({ id: toolId }) => (
              <div key={toolId} id={`board-tool-${toolId}`} role="tabpanel" aria-labelledby={`tab-${toolId}`} hidden={activeTool !== toolId}>
                {toolPanels[toolId]}
              </div>
            ))}
          </div>
        </BoardToolSurface>
      </div>

      {previewIndex >= 0 ? (
        <MediaLightbox
          item={previewables[previewIndex]}
          onClose={() => setPreview(null)}
          hasPrevious={previewIndex > 0}
          hasNext={previewIndex < previewables.length - 1}
          onPrevious={() => setPreview(previewables[previewIndex - 1])}
          onNext={() => setPreview(previewables[previewIndex + 1])}
        />
      ) : null}

      {/* Per-item prompt-from-media analysis (#4188 Phase 3). A successful run
          auto-persists onto the item; the stored analysis renders above the
          analyzer with copy/remove. */}
      {analyzeItem ? (
        <PromptFromMediaModal
          item={analyzeSource}
          open
          onClose={() => setAnalyzeItemId(null)}
          kindDefault={analyzeItem.type === 'video' ? 'video' : 'image'}
          onResult={(result) => persistAnalysis(analyzeItem, result)}
        >
          {analyzeItem.analysis ? (
            <SavedAnalysisCard
              key={analyzeItem.id}
              analysis={analyzeItem.analysis}
              onClear={() => handleClearAnalysis(analyzeItem.id)}
            />
          ) : null}
        </PromptFromMediaModal>
      ) : null}
      {pickingFramesItem ? (
        <VideoFramePicker
          src={moodBoardItemVideoSrc(pickingFramesItem)}
          poster={moodBoardItemSrc(pickingFramesItem)}
          busy={extractingItemId === pickingFramesItem.id}
          onAdd={async (times) => {
            if (await handleAddPickedFrames(pickingFramesItem.id, times)) setPickingFramesItemId(null);
          }}
          onClose={() => setPickingFramesItemId(null)}
        />
      ) : null}
    </div>
  );
}
