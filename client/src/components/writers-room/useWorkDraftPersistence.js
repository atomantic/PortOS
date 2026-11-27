import { useCallback, useEffect, useRef, useState } from 'react';
import useMounted from '../../hooks/useMounted';
import useUnsavedChangesGuard from '../../hooks/useUnsavedChangesGuard';
import { getWritersRoomWork, saveWritersRoomDraft, setWritersRoomActiveDraft, snapshotWritersRoomDraft, updateWritersRoomWork } from '../../services/apiWritersRoom';
import toast from '../ui/Toast';

export default function useWorkDraftPersistence({ work, onChange, exercisePending, beginDraftMutation, endDraftMutation }) {
  const [body, setBody] = useState(work.activeDraftBody || '');
  const [title, setTitle] = useState(work.title);
  // Optimistic mirror of work.status so the dropdown changes show immediately
  // before the PATCH round-trip resolves. Re-synced from the prop when it changes.
  const [status, setStatus] = useState(work.status);
  const [savedBody, setSavedBody] = useState(work.activeDraftBody || '');
  const [saving, setSaving] = useState(false);
  const [switchingDraft, setSwitchingDraft] = useState(false);
  const [polishBusy, setPolishBusy] = useState(false);
  const draftTransitionRef = useRef(false);

  // Rehydrate body/title when the parent swaps the active work OR switches to
  // a different draft version of the same work.
  const prevKey = useRef({ id: work.id, draftId: work.activeDraftVersionId });
  const dirty = body !== savedBody;
  useEffect(() => {
    const key = { id: work.id, draftId: work.activeDraftVersionId };
    const hasNewCleanBody = work.activeDraftBody !== savedBody && !dirty;
    if (prevKey.current.id === key.id && prevKey.current.draftId === key.draftId && !hasNewCleanBody) return;
    prevKey.current = key;
    setBody(work.activeDraftBody || '');
    setSavedBody(work.activeDraftBody || '');
    setTitle(work.title);
  }, [work.id, work.activeDraftVersionId, work.activeDraftBody, work.title, savedBody, dirty]);

  useEffect(() => { setStatus(work.status); }, [work.id, work.activeDraftVersionId, work.status]);
  useEffect(() => { setTitle(work.title); }, [work.id, work.activeDraftVersionId, work.title]);

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
  // Same idea for the saved baseline and the work/draft identity: async
  // completions (Format pass, Polish refresh) compare against these at
  // resolution time instead of the values closed over when they started (#9738).
  const savedBodyRef = useRef(savedBody);
  savedBodyRef.current = savedBody;
  const ownerKey = `${work.id}:${work.activeDraftVersionId || ''}`;
  const ownerKeyRef = useRef(ownerKey);
  ownerKeyRef.current = ownerKey;

  const mountedRef = useMounted();

  // savingRef gates parallel saves synchronously — `saving` state lags React
  // re-renders, so rapid Cmd+S key-repeats can slip past it otherwise.
  const savingRef = useRef(false);
  const handleSaveRef = useRef(null);
  handleSaveRef.current = async () => {
    if (savingRef.current || draftTransitionRef.current || polishBusy || exercisePending) return;
    const startOwner = ownerKeyRef.current;
    const transaction = beginDraftMutation?.(startOwner, 'save');
    if (beginDraftMutation && !transaction) return;
    savingRef.current = true;
    setSaving(true);
    const updated = await saveWritersRoomDraft(work.id, body, { silent: true }).catch((err) => {
      if (mountedRef.current) toast.error(`Save failed: ${err.message}`);
      return null;
    });
    endDraftMutation?.(transaction);
    savingRef.current = false;
    if (!mountedRef.current) return;
    setSaving(false);
    if (!updated || ownerKeyRef.current !== startOwner) return;
    setSavedBody(body);
    onChange?.(updated);
    toast.success('Saved');
  };
  const handleSave = useCallback(() => handleSaveRef.current?.(), []);

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

  // Guard unsaved draft edits at BOTH exit doors (#3958/#3995) — tab
  // close/reload, and any in-app navigation (sidebar link, ⌘K, voice
  // `ui_navigate`, browser Back) — otherwise the body reset in the effect above
  // silently discards them. The confirm renders below the header banners.
  const routeGuard = useUnsavedChangesGuard(dirty || switchingDraft || exercisePending);
  const { proceed: proceedExit } = routeGuard;
  const discardAndExit = useCallback(() => {
    setBody(savedBody);
    proceedExit();
  }, [proceedExit, savedBody]);


  const handleSnapshot = async (runningKind) => {
    if (savingRef.current || draftTransitionRef.current || polishBusy || runningKind || exercisePending) return;
    if (dirty) {
      toast('Save before snapshotting', { icon: '⚠️' });
      return;
    }
    const startOwner = ownerKeyRef.current;
    const transaction = beginDraftMutation?.(startOwner, 'version');
    if (beginDraftMutation && !transaction) return;
    draftTransitionRef.current = true;
    setSwitchingDraft(true);
    const updated = await snapshotWritersRoomDraft(work.id, undefined, { silent: true }).catch((err) => {
      if (mountedRef.current) toast.error(`Snapshot failed: ${err.message}`);
      return null;
    });
    endDraftMutation?.(transaction);
    draftTransitionRef.current = false;
    if (!mountedRef.current) return;
    setSwitchingDraft(false);
    if (!updated || ownerKeyRef.current !== startOwner) return;
    onChange?.({ ...updated, activeDraftBody: body });
    toast.success(`Created ${updated.drafts[updated.drafts.length - 1].label}`);
  };

  const publishMetadata = useCallback((updated, fields, startOwner) => {
    if (!updated || !mountedRef.current || ownerKeyRef.current !== startOwner) return false;
    onChange?.(updated, { fields, ownerKey: startOwner });
    return true;
  }, [onChange, mountedRef]);

  const commitTitle = async () => {
    if (title === work.title) return;
    const startOwner = ownerKeyRef.current;
    const updated = await updateWritersRoomWork(work.id, { title }, { silent: true }).catch((err) => {
      if (mountedRef.current) toast.error(`Title save failed: ${err.message}`);
      return null;
    });
    if (!publishMetadata(updated, ['title'], startOwner)) return;
    if (updated.title !== title) setTitle(updated.title);
  };

  // useCallback + bodyRef: this is a StoryboardPanel prop, and the panel is
  // memoized — a fresh identity per keystroke would defeat the memo boundary.
  const commitImageStyle = useCallback(async (next) => {
    const startOwner = ownerKeyRef.current;
    const updated = await updateWritersRoomWork(work.id, { imageStyle: next }, { silent: true }).catch((err) => {
      if (mountedRef.current) toast.error(`Style save failed: ${err.message}`);
      return null;
    });
    if (publishMetadata(updated, ['imageStyle'], startOwner)) {
      toast.success(next.presetId === 'none' ? 'World style cleared' : 'World style saved');
    }
  }, [work.id, publishMetadata, mountedRef]);

  const commitStatus = async (next) => {
    if (next === status) return;
    const startOwner = ownerKeyRef.current;
    setStatus(next);
    const updated = await updateWritersRoomWork(work.id, { status: next }, { silent: true }).catch((err) => {
      if (mountedRef.current && ownerKeyRef.current === startOwner) {
        toast.error(`Status save failed: ${err.message}`);
        setStatus(work.status);
      }
      return null;
    });
    if (publishMetadata(updated, ['status'], startOwner)) setStatus(updated.status);
  };

  const switchToDraft = async (draftId, runningKind) => {
    if (draftId === work.activeDraftVersionId || draftTransitionRef.current || savingRef.current || polishBusy || runningKind || exercisePending) return;
    if (dirty) {
      toast('Save or snapshot before switching versions', { icon: '⚠️' });
      return;
    }
    const startOwner = ownerKeyRef.current;
    const transaction = beginDraftMutation?.(startOwner, 'version');
    if (beginDraftMutation && !transaction) return;
    draftTransitionRef.current = true;
    setSwitchingDraft(true);
    const updated = await setWritersRoomActiveDraft(work.id, draftId, { silent: true }).catch((err) => {
      if (mountedRef.current) toast.error(`Switch failed: ${err.message}`);
      return null;
    });
    endDraftMutation?.(transaction);
    draftTransitionRef.current = false;
    if (!mountedRef.current) return;
    setSwitchingDraft(false);
    if (!updated || ownerKeyRef.current !== startOwner) return;
    onChange?.(updated);
    return true;
  };


  const applyFormatText = (text) => {
    if (draftTransitionRef.current || savingRef.current || exercisePending) return;
    setBody(text);
    toast('Applied to editor — save to persist', { icon: '💾' });
  };

  // The Polish loop mutates the SAVED draft body on the server (cuts/revise +
  // keep/revert). After a completed run or a manual revert, pull the fresh body
  // back into the editor as the new saved baseline so the buffer isn't stale.
  const reloadBodyFromServer = useCallback(async () => {
    if (draftTransitionRef.current || exercisePending) return;
    const startOwner = ownerKeyRef.current;
    const startBody = bodyRef.current;
    const wasDirty = startBody !== savedBodyRef.current;
    const fresh = await getWritersRoomWork(work.id).catch(() => null);
    if (!fresh || !mountedRef.current || ownerKeyRef.current !== startOwner || draftTransitionRef.current) return;
    const nextBody = fresh.activeDraftBody || '';
    // Adopt the server body as the saved baseline always; replace the buffer
    // only when the writer had nothing unsaved and typed nothing during the GET.
    // Otherwise the local draft stays and the dirty indicator reflects the diff.
    if (!wasDirty && bodyRef.current === startBody) setBody(nextBody);
    setSavedBody(nextBody);
    onChange?.(fresh);
  }, [work.id, onChange, mountedRef, exercisePending]);

  return {
    body, setBody, title, setTitle, status, dirty, saving, switchingDraft, polishBusy, setPolishBusy,
    bodyRef, savedBodyRef, ownerKeyRef, mountedRef, savingRef, draftTransitionRef,
    handleSave, handleSnapshot, commitTitle, commitImageStyle, commitStatus, switchToDraft,
    publishMetadata, applyFormatText, reloadBodyFromServer, routeGuard, discardAndExit,
  };
}
