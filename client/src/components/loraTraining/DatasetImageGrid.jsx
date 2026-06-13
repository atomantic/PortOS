/**
 * Dataset image grid — caption editing, per-image re-caption, delete.
 * Captions blur-save; local state updates reactively (no list refetch).
 */

import { useState } from 'react';
import { Loader2, RefreshCw, AlertTriangle } from 'lucide-react';
import toast from '../ui/Toast';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import {
  updateLoraDatasetImageCaption,
  deleteLoraDatasetImage,
  startLoraCaptionRun,
} from '../../services/api';

const SOURCE_BADGE = {
  generated: { label: 'generated', cls: 'bg-port-accent/20 text-port-accent' },
  upload: { label: 'upload', cls: 'bg-emerald-600/20 text-emerald-300' },
  'refsheet-slice': { label: 'sheet crop', cls: 'bg-purple-600/20 text-purple-300' },
  gallery: { label: 'gallery', cls: 'bg-sky-600/20 text-sky-300' },
};

export default function DatasetImageGrid({ dataset, onImagesChange, onCaptionRunStarted, captionModel = null }) {
  const [drafts, setDrafts] = useState({});
  const [savingId, setSavingId] = useState(null);
  const [confirmingId, setConfirmingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [recaptioningId, setRecaptioningId] = useState(null);

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
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {dataset.images.map((img) => {
        const badge = SOURCE_BADGE[img.source] || SOURCE_BADGE.upload;
        return (
          <div key={img.id} className="bg-port-card border border-port-border rounded-lg overflow-hidden flex flex-col">
            <div className="relative aspect-square bg-port-bg">
              {img.status === 'rendering' ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-400 gap-2">
                  <Loader2 className="w-6 h-6 animate-spin" />
                  <span className="text-xs">rendering…</span>
                </div>
              ) : img.status === 'failed' ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-port-error gap-2">
                  <AlertTriangle className="w-6 h-6" />
                  <span className="text-xs">render failed</span>
                </div>
              ) : (
                <img
                  src={`/data/lora-datasets/${dataset.id}/images/${img.file}`}
                  alt={img.caption || 'dataset image'}
                  className="absolute inset-0 w-full h-full object-cover"
                  loading="lazy"
                />
              )}
              <span className={`absolute top-2 left-2 text-[10px] px-1.5 py-0.5 rounded ${badge.cls}`}>{badge.label}</span>
              {img.variation?.view && (
                <span className="absolute top-2 right-2 text-[10px] px-1.5 py-0.5 rounded bg-black/60 text-gray-300">
                  {img.variation.view}
                </span>
              )}
            </div>
            <div className="p-2 flex flex-col gap-2 flex-1">
              <textarea
                value={drafts[img.id] ?? img.caption}
                onChange={(e) => setDrafts((prev) => ({ ...prev, [img.id]: e.target.value }))}
                onBlur={() => saveCaption(img)}
                placeholder={img.status === 'ready' ? 'Caption (must include the trigger word)…' : ''}
                disabled={img.status !== 'ready'}
                rows={3}
                // Per-grid-cell field — a visible label would be noise, so the
                // accessible name comes from aria-label (the source + view give
                // a screen-reader user enough to tell cells apart).
                aria-label={`Caption for ${img.source}${img.variation?.view ? ` ${img.variation.view}` : ''} image`}
                className="w-full bg-port-bg border border-port-border rounded p-2 text-xs text-gray-200 resize-y disabled:opacity-50"
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
          </div>
        );
      })}
    </div>
  );
}
