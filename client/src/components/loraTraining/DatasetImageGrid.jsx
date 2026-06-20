/**
 * Dataset image grid — caption editing, per-image re-caption, delete.
 * Captions blur-save; local state updates reactively (no list refetch).
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Loader2, RefreshCw, AlertTriangle, ChevronLeft, ChevronRight, X, Eye, EyeOff,
} from 'lucide-react';
import toast from '../ui/Toast';
import Modal from '../ui/Modal';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import AutoSizeTextarea from '../ui/AutoSizeTextarea';
import {
  updateLoraDatasetImageCaption,
  deleteLoraDatasetImage,
  startLoraCaptionRun,
} from '../../services/api';

// Lightweight full-size preview for a dataset image. Kept page-local (the
// rich MediaLightbox is bound to the media-gen `item` shape — prompts, clean/
// regen actions, annotations — none of which a raw training image carries).
// Navigates the ready-image subset with ← / → and Esc-closes via <Modal>.
function DatasetImageLightbox({ datasetId, images, index, onIndexChange, onClose }) {
  const img = images[index];
  const hasPrev = index > 0;
  const hasNext = index < images.length - 1;
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'ArrowLeft' && hasPrev) { e.preventDefault(); onIndexChange(index - 1); }
      if (e.key === 'ArrowRight' && hasNext) { e.preventDefault(); onIndexChange(index + 1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, hasPrev, hasNext, onIndexChange]);
  if (!img) return null;
  return (
    <Modal open onClose={onClose} size="none" backdropClassName="bg-black/90" ariaLabel="Training image preview">
      <div className="relative flex flex-col items-center gap-3">
        <button
          type="button"
          onClick={onClose}
          className="absolute -top-1 right-0 z-10 p-2 rounded-full bg-white text-black hover:bg-white/85 shadow-lg focus:outline-none focus:ring-2 focus:ring-port-accent"
          aria-label="Close (Esc)"
          title="Close (Esc)"
        >
          <X className="w-4 h-4" />
        </button>
        <img
          src={`/data/lora-datasets/${datasetId}/images/${img.file}`}
          alt={img.caption || 'dataset image'}
          className="max-w-[92vw] max-h-[80vh] object-contain rounded-lg bg-black"
        />
        {img.caption && (
          <p className="max-w-[92vw] text-center text-sm text-gray-200 whitespace-pre-wrap">{img.caption}</p>
        )}
        {hasPrev && (
          <button
            type="button"
            onClick={() => onIndexChange(index - 1)}
            className="absolute left-2 md:-left-14 top-1/2 -translate-y-1/2 p-2.5 text-white/80 hover:text-white bg-black/50 hover:bg-black/70 backdrop-blur-sm rounded-full focus:outline-none focus:ring-2 focus:ring-port-accent"
            aria-label="Previous image"
            title="Previous (←)"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>
        )}
        {hasNext && (
          <button
            type="button"
            onClick={() => onIndexChange(index + 1)}
            className="absolute right-2 md:-right-14 top-1/2 -translate-y-1/2 p-2.5 text-white/80 hover:text-white bg-black/50 hover:bg-black/70 backdrop-blur-sm rounded-full focus:outline-none focus:ring-2 focus:ring-port-accent"
            aria-label="Next image"
            title="Next (→)"
          >
            <ChevronRight className="w-6 h-6" />
          </button>
        )}
      </div>
    </Modal>
  );
}

const SOURCE_BADGE = {
  generated: { label: 'generated', cls: 'bg-port-accent/20 text-port-accent' },
  upload: { label: 'upload', cls: 'bg-emerald-600/20 text-emerald-300' },
  'refsheet-slice': { label: 'sheet crop', cls: 'bg-purple-600/20 text-purple-300' },
  gallery: { label: 'gallery', cls: 'bg-sky-600/20 text-sky-300' },
};

export default function DatasetImageGrid({
  dataset, onImagesChange, onCaptionRunStarted, captionModel = null, draftResetToken = 0,
}) {
  const [drafts, setDrafts] = useState({});
  // A bulk caption rewrite in the parent (e.g. strip-shared-fragments) replaces
  // dataset.images out from under any unsaved per-cell draft. Drop the drafts on
  // that signal so the next blur doesn't PATCH the superseded text back.
  useEffect(() => { setDrafts({}); }, [draftResetToken]);
  const [savingId, setSavingId] = useState(null);
  const [confirmingId, setConfirmingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [recaptioningId, setRecaptioningId] = useState(null);
  const [showCaptions, setShowCaptions] = useState(true);
  // Index into the ready-image subset that the lightbox is previewing (null = closed).
  const [previewIndex, setPreviewIndex] = useState(null);

  // Only ready images are previewable — rendering/failed cells have no file.
  const readyImages = dataset.images.filter((i) => i.status === 'ready');
  const openPreview = useCallback((img) => {
    const idx = readyImages.findIndex((i) => i.id === img.id);
    if (idx >= 0) setPreviewIndex(idx);
  }, [readyImages]);

  const saveCaption = async (img) => {
    const draft = drafts[img.id];
    if (draft === undefined || draft === img.caption) return;
    setSavingId(img.id);
    try {
      const updated = await updateLoraDatasetImageCaption(dataset.id, img.id, draft);
      onImagesChange((prev) => prev.map((i) => (i.id === img.id ? { ...i, ...updated } : i)));
      setDrafts((prev) => { const next = { ...prev }; delete next[img.id]; return next; });
    } finally {
      setSavingId(null);
    }
  };

  const removeImage = async (img) => {
    setDeletingId(img.id);
    try {
      await deleteLoraDatasetImage(dataset.id, img.id);
      onImagesChange((prev) => prev.filter((i) => i.id !== img.id));
    } finally {
      setDeletingId(null);
      setConfirmingId(null);
    }
  };

  const recaption = async (img) => {
    setRecaptioningId(img.id);
    try {
      const run = await startLoraCaptionRun(dataset.id, {
        imageIds: [img.id],
        overwrite: true,
        ...(captionModel?.providerId ? { providerId: captionModel.providerId } : {}),
        ...(captionModel?.model ? { model: captionModel.model } : {}),
      });
      onCaptionRunStarted?.(run);
      toast.success('Re-captioning image…');
    } finally {
      setRecaptioningId(null);
    }
  };

  if (!dataset.images.length) {
    return (
      <div className="bg-port-card border border-port-border rounded-lg p-8 text-center text-gray-400 text-sm">
        No images yet — generate reference renders, upload your own, or slice the character&apos;s reference sheet.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setShowCaptions((v) => !v)}
          className="text-xs text-gray-400 hover:text-white flex items-center gap-1.5"
          title={showCaptions ? 'Hide captions — show only thumbnails' : 'Show caption editors'}
          aria-pressed={!showCaptions}
        >
          {showCaptions ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          {showCaptions ? 'Hide captions' : 'Show captions'}
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 items-start">
        {dataset.images.map((img) => {
          const badge = SOURCE_BADGE[img.source] || SOURCE_BADGE.upload;
          return (
            <div key={img.id} className="bg-port-card border border-port-border rounded-lg overflow-hidden flex flex-col">
              <div className="relative bg-port-bg">
                {img.status === 'rendering' ? (
                  <div className="aspect-square flex flex-col items-center justify-center text-gray-400 gap-2">
                    <Loader2 className="w-6 h-6 animate-spin" />
                    <span className="text-xs">rendering…</span>
                  </div>
                ) : img.status === 'failed' ? (
                  <div className="aspect-square flex flex-col items-center justify-center text-port-error gap-2">
                    <AlertTriangle className="w-6 h-6" />
                    <span className="text-xs">render failed</span>
                  </div>
                ) : (
                  // Natural-height thumbnail: fixed column width, full relative
                  // height so portrait/landscape crops aren't sliced by object-cover.
                  <button
                    type="button"
                    onClick={() => openPreview(img)}
                    className="block w-full cursor-zoom-in focus:outline-none focus:ring-2 focus:ring-port-accent"
                    title="Click to preview full size"
                  >
                    <img
                      src={`/data/lora-datasets/${dataset.id}/images/${img.file}`}
                      alt={img.caption || 'dataset image'}
                      className="block w-full h-auto"
                      loading="lazy"
                    />
                  </button>
                )}
                <span className={`absolute top-2 left-2 text-[10px] px-1.5 py-0.5 rounded ${badge.cls}`}>{badge.label}</span>
                {img.variation?.view && (
                  <span className="absolute top-2 right-2 text-[10px] px-1.5 py-0.5 rounded bg-black/60 text-gray-300">
                    {img.variation.view}
                  </span>
                )}
              </div>
              {showCaptions && (
                <div className="p-2 flex flex-col gap-2 flex-1">
                  <AutoSizeTextarea
                    value={drafts[img.id] ?? img.caption}
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [img.id]: e.target.value }))}
                    onBlur={() => saveCaption(img)}
                    placeholder={img.status === 'ready' ? 'Caption (must include the trigger word)…' : ''}
                    disabled={img.status !== 'ready'}
                    // Per-grid-cell field — a visible label would be noise, so the
                    // accessible name comes from aria-label (the source + view give
                    // a screen-reader user enough to tell cells apart).
                    aria-label={`Caption for ${img.source}${img.variation?.view ? ` ${img.variation.view}` : ''} image`}
                    className="w-full min-h-[4.5rem] bg-port-bg border border-port-border rounded p-2 text-xs text-gray-200 disabled:opacity-50"
                  />
                  <div className="flex items-center justify-between text-xs">
                    <button
                      type="button"
                      onClick={() => recaption(img)}
                      disabled={img.status !== 'ready' || recaptioningId === img.id}
                      className="text-gray-400 hover:text-white flex items-center gap-1 disabled:opacity-50"
                      title="Re-caption with the vision model"
                    >
                      {recaptioningId === img.id || savingId === img.id
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        : <RefreshCw className="w-3.5 h-3.5" />}
                      Re-caption
                    </button>
                    {confirmingId === img.id ? (
                      <ConfirmButtonPair
                        prompt="Delete?"
                        busy={deletingId === img.id}
                        onConfirm={() => removeImage(img)}
                        onCancel={() => setConfirmingId(null)}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmingId(img.id)}
                        className="text-gray-500 hover:text-port-error"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {previewIndex !== null && readyImages[previewIndex] && (
        <DatasetImageLightbox
          datasetId={dataset.id}
          images={readyImages}
          index={previewIndex}
          onIndexChange={setPreviewIndex}
          onClose={() => setPreviewIndex(null)}
        />
      )}
    </div>
  );
}
