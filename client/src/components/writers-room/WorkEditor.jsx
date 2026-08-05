import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router';
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
  Loader2,
  BookOpen,
  Pencil,
  Columns3,
  Film,
  ExternalLink,
  Zap,
  Wand2,
  Quote,
} from 'lucide-react';
import toast from '../ui/Toast';
import ProseEditor from '../ui/ProseEditor';
import Drawer from '../Drawer';
import useMounted from '../../hooks/useMounted';
import useClickOutside from '../../hooks/useClickOutside';
import {
  saveWritersRoomDraft,
  snapshotWritersRoomDraft,
  setWritersRoomActiveDraft,
  updateWritersRoomWork,
  runWritersRoomAnalysis,
  getWritersRoomWork,
  listWritersRoomCharacters,
  listWritersRoomPlaces,
  listWritersRoomObjects,
  promoteWritersRoomWorkToPipeline,
} from '../../services/apiWritersRoom';
import { safeReadStorage, safeWriteStorage } from '../../lib/safeStorage';
import { STATUS_LABELS } from './labels';
import { countWords, formatDurationSec } from '../../utils/formatters';
import StoryboardPanel, { STORYBOARD_TAB, STORYBOARD_TAB_VALUES } from './StoryboardPanel';
import LiveContinuationPanel from './LiveContinuationPanel';
import LiveRenderPanel from './LiveRenderPanel';
import CdBridgePanel from './CdBridgePanel';
import AnalysisHistory from './AnalysisHistory';
import PolishPanel from './PolishPanel';
import ProseReader from './ProseReader';
import SyncedReview from './SyncedReview';
import ProseTokenPopover from './ProseTokenPopover';
import WritersRoomDock from './WritersRoomDock';
import WorkEditorVersions from './WorkEditorVersions';
import WorkEditorVoicePanel from './WorkEditorVoicePanel';
import useImageGenQueue from '../../hooks/useImageGenQueue';
import useLiveSuggest from '../../hooks/useLiveSuggest';
import useSidebarResize from '../../hooks/useSidebarResize';
import useTokenPopover from '../../hooks/useTokenPopover';

const ANALYSIS_KIND = { SCRIPT: 'script', CHARACTERS: 'characters', PLACES: 'places', OBJECTS: 'objects', EVALUATE: 'evaluate', FORMAT: 'format' };
const DRAWER = { VERSIONS: 'versions', HISTORY: 'history', POLISH: 'polish', VOICE: 'voice' };
const MOBILE_TAB = { WRITING: 'writing', STORYBOARD: 'storyboard' };

// The three prose surfaces the header toggles between. Declared once so the
// toggle group stays a map instead of three hand-copied buttons.
const VIEW_MODES = [
  { id: 'edit', label: 'Edit', icon: Pencil, title: 'Edit prose (textarea)' },
  { id: 'read', label: 'Read', icon: BookOpen, title: 'Read view with scene anchors' },
  { id: 'review', label: 'Review', icon: Columns3, title: 'Synced prose · script · media review' },
];

const ANALYSIS_LABELS = {
  [ANALYSIS_KIND.SCRIPT]: 'Adapt',
  [ANALYSIS_KIND.CHARACTERS]: 'Characters',
  [ANALYSIS_KIND.PLACES]: 'Places',
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
  return safeReadStorage(READING_THEME_KEY) === 'light' ? 'light' : 'dark';
}

function readSidebarTab() {
  const stored = safeReadStorage(SIDEBAR_TAB_KEY);
  return STORYBOARD_TAB_VALUES.includes(stored) ? stored : STORYBOARD_TAB.BOARDS;
}

export default function WorkEditor({ work, onChange, onToggleExercise, exerciseOpen }) {
  const navigate = useNavigate();
  const [body, setBody] = useState(work.activeDraftBody || '');
  const [title, setTitle] = useState(work.title);
  const [promoting, setPromoting] = useState(false);
  // Optimistic mirror of work.status so the dropdown changes show immediately
  // before the PATCH round-trip resolves. Re-synced from the prop when it changes.
  const [status, setStatus] = useState(work.status);
  const [savedBody, setSavedBody] = useState(work.activeDraftBody || '');
  const [saving, setSaving] = useState(false);
  const [readingTheme, setReadingTheme] = useState(readReadingTheme);
  const [characters, setCharacters] = useState([]);
  const [places, setPlaces] = useState([]);
  const [objects, setObjects] = useState([]);
  const [runningKind, setRunningKind] = useState(null);
  const [runStartedAt, setRunStartedAt] = useState(null);
  const [drawer, setDrawer] = useState(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
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

  // Phase 5 live mode — opt-in, per-work Creative Director continuation
  // suggestions. Optimistic mirror of work.liveMode so the toggle flips
  // instantly; re-synced from the prop. The panel's imperative suggest fn and
  // the post-typing debounce live in useLiveSuggest (below).
  const [liveMode, setLiveMode] = useState(work.liveMode || null);
  useEffect(() => { setLiveMode(work.liveMode || null); }, [work.liveMode]);
  // Shared live text-suggest usage counter. The continuation panel and the CD
  // bridge BOTH draw on the same server-side daily budget, so a single mirror
  // lives here (not one per panel) — otherwise the panel that didn't make the
  // most recent call shows a stale "N left today" readout until its own next
  // call. Seeded from / re-synced to liveMode.usage (parent-driven changes:
  // work swap, budget edit, toggle); updated by whichever panel suggests. The
  // render-preview budget is a distinct counter owned by LiveRenderPanel.
  const [liveUsage, setLiveUsage] = useState(liveMode?.usage || null);
  useEffect(() => { setLiveUsage(liveMode?.usage || null); }, [liveMode?.usage]);
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
  // Phase 5 live render preview — the scene/analysis/image context the storyboard
  // surfaces, fed into LiveRenderPanel so it can render the scene at the cursor
  // using the existing image-gen route + the shared render queue (queueRegister).
  const [liveRenderContext, setLiveRenderContext] = useState(null);
  // Imperative bridge: StoryboardPanel registers its sceneImages merge fn here
  // so a finished live render preview updates the boards reactively (no refetch).
  const sceneImageMergeRef = useRef(null);
  const registerSceneImageMerge = useCallback((fn) => { sceneImageMergeRef.current = fn; }, []);
  const handleSceneImageAttached = useCallback((analysis) => {
    sceneImageMergeRef.current?.(analysis);
  }, []);

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
  const overflowRef = useRef(null);
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

  // The CharactersBible / PlacesBible drawers are the canonical editors;
  // mirror their lists here so the storyboard's image-prompt enrichment picks
  // up edits immediately.
  useEffect(() => {
    Promise.all([
      listWritersRoomCharacters(work.id).catch(() => []),
      listWritersRoomPlaces(work.id).catch(() => []),
      listWritersRoomObjects(work.id).catch(() => []),
    ]).then(([chars, plcs, objs]) => {
      setCharacters(chars || []);
      setPlaces(plcs || []);
      setObjects(objs || []);
    });
  }, [work.id]);

  const dirty = body !== savedBody;
  const wordCount = useMemo(() => countWords(body), [body]);

  // Live mirror of `body` for callbacks that only READ the prose (#3387).
  // Typing is the hot path here: `setBody` re-renders WorkEditor on every
  // keystroke, and any handler with `body` in its useCallback deps would get a
  // fresh identity each time — which defeats the memo boundary on the heavy
  // <StoryboardPanel> sibling and re-renders the whole storyboard tree per
  // character. Reading through the ref keeps those handlers referentially
  // stable. Assigned during render (same pattern as `handleSaveRef` below) so
  // the value is current before any child effect or event handler runs.
  const bodyRef = useRef(body);
  bodyRef.current = body;

  const mountedRef = useMounted();

  // savingRef gates parallel saves synchronously — `saving` state lags React
  // re-renders, so rapid Cmd+S key-repeats can slip past it otherwise.
  const savingRef = useRef(false);
  const handleSaveRef = useRef(null);
  handleSaveRef.current = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    const updated = await saveWritersRoomDraft(work.id, body, { silent: true }).catch((err) => {
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

  // Warn on tab close/navigation away while there are unsaved draft edits —
  // otherwise the body reset in the effect above silently discards them.
  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (e) => { e.preventDefault(); };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  useClickOutside(overflowRef, overflowOpen, () => setOverflowOpen(false));

  const handleSnapshot = async () => {
    if (dirty) {
      toast('Save before snapshotting', { icon: '⚠️' });
      return;
    }
    const updated = await snapshotWritersRoomDraft(work.id, undefined, { silent: true }).catch((err) => {
      if (mountedRef.current) toast.error(`Snapshot failed: ${err.message}`);
      return null;
    });
    if (!updated || !mountedRef.current) return;
    onChange?.({ ...updated, activeDraftBody: body });
    toast.success(`Created ${updated.drafts[updated.drafts.length - 1].label}`);
  };

  const handlePromoteToPipeline = async () => {
    if (dirty) {
      toast('Save before promoting', { icon: '⚠️' });
      return;
    }
    setPromoting(true);
    const result = await promoteWritersRoomWorkToPipeline(work.id, {}, { silent: true }).catch((err) => {
      if (mountedRef.current) toast.error(err.message || 'Promote failed');
      return null;
    });
    if (mountedRef.current) setPromoting(false);
    if (!result) return;
    toast.success(result.reused ? 'Opening existing pipeline issue' : 'Pipeline series + issue created');
    // Optimistic update so the menu flips to "Open in pipeline" instantly.
    // The server route returns the full manifest (including the link fields)
    // on the next GET, so a return-visit to this work will also see the link.
    onChange?.({ ...work, pipelineSeriesId: result.series.id, pipelineIssueId: result.issue.id });
    navigate(`/pipeline/issues/${encodeURIComponent(result.issue.id)}/prose`);
  };

  const handleOpenInPipeline = () => {
    if (!work.pipelineIssueId) return;
    navigate(`/pipeline/issues/${encodeURIComponent(work.pipelineIssueId)}/prose`);
  };

  const handleOpenInCreativeDirector = () => {
    if (!work.cdProjectId) return;
    navigate(`/creative-director/${encodeURIComponent(work.cdProjectId)}/overview`);
  };

  const commitTitle = async () => {
    if (title === work.title) return;
    const updated = await updateWritersRoomWork(work.id, { title }, { silent: true }).catch((err) => {
      if (mountedRef.current) toast.error(`Title save failed: ${err.message}`);
      return null;
    });
    if (!updated || !mountedRef.current) return;
    if (updated.title !== title) setTitle(updated.title);
    onChange?.({ ...updated, activeDraftBody: body });
  };

  // useCallback + bodyRef: this is a StoryboardPanel prop, and the panel is
  // memoized — a fresh identity per keystroke would defeat the memo boundary.
  const commitImageStyle = useCallback(async (next) => {
    // Snapshot the buffer BEFORE awaiting: `updated` is this work's manifest, so
    // the body folded back into it must be the one that was on screen when the
    // style was committed. Reading bodyRef after the round-trip would splice a
    // different work's prose in if the user swapped works mid-flight.
    const bodyAtCommit = bodyRef.current;
    const updated = await updateWritersRoomWork(work.id, { imageStyle: next }, { silent: true }).catch((err) => {
      if (mountedRef.current) toast.error(`Style save failed: ${err.message}`);
      return null;
    });
    if (updated && mountedRef.current) {
      onChange?.({ ...updated, activeDraftBody: bodyAtCommit });
      toast.success(next.presetId === 'none' ? 'World style cleared' : 'World style saved');
    }
  }, [work.id, onChange, mountedRef]);

  // Persist the voice exemplars (#2179). Drop rows with a blank passage before
  // sending (the server prunes them too, but this keeps the round-tripped state
  // honest) and clear the drawer's dirty edits into the saved work.
  const saveVoice = async () => {
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
    if (updated) {
      setVoiceExemplars(updated.voiceExemplars || []);
      setVoiceAntiExemplars(updated.voiceAntiExemplars || []);
      onChange?.({ ...updated, activeDraftBody: body });
      toast.success('Voice exemplars saved');
      setDrawer(null);
    }
  };

  // --- Phase 5 live mode ---

  const liveEnabled = liveMode?.enabled === true;
  const liveDebounceMs = Number.isInteger(liveMode?.debounceMs) ? liveMode.debounceMs : 2500;

  // Snapshot the prose window around the caret for the live-suggest call. We
  // send a bounded window (not the whole manuscript) — enough context for the
  // director without shipping a long body on every pause.
  const getCursorContext = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return null;
    const text = bodyRef.current;
    const start = ta.selectionStart ?? text.length;
    const end = ta.selectionEnd ?? start;
    const WINDOW = 4000;
    // Clamp each slice to the server's per-field caps (before/after 12k,
    // selection 8k) so a huge selection can't 400 the request — the schema
    // would reject it and surface as a red toast instead of a graceful notice.
    return {
      before: text.slice(Math.max(0, start - WINDOW), start),
      after: text.slice(end, end + WINDOW),
      selection: text.slice(start, end).slice(0, 8000),
    };
  }, []);

  // Caret offset into the body for the live render preview's scene resolution.
  // Falls back to end-of-body when the textarea isn't mounted (e.g. Read view).
  const getCursorOffset = useCallback(() => {
    const ta = textareaRef.current;
    return ta?.selectionStart ?? bodyRef.current.length;
  }, []);

  // Insert a suggested snippet at the caret (replacing any selection), then
  // restore focus + caret after the inserted text so the writer keeps flowing.
  const insertAtCursor = useCallback((opt) => {
    const ta = textareaRef.current;
    const snippet = opt?.text || '';
    if (!snippet) return;
    const text = bodyRef.current;
    const start = ta?.selectionStart ?? text.length;
    const end = ta?.selectionEnd ?? start;
    // Space-pad so an inserted snippet doesn't weld onto the preceding word.
    const needsLeadingSpace = start > 0 && !/\s$/.test(text.slice(0, start));
    const piece = (needsLeadingSpace ? ' ' : '') + snippet;
    const next = text.slice(0, start) + piece + text.slice(end);
    setBody(next);
    const caret = start + piece.length;
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
    toast('Inserted — save to persist', { icon: '✍️' });
  }, []);

  // Debounce a suggest after the writer pauses typing. Only arms while live
  // mode is on and we're in the edit textarea; cleared on every keystroke and
  // on unmount so a deferred fire can't hit a dead/closed editor.
  const { registerTrigger: registerLiveTrigger, scheduleSuggest: scheduleLiveSuggest } = useLiveSuggest({
    enabled: liveEnabled && viewMode === 'edit',
    debounceMs: liveDebounceMs,
  });

  const toggleLiveMode = useCallback(async () => {
    const nextEnabled = !liveEnabled;
    // Optimistic flip; the PATCH returns the persisted liveMode (with defaults
    // filled in for a first opt-in) which we fold back through onChange.
    setLiveMode((prev) => ({ ...(prev || {}), enabled: nextEnabled }));
    const updated = await updateWritersRoomWork(work.id, { liveMode: { enabled: nextEnabled } }, { silent: true }).catch((err) => {
      if (mountedRef.current) {
        toast.error(`Live mode save failed: ${err.message}`);
        setLiveMode(work.liveMode || null);
      }
      return null;
    });
    if (!updated || !mountedRef.current) return;
    setLiveMode(updated.liveMode || null);
    onChange?.({ ...updated, activeDraftBody: body });
    toast.success(nextEnabled ? 'Live director on' : 'Live director off');
  }, [liveEnabled, work.id, work.liveMode, body, onChange, mountedRef]);

  const commitStatus = async (next) => {
    if (next === status) return;
    setStatus(next);
    const updated = await updateWritersRoomWork(work.id, { status: next }, { silent: true }).catch((err) => {
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
    const updated = await setWritersRoomActiveDraft(work.id, draftId, { silent: true }).catch((err) => {
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
    setRunStartedAt(Date.now());
    const snapshot = await runWritersRoomAnalysis(work.id, { kind }, { silent: true }).catch((err) => {
      if (mountedRef.current) toast.error(`${ANALYSIS_LABELS[kind] || kind} failed: ${err.message}`);
      return null;
    });
    if (!mountedRef.current) {
      setRunningKind(null);
      setRunStartedAt(null);
      return false;
    }
    setRunningKind(null);
    setRunStartedAt(null);
    if (!snapshot) return false;
    if (snapshot.status === 'failed') {
      toast.error(`${ANALYSIS_LABELS[kind] || kind} failed: ${snapshot.error || 'unknown'}`);
      return false;
    }
    toast.success(`${ANALYSIS_LABELS[kind] || kind} complete`);
    if (kind === 'characters' && Array.isArray(snapshot.result?.mergedProfiles)) {
      setCharacters(snapshot.result.mergedProfiles);
    }
    if (kind === 'places' && Array.isArray(snapshot.result?.mergedProfiles)) {
      setPlaces(snapshot.result.mergedProfiles);
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
  // places → script in order so each later step has the earlier bible to
  // reference. Bails on first failure (the failed step's toast already fired).
  const runFullPipeline = useCallback(async () => {
    if (runningKind) return;
    const okChars = await runAnalysis(ANALYSIS_KIND.CHARACTERS);
    if (!okChars || !mountedRef.current) return;
    const okPlaces = await runAnalysis(ANALYSIS_KIND.PLACES);
    if (!okPlaces || !mountedRef.current) return;
    await runAnalysis(ANALYSIS_KIND.SCRIPT);
  }, [runAnalysis, runningKind]);

  const applyFormatText = (text) => {
    setBody(text);
    toast('Applied to editor — save to persist', { icon: '💾' });
  };

  // The Polish loop mutates the SAVED draft body on the server (cuts/revise +
  // keep/revert). After a completed run or a manual revert, pull the fresh body
  // back into the editor as the new saved baseline so the buffer isn't stale.
  const reloadBodyFromServer = useCallback(async () => {
    const fresh = await getWritersRoomWork(work.id).catch(() => null);
    if (!fresh || !mountedRef.current) return;
    const nextBody = fresh.activeDraftBody || '';
    setBody(nextBody);
    setSavedBody(nextBody);
    onChange?.(fresh);
  }, [work.id, onChange, mountedRef]);

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
    onMouseDown: onSplitMouseDown,
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

  const closeOverflowAnd = (fn) => () => { setOverflowOpen(false); fn?.(); };

  // StoryboardPanel is memoized (#3387) — it only skips a re-render while every
  // prop it receives is referentially stable, so its handlers cannot be inline
  // arrows. These four are the ones that used to be recreated per render (and
  // therefore per keystroke); the rest are state setters, refs, or callbacks
  // already keyed on non-typing deps.
  const runAdapt = useCallback(() => runAnalysis(ANALYSIS_KIND.SCRIPT), [runAnalysis]);
  const runCharacters = useCallback(() => runAnalysis(ANALYSIS_KIND.CHARACTERS), [runAnalysis]);
  const runPlaces = useCallback(() => runAnalysis(ANALYSIS_KIND.PLACES), [runAnalysis]);
  const runObjects = useCallback(() => runAnalysis(ANALYSIS_KIND.OBJECTS), [runAnalysis]);

  return (
    <div className="flex flex-col h-full">
      {/*
        Header — one wrapping row on desktop, two compact rows on phones (#3568).
        Under `sm` the status select and view-mode toggle move to a full-width
        sub-bar of their own (`order-last`) so the first row is just title, Save,
        Snapshot and the Work menu; at `sm+` the sub-bar is `display: contents`,
        generating no box, so its children are direct flex items of the header
        row again. DOM order is therefore the desktop order — no `order` classes
        on the controls themselves — which keeps desktop tab order matching what
        is on screen. Every control stays visible at every width; nothing was
        pushed into the overflow menu to buy the space.
      */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-port-border bg-port-card">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
          className="bg-transparent text-base font-semibold text-white border-none focus:outline-none focus:bg-port-bg/50 px-1 rounded flex-1 min-w-[140px] sm:min-w-[180px] min-h-[44px] sm:min-h-0"
          aria-label="Work title"
        />
        {/* Secondary controls. `w-full order-last` gives them their own compact
            row below the primary actions under `sm`; `sm:contents` dissolves the
            wrapper so they sit inline — in this DOM order — on desktop. */}
        <div className="w-full order-last flex items-center gap-2 sm:contents" data-testid="work-header-secondary">
          <select
            value={status}
            onChange={(e) => commitStatus(e.target.value)}
            className="bg-port-bg border border-port-border rounded px-2 py-1 min-h-[44px] sm:min-h-0 text-[11px] text-gray-300"
            aria-label="Status"
          >
            {Object.entries(STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          {/* Not a true tablist (no separate panels keyed off tab id, no roving
              tabindex, no arrow-key cycling). aria-pressed is the semantically
              correct primitive for a toggle group. The text labels collapse to
              icon-only under `sm` to keep this row single-line at ~375px, so
              each button carries an explicit aria-label. */}
          <div className="flex items-center bg-port-bg border border-port-border rounded p-0.5" role="group" aria-label="View mode">
            {VIEW_MODES.map(({ id, label, icon: Icon, title: viewTitle }) => (
              <button
                key={id}
                type="button"
                aria-pressed={viewMode === id}
                aria-label={label}
                onClick={() => setViewMode(id)}
                className={`flex items-center gap-1 px-3 sm:px-2 py-2 sm:py-0.5 min-h-[40px] sm:min-h-0 text-[11px] rounded ${
                  viewMode === id ? 'bg-port-card text-white' : 'text-gray-400 hover:text-gray-200'
                }`}
                title={viewTitle}
              >
                <Icon size={11} /> <span className="hidden sm:inline">{label}</span>
              </button>
            ))}
          </div>
        </div>
        <button
          onClick={handleSave}
          disabled={!dirty || saving}
          className={`flex items-center gap-1 px-3 py-1 min-h-[44px] sm:min-h-0 text-xs rounded ${
            dirty && !saving ? 'bg-port-accent text-white hover:bg-port-accent/80' : 'bg-port-bg text-gray-500'
          }`}
          title={dirty ? 'Save (Ctrl/Cmd+S)' : 'Up to date'}
        >
          <Save size={12} /> {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
        </button>
        <button
          onClick={handleSnapshot}
          disabled={dirty}
          aria-label="Snapshot"
          className="flex items-center gap-1 px-3 py-1 min-h-[44px] sm:min-h-0 text-xs rounded bg-port-bg border border-port-border text-gray-300 hover:text-white disabled:text-gray-600 disabled:cursor-not-allowed"
          title="Snapshot the active draft as a new version"
        >
          <GitCommit size={12} /> <span className="hidden sm:inline">Snapshot</span>
        </button>
        <div className="relative" ref={overflowRef}>
          <button
            onClick={() => setOverflowOpen((v) => !v)}
            className="flex items-center justify-center px-3 sm:px-2 py-1 min-h-[44px] sm:min-h-0 text-xs rounded bg-port-bg border border-port-border text-gray-300 hover:text-white"
            aria-label="Work menu"
            aria-expanded={overflowOpen}
            title="Work menu"
          >
            <MoreHorizontal size={14} />
          </button>
          {overflowOpen && (
            <div className="absolute right-0 top-full mt-1 z-30 w-60 rounded-md border border-port-border bg-port-card shadow-xl py-1 text-xs">
              <MenuSection label="AI">
                <MenuItem icon={Clapperboard} label="Run Adapt (rebuild storyboard)" running={runningKind === ANALYSIS_KIND.SCRIPT} disabled={dirty} title={dirty ? 'Save first' : undefined} onClick={closeOverflowAnd(() => runAnalysis(ANALYSIS_KIND.SCRIPT))} />
                <MenuItem icon={Users} label="Refresh characters" running={runningKind === ANALYSIS_KIND.CHARACTERS} disabled={dirty} title={dirty ? 'Save first' : undefined} onClick={closeOverflowAnd(() => runAnalysis(ANALYSIS_KIND.CHARACTERS))} />
                <MenuItem icon={MapPin} label="Refresh places" running={runningKind === ANALYSIS_KIND.PLACES} disabled={dirty} title={dirty ? 'Save first' : undefined} onClick={closeOverflowAnd(() => runAnalysis(ANALYSIS_KIND.PLACES))} />
                <MenuItem icon={Sparkles} label="Editorial pass" running={runningKind === ANALYSIS_KIND.EVALUATE} disabled={dirty} title={dirty ? 'Save first' : undefined} onClick={closeOverflowAnd(() => runAnalysis(ANALYSIS_KIND.EVALUATE))} />
                <MenuItem icon={FileSignature} label="Format pass" running={runningKind === ANALYSIS_KIND.FORMAT} disabled={dirty} title={dirty ? 'Save first' : undefined} onClick={closeOverflowAnd(() => runAnalysis(ANALYSIS_KIND.FORMAT))} />
                <MenuItem icon={Wand2} label="Polish (cut → revise)" onClick={closeOverflowAnd(() => setDrawer(DRAWER.POLISH))} />
                <MenuItem icon={Quote} label="Voice exemplars" onClick={closeOverflowAnd(() => setDrawer(DRAWER.VOICE))} />
                <MenuItem icon={Zap} label={liveEnabled ? 'Disable live director' : 'Enable live director'} active={liveEnabled} onClick={closeOverflowAnd(toggleLiveMode)} />
              </MenuSection>
              <MenuSection label="Open">
                <MenuItem icon={Clock} label="Versions" onClick={closeOverflowAnd(() => setDrawer(DRAWER.VERSIONS))} />
                <MenuItem icon={History} label="Analysis history" onClick={closeOverflowAnd(() => setDrawer(DRAWER.HISTORY))} />
                {work.pipelineSeriesId ? (
                  <MenuItem icon={ExternalLink} label="Open in pipeline" onClick={closeOverflowAnd(handleOpenInPipeline)} />
                ) : (
                  <MenuItem icon={Film} label={promoting ? 'Promoting…' : 'Promote to pipeline'} running={promoting} onClick={closeOverflowAnd(handlePromoteToPipeline)} />
                )}
                {work.cdProjectId && (
                  <MenuItem icon={ExternalLink} label="Open in Creative Director" onClick={closeOverflowAnd(handleOpenInCreativeDirector)} />
                )}
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

      {runningKind && (
        <AnalysisRunBanner
          kind={runningKind}
          label={ANALYSIS_LABELS[runningKind] || runningKind}
          startedAt={runStartedAt}
        />
      )}

      {/* Mobile-only Writing/Storyboard toggle — desktop renders both side-by-side.
          Review mode is a full-width surface with no storyboard sidebar, so the
          toggle is irrelevant there. */}
      {viewMode !== 'review' && (
        <div className="lg:hidden flex border-b border-port-border bg-port-bg/40 shrink-0">
          <MobileTab active={mobileTab === MOBILE_TAB.WRITING} onClick={() => setMobileTab(MOBILE_TAB.WRITING)} icon={PenLine} label="Writing" />
          <MobileTab active={mobileTab === MOBILE_TAB.STORYBOARD} onClick={() => setMobileTab(MOBILE_TAB.STORYBOARD)} icon={Clapperboard} label="Storyboard" />
        </div>
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
        <div className={`relative min-h-0 flex-1 ${viewMode !== 'review' && mobileTab === MOBILE_TAB.STORYBOARD ? 'hidden lg:block' : 'block'}`}>
          {viewMode === 'review' ? (
            <SyncedReview work={work} />
          ) : viewMode === 'read' ? (
            <div ref={readerRef} className="w-full h-full">
              <ProseReader
                body={body}
                scenes={latestScenes}
                characters={characters}
                places={places}
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
            <ProseEditor
              ref={textareaRef}
              value={body}
              onChange={(e) => { setBody(e.target.value); scheduleLiveSuggest(); }}
              readingTheme={readingTheme}
              className="w-full h-full resize-none px-6 py-6 text-base focus:outline-none"
            />
          )}
          {viewMode !== 'review' && (
            <div
              className={`absolute bottom-2 right-3 flex items-center gap-3 text-[11px] px-2 py-1 rounded pointer-events-none ${
                readingTheme === 'light' ? 'text-gray-700 bg-[var(--wr-reading-paper)]/85' : 'text-gray-500 bg-port-bg/80'
              }`}
            >
              <span>{wordCount.toLocaleString()} words</span>
              {dirty && <span className="text-port-warning">● unsaved</span>}
            </div>
          )}
        </div>

        {/* Review mode is a full-width synced surface — no storyboard sidebar. */}
        {viewMode !== 'review' && (
        <div
          onMouseDown={onSplitMouseDown}
          onDoubleClick={resetSidebarWidth}
          role="separator"
          aria-label="Resize storyboard sidebar"
          aria-orientation="vertical"
          title="Drag to resize · double-click to reset"
          className="hidden lg:block w-1 shrink-0 cursor-col-resize bg-port-border hover:bg-port-accent/60 active:bg-port-accent transition-colors"
        />
        )}

        {viewMode !== 'review' && (
        <aside
          style={{ '--sidebar-w': `${sidebarWidth}px` }}
          className={`border-t lg:border-t-0 border-port-border bg-port-card/60 flex flex-col text-xs min-h-0 w-full flex-1 lg:flex-initial lg:w-[var(--sidebar-w)] lg:shrink-0 ${
            mobileTab === MOBILE_TAB.WRITING ? 'hidden lg:flex' : 'flex'
          }`}
        >
          {liveEnabled && viewMode === 'edit' && (
            <>
              <LiveRenderPanel
                workId={work.id}
                liveMode={liveMode}
                getCursorOffset={getCursorOffset}
                body={body}
                renderContext={liveRenderContext}
                registerQueue={queueRegister}
                onSceneImageAttached={handleSceneImageAttached}
                workTitle={work.title}
              />
              <div className="shrink-0 max-h-[40%] min-h-0 border-b border-port-border overflow-hidden flex flex-col">
                <LiveContinuationPanel
                  workId={work.id}
                  liveMode={liveMode}
                  usage={liveUsage}
                  onUsageChange={setLiveUsage}
                  getCursorContext={getCursorContext}
                  onInsert={insertAtCursor}
                  registerTrigger={registerLiveTrigger}
                />
              </div>
              <CdBridgePanel
                workId={work.id}
                liveMode={liveMode}
                usage={liveUsage}
                onUsageChange={setLiveUsage}
                getCursorContext={getCursorContext}
                onLinked={(cdProjectId) => onChange?.({ ...work, cdProjectId })}
              />
            </>
          )}
          <StoryboardPanel
            work={work}
            characters={characters}
            places={places}
            objects={objects}
            onCharactersChange={setCharacters}
            onPlacesChange={setPlaces}
            onObjectsChange={setObjects}
            onRunObjects={runObjects}
            onScenesChange={setLatestScenes}
            onLiveRenderContextChange={setLiveRenderContext}
            registerSceneImageMerge={registerSceneImageMerge}
            onJumpToScene={jumpToScene}
            onDebug={handleDebug}
            onRunAdapt={runAdapt}
            onRunCharacters={runCharacters}
            onRunPlaces={runPlaces}
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
            dirty={dirty}
          />
        </aside>
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

      <Drawer open={drawer === DRAWER.VERSIONS} onClose={() => setDrawer(null)} title="Versions">
        <WorkEditorVersions work={work} dirty={dirty} onSwitch={(id) => { switchToDraft(id); setDrawer(null); }} />
      </Drawer>
      <Drawer open={drawer === DRAWER.HISTORY} onClose={() => setDrawer(null)} title="Analysis history">
        <AnalysisHistory work={work} activeHash={activeHash} onApplyFormat={applyFormatText} />
      </Drawer>
      <Drawer open={drawer === DRAWER.POLISH} onClose={() => setDrawer(null)} title="Polish" size="md">
        <PolishPanel work={work} dirty={dirty} onBodyChanged={reloadBodyFromServer} />
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

function MenuSection({ label, children }) {
  return (
    <div className="py-1 border-b border-port-border last:border-b-0">
      <div className="px-3 pt-1 pb-0.5 text-[9px] uppercase tracking-wider text-gray-500">{label}</div>
      {children}
    </div>
  );
}

function MenuItem({ icon: Icon, label, onClick, running = false, active = false, badge = null, disabled = false, title }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={running || disabled}
      title={title}
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

// In-progress banner for a writers-room analysis run. Renders a persistent
// status strip with elapsed time and reassurance text that escalates as the
// run drags on — so long Opus-on-prose runs (which can legitimately take
// 10+ minutes) don't look like the UI has gone silent.
function AnalysisRunBanner({ kind, label, startedAt }) {
  const [elapsed, setElapsed] = useState(() => (startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0));
  useEffect(() => {
    if (!startedAt) return undefined;
    setElapsed(Math.floor((Date.now() - startedAt) / 1000));
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
      <span className="font-semibold shrink-0">{label}</span>
      <span className="tabular-nums text-gray-300 shrink-0" aria-label="elapsed time">{timeStr}</span>
      <span className="truncate text-gray-400">{reassurance}</span>
    </div>
  );
}

function MobileTab({ active, onClick, icon: Icon, label }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 flex items-center justify-center gap-1.5 py-2 min-h-[44px] text-[12px] border-b-2 ${
        active ? 'border-port-accent text-white' : 'border-transparent text-gray-500 hover:text-gray-300'
      }`}
    >
      <Icon size={13} /> {label}
    </button>
  );
}
