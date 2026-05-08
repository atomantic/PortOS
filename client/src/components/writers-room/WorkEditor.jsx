import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Save,
  GitCommit,
  Sun,
  Moon,
  MoreHorizontal,
  Clapperboard,
  Sparkles,
  FileSignature,
  Users,
  MapPin,
  Clock,
  History,
  Timer,
  PenLine,
  Check,
  Loader2,
  BookOpen,
  Pencil,
} from 'lucide-react';
import toast from '../ui/Toast';
import Drawer from '../Drawer';
import useMounted from '../../hooks/useMounted';
import useClickOutside from '../../hooks/useClickOutside';
import {
  saveWritersRoomDraft,
  snapshotWritersRoomDraft,
  setWritersRoomActiveDraft,
  updateWritersRoomWork,
  runWritersRoomAnalysis,
  listWritersRoomCharacters,
  listWritersRoomSettings,
  listWritersRoomObjects,
} from '../../services/apiWritersRoom';
import { STATUS_LABELS } from './labels';
import { countWords } from '../../utils/formatters';
import StoryboardPanel, { STORYBOARD_TAB, STORYBOARD_TAB_VALUES } from './StoryboardPanel';
import AnalysisHistory from './AnalysisHistory';
import ProseReader from './ProseReader';
import ProseTokenPopover from './ProseTokenPopover';
import WritersRoomDock from './WritersRoomDock';
import useImageGenQueue from '../../hooks/useImageGenQueue';

const ANALYSIS_KIND = { SCRIPT: 'script', CHARACTERS: 'characters', SETTINGS: 'settings', OBJECTS: 'objects', EVALUATE: 'evaluate', FORMAT: 'format' };
const DRAWER = { VERSIONS: 'versions', HISTORY: 'history' };
const MOBILE_TAB = { WRITING: 'writing', STORYBOARD: 'storyboard' };

const ANALYSIS_LABELS = {
  [ANALYSIS_KIND.SCRIPT]: 'Adapt',
  [ANALYSIS_KIND.CHARACTERS]: 'Characters',
  [ANALYSIS_KIND.SETTINGS]: 'Settings',
  [ANALYSIS_KIND.OBJECTS]: 'Objects',
  [ANALYSIS_KIND.EVALUATE]: 'Editorial pass',
  [ANALYSIS_KIND.FORMAT]: 'Format pass',
};

const SIDEBAR_WIDTH_KEY = 'wr.sidebarWidth';
const SIDEBAR_DEFAULT = 480;
const SIDEBAR_MIN = 320;
const SIDEBAR_MAX_FRACTION = 0.6;
const READING_THEME_KEY = 'wr.readingTheme';
const SIDEBAR_TAB_KEY = 'wr.sidebarTab';

function readReadingTheme() {
  if (typeof window === 'undefined') return 'dark';
  return window.localStorage.getItem(READING_THEME_KEY) === 'light' ? 'light' : 'dark';
}

function readSidebarWidth() {
  if (typeof window === 'undefined') return SIDEBAR_DEFAULT;
  const raw = window.localStorage.getItem(SIDEBAR_WIDTH_KEY);
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= SIDEBAR_MIN ? n : SIDEBAR_DEFAULT;
}

function persistSidebarWidth(width) {
  try { window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(width))); } catch { return undefined; }
}

function readSidebarTab() {
  if (typeof window === 'undefined') return STORYBOARD_TAB.BOARDS;
  const stored = window.localStorage.getItem(SIDEBAR_TAB_KEY);
  return STORYBOARD_TAB_VALUES.includes(stored) ? stored : STORYBOARD_TAB.BOARDS;
}

export default function WorkEditor({ work, onChange, onToggleExercise, exerciseOpen }) {
  const [body, setBody] = useState(work.activeDraftBody || '');
  const [title, setTitle] = useState(work.title);
  // Optimistic mirror of work.status so the dropdown changes show immediately
  // before the PATCH round-trip resolves. Re-synced from the prop when it changes.
  const [status, setStatus] = useState(work.status);
  const [savedBody, setSavedBody] = useState(work.activeDraftBody || '');
  const [saving, setSaving] = useState(false);
  const [readingTheme, setReadingTheme] = useState(readReadingTheme);
  const [characters, setCharacters] = useState([]);
  const [settings, setSettings] = useState([]);
  const [objects, setObjects] = useState([]);
  const [runningKind, setRunningKind] = useState(null);
  const [drawer, setDrawer] = useState(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [mobileTab, setMobileTab] = useState(MOBILE_TAB.WRITING);
  const [activeSceneId, setActiveSceneId] = useState(null);
  const [sidebarTab, setSidebarTab] = useState(readSidebarTab);
  // Scenes from the latest script analysis — populated by StoryboardPanel via
  // onScenesChange so ProseReader can mark scene boundaries in Read view.
  const [latestScenes, setLatestScenes] = useState([]);
  // Token popover state. `pop.kind`/`pop.refId` identify the hovered token,
  // `pop.anchorEl` is the DOM ELEMENT (not a frozen DOMRect) — the popover
  // re-reads getBoundingClientRect on each reflow so it tracks the token
  // through scrolling and viewport resizes. `pinned` keeps the popover
  // open after click so the user can move into it (e.g. to click
  // "Open profile") without it dismissing.
  const [pop, setPop] = useState(null);
  // Cross-link hot states: `hotRef` ({kind,refId}) ties prose tokens to
  // SceneCard chips and to bible rows; `hotScene` ties SceneCard hover to
  // the matching ProseReader section. Both are nullable.
  const [hotRef, setHotRef] = useState(null);
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

  // View mode (Edit | Read) is URL-driven so it deep-links and survives reloads.
  // ?view=read switches to ProseReader; default is the existing textarea.
  const [searchParams, setSearchParams] = useSearchParams();
  const viewMode = searchParams.get('view') === 'read' ? 'read' : 'edit';
  const setViewMode = useCallback((mode) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (mode === 'read') next.set('view', 'read'); else next.delete('view');
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  useEffect(() => {
    try { window.localStorage.setItem(SIDEBAR_TAB_KEY, sidebarTab); } catch { /* sandboxed storage */ }
  }, [sidebarTab]);

  const textareaRef = useRef(null);
  const readerRef = useRef(null);
  const overflowRef = useRef(null);
  const scrollAnimRef = useRef(null);
  // Hover-delay timers for the prose-token popover. 200ms open, 150ms close
  // so the popover doesn't flicker when the cursor crosses a token.
  const popOpenTimerRef = useRef(null);
  const popCloseTimerRef = useRef(null);
  // Mirror of `pop?.pinned` so callbacks can read pinned state without
  // re-binding (and so setPop updaters stay pure — StrictMode replays the
  // updater and would emit duplicate setHotRef side effects otherwise).
  const popPinnedRef = useRef(false);
  useEffect(() => { popPinnedRef.current = !!pop?.pinned; }, [pop?.pinned]);

  // Pass the anchor ELEMENT down (not a frozen DOMRect) so the popover can
  // re-read getBoundingClientRect on scroll/resize and stay attached to its
  // token. A captured rect goes stale the moment the user scrolls.
  // While pinned, hover-driven opens are ignored — the user explicitly
  // pinned the popover and shouldn't see it ripped out from under them as
  // the cursor crosses other tokens. They have to click the X (or press
  // Escape) before another token can open a new popover.
  const handleTokenEnter = useCallback(({ kind, refId, anchor }) => {
    if (popPinnedRef.current) return;
    if (popCloseTimerRef.current) {
      clearTimeout(popCloseTimerRef.current);
      popCloseTimerRef.current = null;
    }
    if (popOpenTimerRef.current) clearTimeout(popOpenTimerRef.current);
    setHotRef({ kind, refId });
    popOpenTimerRef.current = setTimeout(() => {
      setPop({ kind, refId, anchorEl: anchor, pinned: false });
    }, 200);
  }, []);
  // Schedule the 150ms grace close. Idempotent: clears any existing close
  // timer first so rapid enter/leave events can't pile up multiple pending
  // timeouts that fire later and clear pop/hotRef unexpectedly. The timer
  // also nulls its own ref after firing so external clearTimeouts on a stale
  // id are a no-op.
  //
  // hotRef is only cleared when the popover actually closes (i.e. it wasn't
  // pinned). When pinned, the popover stays visible and the cross-link
  // highlights (SceneCard chips / bible rows) must stay lit too — clearing
  // hotRef there would leave the popover orphaned from its visual targets.
  const scheduleClose = useCallback(() => {
    if (popCloseTimerRef.current) {
      clearTimeout(popCloseTimerRef.current);
      popCloseTimerRef.current = null;
    }
    popCloseTimerRef.current = setTimeout(() => {
      popCloseTimerRef.current = null;
      const isPinned = popPinnedRef.current;
      if (isPinned) return;
      setPop(null);
      setHotRef(null);
    }, 150);
  }, []);
  const handleTokenLeave = useCallback(() => {
    if (popOpenTimerRef.current) {
      clearTimeout(popOpenTimerRef.current);
      popOpenTimerRef.current = null;
    }
    scheduleClose();
  }, [scheduleClose]);
  // Cursor crossed from token onto the popover itself: cancel the pending
  // close so the user can click links inside without it dismissing on them.
  const handlePopoverEnter = useCallback(() => {
    if (popCloseTimerRef.current) {
      clearTimeout(popCloseTimerRef.current);
      popCloseTimerRef.current = null;
    }
    if (popOpenTimerRef.current) {
      clearTimeout(popOpenTimerRef.current);
      popOpenTimerRef.current = null;
    }
  }, []);
  // Cursor left the popover (and didn't go back to a token): schedule the
  // same 150ms grace close as token-leave.
  const handlePopoverLeave = useCallback(() => {
    scheduleClose();
  }, [scheduleClose]);
  const handleTokenClick = useCallback(({ kind, refId, anchor }) => {
    if (popOpenTimerRef.current) clearTimeout(popOpenTimerRef.current);
    if (popCloseTimerRef.current) clearTimeout(popCloseTimerRef.current);
    setPop({ kind, refId, anchorEl: anchor, pinned: true });
  }, []);
  // Closing the popover (whether by Escape, X click, or auto-leave) must also
  // drop the hot-state and any pending hover timers; otherwise SceneCard chips
  // and bible rows can stay highlighted indefinitely after the cursor has
  // moved on.
  const clearPopTimers = useCallback(() => {
    if (popOpenTimerRef.current) {
      clearTimeout(popOpenTimerRef.current);
      popOpenTimerRef.current = null;
    }
    if (popCloseTimerRef.current) {
      clearTimeout(popCloseTimerRef.current);
      popCloseTimerRef.current = null;
    }
  }, []);
  const handlePopClose = useCallback(() => {
    clearPopTimers();
    setPop(null);
    setHotRef(null);
  }, [clearPopTimers]);
  const handleOpenProfile = useCallback(({ kind }) => {
    clearPopTimers();
    setPop(null);
    setHotRef(null);
    if (kind === 'char') setSidebarTab(STORYBOARD_TAB.CHARACTERS);
    else if (kind === 'place') setSidebarTab(STORYBOARD_TAB.WORLD);
    else if (kind === 'object' && STORYBOARD_TAB.OBJECTS) setSidebarTab(STORYBOARD_TAB.OBJECTS);
    setMobileTab(MOBILE_TAB.STORYBOARD);
  }, [clearPopTimers]);

  useEffect(() => () => {
    if (popOpenTimerRef.current) clearTimeout(popOpenTimerRef.current);
    if (popCloseTimerRef.current) clearTimeout(popCloseTimerRef.current);
  }, []);

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

  // Rehydrate body/title when the parent swaps the active work OR switches to
  // a different draft version of the same work.
  const prevKey = useRef({ id: work.id, draftId: work.activeDraftVersionId });
  useEffect(() => {
    const key = { id: work.id, draftId: work.activeDraftVersionId };
    if (prevKey.current.id === key.id && prevKey.current.draftId === key.draftId) return;
    prevKey.current = key;
    setBody(work.activeDraftBody || '');
    setSavedBody(work.activeDraftBody || '');
    setTitle(work.title);
  }, [work.id, work.activeDraftVersionId, work.activeDraftBody, work.title]);

  useEffect(() => { setStatus(work.status); }, [work.status]);
  useEffect(() => { setTitle(work.title); }, [work.title]);

  // The CharactersBible / SettingsBible drawers are the canonical editors;
  // mirror their lists here so the storyboard's image-prompt enrichment picks
  // up edits immediately.
  useEffect(() => {
    Promise.all([
      listWritersRoomCharacters(work.id).catch(() => []),
      listWritersRoomSettings(work.id).catch(() => []),
      listWritersRoomObjects(work.id).catch(() => []),
    ]).then(([chars, sets, objs]) => {
      setCharacters(chars || []);
      setSettings(sets || []);
      setObjects(objs || []);
    });
  }, [work.id]);

  const dirty = body !== savedBody;
  const wordCount = useMemo(() => countWords(body), [body]);

  const mountedRef = useMounted();

  // savingRef gates parallel saves synchronously — `saving` state lags React
  // re-renders, so rapid Cmd+S key-repeats can slip past it otherwise.
  const savingRef = useRef(false);
  const handleSaveRef = useRef(null);
  handleSaveRef.current = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    const updated = await saveWritersRoomDraft(work.id, body).catch((err) => {
      if (mountedRef.current) toast.error(`Save failed: ${err.message}`);
      return null;
    });
    savingRef.current = false;
    if (!mountedRef.current) return;
    setSaving(false);
    if (!updated) return;
    setSavedBody(body);
    onChange?.(updated);
    toast.success('Saved');
  };
  const handleSave = () => handleSaveRef.current?.();

  useEffect(() => {
    const onKey = (e) => {
      const isSave = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's';
      if (!isSave) return;
      e.preventDefault();
      handleSaveRef.current?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useClickOutside(overflowRef, overflowOpen, () => setOverflowOpen(false));

  const handleSnapshot = async () => {
    if (dirty) {
      toast('Save before snapshotting', { icon: '⚠️' });
      return;
    }
    const updated = await snapshotWritersRoomDraft(work.id).catch((err) => {
      if (mountedRef.current) toast.error(`Snapshot failed: ${err.message}`);
      return null;
    });
    if (!updated || !mountedRef.current) return;
    onChange?.({ ...updated, activeDraftBody: body });
    toast.success(`Created ${updated.drafts[updated.drafts.length - 1].label}`);
  };

  const commitTitle = async () => {
    if (title === work.title) return;
    const updated = await updateWritersRoomWork(work.id, { title }).catch((err) => {
      if (mountedRef.current) toast.error(`Title save failed: ${err.message}`);
      return null;
    });
    if (!updated || !mountedRef.current) return;
    if (updated.title !== title) setTitle(updated.title);
    onChange?.({ ...updated, activeDraftBody: body });
  };

  const commitImageStyle = async (next) => {
    const updated = await updateWritersRoomWork(work.id, { imageStyle: next }).catch((err) => {
      if (mountedRef.current) toast.error(`Style save failed: ${err.message}`);
      return null;
    });
    if (updated && mountedRef.current) {
      onChange?.({ ...updated, activeDraftBody: body });
      toast.success(next.presetId === 'none' ? 'World style cleared' : 'World style saved');
    }
  };

  const commitStatus = async (next) => {
    if (next === status) return;
    setStatus(next);
    const updated = await updateWritersRoomWork(work.id, { status: next }).catch((err) => {
      if (mountedRef.current) {
        toast.error(`Status save failed: ${err.message}`);
        setStatus(work.status);
      }
      return null;
    });
    if (updated && mountedRef.current) onChange?.({ ...updated, activeDraftBody: body });
  };

  const switchToDraft = async (draftId) => {
    if (draftId === work.activeDraftVersionId) return;
    if (dirty) {
      toast('Save or snapshot before switching versions', { icon: '⚠️' });
      return;
    }
    const updated = await setWritersRoomActiveDraft(work.id, draftId).catch((err) => {
      if (mountedRef.current) toast.error(`Switch failed: ${err.message}`);
      return null;
    });
    if (!updated || !mountedRef.current) return;
    onChange?.(updated);
  };

  // Shared analysis runner — the storyboard, overflow menu, and per-scene
  // debug menu all funnel through here so we get one toast + state pattern.
  // Format pass replaces the prose buffer (apply-on-success) — the user can
  // back out by simply not saving. Characters refreshes the bible cache so
  // the storyboard's prompt enrichment picks up new profiles immediately.
  const runAnalysis = useCallback(async (kind) => {
    if (runningKind) return false;
    setRunningKind(kind);
    const snapshot = await runWritersRoomAnalysis(work.id, { kind }).catch((err) => {
      if (mountedRef.current) toast.error(`${ANALYSIS_LABELS[kind] || kind} failed: ${err.message}`);
      return null;
    });
    if (!mountedRef.current) {
      setRunningKind(null);
      return false;
    }
    setRunningKind(null);
    if (!snapshot) return false;
    if (snapshot.status === 'failed') {
      toast.error(`${ANALYSIS_LABELS[kind] || kind} failed: ${snapshot.error || 'unknown'}`);
      return false;
    }
    toast.success(`${ANALYSIS_LABELS[kind] || kind} complete`);
    if (kind === 'characters' && Array.isArray(snapshot.result?.mergedProfiles)) {
      setCharacters(snapshot.result.mergedProfiles);
    }
    if (kind === 'settings' && Array.isArray(snapshot.result?.mergedProfiles)) {
      setSettings(snapshot.result.mergedProfiles);
    }
    if (kind === 'objects' && Array.isArray(snapshot.result?.mergedProfiles)) {
      setObjects(snapshot.result.mergedProfiles);
    }
    if (kind === 'format' && snapshot.result?.formattedBody) {
      setBody(snapshot.result.formattedBody);
      toast('Format applied to draft buffer — save to persist', { icon: '💾' });
    }
    return true;
  }, [runningKind, work.id]);

  // Sequential pipeline for the 3-step storyboard setup. Run characters →
  // settings → script in order so each later step has the earlier bible to
  // reference. Bails on first failure (the failed step's toast already fired).
  const runFullPipeline = useCallback(async () => {
    if (runningKind) return;
    const okChars = await runAnalysis(ANALYSIS_KIND.CHARACTERS);
    if (!okChars || !mountedRef.current) return;
    const okSettings = await runAnalysis(ANALYSIS_KIND.SETTINGS);
    if (!okSettings || !mountedRef.current) return;
    await runAnalysis(ANALYSIS_KIND.SCRIPT);
  }, [runAnalysis, runningKind]);

  const applyFormatText = (text) => {
    setBody(text);
    toast('Applied to editor — save to persist', { icon: '💾' });
  };

  const activeDraft = useMemo(
    () => work.drafts?.find((d) => d.id === work.activeDraftVersionId),
    [work.drafts, work.activeDraftVersionId]
  );
  const activeHash = activeDraft?.contentHash || null;

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
    if (!ta || !body) return;
    const heading = scene.heading || '';
    let idx = -1;
    for (const prefix of ['## ', '### ', '# ', '']) {
      if (!heading) break;
      idx = body.indexOf(prefix + heading);
      if (idx >= 0) break;
    }
    if (idx < 0) {
      for (const candidate of [scene.summary, scene.action]) {
        if (!candidate) continue;
        const snippet = String(candidate).trim().slice(0, 40);
        if (!snippet) continue;
        idx = body.indexOf(snippet);
        if (idx >= 0) break;
      }
    }
    let target;
    if (idx >= 0) {
      ta.focus();
      ta.setSelectionRange(idx, idx);
      const fraction = idx / body.length;
      target = Math.max(0, fraction * (ta.scrollHeight - ta.clientHeight));
    } else if (totalScenes > 0 && sceneIndex >= 0) {
      const fraction = sceneIndex / totalScenes;
      target = Math.max(0, fraction * (ta.scrollHeight - ta.clientHeight));
    } else {
      return;
    }
    smoothScrollTextarea(ta, target);
  }, [body, viewMode, smoothScrollTextarea]);

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

  // Drag-to-resize sidebar (desktop only).
  const splitRef = useRef(null);
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const sidebarWidthRef = useRef(sidebarWidth);
  useEffect(() => { sidebarWidthRef.current = sidebarWidth; }, [sidebarWidth]);
  const dragStartRef = useRef(null);

  const onSplitMouseDown = useCallback((e) => {
    e.preventDefault();
    const containerWidth = splitRef.current?.getBoundingClientRect().width ?? 0;
    dragStartRef.current = { startX: e.clientX, startWidth: sidebarWidthRef.current, containerWidth };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const onMove = (e) => {
      if (!dragStartRef.current) return;
      const { startX, startWidth, containerWidth } = dragStartRef.current;
      const max = Math.max(SIDEBAR_MIN + 1, containerWidth * SIDEBAR_MAX_FRACTION);
      const next = Math.min(max, Math.max(SIDEBAR_MIN, startWidth - (e.clientX - startX)));
      setSidebarWidth(next);
    };
    const onUp = () => {
      if (!dragStartRef.current) return;
      dragStartRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      persistSidebarWidth(sidebarWidthRef.current);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (dragStartRef.current) {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        dragStartRef.current = null;
      }
    };
  }, []);

  const toggleReadingTheme = useCallback(() => {
    setReadingTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      try { window.localStorage.setItem(READING_THEME_KEY, next); } catch { return next; }
      return next;
    });
  }, []);

  const closeOverflowAnd = (fn) => () => { setOverflowOpen(false); fn?.(); };

  return (
    <div className="flex flex-col h-full">
      {/* Header — title + status on left, primary actions + overflow on right */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-port-border bg-port-card">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
          className="bg-transparent text-base font-semibold text-white border-none focus:outline-none focus:bg-port-bg/50 px-1 rounded flex-1 min-w-[180px]"
          aria-label="Work title"
        />
        <select
          value={status}
          onChange={(e) => commitStatus(e.target.value)}
          className="bg-port-bg border border-port-border rounded px-2 py-1 text-[11px] text-gray-300"
          aria-label="Status"
        >
          {Object.entries(STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        {/* Two-state toggle, not a true tablist (no separate panels keyed off
            tab id, no roving tabindex, no arrow-key cycling). aria-pressed is
            the semantically correct primitive for an on/off-style toggle pair. */}
        <div className="flex items-center bg-port-bg border border-port-border rounded p-0.5" role="group" aria-label="View mode">
          <button
            type="button"
            aria-pressed={viewMode === 'edit'}
            onClick={() => setViewMode('edit')}
            className={`flex items-center gap-1 px-2 py-0.5 text-[11px] rounded ${
              viewMode === 'edit' ? 'bg-port-card text-white' : 'text-gray-400 hover:text-gray-200'
            }`}
            title="Edit prose (textarea)"
          >
            <Pencil size={11} /> Edit
          </button>
          <button
            type="button"
            aria-pressed={viewMode === 'read'}
            onClick={() => setViewMode('read')}
            className={`flex items-center gap-1 px-2 py-0.5 text-[11px] rounded ${
              viewMode === 'read' ? 'bg-port-card text-white' : 'text-gray-400 hover:text-gray-200'
            }`}
            title="Read view with scene anchors"
          >
            <BookOpen size={11} /> Read
          </button>
        </div>
        <button
          onClick={handleSave}
          disabled={!dirty || saving}
          className={`flex items-center gap-1 px-3 py-1 text-xs rounded ${
            dirty && !saving ? 'bg-port-accent text-white hover:bg-port-accent/80' : 'bg-port-bg text-gray-500'
          }`}
          title={dirty ? 'Save (Ctrl/Cmd+S)' : 'Up to date'}
        >
          <Save size={12} /> {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
        </button>
        <button
          onClick={handleSnapshot}
          disabled={dirty}
          className="flex items-center gap-1 px-3 py-1 text-xs rounded bg-port-bg border border-port-border text-gray-300 hover:text-white disabled:text-gray-600 disabled:cursor-not-allowed"
          title="Snapshot the active draft as a new version"
        >
          <GitCommit size={12} /> Snapshot
        </button>
        <div className="relative" ref={overflowRef}>
          <button
            onClick={() => setOverflowOpen((v) => !v)}
            className="flex items-center justify-center px-2 py-1 text-xs rounded bg-port-bg border border-port-border text-gray-300 hover:text-white"
            aria-label="Work menu"
            aria-expanded={overflowOpen}
            title="Work menu"
          >
            <MoreHorizontal size={14} />
          </button>
          {overflowOpen && (
            <div className="absolute right-0 top-full mt-1 z-30 w-60 rounded-md border border-port-border bg-port-card shadow-xl py-1 text-xs">
              <MenuSection label="AI">
                <MenuItem icon={Clapperboard} label="Run Adapt (rebuild storyboard)" running={runningKind === ANALYSIS_KIND.SCRIPT} onClick={closeOverflowAnd(() => runAnalysis(ANALYSIS_KIND.SCRIPT))} />
                <MenuItem icon={Users} label="Refresh characters" running={runningKind === ANALYSIS_KIND.CHARACTERS} onClick={closeOverflowAnd(() => runAnalysis(ANALYSIS_KIND.CHARACTERS))} />
                <MenuItem icon={MapPin} label="Refresh settings" running={runningKind === ANALYSIS_KIND.SETTINGS} onClick={closeOverflowAnd(() => runAnalysis(ANALYSIS_KIND.SETTINGS))} />
                <MenuItem icon={Sparkles} label="Editorial pass" running={runningKind === ANALYSIS_KIND.EVALUATE} onClick={closeOverflowAnd(() => runAnalysis(ANALYSIS_KIND.EVALUATE))} />
                <MenuItem icon={FileSignature} label="Format pass" running={runningKind === ANALYSIS_KIND.FORMAT} onClick={closeOverflowAnd(() => runAnalysis(ANALYSIS_KIND.FORMAT))} />
              </MenuSection>
              <MenuSection label="Open">
                <MenuItem icon={Clock} label="Versions" onClick={closeOverflowAnd(() => setDrawer(DRAWER.VERSIONS))} />
                <MenuItem icon={History} label="Analysis history" onClick={closeOverflowAnd(() => setDrawer(DRAWER.HISTORY))} />
              </MenuSection>
              <MenuSection label="View">
                <MenuItem
                  icon={readingTheme === 'dark' ? Sun : Moon}
                  label={readingTheme === 'dark' ? 'Light reading theme' : 'Dark reading theme'}
                  onClick={closeOverflowAnd(toggleReadingTheme)}
                />
                {onToggleExercise && (
                  <MenuItem
                    icon={Timer}
                    label={exerciseOpen ? 'Hide Write for 10' : 'Write for 10'}
                    onClick={closeOverflowAnd(onToggleExercise)}
                    active={exerciseOpen}
                  />
                )}
              </MenuSection>
            </div>
          )}
        </div>
      </div>

      {/* Mobile-only Writing/Storyboard toggle — desktop renders both side-by-side. */}
      <div className="lg:hidden flex border-b border-port-border bg-port-bg/40 shrink-0">
        <MobileTab active={mobileTab === MOBILE_TAB.WRITING} onClick={() => setMobileTab(MOBILE_TAB.WRITING)} icon={PenLine} label="Writing" />
        <MobileTab active={mobileTab === MOBILE_TAB.STORYBOARD} onClick={() => setMobileTab(MOBILE_TAB.STORYBOARD)} icon={Clapperboard} label="Storyboard" />
      </div>

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
        <div className={`relative min-h-0 flex-1 ${mobileTab === MOBILE_TAB.STORYBOARD ? 'hidden lg:block' : 'block'}`}>
          {viewMode === 'read' ? (
            <div ref={readerRef} className="w-full h-full">
              <ProseReader
                body={body}
                scenes={latestScenes}
                characters={characters}
                settings={settings}
                objects={objects}
                readingTheme={readingTheme}
                activeSceneId={activeSceneId}
                hotRef={hotRef}
                hotScene={hotScene}
                onTokenEnter={handleTokenEnter}
                onTokenLeave={handleTokenLeave}
                onTokenClick={handleTokenClick}
                onSceneEnter={setHotScene}
                onSceneLeave={() => setHotScene(null)}
              />
            </div>
          ) : (
            <textarea
              ref={textareaRef}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Start writing… Use # Chapter, ## Scene, ### Beat headings to outline."
              style={readingTheme === 'light'
                ? { '--port-input-bg': 'var(--wr-reading-paper)', color: '#1a1a1a' }
                : undefined}
              className="w-full h-full resize-none px-6 py-6 font-serif text-base leading-relaxed focus:outline-none"
              spellCheck
            />
          )}
          <div
            className={`absolute bottom-2 right-3 flex items-center gap-3 text-[11px] px-2 py-1 rounded pointer-events-none ${
              readingTheme === 'light' ? 'text-gray-700 bg-[var(--wr-reading-paper)]/85' : 'text-gray-500 bg-port-bg/80'
            }`}
          >
            <span>{wordCount.toLocaleString()} words</span>
            {dirty && <span className="text-port-warning">● unsaved</span>}
          </div>
        </div>

        <div
          onMouseDown={onSplitMouseDown}
          onDoubleClick={() => {
            setSidebarWidth(SIDEBAR_DEFAULT);
            persistSidebarWidth(SIDEBAR_DEFAULT);
          }}
          role="separator"
          aria-label="Resize storyboard sidebar"
          aria-orientation="vertical"
          title="Drag to resize · double-click to reset"
          className="hidden lg:block w-1 shrink-0 cursor-col-resize bg-port-border hover:bg-port-accent/60 active:bg-port-accent transition-colors"
        />

        <aside
          style={{ '--sidebar-w': `${sidebarWidth}px` }}
          className={`border-t lg:border-t-0 border-port-border bg-port-card/60 flex flex-col text-xs min-h-0 w-full flex-1 lg:flex-initial lg:w-[var(--sidebar-w)] lg:shrink-0 ${
            mobileTab === MOBILE_TAB.WRITING ? 'hidden lg:flex' : 'flex'
          }`}
        >
          <StoryboardPanel
            work={work}
            characters={characters}
            settings={settings}
            objects={objects}
            onCharactersChange={setCharacters}
            onSettingsChange={setSettings}
            onObjectsChange={setObjects}
            onRunObjects={() => runAnalysis(ANALYSIS_KIND.OBJECTS)}
            onScenesChange={setLatestScenes}
            onJumpToScene={jumpToScene}
            onDebug={handleDebug}
            onRunAdapt={() => runAnalysis(ANALYSIS_KIND.SCRIPT)}
            onRunCharacters={() => runAnalysis(ANALYSIS_KIND.CHARACTERS)}
            onRunSettings={() => runAnalysis(ANALYSIS_KIND.SETTINGS)}
            onRunFullPipeline={runFullPipeline}
            runningAdapt={runningKind === ANALYSIS_KIND.SCRIPT}
            runningKind={runningKind}
            readingTheme={readingTheme}
            activeSceneId={activeSceneId}
            onStyleChange={commitImageStyle}
            hotRef={hotRef}
            onSceneHover={setHotScene}
            onSceneRenderStart={queueRegister}
            tab={sidebarTab}
            onTabChange={setSidebarTab}
          />
        </aside>
      </div>

      <ProseTokenPopover
        open={!!pop}
        pinned={!!pop?.pinned}
        anchorEl={pop?.anchorEl || null}
        kind={pop?.kind}
        refId={pop?.refId}
        characters={characters}
        settings={settings}
        objects={objects}
        onOpenProfile={handleOpenProfile}
        onClose={handlePopClose}
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

      <Drawer open={drawer === DRAWER.VERSIONS} onClose={() => setDrawer(null)} title="Versions">
        <VersionsList work={work} dirty={dirty} onSwitch={(id) => { switchToDraft(id); setDrawer(null); }} />
      </Drawer>
      <Drawer open={drawer === DRAWER.HISTORY} onClose={() => setDrawer(null)} title="Analysis history">
        <AnalysisHistory work={work} activeHash={activeHash} onApplyFormat={applyFormatText} />
      </Drawer>
    </div>
  );
}

function MenuSection({ label, children }) {
  return (
    <div className="py-1 border-b border-port-border last:border-b-0">
      <div className="px-3 pt-1 pb-0.5 text-[9px] uppercase tracking-wider text-gray-500">{label}</div>
      {children}
    </div>
  );
}

function MenuItem({ icon: Icon, label, onClick, running = false, active = false, badge = null }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={running}
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-[11px] hover:bg-port-bg disabled:opacity-50 ${
        active ? 'text-port-accent' : 'text-gray-300'
      }`}
    >
      {running
        ? <Loader2 size={11} className="animate-spin text-port-accent" />
        : <Icon size={11} className={active ? 'text-port-accent' : 'text-gray-500'} />
      }
      <span className="flex-1">{label}</span>
      {badge != null && <span className="text-[10px] text-gray-500">{badge}</span>}
    </button>
  );
}

function MobileTab({ active, onClick, icon: Icon, label }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-[12px] border-b-2 ${
        active ? 'border-port-accent text-white' : 'border-transparent text-gray-500 hover:text-gray-300'
      }`}
    >
      <Icon size={13} /> {label}
    </button>
  );
}

function VersionsList({ work, dirty, onSwitch }) {
  const drafts = (work.drafts || []).slice().reverse();
  if (drafts.length === 0) {
    return <div className="text-xs text-gray-500 italic">No versions yet. Click Snapshot in the header to create one.</div>;
  }
  return (
    <>
      {dirty && (
        <div className="mb-2 px-2 py-1.5 text-[11px] border border-port-warning/40 bg-port-warning/5 text-port-warning rounded">
          Save or snapshot before switching versions — unsaved edits will be lost.
        </div>
      )}
      <ul className="space-y-1 text-xs">
        {drafts.map((draft) => {
          const isActive = draft.id === work.activeDraftVersionId;
          return (
            <li key={draft.id}>
              <button
                onClick={() => onSwitch(draft.id)}
                disabled={isActive}
                className={`w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded text-left ${
                  isActive ? 'bg-port-accent/20 text-port-accent cursor-default' : 'text-gray-400 hover:bg-port-bg hover:text-white'
                }`}
              >
                <span className="flex items-center gap-2 truncate">
                  {isActive ? <Check size={11} /> : <Clock size={11} />}
                  {draft.label}
                </span>
                <span className="text-[10px] text-gray-500">{draft.wordCount}w</span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
