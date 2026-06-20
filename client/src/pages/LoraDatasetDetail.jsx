/**
 * LoRA dataset workbench (/media/training/:datasetId).
 *
 * Build reference material for one universe bible subject (generate via the image
 * queue, upload, slice the reference-sheet turnaround), caption it with
 * the vision model, then launch a training run. The dataset record is the
 * single source of truth; rendering images poll-refresh until they land.
 */

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ArrowLeft, Loader2, Upload, Wand2, Scissors, Tags, RefreshCw, AlertTriangle, Images, Replace, Lightbulb, Eraser,
} from 'lucide-react';
import toast from '../components/ui/Toast';
import Modal from '../components/ui/Modal';
import { useSseProgress } from '../hooks/useSseProgress';
import DatasetImageGrid from '../components/loraTraining/DatasetImageGrid';
import GenerateBatchDialog from '../components/loraTraining/GenerateBatchDialog';
import TrainingPanel from '../components/loraTraining/TrainingPanel';
import CaptionModelPicker from '../components/loraTraining/CaptionModelPicker';
import ImportGalleryDialog from '../components/loraTraining/ImportGalleryDialog';
import UniverseCharacterPicker from '../components/loraTraining/UniverseCharacterPicker';
import {
  getLoraDataset,
  getLoraDatasetVariationAxes,
  patchLoraDataset,
  uploadLoraDatasetImages,
  sliceLoraDatasetRefSheet,
  startLoraCaptionRun,
  stripLoraDatasetSharedCaptionFragments,
  getUniverse,
} from '../services/api';

const TRIGGER_RE = /^[a-z0-9_]{2,64}$/;
const SUBJECT_TYPE_LABEL = { characters: 'Character', objects: 'Object', places: 'Place' };
const subjectKind = (dataset) => dataset?.character?.entryKind || 'characters';
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
// Mirror of server/lib/loraDataset.js analyzeCaptionInvariants — flags the
// identity fragments repeated across most captions (which bind the character to
// the caption phrases instead of the trigger token, issue #1320). Page-local so
// the advisory updates the instant a caption is edited, without a refetch; the
// authoritative strip recomputes server-side. Port logic changes here when the
// server helper changes.
const INVARIANT_SHARE_THRESHOLD = 0.8;
const MIN_CAPTIONS_FOR_INVARIANT_ANALYSIS = 4;
const captionBody = (caption, triggerWord) => {
  const word = (triggerWord || '').trim();
  let body = (caption || '').trim();
  if (word) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    body = body.replace(new RegExp(`^${escaped}(?=[\\s,]|$)\\s*,?\\s*`, 'i'), '');
  }
  return body;
};
const splitCaptionFragments = (caption, triggerWord) => captionBody(caption, triggerWord)
  .split(',').map((f) => f.trim()).filter(Boolean);
const normalizeFragment = (f) => (f || '').trim().toLowerCase().replace(/\s+/g, ' ');
const analyzeCaptionInvariants = (images, triggerWord) => {
  const list = Array.isArray(images) ? images : [];
  const word = (triggerWord || '').trim();
  const captioned = list.filter((img) => img?.status === 'ready' && captionHasTriggerWord(img.caption, word));
  const total = captioned.length;
  if (total < MIN_CAPTIONS_FOR_INVARIANT_ANALYSIS) return { analyzable: false, total, sharedFragments: [] };
  const counts = new Map();
  for (const img of captioned) {
    const seen = new Set();
    for (const frag of splitCaptionFragments(img.caption, word)) {
      const norm = normalizeFragment(frag);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      const cur = counts.get(norm) || { fragment: frag, count: 0 };
      cur.count += 1;
      counts.set(norm, cur);
    }
  }
  const sharedFragments = [...counts.entries()]
    .filter(([, v]) => v.count >= 2 && v.count / total >= INVARIANT_SHARE_THRESHOLD)
    .map(([normalized, v]) => ({ fragment: v.fragment, normalized, count: v.count, ratio: v.count / total }))
    .sort((a, b) => b.count - a.count || a.fragment.localeCompare(b.fragment));
  return { analyzable: true, total, sharedFragments };
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
  // Vision-auto detection is the default; the grid inputs are the fallback the
  // user reaches for when no vision model is installed or auto-detect mis-cuts.
  const [useVision, setUseVision] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    try {
      const result = await sliceLoraDatasetRefSheet(dataset.id, { cols, rows, useVision });
      const via = result.method === 'vision' ? 'auto-detected' : 'grid';
      toast.success(`Added ${result.images.length} ${via} crops from the reference sheet — prune any bad ones`);
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
          Cuts the character&apos;s reference-sheet turnaround into individual training crops.
          Sheet layouts vary, so expect to delete cells that caught labels or palette swatches.
        </p>
        <label htmlFor="lt-slice-vision" className="flex items-start gap-2 text-sm text-gray-300">
          <input
            id="lt-slice-vision"
            type="checkbox"
            checked={useVision}
            onChange={(e) => setUseVision(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Auto-detect figures with a vision model
            <span className="block text-xs text-gray-500">
              Proposes a crop per figure instead of a rigid grid. Falls back to the grid below if no
              vision model is installed or detection finds nothing.
            </span>
          </span>
        </label>
        <div className={`grid grid-cols-2 gap-3 ${useVision ? 'opacity-50' : ''}`}>
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
            {useVision ? 'Auto-slice' : `Slice ${cols}×${rows}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ReassignDialog({ dataset, onClose, onReassigned }) {
  // Default to the current assignment so the picker opens on the dataset's
  // own universe (subjects pre-load) and the user only changes what they want.
  const [universeId, setUniverseId] = useState(dataset.character.universeId);
  const [entryKind, setEntryKind] = useState(subjectKind(dataset));
  const [entryId, setEntryId] = useState(dataset.character.entryId);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    try {
      const next = await patchLoraDataset(dataset.id, { universeId, entryKind, entryId });
      toast.success(`Reassigned to ${next.character.name}`);
      onReassigned(next);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      ariaLabelledBy="lt-reassign-title"
      panelClassName="bg-port-card border border-port-border rounded-lg p-5"
    >
      <div className="space-y-4">
        <h2 id="lt-reassign-title" className="text-base font-semibold text-white">Reassign subject</h2>
        <p className="text-sm text-gray-400">
          Move this dataset&apos;s images and trigger word to a different universe bible subject.
          The trigger word stays the same — edit it separately if the new subject needs its own token.
        </p>
        <UniverseCharacterPicker
          idPrefix="lt-reassign"
          universeId={universeId}
          entryKind={entryKind}
          entryId={entryId}
          onUniverseChange={(id) => { setUniverseId(id); setEntryId(''); }}
          onEntryKindChange={(kind) => { setEntryKind(kind); setEntryId(''); }}
          onEntryChange={setEntryId}
        />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-2 text-sm text-gray-400 hover:text-white">Cancel</button>
          <button
            type="button"
            onClick={submit}
            disabled={!universeId || !entryId || submitting}
            className="px-3 py-2 text-sm rounded bg-port-accent text-white disabled:opacity-50 flex items-center gap-2"
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Replace className="w-4 h-4" />}
            Reassign
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
  const [subject, setSubject] = useState(null);
  const [variationAxes, setVariationAxes] = useState(null);
  const [triggerDraft, setTriggerDraft] = useState(null);
  const [triggerSaving, setTriggerSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [showGenerate, setShowGenerate] = useState(false);
  const [showSlice, setShowSlice] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showReassign, setShowReassign] = useState(false);
  const [captionRun, setCaptionRun] = useState(null);
  const [captionStarting, setCaptionStarting] = useState(false);
  // Chosen caption model { providerId, model } — null fields mean "let the
  // server auto-pick a vision model". Lifted from CaptionModelPicker so caption
  // runs pass the explicit selection.
  const [captionModel, setCaptionModel] = useState({ providerId: null, model: null });
  const [strippingFragments, setStrippingFragments] = useState(false);
  // Bumped after a bulk caption rewrite (strip) so the image grid drops any
  // unsaved caption drafts the rewrite superseded — otherwise a stale draft
  // blur-saves the old text back, undoing the strip.
  const [captionDraftResetToken, setCaptionDraftResetToken] = useState(0);
  const fileInputRef = useRef(null);

  const refresh = useCallback(() => getLoraDataset(datasetId)
    .then((d) => { setDataset(d); return d; })
    .catch((err) => { setLoadError(err?.message || 'Dataset not found'); return null; }), [datasetId]);

  useEffect(() => { refresh(); }, [refresh]);

  // Pull the live canon subject once for variation-axis options + sheet link.
  useEffect(() => {
    if (!dataset?.character?.universeId) return;
    getUniverse(dataset.character.universeId, { silent: true })
      .then((u) => {
        const entries = Array.isArray(u?.[subjectKind(dataset)]) ? u[subjectKind(dataset)] : [];
        setSubject(entries.find((entry) => entry.id === dataset.character.entryId) || null);
      })
      .catch(() => {});
  }, [dataset?.character?.universeId, dataset?.character?.entryKind, dataset?.character?.entryId]);

  // Object/place variation axes (Lighting/Settings) live as server-side
  // constants in deriveVariationAxes — fetch them so the generate-batch
  // override chips render without mirroring the vocab client-side. Characters
  // seed their chips from live canon (expressions/wardrobes) instead.
  useEffect(() => {
    if (!datasetId || subjectKind(dataset) === 'characters') {
      setVariationAxes(null);
      return undefined;
    }
    // Clear first so a direct object↔place switch can't seed the generate
    // dialog from the previous kind's axes while the new fetch is in flight,
    // and cancel-on-cleanup so a late response can't overwrite the current one.
    let cancelled = false;
    setVariationAxes(null);
    getLoraDatasetVariationAxes(datasetId, { silent: true })
      .then((axes) => { if (!cancelled) setVariationAxes(axes); })
      .catch(() => { if (!cancelled) setVariationAxes(null); });
    return () => { cancelled = true; };
  }, [datasetId, dataset?.character?.entryKind]);

  // Readiness is derived from the live local images (not the server's snapshot
  // on `dataset.readiness`) so manual caption edits / deletes reflect in the
  // counts + Train gate immediately, without a refetch per keystroke.
  const readiness = useMemo(
    () => deriveReadiness(dataset?.images, dataset?.triggerWord),
    [dataset?.images, dataset?.triggerWord],
  );

  // Caption-lint advisory: identity fragments repeated across most captions
  // (issue #1320). Derived live so it tracks manual caption edits without a
  // refetch; the "Strip" action recomputes server-side.
  const captionInvariants = useMemo(
    () => analyzeCaptionInvariants(dataset?.images, dataset?.triggerWord),
    [dataset?.images, dataset?.triggerWord],
  );

  const stripSharedFragments = async () => {
    setStrippingFragments(true);
    try {
      const { dataset: next, removedFragments, updatedImages } = await stripLoraDatasetSharedCaptionFragments(datasetId);
      setDataset(next);
      setCaptionDraftResetToken((n) => n + 1);
      if (removedFragments.length) {
        toast.success(`Stripped ${removedFragments.length} shared identity fragment${removedFragments.length === 1 ? '' : 's'} from ${updatedImages} caption${updatedImages === 1 ? '' : 's'}`);
      } else {
        toast.success('No shared identity fragments to strip');
      }
    } finally {
      setStrippingFragments(false);
    }
  };

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
    () => (subjectKind(dataset) === 'characters'
      ? (subject?.expressions || []).map((e) => e?.name).filter(Boolean)
      : (variationAxes?.expressions || [])),
    [dataset, subject, variationAxes],
  );
  const outfitOptions = useMemo(
    () => (subjectKind(dataset) === 'characters'
      ? (subject?.wardrobes || []).map((w) => w?.name).filter(Boolean)
      : (variationAxes?.outfits || [])),
    [dataset, subject, variationAxes],
  );
  const hasReferenceSheet = !!(subject?.referenceSheetImageRef
    || Object.values(subject?.referenceSheets || {}).some(Boolean));

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
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-lg font-semibold text-white truncate">
              <Link
                to={`/universes/${dataset.character.universeId}`}
                className="hover:text-port-accent"
                title="Open in universe editor"
              >
                {dataset.character.name}
              </Link>
            </h2>
            <button
              type="button"
              onClick={() => setShowReassign(true)}
              disabled={dataset.status === 'training'}
              title={dataset.status === 'training'
                ? 'Cancel the in-progress training run before reassigning'
                : 'Reassign this dataset to a different universe subject'}
              className="shrink-0 text-xs text-gray-500 hover:text-port-accent flex items-center gap-1 disabled:opacity-40 disabled:hover:text-gray-500"
            >
              <Replace className="w-3.5 h-3.5" /> Reassign
            </button>
          </div>
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
          <div className="text-xs text-gray-500 mt-1">
            {SUBJECT_TYPE_LABEL[subjectKind(dataset)] || 'Subject'} from the universe bible
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

      {captionInvariants.sharedFragments.length > 0 && (
        <div className="bg-port-warning/10 border border-port-warning/40 rounded-lg p-3 text-sm">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-port-warning shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1 space-y-2">
              <p className="text-gray-200">
                <span className="font-medium text-port-warning">Identity is leaking into the captions.</span>
                {' '}
                These fragments repeat across most captions, so the model binds the look to the phrases instead of the
                {' '}
                <span className="font-mono text-gray-300">{dataset.triggerWord || 'trigger'}</span>
                {' '}
                token — the trigger then renders a generic subject. Keep only what changes shot-to-shot (pose, framing,
                setting) and let the trigger absorb the fixed identity.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {captionInvariants.sharedFragments.map((f) => (
                  <span
                    key={f.normalized}
                    className="text-xs px-1.5 py-0.5 rounded bg-port-bg border border-port-border text-gray-300 font-mono"
                    title={`in ${f.count} of ${captionInvariants.total} captions`}
                  >
                    {f.fragment}
                    <span className="text-gray-500"> ·{f.count}/{captionInvariants.total}</span>
                  </span>
                ))}
              </div>
              <button
                type="button"
                onClick={stripSharedFragments}
                disabled={strippingFragments || !!captionRun}
                className="px-3 py-1.5 text-xs rounded bg-port-warning/20 text-port-warning hover:bg-port-warning/30 flex items-center gap-2 disabled:opacity-50"
                title="Remove these shared fragments from every caption, keeping the trigger word and per-shot detail"
              >
                {strippingFragments ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eraser className="w-3.5 h-3.5" />}
                Strip shared identity from all captions
              </button>
            </div>
          </div>
        </div>
      )}

      <details className="bg-port-card border border-port-border rounded-lg text-sm">
        <summary className="cursor-pointer select-none px-3 py-2 flex items-center gap-2 text-gray-300 hover:text-white">
          <Lightbulb className="w-4 h-4 text-port-warning shrink-0" />
          <span className="font-medium">Tips for a strong training dataset</span>
          <span className="text-xs text-gray-500">
            target ~{RECOMMENDED_TRAINING_IMAGES}–{TRAINING_IMAGE_SWEET_SPOT_MAX} images · {MIN_TRAINING_IMAGES} minimum
          </span>
        </summary>
        <div className="px-3 pb-3 pt-1 text-xs text-gray-400 space-y-2 border-t border-port-border/60">
          <p>
            Quality beats quantity. {MIN_TRAINING_IMAGES} images is the floor; ~{RECOMMENDED_TRAINING_IMAGES}–{TRAINING_IMAGE_SWEET_SPOT_MAX} sharp,
            varied shots is the sweet spot. Past ~50 you mostly add training time and overfitting risk —
            near-duplicate frames teach the model to memorize one setup instead of learning the subject.
          </p>
          <ul className="list-disc pl-4 space-y-1">
            <li><span className="text-gray-300">Vary the angle</span> — front, three-quarter, profile, and a back view.</li>
            <li><span className="text-gray-300">Vary the framing</span> — mix tight face close-ups (for likeness) with mid and full-body shots (for proportions).</li>
            <li><span className="text-gray-300">Vary pose, presentation &amp; expression</span> — action and rest for characters; display angles and use context for objects and places.</li>
            <li><span className="text-gray-300">Vary outfit, lighting &amp; background</span> — so the LoRA learns the subject, not one costume, key light, or backdrop.</li>
            <li><span className="text-gray-300">Keep it single-subject and on-model</span> — one clearly-visible subject per image, consistent identity, no clutter.</li>
            <li><span className="text-gray-300">Drop the weak ones</span> — blurry, occluded, or off-model frames hurt more than they help; avoid near-duplicates.</li>
          </ul>
          <p className="pt-1 border-t border-port-border/60">
            <span className="text-gray-300">Caption what changes shot-to-shot, not who the subject is.</span> The
            {' '}
            <span className="font-mono text-gray-400">{dataset.triggerWord || 'trigger word'}</span>
            {' '}
            token is what the LoRA binds the fixed identity to — describe pose, framing, expression, outfit, and setting
            in each caption, and leave invariant features (hair, eyes, skin, signature items) out. Repeating the same
            identity phrases in every caption teaches those words instead of the trigger, so the bare trigger then
            renders a generic subject. Captions are auto-prefixed with the trigger; this page warns when identity
            fragments repeat across most captions and offers a one-click strip.
          </p>
        </div>
      </details>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4 items-start">
        <DatasetImageGrid
          dataset={dataset}
          onImagesChange={onImagesChange}
          onCaptionRunStarted={setCaptionRun}
          captionModel={captionModel}
          draftResetToken={captionDraftResetToken}
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
      {showReassign && (
        <ReassignDialog
          dataset={dataset}
          onClose={() => setShowReassign(false)}
          onReassigned={(next) => { setShowReassign(false); setDataset(next); }}
        />
      )}
    </div>
  );
}
