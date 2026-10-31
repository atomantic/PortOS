/**
 * The storyboard editor: Create › Storyboards' board page, and a music video's
 * Storyboard step, which edits the board the video links. `boardPath` is where
 * the board lives in the app; the open panel is deep-linked at
 * `<boardPath>/panel/:panelId` and the view in `?view=board|play`.
 *
 * Beats view: one row per beat (title, musical role, estimated length) with a
 * strip of panels. Board view: the same beats as storyboard sheets, each
 * beat's panels in a grid. Play view: the animatic, with the temp track under
 * it. A panel opens in the side panel. Each write returns the whole board, and
 * the editor keeps the newest one it has seen (`updatedAt`), so two quick
 * edits can't land out of order. `embedded` drops the page chrome (back link,
 * full height, song brief and Make video) for a host page that has its own,
 * opens on the board view, folds the board settings behind a toggle, and shows
 * the host's `actions` beside the editor's own. A music video's Storyboard
 * step passes its `timingSong` (lib/storyboardFit.js storyboardFitSong): each
 * panel then shows when it plays on the song and the line sung over it, and
 * its drawer sets its exact length (lib/storyboardShotSync.js).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ArrowLeft, BookOpen, Clapperboard, ExternalLink, LayoutGrid, LayoutPanelLeft, ListMusic, Loader2, Play, Plus, Rows3, ScrollText, SlidersHorizontal } from 'lucide-react';
import TabPills from '../ui/TabPills';
import toast from '../ui/Toast';
import socket from '../../services/socket';
import {
  addStoryboardBeat, addStoryboardPanel, addStoryboardPanelTake, correctStoryboardPanel, createBlankSketch, deleteStoryboardBeat,
  deleteStoryboardPanel, drawStoryboardPanel, getStoryboard, listMoodBoardNames, moveStoryboardBeat, moveStoryboardPanel,
  removeStoryboardPanelTake, runStoryboardPanelNode, selectStoryboardPanelTake, sendStoryboardPanelToFableLoom, updateStoryboard, updateStoryboardBeat,
  updateStoryboardPanel, updateStoryboardPanelNode, updateStoryboardRecipe,
} from '../../services/api';
import { formatTimecode } from '../../utils/formatters';
import { storyboardPanelSpans } from '../../../../server/lib/storyboardShotSync.js';
import { STORYBOARD_ART_STYLE_LABELS, STORYBOARD_ART_STYLES, STORYBOARD_ASPECT_RATIOS, STORYBOARD_LIMITS } from '../../../../server/lib/storyboardVocabulary.js';
import BeatSection from './BeatSection';
import CommitField from './CommitField';
import MakeEmptyPanels from './MakeEmptyPanels';
import PlotBeatsDrawer from './PlotBeatsDrawer';
import SongBriefDrawer from './SongBriefDrawer';
import StoryboardPlayer from './StoryboardPlayer';
import PanelDrawer from './PanelDrawer';
import VideoDraftDrawer from '../creative-director/VideoDraftDrawer';
import { beatSeconds, findPanel } from './storyboardArt';

const VIEW_TABS = [
  { id: 'beats', label: 'Beats', icon: Rows3 },
  { id: 'board', label: 'Board', icon: LayoutGrid },
  { id: 'play', label: 'Play', icon: Play },
];
const VIEW_IDS = new Set(VIEW_TABS.map((tab) => tab.id));
// The editor's own query keys; opening or closing a panel clears them and keeps
// the rest (the view, and a host page's own keys).
const EDITOR_PARAMS = ['panelTab', 'makeView', 'node', 'plot', 'brief', 'video', 'correct'];

const selectClass = 'min-h-[44px] bg-port-bg border border-port-border rounded px-2 text-sm text-white';
const headerButton = 'min-h-[44px] inline-flex items-center gap-1.5 rounded border border-port-border px-3 text-sm text-gray-200 hover:border-port-accent/60 hover:text-white';

export default function StoryboardEditor({ boardId: id, panelId, boardPath, embedded = false, onBoard, refreshKey = 0, actions = null, song = null, timingSong = null }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const defaultView = embedded ? 'board' : 'beats';
  const view = VIEW_IDS.has(searchParams.get('view')) ? searchParams.get('view') : defaultView;
  const [showSettings, setShowSettings] = useState(!embedded);
  // Drawers over the board (`?plot=open`, `?brief=open`, `?video=open`), deep-linkable.
  const setDrawerParam = (key, on) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    if (on) next.set(key, 'open');
    else next.delete(key);
    return next;
  }, { replace: !on });
  const plotOpen = searchParams.get('plot') === 'open';
  const setPlotOpen = (on) => setDrawerParam('plot', on);
  const briefOpen = searchParams.get('brief') === 'open';
  const videoOpen = searchParams.get('video') === 'open';
  const panelSearch = () => {
    const next = new URLSearchParams(searchParams);
    for (const key of EDITOR_PARAMS) next.delete(key);
    const search = next.toString();
    return search ? `?${search}` : '';
  };
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
  // user navigated away and back), or the host found the board stale
  // (`refreshKey`): swap in the board's current record.
  useEffect(() => {
    if (!refreshKey) return undefined;
    let active = true;
    getStoryboard(id, { silent: true })
      .then((next) => { if (active && next) setBoard((prev) => (prev && prev.updatedAt > next.updatedAt ? prev : next)); })
      .catch(() => {});
    return () => { active = false; };
  }, [id, refreshKey]);
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

  // The host hears of every board this editor shows (a write, a socket refresh).
  const onBoardRef = useRef(onBoard);
  onBoardRef.current = onBoard;
  useEffect(() => { if (board) onBoardRef.current?.(board); }, [board]);

  const sketchNonce = useCallback((key) => (key ? sketchNonces[key] || mountNonceRef.current : 0), [sketchNonces]);

  // Keep the newest board: a slower earlier write must not undo a later one.
  const apply = useCallback((res) => {
    const next = res?.board ?? res;
    if (next?.id !== id) return res;
    setBoard((prev) => (prev && prev.updatedAt > next.updatedAt ? prev : next));
    return res;
  }, [id]);

  // The request helper toasts a failure; null tells the caller it failed.
  // Every write in flight, so a draw waits for a field committed on blur (the
  // tap on Draw panel blurs the field first) and draws from the saved words.
  const inFlight = useRef(new Set());
  const write = useCallback((call) => {
    const pendingWrite = call().then(apply).catch(() => null);
    inFlight.current.add(pendingWrite);
    pendingWrite.finally(() => inFlight.current.delete(pendingWrite));
    return pendingWrite;
  }, [apply]);

  // Marks on the temp track a beat can be pinned to (Play starts the beat there).
  const pinOptions = useMemo(() => {
    const track = board?.tempTrack;
    if (!track) return [];
    return [
      ...(track.sections || []).map((section) => ({ id: section.id, label: `${section.label} · ${formatTimecode(section.at)}` })),
      ...(track.lines || []).map((line) => ({ id: line.id, label: `“${line.text}” · ${line.at === null ? 'not stamped' : formatTimecode(line.at)}` })),
    ];
  }, [board?.tempTrack]);

  // Each panel's place on the song, when the host has one.
  const spans = useMemo(() => {
    if (!board || !timingSong) return null;
    return new Map(storyboardPanelSpans(board, timingSong).panels.map((span) => [span.panelId, span]));
  }, [board, timingSong]);
  const spanOf = spans ? (pid) => spans.get(pid) || null : null;

  const panelNumbers = useMemo(() => {
    const numbers = new Map();
    let n = 1;
    for (const beat of board?.beats || []) for (const panel of beat.panels) numbers.set(panel.id, n++);
    return numbers;
  }, [board]);

  const panelPath = (pid) => `${boardPath}/panel/${pid}`;
  const openPanel = (pid) => navigate(`${panelPath(pid)}${panelSearch()}`);
  const closePanel = () => navigate(`${boardPath}${panelSearch()}`);
  const setView = (next) => setSearchParams((prev) => {
    const params = new URLSearchParams(prev);
    if (next === defaultView) params.delete('view');
    else params.set('view', next);
    return params;
  }, { replace: true });

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
  // Previous / next panel in story order; `checkOnly` asks whether one exists.
  const stepPanel = (delta, checkOnly = false) => {
    const order = (board?.beats || []).flatMap((beat) => beat.panels.map((panel) => panel.id));
    const target = order[order.indexOf(panelId) + delta];
    if (!found || !target) return false;
    if (!checkOnly) openPanel(target);
    return true;
  };

  const panelHandlers = {
    onPatch: (patch) => write(() => updateStoryboardPanel(id, panelId, patch)),
    onAddTake: (take) => write(() => addStoryboardPanelTake(id, panelId, take)),
    onSelectTake: (takeId) => write(() => selectStoryboardPanelTake(id, panelId, takeId)),
    onRemoveTake: (takeId) => write(() => removeStoryboardPanelTake(id, panelId, takeId)),
    onMove: (target) => write(() => moveStoryboardPanel(id, panelId, target)),
    // A blank panel at `index` in this panel's beat, opened for editing.
    onInsert: async (index) => {
      if (!found) return;
      const res = await write(() => addStoryboardPanel(id, found.beat.id, { index }));
      if (res?.panelId) openPanel(res.panelId);
    },
    onSendToScene: async () => {
      const res = await write(() => sendStoryboardPanelToFableLoom(id, panelId));
      if (res) toast.success(board.source?.kind === 'pipeline' ? 'Shot start frame updated in the pipeline' : 'Scene art updated in FableLoom');
    },
    // Resolves once the frame is queued; it lands on `storyboard:make` as the panel's art.
    onDraw: async () => {
      await Promise.all([...inFlight.current]);
      return write(() => drawStoryboardPanel(id, panelId));
    },
    // Resolves true once the corrected frames are queued (a failure toasts, or shows on the writer's card).
    onCorrect: async (body) => {
      const res = await write(() => correctStoryboardPanel(id, panelId, body));
      if (res) toast.success('Redrawing: the new frames land as takes');
      return !!res;
    },
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
      const returnTo = `${panelPath(panelId)}${panelSearch()}`;
      navigate(`/media/annotate/${encodeURIComponent(minted.key)}?returnTo=${encodeURIComponent(returnTo)}`);
    },
  };

  if (board === undefined) {
    return (
      <div className={`flex items-center justify-center text-gray-500 ${embedded ? 'py-10' : 'h-full'}`}>
        <Loader2 className="w-5 h-5 animate-spin" aria-label="Loading storyboard" />
      </div>
    );
  }

  if (board === null) {
    return (
      <div className="p-6 text-center space-y-3">
        <p className="text-gray-300">This storyboard doesn't exist or was deleted.</p>
        {!embedded && <Link to="/storyboards" className="text-port-accent hover:underline">All storyboards</Link>}
      </div>
    );
  }

  const runtime = board.beats.reduce((sum, beat) => sum + beatSeconds(beat), 0);
  const missingMoodBoard = board.moodBoardId && !moodBoards.some((m) => m.id === board.moodBoardId);
  let firstPanelNumber = 1;

  return (
    <div className={embedded ? 'min-w-0' : 'flex h-full min-h-0 flex-col'}>
      <header className={`shrink-0 border-b border-port-border space-y-2 ${embedded ? 'pb-2' : 'px-2 py-2 sm:px-4'}`}>
        {/* The name is edited in place, so the page heading is for screen readers. */}
        {embedded ? <h3 className="sr-only">{board.name}</h3> : <h1 className="sr-only">{board.name}</h1>}
        <div className="flex items-center gap-1 sm:gap-2">
          {embedded ? (
            <Link to={`/storyboards/${id}`} aria-label="Open in Storyboards" title="Open in Storyboards"
              className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded text-gray-400 hover:text-white">
              <ExternalLink size={18} />
            </Link>
          ) : (
            <Link to="/storyboards" aria-label="All storyboards"
              className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded text-gray-400 hover:text-white">
              <ArrowLeft size={18} />
            </Link>
          )}
          <LayoutPanelLeft className="hidden sm:block w-6 h-6 shrink-0 text-port-accent" aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <CommitField id="storyboard-name" value={board.name} maxLength={STORYBOARD_LIMITS.name} ariaLabel="Storyboard name"
              onCommit={(name) => write(() => updateStoryboard(id, { name }))} className="text-base font-semibold" />
          </div>
          <span className="text-sm text-gray-400 tabular-nums shrink-0" title="Estimated runtime">{formatTimecode(runtime)}</span>
          {embedded && (
            <button type="button" onClick={() => setShowSettings((on) => !on)} aria-expanded={showSettings} aria-controls="storyboard-settings"
              aria-label="Board settings" title="Logline, aspect, art style, mood board"
              className={`min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded hover:text-white ${showSettings ? 'text-port-accent' : 'text-gray-400'}`}>
              <SlidersHorizontal size={18} />
            </button>
          )}
          <TabPills tabs={VIEW_TABS} activeTab={view} onChange={setView} variant="pills" size="sm" mobileCompact ariaLabel="Storyboard view" />
        </div>
        {showSettings && (
          <div id="storyboard-settings" className="flex flex-wrap items-start gap-2">
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
            <label htmlFor="storyboard-art-style" className="sr-only">Art style</label>
            <select id="storyboard-art-style" value={board.artStyle} className={selectClass}
              onChange={(event) => write(() => updateStoryboard(id, { artStyle: event.target.value }))}>
              {STORYBOARD_ART_STYLES.map((style) => <option key={style} value={style}>{STORYBOARD_ART_STYLE_LABELS[style]}</option>)}
            </select>
            <label htmlFor="storyboard-mood-board" className="sr-only">Mood board</label>
            <select id="storyboard-mood-board" value={board.moodBoardId || ''} className={`${selectClass} max-w-[12rem]`}
              onChange={(event) => write(() => updateStoryboard(id, { moodBoardId: event.target.value || null }))}>
              <option value="">No mood board</option>
              {missingMoodBoard ? <option value={board.moodBoardId}>Missing mood board</option> : null}
              {moodBoards.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
        )}
        <div className="flex flex-wrap items-start gap-2">
          {actions}
          <button type="button" onClick={() => setPlotOpen(true)} className={headerButton}>
            <ScrollText size={16} aria-hidden="true" /> Beats from plot
          </button>
          {!embedded && (
            <button type="button" onClick={() => setDrawerParam('brief', true)} className={headerButton}>
              <ListMusic size={16} aria-hidden="true" /> Song brief
            </button>
          )}
          {!embedded && board.beats.length > 0 && (
            <button type="button" onClick={() => setDrawerParam('video', true)} className={headerButton}>
              <Clapperboard size={16} aria-hidden="true" /> Make video
            </button>
          )}
          {board.beats.some((beat) => beat.panels.length) && <MakeEmptyPanels boardId={id} />}
          {board.source?.kind === 'fableloom' && (
            <Link to={`/fableloom/${encodeURIComponent(board.source.loomId)}/${encodeURIComponent(board.source.episodeId)}/board`} className={headerButton}>
              <BookOpen size={16} aria-hidden="true" /> FableLoom episode
            </Link>
          )}
          {board.source?.kind === 'pipeline' && (
            <Link to={`/pipeline/issues/${encodeURIComponent(board.source.issueId)}/storyboards`} className={headerButton}>
              <BookOpen size={16} aria-hidden="true" /> Pipeline issue
            </Link>
          )}
        </div>
      </header>

      <div className={embedded ? 'pt-2' : 'flex-1 min-h-0 overflow-auto p-2 sm:p-4'}>
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
          <StoryboardPlayer board={board} sketchNonce={sketchNonce} song={song}
            onTempTrack={(tempTrack) => write(() => updateStoryboard(id, { tempTrack }))} />
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
                  pinOptions={pinOptions}
                  canPlayBeforeSong={beatIndex === 0 || board.beats[beatIndex - 1].beforeSong === true}
                  grid={view === 'board'}
                  spanOf={spanOf}
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

      {!embedded && (
        <>
          <VideoDraftDrawer open={videoOpen} storyboard={board} onClose={() => setDrawerParam('video', false)}
            onSaved={(created) => navigate(`/creative-director/${created.id}/overview`)} />
          <SongBriefDrawer open={briefOpen} board={board} onClose={() => setDrawerParam('brief', false)} />
        </>
      )}
      <PlotBeatsDrawer open={plotOpen} board={board} onClose={() => setPlotOpen(false)} onBoard={apply} />
      <PanelDrawer
        open={!!panelId}
        board={board}
        found={found}
        panelNumber={found ? panelNumbers.get(found.panel.id) : null}
        sketchNonce={sketchNonce}
        busy={pending === 'sketch'}
        onClose={closePanel}
        onStep={stepPanel}
        handlers={panelHandlers}
        timing={!embedded}
        songTiming={found && spanOf?.(found.panel.id) ? { span: spanOf(found.panel.id), lyricCues: timingSong.lyricCues } : null}
      />
    </div>
  );
}
