/**
 * LoRA dataset workbench (/media/training/:datasetId).
 *
 * Build reference material for one character (generate via the image
 * queue, upload, slice the reference-sheet turnaround), caption it with
 * the vision model, then launch a training run. The dataset record is the
 * single source of truth; rendering images poll-refresh until they land.
 */

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ArrowLeft, Loader2, Upload, Wand2, Scissors, Tags, RefreshCw, AlertTriangle, Images, Lightbulb,
} from 'lucide-react';
import toast from '../components/ui/Toast';
import Modal from '../components/ui/Modal';
import { useSseProgress } from '../hooks/useSseProgress';
import DatasetImageGrid from '../components/loraTraining/DatasetImageGrid';
import GenerateBatchDialog from '../components/loraTraining/GenerateBatchDialog';
import TrainingPanel from '../components/loraTraining/TrainingPanel';
import CaptionModelPicker from '../components/loraTraining/CaptionModelPicker';
import ImportGalleryDialog from '../components/loraTraining/ImportGalleryDialog';
import {
  getLoraDataset,
  patchLoraDataset,
  uploadLoraDatasetImages,
  sliceLoraDatasetRefSheet,
  startLoraCaptionRun,
  getUniverse,
} from '../services/api';

const TRIGGER_RE = /^[a-z0-9_]{2,64}$/;
// Mirror of server/lib/loraDataset.js MIN_TRAINING_IMAGES + the token-boundary
// caption match. Kept page-local (UX-advisory only — the server re-validates
// authoritatively via validateDatasetReady at train time) so the readiness
// summary + Train gate update the instant a caption is edited or an image
// deleted, instead of waiting on a server round-trip. Port logic changes here
// when the server helper changes.
const MIN_TRAINING_IMAGES = 10;
const RECOMMENDED_TRAINING_IMAGES = 20;
const TRAINING_IMAGE_SWEET_SPOT_MAX = 30;
const qualityTier = (captioned) => {
  if (captioned < MIN_TRAINING_IMAGES) return 'insufficient';
  if (captioned < RECOMMENDED_TRAINING_IMAGES) return 'minimum';
  return 'good';
};
const captionHasTriggerWord = (caption, triggerWord) => {
  const word = (triggerWord || '').trim();
  const text = (caption || '').trim();
  if (!text) return false;
  if (!word) return true;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9_])${escaped}(?:[^a-z0-9_]|$)`, 'i').test(text);
};
const deriveReadiness = (images, triggerWord) => {
  const list = Array.isArray(images) ? images : [];
  const word = (triggerWord || '').trim();
  const ready = list.filter((img) => img.status === 'ready');
  const captioned = ready.filter((img) => captionHasTriggerWord(img.caption, word));
  const trainable = !!word && captioned.length >= MIN_TRAINING_IMAGES;
  return {
    total: list.length,
    ready: ready.length,
    captioned: captioned.length,
    rendering: list.filter((img) => img.status === 'rendering').length,
    required: MIN_TRAINING_IMAGES,
    recommended: RECOMMENDED_TRAINING_IMAGES,
    trainable,
    // Mirror of computeDatasetReadiness: gate the tier on trainability so a
    // record with enough images but no trigger word never shows green.
    quality: trainable ? qualityTier(captioned.length) : 'insufficient',
  };
};

function SliceDialog({ dataset, onClose, onSliced }) {
  const [cols, setCols] = useState(3);
  const [rows, setRows] = useState(2);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    try {
      const result = await sliceLoraDatasetRefSheet(dataset.id, { cols, rows });
      toast.success(`Added ${result.images.length} crops from the reference sheet — prune any bad ones`);
      onSliced(result);
    } finally {
      setSubmitting(false);
    }
  };

  const numberInput = (id, label, value, set) => (
    <div>
      <label htmlFor={id} className="block text-xs text-gray-400 mb-1">{label}</label>
      <input
        id={id}
        type="number"
        min={1}
        max={6}
        value={value}
        onChange={(e) => set(Math.max(1, Math.min(6, Number(e.target.value) || 1)))}
        className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white"
      />
    </div>
  );

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      ariaLabelledBy="lt-slice-title"
      panelClassName="bg-port-card border border-port-border rounded-lg p-5"
    >
      <div className="space-y-4">
        <h2 id="lt-slice-title" className="text-base font-semibold text-white">Slice reference sheet</h2>
        <p className="text-sm text-gray-400">
          Cuts the character&apos;s reference-sheet turnaround into a fixed grid of training crops.
          Sheet layouts vary, so expect to delete cells that caught labels or palette swatches.
        </p>
        <div className="grid grid-cols-2 gap-3">
          {numberInput('lt-slice-cols', 'Columns', cols, setCols)}
          {numberInput('lt-slice-rows', 'Rows', rows, setRows)}
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-2 text-sm text-gray-400 hover:text-white">Cancel</button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            className="px-3 py-2 text-sm rounded bg-port-accent text-white disabled:opacity-50 flex items-center gap-2"
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Scissors className="w-4 h-4" />}
            Slice {cols}×{rows}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export default function LoraDatasetDetail() {
  const { datasetId } = useParams();
  const [dataset, setDataset] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [character, setCharacter] = useState(null);
  const [triggerDraft, setTriggerDraft] = useState(null);
  const [triggerSaving, setTriggerSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [showGenerate, setShowGenerate] = useState(false);
  const [showSlice, setShowSlice] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [captionRun, setCaptionRun] = useState(null);
  const [captionStarting, setCaptionStarting] = useState(false);
  // Chosen caption model { providerId, model } — null fields mean "let the
  // server auto-pick a vision model". Lifted from CaptionModelPicker so caption
  // runs pass the explicit selection.
  const [captionModel, setCaptionModel] = useState({ providerId: null, model: null });
  const fileInputRef = useRef(null);

  const refresh = useCallback(() => getLoraDataset(datasetId)
    .then((d) => { setDataset(d); return d; })
    .catch((err) => { setLoadError(err?.message || 'Dataset not found'); return null; }), [datasetId]);

  useEffect(() => { refresh(); }, [refresh]);

  // Pull the live canon character once for variation-axis options + sheet link.
  useEffect(() => {
    if (!dataset?.character?.universeId) return;
    getUniverse(dataset.character.universeId, { silent: true })
      .then((u) => setCharacter((u?.characters || []).find((c) => c.id === dataset.character.entryId) || null))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset?.character?.universeId, dataset?.character?.entryId]);

  // Readiness is derived from the live local images (not the server's snapshot
  // on `dataset.readiness`) so manual caption edits / deletes reflect in the
  // counts + Train gate immediately, without a refetch per keystroke.
  const readiness = useMemo(
    () => deriveReadiness(dataset?.images, dataset?.triggerWord),
    [dataset?.images, dataset?.triggerWord],
  );

  // Poll while any image renders — the server heals stuck images on read.
  const renderingCount = readiness.rendering;
  useEffect(() => {
    if (!renderingCount) return undefined;
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [renderingCount, refresh]);

  // Caption-run SSE — refetch on terminal so captions land in the grid, and
  // surface failures the run reported. The server emits per-image `error`
  // progress frames and a terminal frame carrying the failure tally
  // (`complete` with `failed`, or `error` when every image failed); without
  // this the run just stops spinning and the user never learns an image was
  // refused / returned an empty description.
  const captionSseUrl = captionRun ? `/api/lora-datasets/${datasetId}/caption-runs/${captionRun.runId}/events` : null;
  const captionSse = useSseProgress(captionSseUrl, { enabled: !!captionRun });
  useEffect(() => {
    if (!captionRun || !captionSse.closed) return;
    const last = captionSse.latest;
    // The per-image `progress` frames carry the specific failure reason (refusal
    // vs. a reasoning model that exhausted its token budget). The terminal frame
    // only has a tally, so pull the most recent per-image error to surface the
    // actionable detail — invaluable when a single-image run fails.
    const lastImageError = [...(captionSse.frames || [])]
      .reverse().find((f) => f?.type === 'progress' && f.error)?.error;
    if (last?.type === 'error') {
      // Every image failed — the server's terminal `error` frame carries only a
      // generic "check the vision provider" tally, but the per-image `progress`
      // frames already reported the specific reason (refusal vs. a reasoning
      // model that exhausted its token budget). Prefer that detail; it's the
      // whole point for the common single-image failure, which lands here (not
      // in the `complete` branch) because done===0.
      toast.error(lastImageError || last.message || 'Captioning failed');
    } else if (last?.type === 'complete' && last.failed > 0) {
      const noun = last.failed === 1 ? 'image' : 'images';
      const detail = lastImageError ? ` ${lastImageError}` : '';
      toast.error(last.done > 0
        ? `Captioned ${last.done}/${last.total} — ${last.failed} ${noun} failed.${detail || ' Re-caption individually or pick another vision model.'}`
        : `All ${last.failed} ${noun} failed to caption.${detail || ' The vision model refused or returned nothing — try another vision model.'}`);
    } else if (last?.type === 'complete' && last.done > 0) {
      toast.success(`Captioned ${last.done} image${last.done === 1 ? '' : 's'}`);
    }
    setCaptionRun(null);
    refresh();
  }, [captionRun, captionSse.closed, captionSse.latest, captionSse.frames, refresh]);

  const onImagesChange = (mutate) => setDataset((prev) => (prev ? { ...prev, images: mutate(prev.images) } : prev));

  const saveTriggerWord = async () => {
    if (triggerDraft === null || triggerDraft === dataset.triggerWord) { setTriggerDraft(null); return; }
    if (!TRIGGER_RE.test(triggerDraft)) {
      toast.error('Trigger word must be 2-64 chars of a-z, 0-9, _');
      return;
    }
    setTriggerSaving(true);
    try {
      const next = await patchLoraDataset(datasetId, { triggerWord: triggerDraft });
      setDataset(next);
      setTriggerDraft(null);
      toast.success('Trigger word saved — re-caption images so captions carry the new token');
    } finally {
      setTriggerSaving(false);
    }
  };

  const onUpload = async (e) => {
    const files = e.target.files;
    if (!files?.length) return;
    setUploading(true);
    try {
      const { images } = await uploadLoraDatasetImages(datasetId, files);
      onImagesChange((prev) => [...prev, ...images]);
      refresh();
      toast.success(`Added ${images.length} image${images.length === 1 ? '' : 's'}`);
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  // Stable so CaptionModelPicker's run-once effect doesn't re-fire.
  const onCaptionModelChange = useCallback((sel) => setCaptionModel(sel), []);

  // Strip null provider/model so an "Auto" selection sends an empty body and
  // the server resolves a vision model itself.
  const captionOptions = (extra = {}) => ({
    ...extra,
    ...(captionModel.providerId ? { providerId: captionModel.providerId } : {}),
    ...(captionModel.model ? { model: captionModel.model } : {}),
  });

  // Caption only images that have no caption yet (overwrite: false). Re-caption
  // all overwrites every ready image's caption with the picked model — the way
  // to re-run the whole dataset through a newer/better VLM.
  const startCaption = async (overwrite) => {
    setCaptionStarting(true);
    try {
      const run = await startLoraCaptionRun(datasetId, captionOptions({ overwrite }));
      setCaptionRun(run);
    } finally {
      setCaptionStarting(false);
    }
  };
  const captionAll = () => startCaption(false);
  const recaptionAll = () => startCaption(true);

  const expressionOptions = useMemo(
    () => (character?.expressions || []).map((e) => e?.name).filter(Boolean),
    [character],
  );
  const outfitOptions = useMemo(
    () => (character?.wardrobes || []).map((w) => w?.name).filter(Boolean),
    [character],
  );
  const hasReferenceSheet = !!(character?.referenceSheetImageRef
    || Object.values(character?.referenceSheets || {}).some(Boolean));

  if (loadError) {
    return (
      <div className="bg-port-card border border-port-border rounded-lg p-6 text-center text-gray-400">
        <AlertTriangle className="w-6 h-6 mx-auto mb-2 text-port-error" />
        {loadError} — <Link to="/media/training" className="text-port-accent hover:underline">back to datasets</Link>
      </div>
    );
  }
  if (!dataset) {
    return <div className="text-gray-400 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading dataset…</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <Link to="/media/training" className="text-xs text-gray-400 hover:text-white flex items-center gap-1 mb-1">
            <ArrowLeft className="w-3 h-3" /> Datasets
          </Link>
          <h2 className="text-lg font-semibold text-white truncate">
            <Link
              to={`/universes/${dataset.character.universeId}`}
              className="hover:text-port-accent"
              title="Open in universe editor"
            >
              {dataset.character.name}
            </Link>
          </h2>
          <div className="flex items-center gap-2 mt-1">
            <label htmlFor="lt-trigger" className="text-xs text-gray-500">Trigger word</label>
            <input
              id="lt-trigger"
              value={triggerDraft ?? dataset.triggerWord}
              onChange={(e) => setTriggerDraft(e.target.value)}
              onBlur={saveTriggerWord}
              disabled={triggerSaving}
              className="bg-port-bg border border-port-border rounded px-2 py-1 text-xs font-mono text-white w-56 disabled:opacity-50"
            />
            {triggerSaving && <Loader2 className="w-3 h-3 animate-spin text-gray-400" />}
          </div>
        </div>
        <div className="text-right text-sm">
          <div className={readiness.quality === 'good' ? 'text-port-success' : readiness.quality === 'minimum' ? 'text-port-warning' : 'text-gray-400'}>
            {readiness.ready ?? 0} images · {readiness.captioned ?? 0}/{readiness.required ?? 10} captioned
            {renderingCount ? ` · ${renderingCount} rendering` : ''}
          </div>
          <div className="text-xs text-gray-500">
            {readiness.quality === 'good'
              ? 'Ready to train — strong dataset'
              : readiness.quality === 'minimum'
                ? `Trainable now · ${Math.max(0, (readiness.recommended ?? 20) - (readiness.captioned ?? 0))} more for best quality`
                : (readiness.captioned ?? 0) >= (readiness.required ?? 10)
                  ? 'Set a trigger word to train'
                  : `Add + caption ${(readiness.required ?? 10) - (readiness.captioned ?? 0)} more to train`}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setShowGenerate(true)}
          className="px-3 py-2 text-sm rounded bg-port-accent/20 text-port-accent hover:bg-port-accent/30 flex items-center gap-2"
        >
          <Wand2 className="w-4 h-4" /> Generate
        </button>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="px-3 py-2 text-sm rounded bg-port-card border border-port-border text-gray-300 hover:text-white flex items-center gap-2 disabled:opacity-50"
        >
          {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />} Upload
        </button>
        <button
          type="button"
          onClick={() => setShowImport(true)}
          className="px-3 py-2 text-sm rounded bg-port-card border border-port-border text-gray-300 hover:text-white flex items-center gap-2"
        >
          <Images className="w-4 h-4" /> From gallery
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          className="hidden"
          onChange={onUpload}
        />
        <button
          type="button"
          onClick={() => setShowSlice(true)}
          disabled={!hasReferenceSheet}
          title={hasReferenceSheet ? '' : 'Render a reference sheet in the universe editor first'}
          className="px-3 py-2 text-sm rounded bg-port-card border border-port-border text-gray-300 hover:text-white flex items-center gap-2 disabled:opacity-50"
        >
          <Scissors className="w-4 h-4" /> Slice sheet
        </button>
        <button
          type="button"
          onClick={captionAll}
          disabled={captionStarting || !!captionRun || !readiness.ready}
          className="px-3 py-2 text-sm rounded bg-port-card border border-port-border text-gray-300 hover:text-white flex items-center gap-2 disabled:opacity-50"
        >
          {captionStarting || captionRun ? <Loader2 className="w-4 h-4 animate-spin" /> : <Tags className="w-4 h-4" />}
          {captionRun
            ? `Captioning ${captionSse.latest?.done ?? 0}/${captionSse.latest?.total ?? '…'}`
            : 'Caption all'}
        </button>
        <button
          type="button"
          onClick={recaptionAll}
          disabled={captionStarting || !!captionRun || !readiness.ready}
          title="Re-caption every ready image with the selected model — overwrites all existing captions, including manual edits"
          className="px-3 py-2 text-sm rounded bg-port-card border border-port-border text-gray-300 hover:text-white flex items-center gap-2 disabled:opacity-50"
        >
          <RefreshCw className="w-4 h-4" /> Re-caption all
        </button>
        <CaptionModelPicker onChange={onCaptionModelChange} />
      </div>

      <details className="bg-port-card border border-port-border rounded-lg text-sm">
        <summary className="cursor-pointer select-none px-3 py-2 flex items-center gap-2 text-gray-300 hover:text-white">
          <Lightbulb className="w-4 h-4 text-port-warning shrink-0" />
          <span className="font-medium">Tips for a strong character dataset</span>
          <span className="text-xs text-gray-500">
            target ~{RECOMMENDED_TRAINING_IMAGES}–{TRAINING_IMAGE_SWEET_SPOT_MAX} images · {MIN_TRAINING_IMAGES} minimum
          </span>
        </summary>
        <div className="px-3 pb-3 pt-1 text-xs text-gray-400 space-y-2 border-t border-port-border/60">
          <p>
            Quality beats quantity. {MIN_TRAINING_IMAGES} images is the floor; ~{RECOMMENDED_TRAINING_IMAGES}–{TRAINING_IMAGE_SWEET_SPOT_MAX} sharp,
            varied shots is the sweet spot. Past ~50 you mostly add training time and overfitting risk —
            near-duplicate frames teach the model to memorize a pose instead of learning the character.
          </p>
          <ul className="list-disc pl-4 space-y-1">
            <li><span className="text-gray-300">Vary the angle</span> — front, three-quarter, profile, and a back view.</li>
            <li><span className="text-gray-300">Vary the framing</span> — mix tight face close-ups (for likeness) with mid and full-body shots (for proportions).</li>
            <li><span className="text-gray-300">Vary pose &amp; expression</span> — standing, sitting, action; neutral, smiling, intense.</li>
            <li><span className="text-gray-300">Vary outfit, lighting &amp; background</span> — so the LoRA learns the character, not one costume, key light, or backdrop.</li>
            <li><span className="text-gray-300">Keep it single-subject and on-model</span> — one clearly-visible character per image, consistent identity, no clutter or other people.</li>
            <li><span className="text-gray-300">Drop the weak ones</span> — blurry, occluded, or off-model frames hurt more than they help; avoid near-duplicates.</li>
          </ul>
        </div>
      </details>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4 items-start">
        <DatasetImageGrid
          dataset={dataset}
          onImagesChange={onImagesChange}
          onCaptionRunStarted={setCaptionRun}
          captionModel={captionModel}
        />
        <TrainingPanel
          dataset={dataset}
          readiness={readiness}
          triggerSaving={triggerSaving}
          onRunFinished={refresh}
        />
      </div>

      {showGenerate && (
        <GenerateBatchDialog
          dataset={dataset}
          expressionOptions={expressionOptions}
          outfitOptions={outfitOptions}
          onClose={() => setShowGenerate(false)}
          onStarted={() => { setShowGenerate(false); refresh(); }}
        />
      )}
      {showSlice && (
        <SliceDialog
          dataset={dataset}
          onClose={() => setShowSlice(false)}
          onSliced={() => { setShowSlice(false); refresh(); }}
        />
      )}
      {showImport && (
        <ImportGalleryDialog
          dataset={dataset}
          onClose={() => setShowImport(false)}
          onImported={(images) => {
            setShowImport(false);
            if (images?.length) onImagesChange((prev) => [...prev, ...images]);
            refresh();
          }}
        />
      )}
    </div>
  );
}
