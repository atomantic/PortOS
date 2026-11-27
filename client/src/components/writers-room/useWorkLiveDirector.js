import { useCallback, useEffect, useRef, useState } from 'react';
import { updateWritersRoomWork } from '../../services/apiWritersRoom';
import toast from '../ui/Toast';
import useLiveSuggest from './useLiveSuggest';

export default function useWorkLiveDirector({
  work, viewMode, bodyRef, textareaRef, setBody, switchingDraft, exercisePending, draftTransitionRef,
  ownerKeyRef, mountedRef, publishMetadata,
}) {
  // Phase 5 live mode — opt-in, per-work Creative Director continuation
  // suggestions. Optimistic mirror of work.liveMode so the toggle flips
  // instantly; re-synced from the prop. The panel's imperative suggest fn and
  // the post-typing debounce live in useLiveSuggest (below).
  const [liveMode, setLiveMode] = useState(work.liveMode || null);
  useEffect(() => { setLiveMode(work.liveMode || null); }, [work.id, work.activeDraftVersionId, work.liveMode]);
  // Shared live text-suggest usage counter. The continuation panel and the CD
  // bridge BOTH draw on the same server-side daily budget, so a single mirror
  // lives here (not one per panel) — otherwise the panel that didn't make the
  // most recent call shows a stale "N left today" readout until its own next
  // call. Seeded from / re-synced to liveMode.usage (parent-driven changes:
  // work swap, budget edit, toggle); updated by whichever panel suggests. The
  // render-preview budget is a distinct counter owned by LiveRenderPanel.
  const [liveUsage, setLiveUsage] = useState(liveMode?.usage || null);
  useEffect(() => { setLiveUsage(liveMode?.usage || null); }, [liveMode?.usage]);

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

  const liveEnabled = liveMode?.enabled === true;
  const showLiveDirector = liveEnabled && viewMode === 'edit';
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
  }, [bodyRef, textareaRef]);

  // Caret offset into the body for the live render preview's scene resolution.
  // Falls back to end-of-body when the textarea isn't mounted (e.g. Read view).
  const getCursorOffset = useCallback(() => {
    const ta = textareaRef.current;
    return ta?.selectionStart ?? bodyRef.current.length;
  }, [bodyRef, textareaRef]);

  // Insert a suggested snippet at the caret (replacing any selection), then
  // restore focus + caret after the inserted text so the writer keeps flowing.
  const insertAtCursor = useCallback((opt) => {
    const ta = textareaRef.current;
    if (draftTransitionRef.current || exercisePending) return;
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
  }, [bodyRef, textareaRef, draftTransitionRef, exercisePending, setBody]);

  // Debounce a suggest after the writer pauses typing. Only arms while live
  // mode is on and we're in the edit textarea; cleared on every keystroke and
  // on unmount so a deferred fire can't hit a dead/closed editor.
  const { registerTrigger: registerLiveTrigger, scheduleSuggest: scheduleLiveSuggest } = useLiveSuggest({
    enabled: showLiveDirector && !switchingDraft && !exercisePending,
    debounceMs: liveDebounceMs,
  });

  const toggleLiveMode = useCallback(async () => {
    const startOwner = ownerKeyRef.current;
    const nextEnabled = !liveEnabled;
    // Optimistic flip; the PATCH returns the persisted liveMode (with defaults
    // filled in for a first opt-in) which we fold back through onChange.
    setLiveMode((prev) => ({ ...(prev || {}), enabled: nextEnabled }));
    const updated = await updateWritersRoomWork(work.id, { liveMode: { enabled: nextEnabled } }, { silent: true }).catch((err) => {
      if (mountedRef.current && ownerKeyRef.current === startOwner) {
        toast.error(`Live mode save failed: ${err.message}`);
        setLiveMode(work.liveMode || null);
      }
      return null;
    });
    if (!publishMetadata(updated, ['liveMode'], startOwner)) return;
    setLiveMode(updated.liveMode || null);
    toast.success(nextEnabled ? 'Live director on' : 'Live director off');
  }, [liveEnabled, work.id, work.liveMode, publishMetadata, mountedRef, ownerKeyRef]);

  return {
    liveEnabled, toggleLiveMode, scheduleLiveSuggest, showLiveDirector,
    liveMode, liveUsage, setLiveUsage, getCursorContext, getCursorOffset, insertAtCursor, registerLiveTrigger,
    liveRenderContext, setLiveRenderContext, registerSceneImageMerge, handleSceneImageAttached,
  };
}
