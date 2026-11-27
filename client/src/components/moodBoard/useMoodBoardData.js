import { useCallback, useEffect, useRef, useState } from 'react';
import toast from '../ui/Toast';
import useMounted from '../../hooks/useMounted';
import { moodBoardAnalysisFromResult, isMoodBoardItemAnalyzed } from '../../lib/moodBoardAnalysis';
import {
  getMoodBoard,
  updateMoodBoard,
  updateMoodBoardItem,
  removeMoodBoardItem,
  localizeMoodBoardMedia,
  renderMoodBoardItem,
  extractMoodBoardItemFrames,
  extractMoodBoardItemFramesAt,
} from '../../services/apiMoodBoard.js';
import socket from '../../services/socket';

export default function useMoodBoardData(id) {
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(true);
  // Only a 404 means the board is gone; any other failed read keeps a Retry.
  const [loadError, setLoadError] = useState(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [savingMeta, setSavingMeta] = useState(false);
  const [extractingItemId, setExtractingItemId] = useState(null);

  // Text note → image render (#10531): the note whose request is in flight.
  // The queued state itself lives on the item (`item.render`).
  const [renderingItemId, setRenderingItemId] = useState(null);
  // The request already toasts its own refusal; the echoed socket event must not.
  const renderRequestRef = useRef(null);
  // The keyed editor isolates board state. Also guard async continuations and
  // delayed child callbacks so the old editor cannot toast or start a mutation
  // after navigation. The load sequence drops StrictMode's duplicate GET.
  const mountedRef = useMounted();
  const loadSeqRef = useRef(0);
  const boardLoadedRef = useRef(false);
  const loadInFlightRef = useRef(false);
  const loadPromiseRef = useRef(null);

  const readBoard = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    loadInFlightRef.current = true;
    setLoading(true);
    let error = null;
    const data = await getMoodBoard(id, { silent: true }).catch((err) => { error = err; return null; });
    // Drop stale (a newer load started) or unmounted resolutions before any
    // setState / toast so an out-of-order response can't overwrite current state.
    if (!mountedRef.current || seq !== loadSeqRef.current) return;
    setLoadError(error && error.status !== 404 ? error : null);
    if (data) {
      boardLoadedRef.current = true;
      setBoard(data);
      setName(data.name || '');
      setDescription(data.description || '');
      // Boards never serve remote URLs: re-host any external pins in the
      // background, then swap the localized board in.
      if ((data.items || []).some((it) => /^https?:\/\//i.test(it?.imageUrl || ''))) {
        localizeMoodBoardMedia(id, { silent: true }).then((res) => {
          if (!mountedRef.current || seq !== loadSeqRef.current || !res?.board) return;
          if (res.localized > 0) {
            setBoard(res.board);
            toast.success(`Imported ${res.localized} external image${res.localized === 1 ? '' : 's'} into the gallery`);
          }
          if (res.failed > 0) toast.error(`${res.failed} external image${res.failed === 1 ? '' : 's'} could not be downloaded`);
        }).catch(() => {});
      }
    } else {
      setBoard(null);
      if (!error || error.status === 404) toast.error('Mood board not found');
    }
    loadInFlightRef.current = false;
    setLoading(false);
  }, [id]);
  const load = useCallback(() => {
    loadPromiseRef.current = readBoard();
    return loadPromiseRef.current;
  }, [readBoard]);

  useEffect(() => { load(); }, [load]);

  // A note render was queued, finished or failed — possibly started by
  // autopilot or another tab — so swap in the board's current items.
  useEffect(() => {
    // A refetch still in flight when this effect is disposed must not write
    // its board's items into whatever board the page shows next.
    let active = true;
    let sequence = 0;
    const onRender = async (evt) => {
      if (evt?.boardId !== id) return;
      let reported = false;
      const reportRenderFailure = () => {
        if (reported) return;
        reported = true;
        if (evt.itemId && evt.status === 'failed' && evt.error && renderRequestRef.current !== evt.itemId) toast.error(`Render failed: ${evt.error}`);
      };
      // With no board loaded yet (first read failed or still pending) only a
      // full load also seeds the name/description fields. A pending read may
      // have captured the board before this event, so let it finish and then
      // refresh the items it returned.
      if (!boardLoadedRef.current) {
        reportRenderFailure();
        if (!loadInFlightRef.current) {
          load();
          return;
        }
        await loadPromiseRef.current;
        if (!active || !boardLoadedRef.current) return;
      }
      const current = ++sequence;
      const fresh = await getMoodBoard(id, { silent: true }).catch(() => null);
      if (!active || current !== sequence || !mountedRef.current || !fresh) return;
      setBoard((prev) => (prev ? { ...prev, items: fresh.items, updatedAt: fresh.updatedAt } : prev));
      reportRenderFailure();
    };
    socket.on('mood-board:item-render', onRender);
    socket.on('mood-board:generate', onRender);
    const onReconnect = () => onRender({ boardId: id });
    socket.on('connect', onReconnect);
    return () => {
      active = false;
      socket.off('mood-board:item-render', onRender);
      socket.off('mood-board:generate', onRender);
      socket.off('connect', onReconnect);
    };
  }, [id, load, mountedRef]);

  const nameDirty = Boolean(board) && name.trim() !== (board.name || '');
  const descriptionDirty = Boolean(board) && description !== (board.description || '');
  const metaDirty = nameDirty || descriptionDirty;
  const handleSaveMeta = async () => {
    if (!mountedRef.current) return;
    if (!name.trim()) { toast.error('Board name is required'); return; }
    setSavingMeta(true);
    const updated = await updateMoodBoard(id, { name: name.trim(), description }, { silent: true }).catch(() => null);
    if (!mountedRef.current) return;
    setSavingMeta(false);
    if (!updated) { toast.error('Failed to save board'); return; }
    setBoard(updated);
    toast.success('Board saved');
  };

  const handleUpdateItemText = async (item, nextText) => {
    if (!mountedRef.current) return;
    const isAnalyzed = isMoodBoardItemAnalyzed(item);
    const patch = {};
    if (isAnalyzed) {
      patch.analysis = { ...item.analysis, prompt: nextText || '' };
      patch.prompt = nextText || null;
      if (!item.caption || item.caption.trim() === (item.analysis?.prompt || '').trim()) {
        patch.caption = nextText ? nextText.slice(0, 2000) : null;
      }
    } else if (item.prompt) {
      patch.prompt = nextText || null;
      if (!item.caption || item.caption.trim() === item.prompt.trim()) {
        patch.caption = nextText ? nextText.slice(0, 2000) : null;
      }
    } else {
      patch.caption = nextText || null;
    }
    const updated = await updateMoodBoardItem(id, item.id, patch, { silent: true }).catch(() => null);
    if (!mountedRef.current) return;
    if (!updated) { toast.error('Failed to update'); return; }
    setBoard((prev) => (prev
      ? { ...prev, items: (prev.items || []).map((it) => (it.id === item.id ? updated : it)) }
      : prev));
  };

  // Persist a prompt-from-media run onto the item (#4188 Phase 3). The
  // analyzer can return an image and/or a video prompt; store the one that
  // matches the item's own type, falling back to whichever was generated.
  const persistAnalysis = async (item, result) => {
    if (!mountedRef.current) return;
    const analysis = moodBoardAnalysisFromResult(item, result);
    if (!analysis) return;
    // The caption mirrors the prompt: fill it when empty or when it still holds
    // the previous analysis prompt, but never overwrite a caption the user wrote.
    const prevCaption = (item.caption || '').trim();
    const captionFollows = !prevCaption || prevCaption === (item.analysis?.prompt || '').trim();
    const patch = captionFollows ? { analysis, caption: analysis.prompt.slice(0, 2000) } : { analysis };
    const updated = await updateMoodBoardItem(id, item.id, patch, { silent: true }).catch(() => null);
    if (!mountedRef.current) return;
    if (!updated) { toast.error('Analysis ran but could not be saved to the item'); return; }
    setBoard((prev) => (prev
      ? { ...prev, items: (prev.items || []).map((it) => (it.id === item.id ? updated : it)) }
      : prev));
    toast.success('Analysis saved to item');
  };

  const handleClearAnalysis = async (itemId) => {
    if (!mountedRef.current) return;
    const updated = await updateMoodBoardItem(id, itemId, { analysis: null }, { silent: true }).catch(() => null);
    if (!mountedRef.current) return;
    if (!updated) { toast.error('Failed to remove analysis'); return; }
    setBoard((prev) => (prev
      ? { ...prev, items: (prev.items || []).map((it) => (it.id === itemId ? updated : it)) }
      : prev));
    return true;
  };

  const handleExtractFrames = async (itemId, frameCount) => {
    if (!mountedRef.current) return;
    setExtractingItemId(itemId);
    const res = await extractMoodBoardItemFrames(id, itemId, frameCount, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Could not extract frames'); return null; });
    if (!mountedRef.current) return;
    setExtractingItemId(null);
    if (!res?.board) return;
    setBoard(res.board);
    toast.success(res.added ? `Added ${res.added} frame${res.added === 1 ? '' : 's'} to the board` : 'Those frames are already on the board');
  };

  const handleAddPickedFrames = async (itemId, times) => {
    if (!mountedRef.current || !times.length) return;
    setExtractingItemId(itemId);
    const res = await extractMoodBoardItemFramesAt(id, itemId, times, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Could not add those frames'); return null; });
    if (!mountedRef.current) return;
    setExtractingItemId(null);
    if (!res?.board) return;
    setBoard(res.board);
    toast.success(res.added ? `Added ${res.added} frame${res.added === 1 ? '' : 's'} to the board` : 'Those frames are already on the board');
    return true;
  };

  const handleRenderItem = async (itemId) => {
    if (!mountedRef.current) return;
    setRenderingItemId(itemId);
    renderRequestRef.current = itemId;
    const res = await renderMoodBoardItem(id, itemId, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Could not render this note'); return null; });
    renderRequestRef.current = null;
    if (!mountedRef.current) return;
    setRenderingItemId(null);
    if (!res?.item) return;
    setBoard((prev) => (prev
      ? { ...prev, items: (prev.items || []).map((it) => (it.id === itemId && it.type === 'text' ? res.item : it)) }
      : prev));
  };

  const handleRemoveItem = async (itemId) => {
    if (!mountedRef.current) return;
    const updated = await removeMoodBoardItem(id, itemId, { silent: true }).catch(() => null);
    if (!mountedRef.current) return;
    if (!updated) { toast.error('Failed to remove item'); return; }
    setBoard((prev) => (prev ? { ...prev, items: (prev.items || []).filter((it) => it.id !== itemId) } : prev));
  };

  return {
    board, setBoard, loading, loadError, load,
    name, setName, description, setDescription, nameDirty, descriptionDirty, metaDirty, savingMeta,
    extractingItemId, renderingItemId,
    handleSaveMeta, handleUpdateItemText, persistAnalysis, handleClearAnalysis,
    handleExtractFrames, handleAddPickedFrames, handleRenderItem, handleRemoveItem,
  };
}
