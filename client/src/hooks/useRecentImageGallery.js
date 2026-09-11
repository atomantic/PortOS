import { useCallback, useEffect, useState } from 'react';
import { listImageGalleryPage } from '../services/api';

const HIDDEN_PAGE_SIZE = 60;

/** Recent-five gallery, lazy hidden pages, and a bounded deep-link lookup. */
export function useRecentImageGallery({ favoritesOnly, showHidden, previewParam, annotationRevision = '', annotationPending = false }) {
  const [gallery, setGallery] = useState([]);
  const [total, setTotal] = useState(0);
  const [hiddenTotal, setHiddenTotal] = useState(0);
  const [hiddenOffset, setHiddenOffset] = useState(0);
  const [nextHiddenOffset, setNextHiddenOffset] = useState(null);
  const [hiddenLoading, setHiddenLoading] = useState(false);
  const [error, setError] = useState(false);
  const [hiddenError, setHiddenError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [hiddenRevision, setHiddenRevision] = useState(0);
  const waitingForAnnotations = favoritesOnly && annotationPending;
  const refreshRecent = useCallback(() => setRevision(n => n + 1), []);
  const [previewImage, setPreviewImage] = useState(null);
  const refreshGallery = useCallback(() => {
    setHiddenOffset(0);
    setHiddenRevision(n => n + 1);
    setRevision(n => n + 1);
  }, []);

  useEffect(() => {
    if (waitingForAnnotations) return;
    let cancelled = false;
    setError(false);
    listImageGalleryPage({ limit: 5, hidden: false, starred: favoritesOnly, summary: true }, { silent: true })
      .then(page => {
        if (cancelled) return;
        setGallery(previous => [...page.items, ...previous.filter(item => item.hidden)]);
        setTotal(page.total);
        setHiddenTotal(page.hiddenTotal);
      })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [favoritesOnly, revision, annotationRevision, waitingForAnnotations]);

  // Scope changes start hidden browsing at the beginning; keep the offset tied
  // to that scope rather than issuing a stale offset before an effect resets it.
  const scope = `${favoritesOnly}:${annotationRevision}`;
  const [hiddenScope, setHiddenScope] = useState(scope);
  if (hiddenScope !== scope) {
    setHiddenScope(scope);
    setHiddenOffset(0);
  }

  useEffect(() => {
    if (!showHidden) {
      setGallery(previous => previous.filter(item => !item.hidden));
      setHiddenOffset(0);
      setNextHiddenOffset(null);
      setHiddenLoading(false);
      return;
    }
    if (waitingForAnnotations) return;
    if (hiddenOffset === 0) {
      setGallery(previous => previous.filter(item => !item.hidden));
      setNextHiddenOffset(null);
    }
    let cancelled = false;
    setHiddenLoading(true);
    setHiddenError(false);
    listImageGalleryPage({ limit: HIDDEN_PAGE_SIZE, offset: hiddenOffset, hidden: true, starred: favoritesOnly }, { silent: true })
      .then(page => {
        if (cancelled) return;
        setGallery(previous => {
          const keep = previous.filter(item => !item.hidden || hiddenOffset !== 0);
          const byFilename = new Map(keep.map(item => [item.filename, item]));
          for (const item of page.items) byFilename.set(item.filename, item);
          return [...byFilename.values()];
        });
        setHiddenTotal(page.total);
        const next = page.offset + page.items.length;
        setNextHiddenOffset(page.items.length && next < page.total ? next : null);
      })
      .catch(() => { if (!cancelled) setHiddenError(true); })
      .finally(() => { if (!cancelled) setHiddenLoading(false); });
    return () => { cancelled = true; };
  }, [showHidden, favoritesOnly, hiddenOffset, hiddenRevision, annotationRevision, waitingForAnnotations]);

  const filename = previewParam?.startsWith('image:') ? previewParam.slice(6) : previewParam;
  const cachedPreview = gallery.find(item => item.filename === filename);
  useEffect(() => {
    setPreviewImage(null);
    if (!filename || cachedPreview) return;
    let cancelled = false;
    listImageGalleryPage({ limit: 1, filename }, { silent: true })
      .then(page => { if (!cancelled) setPreviewImage(page.items[0] || null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [filename, cachedPreview, revision]);

  const loadMoreHidden = () => {
    if (!hiddenLoading && nextHiddenOffset !== null) setHiddenOffset(nextHiddenOffset);
  };
  return {
    gallery, setGallery, total, hiddenTotal, refreshGallery, refreshRecent, previewImage: cachedPreview || previewImage,
    hiddenLoading, hiddenError, error, loadMoreHidden, hasMoreHidden: nextHiddenOffset !== null,
  };
}
