import { useCallback, useMemo, useRef, useState } from 'react';
import { normalizeImage } from '../components/media/normalize';
import usePreviewRoute from './usePreviewRoute';
import { useMediaAnnotations } from './useMediaAnnotations';
import { useRecentImageGallery } from './useRecentImageGallery';
import toast from '../components/ui/Toast';
import {
  cleanGalleryImage,
  deleteImage,
  removeImageWatermark,
  setImageHidden,
} from '../services/api';

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

  const handleDelete = useCallback(async (item) => {
    const filename = item?.filename;
    if (!filename) return;
    const deleted = await deleteImage(filename).then(() => true, () => false);
    if (!deleted) return;
    setGallery((current) => current.filter((image) => image.filename !== filename));
    refreshGallery();
  }, [refreshGallery, setGallery]);

  const handlePromptSaved = useCallback((item, prompt) => {
    const filename = item?.filename || item?.raw?.filename;
    if (!filename) return;
    setGallery((current) => current.map((image) => image.filename === filename
      ? { ...image, prompt: prompt === '(no prompt)' ? '' : prompt }
      : image));
    refreshGallery();
  }, [refreshGallery, setGallery]);

  const handleToggleHidden = useCallback(async (item) => {
    const image = item?.raw || item;
    const nextHidden = !image.hidden;
    setGallery((current) => current.map((entry) => (entry.filename === image.filename ? { ...entry, hidden: nextHidden } : entry)));
    const result = await setImageHidden(image.filename, nextHidden, { silent: true }).catch((error) => {
      toast.error(error.message || 'Failed to update visibility');
      setGallery((current) => current.map((entry) => (entry.filename === image.filename ? { ...entry, hidden: !nextHidden } : entry)));
      return null;
    });
    if (result) {
      toast.success(nextHidden ? 'Image hidden' : 'Image unhidden');
      refreshGallery();
    }
  }, [refreshGallery, setGallery]);

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
      delete: handleDelete,
      promptSaved: handlePromptSaved,
      toggleHidden: handleToggleHidden,
      clean: handleClean,
      removeWatermark: handleRemoveWatermark,
      toggleStar: toggleGalleryStar,
      prependVariant,
    },
    getCardProps,
    refreshRecent,
  };
}
