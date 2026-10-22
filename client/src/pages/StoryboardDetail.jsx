/**
 * Storyboard editor — `/storyboards/:id`, with the open panel deep-linked at
 * `/storyboards/:id/panel/:panelId` and the view in `?view=board|play`.
 *
 * Beats view: one row per beat (title, musical role, estimated length) with a
 * strip of panels. Board view: every panel as one sheet, the classic
 * storyboard page. Play view: the animatic, with the temp track under it. Each write returns the whole board, and the page keeps the
 * newest one it has seen (`updatedAt`), so two quick edits can't land out of
 * order.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ArrowLeft, LayoutGrid, LayoutPanelLeft, ListMusic, Loader2, Play, Plus, Rows3, ScrollText } from 'lucide-react';
import TabPills from '../components/ui/TabPills';
import toast from '../components/ui/Toast';
import socket from '../services/socket';
import {
  addStoryboardBeat, addStoryboardPanel, addStoryboardPanelTake, createBlankSketch, deleteStoryboardBeat,
  deleteStoryboardPanel, getStoryboard, listMoodBoardNames, moveStoryboardBeat, moveStoryboardPanel,
  removeStoryboardPanelTake, runStoryboardPanelNode, selectStoryboardPanelTake, updateStoryboard, updateStoryboardBeat,
  updateStoryboardPanel, updateStoryboardPanelNode, updateStoryboardRecipe,
} from '../services/api';
import { formatTimecode } from '../utils/formatters';
import { STORYBOARD_ASPECT_RATIOS, STORYBOARD_LIMITS } from '../../../server/lib/storyboardVocabulary.js';
import BeatSection from '../components/storyboards/BeatSection';
import CommitField from '../components/storyboards/CommitField';
import MakeEmptyPanels from '../components/storyboards/MakeEmptyPanels';
import PlotBeatsDrawer from '../components/storyboards/PlotBeatsDrawer';
import SongBriefDrawer from '../components/storyboards/SongBriefDrawer';
import StoryboardPlayer from '../components/storyboards/StoryboardPlayer';
import PanelCard from '../components/storyboards/PanelCard';
import PanelDrawer from '../components/storyboards/PanelDrawer';
import { beatSeconds, findPanel } from '../components/storyboards/storyboardArt';

const VIEW_TABS = [
  { id: 'beats', label: 'Beats', icon: Rows3 },
  { id: 'board', label: 'Board', icon: LayoutGrid },
  { id: 'play', label: 'Play', icon: Play },
];
const VIEW_IDS = new Set(VIEW_TABS.map((tab) => tab.id));

const selectClass = 'min-h-[44px] bg-port-bg border border-port-border rounded px-2 text-sm text-white';
const headerButton = 'min-h-[44px] inline-flex items-center gap-1.5 rounded border border-port-border px-3 text-sm text-gray-200 hover:border-port-accent/60 hover:text-white';

export default function StoryboardDetail() {
  const { id, panelId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = VIEW_IDS.has(searchParams.get('view')) ? searchParams.get('view') : 'beats';
  // Drawers over the board (`?plot=open`, `?brief=open`), deep-linkable.
  const setDrawerParam = (key, on) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    if (on) next.set(key, 'open');
    else next.delete(key);
    return next;
  }, { replace: !on });
  const plotOpen = searchParams.get('plot') === 'open';
  const setPlotOpen = (on) => setDrawerParam('plot', on);
  const briefOpen = searchParams.get('brief') === 'open';
  const viewQuery = (next) => (next === 'beats' ? '' : `?view=${next}`);
  const viewSuffix = viewQuery(view);
  // undefined = loading, null = missing.
  const [board, setBoard] = useState(undefined);
  const [pending, setPending] = useState(null);
  const [moodBoards, setMoodBoards] = useState([]);
  const [sketchNonces, setSketchNonces] = useState({});
  const mountNonceRef = useRef(Date.now());

  useEffect(() => {
    let active = true;
    setBoard(undefined);
    getStoryboard(id, { silent: true })
      .then((next) => { if (active) setBoard(next); })
      .catch(() => { if (active) setBoard(null); });
    return () => { active = false; };
  }, [id]);

  useEffect(() => {
    let active = true;
    listMoodBoardNames({ silent: true })
      .then((rows) => { if (active) setMoodBoards(Array.isArray(rows) ? rows : []); })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const onSketchUpdated = ({ key } = {}) => {
      if (key) setSketchNonces((prev) => ({ ...prev, [key]: (prev[key] || mountNonceRef.current) + 1 }));
    };
    socket.on('media:sketch:updated', onSketchUpdated);
    return () => socket.off('media:sketch:updated', onSketchUpdated);
  }, []);
  // A panel maker run or frame landed (here, in another tab, or after the
  // user navigated away and back): swap in the board's current record.
  useEffect(() => {
    let active = true;
    const refresh = (evt) => {
      if (evt?.storyboardId && evt.storyboardId !== id) return;
      getStoryboard(id, { silent: true })
        .then((next) => { if (active && next) setBoard((prev) => (prev && prev.updatedAt > next.updatedAt ? prev : next)); })
        .catch(() => {});
    };
    const onReconnect = () => refresh();
    socket.on('storyboard:make', refresh);
    socket.on('connect', onReconnect);
    return () => {
      active = false;
      socket.off('storyboard:make', refresh);
      socket.off('connect', onReconnect);
    };
  }, [id]);

  const sketchNonce = useCallback((key) => (key ? sketchNonces[key] || mountNonceRef.current : 0), [sketchNonces]);

  // Keep the newest board: a slower earlier write must not undo a later one.
  const apply = useCallback((res) => {
    const next = res?.board ?? res;
    if (next?.id !== id) return res;
    setBoard((prev) => (prev && prev.updatedAt > next.updatedAt ? prev : next));
    return res;
  }, [id]);

  // The request helper toasts a failure; null tells the caller it failed.
  const write = useCallback((call) => call().then(apply).catch(() => null), [apply]);

  const panelNumbers = useMemo(() => {
    const numbers = new Map();
    let n = 1;
    for (const beat of board?.beats || []) for (const panel of beat.panels) numbers.set(panel.id, n++);
    return numbers;
  }, [board]);

  const openPanel = (pid) => navigate(`/storyboards/${id}/panel/${pid}${viewSuffix}`);
  const closePanel = () => navigate(`/storyboards/${id}${viewSuffix}`);
  const setView = (next) => navigate(`/storyboards/${id}${panelId ? `/panel/${panelId}` : ''}${viewQuery(next)}`, { replace: true });

  const addBeat = async () => {
    setPending('beat');
    await write(() => addStoryboardBeat(id, {}));
    setPending(null);
  };

  const addPanel = async (beatId) => {
    setPending(`panel:${beatId}`);
    const res = await write(() => addStoryboardPanel(id, beatId, {}));
    setPending(null);
    if (res?.panelId) openPanel(res.panelId);
  };

  const found = board && panelId ? findPanel(board, panelId) : null;

  const panelHandlers = {
    onPatch: (patch) => write(() => updateStoryboardPanel(id, panelId, patch)),
    onAddTake: (take) => write(() => addStoryboardPanelTake(id, panelId, take)),
    onSelectTake: (takeId) => write(() => selectStoryboardPanelTake(id, panelId, takeId)),
    onRemoveTake: (takeId) => write(() => removeStoryboardPanelTake(id, panelId, takeId)),
    onMove: (target) => write(() => moveStoryboardPanel(id, panelId, target)),
    onRecipe: (recipe) => write(() => updateStoryboardRecipe(id, recipe)),
    onNodePatch: (nodeId, patch) => write(() => updateStoryboardPanelNode(id, panelId, nodeId, patch)),
    // Resolves true when the node ran (Run all stops at the first failure,
    // whose reason the node card shows).
    onRunNode: async (nodeId) => {
      const res = await write(() => runStoryboardPanelNode(id, panelId, nodeId));
      return !!res && findPanel(res, panelId)?.panel.make?.nodes?.[nodeId]?.status !== 'failed';
    },
    onDelete: async () => {
      const res = await write(() => deleteStoryboardPanel(id, panelId));
      if (res) closePanel();
    },
    // A blank sketch is minted server-side, added as the panel's take, then
    // drawn on the annotate page, which returns here.
    onSketch: async () => {
      setPending('sketch');
      const minted = await createBlankSketch({ silent: true }).catch(() => null);
      if (!minted?.key) {
        setPending(null);
        toast.error('Could not start a sketch');
        return;
      }
      const res = await write(() => addStoryboardPanelTake(id, panelId, { source: 'sketch', sketchKey: minted.key }));
      setPending(null);
      if (!res) return;
      const returnTo = `/storyboards/${id}/panel/${panelId}${viewSuffix}`;
      navigate(`/media/annotate/${encodeURIComponent(minted.key)}?returnTo=${encodeURIComponent(returnTo)}`);
    },
  };

  if (board === undefined) {
    return (
      <div className="flex h-full items-center justify-center text-gray-500">
        <Loader2 className="w-5 h-5 animate-spin" aria-label="Loading storyboard" />
      </div>
    );
  }

  if (board === null) {
    return (
      <div className="p-6 text-center space-y-3">
        <p className="text-gray-300">This storyboard doesn't exist or was deleted.</p>
        <Link to="/storyboards" className="text-port-accent hover:underline">All storyboards</Link>
      </div>
    );
  }

  const runtime = board.beats.reduce((sum, beat) => sum + beatSeconds(beat), 0);
  const missingMoodBoard = board.moodBoardId && !moodBoards.some((m) => m.id === board.moodBoardId);
  let firstPanelNumber = 1;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-port-border px-2 py-2 sm:px-4 space-y-2">
        {/* The name is edited in place, so the page heading is for screen readers. */}
        <h1 className="sr-only">{board.name}</h1>
        <div className="flex items-center gap-1 sm:gap-2">
          <Link to="/storyboards" aria-label="All storyboards"
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded text-gray-400 hover:text-white">
            <ArrowLeft size={18} />
          </Link>
          <LayoutPanelLeft className="hidden sm:block w-6 h-6 shrink-0 text-port-accent" aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <CommitField id="storyboard-name" value={board.name} maxLength={STORYBOARD_LIMITS.name} ariaLabel="Storyboard name"
              onCommit={(name) => write(() => updateStoryboard(id, { name }))} className="text-base font-semibold" />
          </div>
          <span className="text-sm text-gray-400 tabular-nums shrink-0" title="Estimated runtime">{formatTimecode(runtime)}</span>
          <TabPills tabs={VIEW_TABS} activeTab={view} onChange={setView} variant="pills" size="sm" mobileCompact ariaLabel="Storyboard view" />
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <div className="flex-1 min-w-[14rem]">
            <CommitField id="storyboard-logline" multiline value={board.logline} maxLength={STORYBOARD_LIMITS.logline}
              placeholder="Logline: the story in a sentence" ariaLabel="Logline" minHeightClass="min-h-[2.75rem]"
              onCommit={(logline) => write(() => updateStoryboard(id, { logline }))} />
          </div>
          <label htmlFor="storyboard-aspect" className="sr-only">Aspect ratio</label>
          <select id="storyboard-aspect" value={board.aspectRatio} className={selectClass}
            onChange={(event) => write(() => updateStoryboard(id, { aspectRatio: event.target.value }))}>
            {STORYBOARD_ASPECT_RATIOS.map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
          </select>
          <label htmlFor="storyboard-mood-board" className="sr-only">Mood board</label>
          <select id="storyboard-mood-board" value={board.moodBoardId || ''} className={`${selectClass} max-w-[12rem]`}
            onChange={(event) => write(() => updateStoryboard(id, { moodBoardId: event.target.value || null }))}>
            <option value="">No mood board</option>
            {missingMoodBoard ? <option value={board.moodBoardId}>Missing mood board</option> : null}
            {moodBoards.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <button type="button" onClick={() => setPlotOpen(true)} className={headerButton}>
            <ScrollText size={16} aria-hidden="true" /> Beats from plot
          </button>
          <button type="button" onClick={() => setDrawerParam('brief', true)} className={headerButton}>
            <ListMusic size={16} aria-hidden="true" /> Song brief
          </button>
          {board.beats.some((beat) => beat.panels.length) && <MakeEmptyPanels boardId={id} />}
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-auto p-2 sm:p-4">
        {board.beats.length === 0 ? (
          <div className="py-10 text-center space-y-3">
            <p className="text-sm text-gray-400">Start with the first story beat, or draw the beats from a plot summary.</p>
            <button type="button" onClick={addBeat} disabled={pending === 'beat'}
              className="min-h-[44px] inline-flex items-center gap-1.5 px-4 rounded bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50">
              <Plus size={16} aria-hidden="true" /> Beat
            </button>
            <button type="button" onClick={() => setPlotOpen(true)} className={`${headerButton} ml-2`}>
              <ScrollText size={16} aria-hidden="true" /> Beats from plot
            </button>
          </div>
        ) : view === 'play' ? (
          <StoryboardPlayer board={board} sketchNonce={sketchNonce}
            onTempTrack={(tempTrack) => write(() => updateStoryboard(id, { tempTrack }))} />
        ) : view === 'board' ? (
          <ol className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2" aria-label="All panels">
            {board.beats.flatMap((beat, beatIndex) => beat.panels.map((panel, index) => (
              <li key={panel.id}>
                <PanelCard
                  panel={panel}
                  number={panelNumbers.get(panel.id)}
                  aspectRatio={board.aspectRatio}
                  selected={panel.id === panelId}
                  sketchNonce={sketchNonce}
                  caption={index === 0 ? (beat.title || `Beat ${beatIndex + 1}`) : null}
                  onOpen={() => openPanel(panel.id)}
                />
              </li>
            )))}
          </ol>
        ) : (
          <div className="space-y-3">
            {board.beats.map((beat, beatIndex) => {
              const first = firstPanelNumber;
              firstPanelNumber += beat.panels.length;
              return (
                <BeatSection
                  key={beat.id}
                  beat={beat}
                  beatIndex={beatIndex}
                  beatCount={board.beats.length}
                  firstPanelNumber={first}
                  aspectRatio={board.aspectRatio}
                  selectedPanelId={panelId}
                  sketchNonce={sketchNonce}
                  addingPanel={pending === `panel:${beat.id}`}
                  onUpdate={(patch) => write(() => updateStoryboardBeat(id, beat.id, patch))}
                  onMove={(index) => write(() => moveStoryboardBeat(id, beat.id, index))}
                  onDelete={() => write(() => deleteStoryboardBeat(id, beat.id))}
                  onAddPanel={() => addPanel(beat.id)}
                  onOpenPanel={openPanel}
                />
              );
            })}
            <button type="button" onClick={addBeat} disabled={pending === 'beat'}
              className="w-full min-h-[44px] rounded-xl border border-dashed border-port-border text-sm text-gray-400 hover:text-white hover:border-port-accent/60 inline-flex items-center justify-center gap-1.5 disabled:opacity-50">
              <Plus size={16} aria-hidden="true" /> Beat
            </button>
          </div>
        )}
      </div>

      <SongBriefDrawer open={briefOpen} board={board} onClose={() => setDrawerParam('brief', false)} />
      <PlotBeatsDrawer open={plotOpen} board={board} onClose={() => setPlotOpen(false)} onBoard={apply} />
      <PanelDrawer
        open={!!panelId}
        board={board}
        found={found}
        panelNumber={found ? panelNumbers.get(found.panel.id) : null}
        sketchNonce={sketchNonce}
        busy={pending === 'sketch'}
        onClose={closePanel}
        handlers={panelHandlers}
      />
    </div>
  );
}
