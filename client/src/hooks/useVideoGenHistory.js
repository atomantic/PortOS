/**
 * VideoGen render history: the newest-records load, gallery filters, preview route, and the delete/hide/trim/upscale handlers.
 *
 * Use when: The /media/video page's history column. `historyLoad` is a sentinel ('loading',
 * 'loaded', 'error'), never inferred from `history.length`, because an empty loaded history is
 * a real state the Remix handoff must tell apart from a failed or in-flight read.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { mediaDeleteOutcome } from '../lib/mediaDeleteOutcome';
import { normalizeVideo } from '../components/media/normalize';
import toast from '../components/ui/Toast';
import { cancelVideoPendingDelete, deleteVideoHistoryItem, listVideoHistory } from '../services/apiImageVideo.js';
import { useMediaCompletionRefresh } from './useMediaCompletionRefresh';
import { useMediaAnnotations } from './useMediaAnnotations';
import { refreshMediaUsages } from './useMediaUsages';
import { useMediaHideToggle } from './useMediaHideToggle';
import usePreviewRoute from './usePreviewRoute';
import usePendingDeletePeerNames from './usePendingDeletePeerNames';

// The gallery shows the newest records; older ones are reached by id (Remix) or Media History.
const HISTORY_PAGE_LIMIT = 200;

export function useVideoGenHistory() {
  const [history, setHistory] = useState([]);
  const [showHidden, setShowHidden] = useState(false);

  // 'loading' until the first fetch settles, then 'loaded' or 'error'.
  //
  // The mount fetch and the completion refresh share this one sentinel, so the
  // Remix handoff also needs to know whether ANOTHER fetch is still running before it
  // trusts an 'error': a transient failure on a background refresh must not
  // strand a handoff that the in-flight mount fetch is about to satisfy. The
  // count is a ref because only the effects read it, and they run after commit.
  const [historyLoad, setHistoryLoad] = useState('loading');
  const historyInFlightRef = useRef(0);
  // `silent` — this page owns the failure UI (the Remix banner, and the
  // gallery simply staying empty), so the shared toast would double it.
  const refreshHistory = useCallback(() => {
    historyInFlightRef.current += 1;
    return listVideoHistory({ silent: true, query: { limit: HISTORY_PAGE_LIMIT } })
      .then((items) => {
        setHistory(Array.isArray(items) ? items : []);
        setHistoryLoad('loaded');
      })
      .catch(() => setHistoryLoad('error'))
      .finally(() => { historyInFlightRef.current -= 1; });
  }, []);
  useMediaCompletionRefresh({ onVideoCompleted: refreshHistory });
  useEffect(() => { refreshHistory(); }, [refreshHistory]);

  const { visibleHistory, hiddenHistory } = useMemo(() => ({
    visibleHistory: history.filter((v) => !v.hidden),
    hiddenHistory: history.filter((v) => v.hidden),
  }), [history]);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const { annotations, updateAnnotation, getCardProps } = useMediaAnnotations();
  // Gallery sections respect the favorites filter; the extend-mode dropdown
  // (which reads visibleHistory directly) intentionally does not, since
  // hiding non-favorites from the "pick a previous video" picker would
  // surprise the user.
  const { galleryVisible, galleryHidden } = useMemo(() => {
    if (!favoritesOnly) return { galleryVisible: visibleHistory, galleryHidden: hiddenHistory };
    // Normalize to derive the canonical item.key rather than hand-building
    // `video:${v.id}` — the kind/ref convention lives in normalize.js.
    const isStarred = (v) => !!annotations[normalizeVideo(v).key]?.starred;
    return { galleryVisible: visibleHistory.filter(isStarred), galleryHidden: hiddenHistory.filter(isStarred) };
  }, [visibleHistory, hiddenHistory, favoritesOnly, annotations]);
  const galleryVisibleItems = useMemo(() => galleryVisible.map(normalizeVideo), [galleryVisible]);
  const galleryHiddenItems = useMemo(() => galleryHidden.map(normalizeVideo), [galleryHidden]);
  const previewItems = useMemo(() => [
    ...galleryVisibleItems,
    ...(showHidden ? galleryHiddenItems : []),
  ], [galleryVisibleItems, galleryHiddenItems, showHidden]);
  const [preview, setPreview] = usePreviewRoute(previewItems);

  const { peerNames: pendingPeerNames, rememberPeerName } = usePendingDeletePeerNames(history);
  const withPendingDelete = useCallback((id, pendingDelete) => setHistory((h) => h.map((v) => {
    if (v.id !== id) return v;
    const { pendingDelete: _previous, ...rest } = v;
    return pendingDelete ? { ...rest, pendingDelete } : rest;
  })), []);
  const handleDeleteHistory = useCallback(async (item, { force = false } = {}) => {
    const raw = item?.raw || item;
    const result = await deleteVideoHistoryItem(raw.id, { silent: true, force })
      .catch((err) => {
        if (err.code === 'MEDIA_IN_USE') void refreshMediaUsages();
        toast.error(err.message || 'Delete failed');
        return null;
      });
    if (!result) return;
    void refreshMediaUsages();
    const outcome = mediaDeleteOutcome(result, 'video');
    // A delete that waits on, or did not reach, this machine's copy keeps the row.
    if (!outcome.remove) {
      rememberPeerName(outcome.pendingDelete?.peerId, result.peerName);
      withPendingDelete(raw.id, outcome.pendingDelete);
      toast(outcome.notice);
      return;
    }
    setHistory((h) => h.filter((v) => v.id !== raw.id));
    if (outcome.tone === 'info') toast(outcome.notice);
  }, [rememberPeerName, withPendingDelete]);
  const handleCancelPendingDelete = useCallback(async (item) => {
    const raw = item?.raw || item;
    const cancelled = await cancelVideoPendingDelete(raw.id, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error(err.message || 'Cancel failed'); return false; });
    if (!cancelled) return;
    withPendingDelete(raw.id, null);
    toast.success('Pending delete cancelled');
  }, [withPendingDelete]);
  const handlePromptSaved = useCallback((item, prompt) => {
    const id = item?.id || item?.raw?.id;
    if (!id) return;
    setHistory((h) => h.map((v) => v.id === id
      ? { ...v, prompt: prompt === '(no prompt)' ? '' : prompt }
      : v));
  }, []);
  const handleToggleHistoryHidden = useMediaHideToggle(useCallback((item, hidden) => {
    const id = (item?.raw || item).id;
    setHistory((h) => h.map((v) => (v.id === id ? { ...v, hidden } : v)));
  }, []));
  // The button opens a method-picker drawer (#6510) instead of upscaling
  // directly — the drawer owns the plan fetch, the disclosure, and the actual
  // submit; this page just supplies which item is open and how to fold the
  // finished entry into local state.
  const [upscaleItem, setUpscaleItem] = useState(null);
  const handleUpscaleHistory = useCallback((item) => {
    setUpscaleItem(item?.raw || item);
  }, []);
  // A start trim is a new clip: list it first and open it in place of the source.
  const handleTrimmed = useCallback((video) => {
    setHistory((h) => [video, ...h]);
    setPreview(normalizeVideo(video));
  }, [setPreview]);
  const handleUpscaled = useCallback((video) => {
    setHistory((h) => [video, ...h]);
  }, []);
  const handleToggleFavorites = useCallback(() => setFavoritesOnly((value) => !value), []);
  const handleToggleShowHidden = useCallback(() => setShowHidden((value) => !value), []);

  return {
    history, visibleHistory, historyLoad, setHistoryLoad, historyInFlightRef, refreshHistory,
    preview, setPreview, previewItems, annotations, updateAnnotation,
    handleDeleteHistory, handleToggleHistoryHidden, handlePromptSaved, handleTrimmed, handleUpscaled,
    upscaleItem, setUpscaleItem,
    // Exactly the gallery's own props, so the page spreads them onto it.
    gallery: {
      galleryVisible: galleryVisibleItems,
      galleryHidden: galleryHiddenItems,
      favoritesOnly,
      showHidden,
      onToggleFavorites: handleToggleFavorites,
      onToggleShowHidden: handleToggleShowHidden,
      onPreview: setPreview,
      onUpscale: handleUpscaleHistory,
      onDelete: handleDeleteHistory,
      onCancelPendingDelete: handleCancelPendingDelete,
      pendingPeerNames,
      onToggleHidden: handleToggleHistoryHidden,
      getCardProps,
    },
  };
}

export default useVideoGenHistory;
