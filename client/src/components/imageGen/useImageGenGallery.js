/**
 * Owns Image Gen gallery filters, normalized recent/hidden cards, annotations, URL preview state, and
 * local gallery mutations.
 *
 * Use when: Image Gen gallery and lightbox surfaces that share recent-image, annotation, and preview
 * behavior.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { normalizeImage } from '../media/normalize';
import usePreviewRoute from '../../hooks/usePreviewRoute';
import { useMediaDelete } from '../../hooks/useMediaDelete';
import { useMediaAnnotations } from '../../hooks/useMediaAnnotations';
import { useRecentImageGallery } from './useRecentImageGallery';
import toast from '../ui/Toast';
import { useMediaHideToggle } from '../../hooks/useMediaHideToggle';
import {
  cleanGalleryImage,
  removeImageWatermark,
} from '../../services/apiImageVideo.js';

export function useImageGenGallery({ previewParam }) {
  const [showHidden, setShowHidden] = useState(false);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const { annotations, updateAnnotation: saveAnnotation, getCardProps } = useMediaAnnotations();
  const [annotationSaves, setAnnotationSaves] = useState(0);
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  const annotationRevision = useMemo(() => favoritesOnly
    ? Object.keys(annotations).filter((key) => annotations[key]?.starred).sort().join('\n')
    : '', [annotations, favoritesOnly]);
  const {
    gallery,
    setGallery,
    total: galleryTotal,
    hiddenTotal,
    refreshGallery,
    refreshRecent,
    previewImage,
    hiddenLoading,
    hiddenError,
    error: galleryError,
    loadMoreHidden,
    hasMoreHidden,
  } = useRecentImageGallery({
    favoritesOnly,
    showHidden,
    previewParam,
    annotationRevision,
    annotationPending: annotationSaves > 0,
  });

  const updateAnnotation = useCallback(async (...args) => {
    setAnnotationSaves((count) => count + 1);
    return saveAnnotation(...args).finally(() => {
      setAnnotationSaves((count) => count - 1);
      if (favoritesOnly) refreshGallery();
    });
  }, [saveAnnotation, refreshGallery, favoritesOnly]);

  const toggleGalleryStar = useCallback((item) => {
    if (!item?.key) return;
    updateAnnotation(item.key, { starred: !annotationsRef.current[item.key]?.starred });
  }, [updateAnnotation]);

  const visibleGallery = useMemo(() => gallery.filter((image) => !image.hidden), [gallery]);
  const hiddenGallery = useMemo(() => gallery.filter((image) => image.hidden), [gallery]);
  const visibleGalleryItems = useMemo(() => visibleGallery.map(normalizeImage), [visibleGallery]);
  const hiddenGalleryItems = useMemo(() => hiddenGallery.map(normalizeImage), [hiddenGallery]);
  const previewItems = useMemo(() => {
    const items = [...visibleGalleryItems, ...(showHidden ? hiddenGalleryItems : [])];
    if (previewImage && !items.some((item) => item.filename === previewImage.filename)) {
      items.push(normalizeImage(previewImage));
    }
    return items;
  }, [visibleGalleryItems, hiddenGalleryItems, showHidden, previewImage]);
  const [preview, setPreview] = usePreviewRoute(previewItems);

  const { deleteItem, cancelPendingDelete, pendingPeerNames } = useMediaDelete({
    rows: gallery,
    onPending: useCallback((item, pendingDelete) => setGallery((current) => current.map((image) => {
      if (image.filename !== item.filename) return image;
      const { pendingDelete: _previous, ...rest } = image;
      return pendingDelete ? { ...rest, pendingDelete } : rest;
    })), [setGallery]),
    onRemoved: useCallback((item) => {
      setGallery((current) => current.filter((image) => image.filename !== item.filename));
      refreshGallery();
    }, [refreshGallery, setGallery]),
  });

  const handlePromptSaved = useCallback((item, prompt) => {
    const filename = item?.filename || item?.raw?.filename;
    if (!filename) return;
    setGallery((current) => current.map((image) => image.filename === filename
      ? { ...image, prompt: prompt === '(no prompt)' ? '' : prompt }
      : image));
    refreshGallery();
  }, [refreshGallery, setGallery]);

  const handleToggleHidden = useMediaHideToggle(useCallback((item, hidden) => {
    const filename = (item?.raw || item).filename;
    setGallery((current) => current.map((entry) => (entry.filename === filename ? { ...entry, hidden } : entry)));
    refreshGallery();
  }, [refreshGallery, setGallery]));

  const prependVariant = useCallback((variant) => {
    setGallery((current) => [variant, ...current.filter((image) => image.filename !== variant.filename)]);
    refreshGallery();
  }, [refreshGallery, setGallery]);

  const handleClean = async (image) => {
    if (!image?.filename) throw new Error('Missing filename');
    const cleaned = await cleanGalleryImage(image.filename, { silent: true }).catch((error) => {
      toast.error(error.message || 'Failed to clean image');
      throw error;
    });
    prependVariant(cleaned);
    toast.success(`Cleaned → ${cleaned.filename}`);
  };

  const handleRemoveWatermark = async (image) => {
    if (!image?.filename) throw new Error('Missing filename');
    const variant = await removeImageWatermark(image.filename).catch((error) => {
      toast.error(error.message || 'Failed to remove watermark');
      throw error;
    });
    prependVariant(variant);
    toast.success(`Watermark removed → ${variant.filename}`);
  };

  return {
    view: {
      galleryError,
      refreshGallery,
      galleryTotal,
      favoritesOnly,
      setFavoritesOnly,
      visibleGallery,
      visibleGalleryItems,
      hiddenTotal,
      showHidden,
      setShowHidden,
      hiddenGalleryItems,
      hiddenError,
      hasMoreHidden,
      hiddenLoading,
      loadMoreHidden,
    },
    preview: {
      value: preview,
      set: setPreview,
      items: previewItems,
      annotations,
      updateAnnotation,
    },
    actions: {
      delete: deleteItem,
      cancelPendingDelete,
      promptSaved: handlePromptSaved,
      toggleHidden: handleToggleHidden,
      clean: handleClean,
      removeWatermark: handleRemoveWatermark,
      toggleStar: toggleGalleryStar,
      prependVariant,
    },
    getCardProps,
    pendingPeerNames,
    refreshRecent,
  };
}
