import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Clapperboard, Loader2, PenLine } from 'lucide-react';
import toast from '../ui/Toast';
import TabPills from '../ui/TabPills';
import Drawer from '../Drawer';
import UnsavedChangesConfirm from '../ui/UnsavedChangesConfirm';
import { updateWritersRoomWork } from '../../services/apiWritersRoom';
import { safeReadStorage, safeWriteStorage } from '../../lib/safeStorage';
import { formatDurationSec } from '../../utils/formatters';
import { STORYBOARD_TAB, STORYBOARD_TAB_VALUES } from './StoryboardPanel';
import AnalysisHistory from './AnalysisHistory';
import PolishPanel from './PolishPanel';
import ProseTokenPopover from './ProseTokenPopover';
import WritersRoomDock from './WritersRoomDock';
import WorkEditorVersions from './WorkEditorVersions';
import WorkEditorVoicePanel from './WorkEditorVoicePanel';
import useImageGenQueue from './useImageGenQueue';
import useSidebarResize from './useSidebarResize';
import useTokenPopover from './useTokenPopover';
import useWorkLiveDirector from './useWorkLiveDirector';
import WorkEditorToolbar, { DRAWER } from './WorkEditorToolbar';
import WorkEditorSidebar from './WorkEditorSidebar';
import WorkEditorProsePane from './WorkEditorProsePane';
import useWorkDraftPersistence from './useWorkDraftPersistence';
import useWorkAnalysisPipeline, { ANALYSIS_LABELS } from './useWorkAnalysisPipeline';

const MOBILE_TAB = { WRITING: 'writing', STORYBOARD: 'storyboard' };
const MOBILE_TABS = [
  { id: MOBILE_TAB.WRITING, label: 'Writing', icon: PenLine },
  { id: MOBILE_TAB.STORYBOARD, label: 'Storyboard', icon: Clapperboard },
];

const SIDEBAR_WIDTH_KEY = 'wr.sidebarWidth';
const SIDEBAR_DEFAULT = 480;
const SIDEBAR_MIN = 320;
const SIDEBAR_MAX_FRACTION = 0.6;
const READING_THEME_KEY = 'wr.readingTheme';
const SIDEBAR_TAB_KEY = 'wr.sidebarTab';

function readReadingTheme() {
  return safeReadStorage(READING_THEME_KEY) === 'light' ? 'light' : 'dark';
}

function readSidebarTab() {
  const stored = safeReadStorage(SIDEBAR_TAB_KEY);
  return STORYBOARD_TAB_VALUES.includes(stored) ? stored : STORYBOARD_TAB.BOARDS;
}

export default function WorkEditor({ work, onChange, onToggleExercise, exerciseOpen, onDirtyChange, headerCollapsed = false, draftMutation = null, beginDraftMutation, endDraftMutation }) {
  const exercisePending = draftMutation?.kind === 'exercise';

  const {
    body, setBody, title, setTitle, status, dirty, saving, switchingDraft, polishBusy, setPolishBusy,
    bodyRef, savedBodyRef, ownerKeyRef, mountedRef, savingRef, draftTransitionRef,
    handleSave, handleSnapshot, commitTitle, commitImageStyle, commitStatus, switchToDraft,
    publishMetadata, applyFormatText, reloadBodyFromServer, routeGuard, discardAndExit,
  } = useWorkDraftPersistence({ work, onChange, exercisePending, beginDraftMutation, endDraftMutation });
  const analysis = useWorkAnalysisPipeline({
    workId: work.id, bodyRef, savedBodyRef, ownerKeyRef, draftTransitionRef, savingRef, mountedRef,
    setBody, polishBusy, exercisePending,
  });
  const { characters, places, objects, runningKind, runStartedAt, runAnalysis } = analysis;
  const [readingTheme, setReadingTheme] = useState(readReadingTheme);
  const [drawer, setDrawer] = useState(null);
  const [mobileTab, setMobileTab] = useState(MOBILE_TAB.WRITING);
  const [activeSceneId, setActiveSceneId] = useState(null);
  const [sidebarTab, setSidebarTab] = useState(readSidebarTab);
  // Scenes from the latest script analysis — populated by StoryboardPanel via
  // onScenesChange so ProseReader can mark scene boundaries in Read view.
  const [latestScenes, setLatestScenes] = useState([]);
  // Prose-token popover state machine (hover/click/pin + the cross-link
  // `hotRef` that lights SceneCard chips and bible rows). See useTokenPopover.
  const {
    pop,
    hotRef,
    onTokenEnter: handleTokenEnter,
    onTokenLeave: handleTokenLeave,
    onTokenClick: handleTokenClick,
    onPopoverEnter: handlePopoverEnter,
    onPopoverLeave: handlePopoverLeave,
    closePopover,
  } = useTokenPopover();
  // `hotScene` ties SceneCard hover to the matching ProseReader section.
  const [hotScene, setHotScene] = useState(null);
  // Live image-gen queue scoped to this page. SceneCard calls
  // queueRegister({jobId, sceneId, sceneLabel}) on render kickoff so the dock
  // can label rows; the hook subscribes to image-gen:* socket events globally.
  const {
    queue: renderQueue,
    renderingCount: renderRenderingCount,
    cancelingCount: renderCancelingCount,
    activeCount: renderActiveCount,
    register: queueRegister,
    stopAll: queueStopAll,
    stopOne: queueStopOne,
  } = useImageGenQueue();

  // Voice exemplars / anti-exemplars (#2179) — "the tuning fork" passages that
  // anchor the live-continuation prompt + the polish revision brief to the
  // chosen voice. Edited in the Voice drawer, persisted via updateWork on Save.
  // Hoisted here (not inside the drawer body) so switching works re-seeds it and
  // the drawer body can remount freely without losing in-progress edits.
  const [voiceExemplars, setVoiceExemplars] = useState(work.voiceExemplars || []);
  const [voiceAntiExemplars, setVoiceAntiExemplars] = useState(work.voiceAntiExemplars || []);
  const [savingVoice, setSavingVoice] = useState(false);
  useEffect(() => { setVoiceExemplars(work.voiceExemplars || []); }, [work.id, work.voiceExemplars]);
  useEffect(() => { setVoiceAntiExemplars(work.voiceAntiExemplars || []); }, [work.id, work.voiceAntiExemplars]);
  // View mode (Edit | Read | Review) is URL-driven so it deep-links and
  // survives reloads. ?view=read → ProseReader; ?view=review → SyncedReview
  // (Phase 4 prose/script/media surface); default is the existing textarea.
  const [searchParams, setSearchParams] = useSearchParams();
  const rawView = searchParams.get('view');
  const viewMode = rawView === 'read' ? 'read' : rawView === 'review' ? 'review' : 'edit';
  const setViewMode = useCallback((mode) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (mode === 'read' || mode === 'review') next.set('view', mode); else next.delete('view');
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  useEffect(() => {
    safeWriteStorage(SIDEBAR_TAB_KEY, sidebarTab);
  }, [sidebarTab]);

  const textareaRef = useRef(null);
  const readerRef = useRef(null);
  const scrollAnimRef = useRef(null);
  // Popover open/close callbacks come from useTokenPopover above.
  // `handleOpenProfile` is the one that isn't purely popover-local: it closes
  // the popover AND swings the sidebar/mobile tab to the matching bible section.
  const handleOpenProfile = useCallback(({ kind }) => {
    closePopover();
    if (kind === 'char') setSidebarTab(STORYBOARD_TAB.CHARACTERS);
    else if (kind === 'place') setSidebarTab(STORYBOARD_TAB.WORLD);
    else if (kind === 'object' && STORYBOARD_TAB.OBJECTS) setSidebarTab(STORYBOARD_TAB.OBJECTS);
    setMobileTab(MOBILE_TAB.STORYBOARD);
  }, [closePopover]);

  const smoothScrollTextarea = useCallback((ta, targetTop, ms = 220) => {
    if (!ta) return;
    if (scrollAnimRef.current) {
      cancelAnimationFrame(scrollAnimRef.current);
      scrollAnimRef.current = null;
    }
    const startTop = ta.scrollTop;
    const delta = targetTop - startTop;
    if (Math.abs(delta) < 1) { ta.scrollTop = targetTop; return; }
    const startTs = performance.now();
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const step = (ts) => {
      const elapsed = ts - startTs;
      const t = Math.min(1, elapsed / ms);
      ta.scrollTop = startTop + delta * ease(t);
      if (t < 1) {
        scrollAnimRef.current = requestAnimationFrame(step);
      } else {
        scrollAnimRef.current = null;
      }
    };
    scrollAnimRef.current = requestAnimationFrame(step);
  }, []);

  useEffect(() => () => {
    if (scrollAnimRef.current) cancelAnimationFrame(scrollAnimRef.current);
  }, []);

  useEffect(() => { onDirtyChange?.(dirty || polishBusy || !!runningKind); }, [dirty, polishBusy, runningKind, onDirtyChange]);
  // Persist the voice exemplars (#2179). Drop rows with a blank passage before
  // sending (the server prunes them too, but this keeps the round-tripped state
  // honest) and clear the drawer's dirty edits into the saved work.
  const saveVoice = async () => {
    const startOwner = ownerKeyRef.current;
    const clean = (list) => (Array.isArray(list) ? list : [])
      .map((e) => ({ passage: (e.passage || '').trim(), note: (e.note || '').trim() }))
      .filter((e) => e.passage)
      .map((e) => (e.note ? e : { passage: e.passage }));
    setSavingVoice(true);
    const updated = await updateWritersRoomWork(work.id, {
      voiceExemplars: clean(voiceExemplars),
      voiceAntiExemplars: clean(voiceAntiExemplars),
    }, { silent: true }).catch((err) => {
      if (mountedRef.current) toast.error(`Voice save failed: ${err.message}`);
      return null;
    });
    if (!mountedRef.current) return;
    setSavingVoice(false);
    if (publishMetadata(updated, ['voiceExemplars', 'voiceAntiExemplars'], startOwner)) {
      setVoiceExemplars(updated.voiceExemplars || []);
      setVoiceAntiExemplars(updated.voiceAntiExemplars || []);
      toast.success('Voice exemplars saved');
      setDrawer(null);
    }
  };

  const liveDirector = useWorkLiveDirector({
    work, viewMode, bodyRef, textareaRef, setBody, switchingDraft, exercisePending, draftTransitionRef,
    ownerKeyRef, mountedRef, publishMetadata,
  });
  const { liveEnabled, toggleLiveMode, scheduleLiveSuggest } = liveDirector;

  const handleEdit = (text) => {
    if (draftTransitionRef.current || exercisePending) return;
    setBody(text);
    scheduleLiveSuggest();
  };

  const activeHash = useMemo(
    () => work.drafts?.find((draft) => draft.id === work.activeDraftVersionId)?.contentHash || null,
    [work.drafts, work.activeDraftVersionId],
  );

  // Click-to-jump tries the LLM heading (with markdown prefixes), then a
  // summary/action snippet, then proportional by scene index. Browsers don't
  // always re-scroll on focus alone if the caret was already visible, so we
  // always set scrollTop explicitly after focusing.
  const jumpToScene = useCallback((scene, sceneIndex = -1, totalScenes = 0) => {
    if (!scene) return;
    setActiveSceneId(scene.id || null);
    setMobileTab(MOBILE_TAB.WRITING);

    // Read view: each scene section has a stable DOM anchor — scrollIntoView
    // is the natural fit and animates by default in modern browsers.
    if (viewMode === 'read' && scene.id) {
      const reader = readerRef.current;
      const el = reader?.querySelector?.(`#scene-anchor-${CSS.escape(scene.id)}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      // Fall through to the textarea path if the section wasn't found.
    }

    const ta = textareaRef.current;
    const text = bodyRef.current;
    if (!ta || !text) return;
    const heading = scene.heading || '';
    let idx = -1;
    for (const prefix of ['## ', '### ', '# ', '']) {
      if (!heading) break;
      idx = text.indexOf(prefix + heading);
      if (idx >= 0) break;
    }
    if (idx < 0) {
      for (const candidate of [scene.summary, scene.action]) {
        if (!candidate) continue;
        const snippet = String(candidate).trim().slice(0, 40);
        if (!snippet) continue;
        idx = text.indexOf(snippet);
        if (idx >= 0) break;
      }
    }
    let target;
    if (idx >= 0) {
      ta.focus();
      ta.setSelectionRange(idx, idx);
      const fraction = idx / text.length;
      target = Math.max(0, fraction * (ta.scrollHeight - ta.clientHeight));
    } else if (totalScenes > 0 && sceneIndex >= 0) {
      const fraction = sceneIndex / totalScenes;
      target = Math.max(0, fraction * (ta.scrollHeight - ta.clientHeight));
    } else {
      return;
    }
    smoothScrollTextarea(ta, target);
  }, [viewMode, smoothScrollTextarea]);

  // Per-scene Debug menu actions — until scoped tools land, route to the
  // most relevant tab/drawer.
  const handleDebug = useCallback(({ kind, scene }) => {
    if (scene) setActiveSceneId(scene.id || null);
    if (kind === 'check-characters') {
      setSidebarTab(STORYBOARD_TAB.CHARACTERS);
      setMobileTab(MOBILE_TAB.STORYBOARD);
    }
    else if (kind === 'editorial') setDrawer(DRAWER.HISTORY);
    else if (kind === 'why-image') setDrawer(DRAWER.HISTORY);
  }, []);

  // Drag-to-resize sidebar (desktop only). `splitRef` goes on the flex
  // container so the drag can cap the sidebar at SIDEBAR_MAX_FRACTION of it.
  const {
    containerRef: splitRef,
    width: sidebarWidth,
    maxWidth: sidebarMaxWidth,
    onMouseDown: onSplitMouseDown,
    onKeyDown: onSplitKeyDown,
    reset: resetSidebarWidth,
  } = useSidebarResize({
    storageKey: SIDEBAR_WIDTH_KEY,
    defaultWidth: SIDEBAR_DEFAULT,
    minWidth: SIDEBAR_MIN,
    maxFraction: SIDEBAR_MAX_FRACTION,
  });
  const toggleReadingTheme = useCallback(() => {
    setReadingTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      safeWriteStorage(READING_THEME_KEY, next);
      return next;
    });
  }, []);

  const showSidebar = viewMode !== 'review';

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Keep the editor mounted when collapsing controls so unsaved prose,
          selection and active view survive focused writing. */}
      <WorkEditorToolbar
        work={work} ownerKeyRef={ownerKeyRef} publishMetadata={publishMetadata} headerCollapsed={headerCollapsed}
        title={title} setTitle={setTitle} commitTitle={commitTitle}
        status={status} commitStatus={commitStatus} viewMode={viewMode} setViewMode={setViewMode}
        dirty={dirty} saving={saving} switchingDraft={switchingDraft} polishBusy={polishBusy} exercisePending={exercisePending}
        handleSave={handleSave} handleSnapshot={() => handleSnapshot(runningKind)}
        runningKind={runningKind} runAnalysis={runAnalysis} setDrawer={setDrawer}
        liveEnabled={liveEnabled} toggleLiveMode={toggleLiveMode}
        readingTheme={readingTheme} toggleReadingTheme={toggleReadingTheme}
        onToggleExercise={onToggleExercise} exerciseOpen={exerciseOpen}
      />
      {/* A save in flight is about to settle the draft clean, and the guard
          releases the parked navigation on its own — no confirm to flash. */}
      {exercisePending && <div role="status" className="px-3 py-2 text-sm text-port-warning">Adding sprint text to draft…</div>}
      <UnsavedChangesConfirm
        guard={routeGuard}
        when={!saving && !switchingDraft && !exercisePending}
        question="Discard your unsaved changes to this work?"
        label={`Discard unsaved changes to ${title || 'this work'}`}
        onDiscard={discardAndExit}
      />

      {runningKind && (
        <AnalysisRunBanner
          kind={runningKind}
          startedAt={runStartedAt}
        />
      )}

      {/* Mobile-only Writing/Storyboard toggle — desktop renders both side-by-side.
          Review mode is a full-width surface with no storyboard sidebar, so the
          toggle is irrelevant there. */}
      {showSidebar && (
        <TabPills
          tabs={MOBILE_TABS}
          activeTab={mobileTab}
          onChange={setMobileTab}
          variant="underline"
          stretch
          size="sm"
          mobileCompact
          ariaLabel="Writing or storyboard"
          className="lg:hidden shrink-0"
        />
      )}

      {/*
        When the render dock is visible (queue non-empty) it's `position: fixed`
        at the bottom of the viewport. Add a conservative bottom inset to the
        split so the dock doesn't overlap the textarea, the Read view, the
        word-count overlay, or the storyboard scroll area. Tracks the dock's
        own measured height (~52px); a few px of slack is fine.
      */}
      <div
        ref={splitRef}
        className="flex-1 flex flex-col lg:flex-row min-h-0"
        style={renderQueue.length ? { paddingBottom: 56 } : undefined}
      >
        <WorkEditorProsePane
          viewMode={viewMode} work={work} hidden={showSidebar && mobileTab === MOBILE_TAB.STORYBOARD}
          body={body} dirty={dirty} readOnly={switchingDraft || exercisePending} onEdit={handleEdit}
          textareaRef={textareaRef} readerRef={readerRef} readingTheme={readingTheme}
          latestScenes={latestScenes} activeSceneId={activeSceneId}
          characters={characters} places={places} objects={objects}
          hotRef={hotRef} pop={pop} hotScene={hotScene} setHotScene={setHotScene}
          handleTokenEnter={handleTokenEnter} handleTokenLeave={handleTokenLeave} handleTokenClick={handleTokenClick}
        />

        {/* Review mode is a full-width synced surface — no storyboard sidebar. */}
        {showSidebar && (
          <>
            <div
              onMouseDown={onSplitMouseDown}
              onDoubleClick={resetSidebarWidth}
              onKeyDown={onSplitKeyDown}
              tabIndex={0}
              role="separator"
              aria-label="Resize storyboard sidebar"
              aria-orientation="vertical"
              aria-valuemin={SIDEBAR_MIN}
              aria-valuemax={Math.round(sidebarMaxWidth)}
              aria-valuenow={Math.round(sidebarWidth)}
              title="Drag to resize · double-click to reset · focus and use Left/Right arrows (Shift for larger steps), Home/End, Enter to reset"
              className="hidden lg:block w-1 shrink-0 cursor-col-resize bg-port-border hover:bg-port-accent/60 active:bg-port-accent transition-colors"
            />

            <WorkEditorSidebar
              work={work} onChange={onChange} hidden={mobileTab === MOBILE_TAB.WRITING}
              sidebarWidth={sidebarWidth} sidebarTab={sidebarTab} setSidebarTab={setSidebarTab}
              readingTheme={readingTheme} activeSceneId={activeSceneId}
              body={body} dirty={dirty} hotRef={hotRef} setHotScene={setHotScene} analysis={analysis}
              liveDirector={liveDirector} queueRegister={queueRegister} setLatestScenes={setLatestScenes}
              jumpToScene={jumpToScene} handleDebug={handleDebug} commitImageStyle={commitImageStyle}
            />
          </>
        )}
      </div>

      <ProseTokenPopover
        open={!!pop}
        pinned={!!pop?.pinned}
        anchorEl={pop?.anchorEl || null}
        kind={pop?.kind}
        refId={pop?.refId}
        characters={characters}
        places={places}
        objects={objects}
        onOpenProfile={handleOpenProfile}
        onClose={closePopover}
        onPopoverEnter={handlePopoverEnter}
        onPopoverLeave={handlePopoverLeave}
      />

      <WritersRoomDock
        queue={renderQueue}
        renderingCount={renderRenderingCount}
        cancelingCount={renderCancelingCount}
        activeCount={renderActiveCount}
        onStopAll={queueStopAll}
        onStopOne={queueStopOne}
      />

      <Drawer open={drawer === DRAWER.VERSIONS} onClose={() => { if (!draftTransitionRef.current) setDrawer(null); }} title="Versions">
        <WorkEditorVersions work={work} dirty={dirty} pending={switchingDraft} disabled={saving || polishBusy || !!runningKind || exercisePending} onSwitch={async (draftId) => {
          if (await switchToDraft(draftId, runningKind)) setDrawer(null);
        }} />
      </Drawer>
      <Drawer open={drawer === DRAWER.HISTORY} onClose={() => setDrawer(null)} title="Analysis history">
        <AnalysisHistory work={work} activeHash={activeHash} onApplyFormat={applyFormatText} />
      </Drawer>
      <Drawer open={drawer === DRAWER.POLISH} onClose={() => { if (!polishBusy) setDrawer(null); }} title="Polish" size="md">
        <PolishPanel work={work} dirty={dirty} blocked={switchingDraft || saving || exercisePending} onBusyChange={setPolishBusy} onBodyChanged={reloadBodyFromServer} />
      </Drawer>
      <Drawer open={drawer === DRAWER.VOICE} onClose={() => setDrawer(null)} title="Voice exemplars" size="md">
        <WorkEditorVoicePanel
          exemplars={voiceExemplars}
          antiExemplars={voiceAntiExemplars}
          onExemplarsChange={setVoiceExemplars}
          onAntiExemplarsChange={setVoiceAntiExemplars}
          saving={savingVoice}
          onSave={saveVoice}
        />
      </Drawer>
    </div>
  );
}

// In-progress banner for a writers-room analysis run. Renders a persistent
// status strip with elapsed time and reassurance text that escalates as the
// run drags on — so long Opus-on-prose runs (which can legitimately take
// 10+ minutes) don't look like the UI has gone silent.
function AnalysisRunBanner({ kind, startedAt }) {
  const [elapsed, setElapsed] = useState(() => (startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0));
  useEffect(() => {
    if (!startedAt) return undefined;
    setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    // biome-ignore lint/plugin/lint-no-view-interval: Elapsed-time clock for the analysis-run banner; no I/O.
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  const timeStr = formatDurationSec(elapsed);

  // Reassurance ladder — escalating context so the user can tell the
  // difference between "normal" and "this is taking unusually long."
  const tone =
    elapsed >= 480 ? 'border-port-warning/50 bg-port-warning/5 text-port-warning'
    : 'border-port-accent/40 bg-port-accent/5 text-gray-200';
  const reassurance =
    elapsed < 30  ? 'Working…'
    : elapsed < 120 ? 'Still working — large prompts can take a few minutes.'
    : elapsed < 480 ? 'Still going — Opus on long prose runs 5–10+ minutes. Hang tight.'
    : 'Almost there — keep this tab open while the agent finishes.';

  return (
    <div
      role="status"
      aria-live="polite"
      className={`shrink-0 flex items-center gap-3 px-4 py-2 border-b text-[12px] ${tone}`}
      data-kind={kind}
    >
      <Loader2 size={14} className="animate-spin shrink-0" />
      <span className="font-semibold shrink-0">{ANALYSIS_LABELS[kind] || kind}</span>
      <span className="tabular-nums text-gray-300 shrink-0" aria-label="elapsed time">{timeStr}</span>
      <span className="truncate text-gray-400">{reassurance}</span>
    </div>
  );
}
