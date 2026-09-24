import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { composeStyledPrompt } from '../lib/composeStyledPrompt';
import {
  IMAGE_GEN_MODE,
  isCloudCliMode,
  modeLabel,
} from '../lib/imageGenBackends';
import { clampImageEdge } from '../lib/imageGenResolutions';
import { useImageGenForm } from './useImageGenForm';
import { useImageGenGallery } from './useImageGenGallery';
import { useAutoRefetch } from './useAutoRefetch';
import { useFederatedMediaTarget } from './useFederatedMediaTarget';
import { useImageGenProgress } from './useImageGenProgress';
import { useMediaCompletionRefresh } from './useMediaCompletionRefresh';
import { useMediaJobSse } from './useMediaJobSse';
import { useModelDownloadStatus } from './useModelDownloadStatus';
import { useHfTokenStatus } from './useHfTokenStatus';
import { useAgyModels } from './useAgyModels';
import toast from '../components/ui/Toast';
import {
  buildFormData,
  cancelImageGen,
  generateImage,
  generateImageMultipart,
  getActiveImageJob,
  getFlux2Status,
  getImageGenStatus,
  getRegenAvailability,
  listMediaJobs,
  regenerateGalleryImage,
} from '../services/api';

const STAGE_LABELS = {
  starting: 'Starting…',
  'download-tokenizer': 'Loading tokenizer…',
  'download-pipeline': 'Downloading model weights (~8 GB on first run)…',
  'download-snapshot': 'Downloading model weights…',
  'download-int8-snapshot': 'Downloading model weights (~16 GB on first run)…',
  'load-transformer': 'Loading transformer…',
  'load-text-encoder': 'Loading text encoder…',
  'move-to-device': 'Moving model to GPU…',
  inference: 'Running diffusion…',
};

function useImageGenBackendRuntime() {
  const [status, setStatus] = useState(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [selectedMode, setSelectedMode] = useState(null);
  const [availableBackends, setAvailableBackends] = useState([]);
  const selectedModeRef = useRef(null);
  selectedModeRef.current = selectedMode;
  const statusRequestToken = useRef(0);
  const effectiveMode = selectedMode || status?.mode || IMAGE_GEN_MODE.EXTERNAL;
  const isLocalMode = effectiveMode === IMAGE_GEN_MODE.LOCAL;
  const isCloudMode = isCloudCliMode(effectiveMode);
  const cloudModeLabel = modeLabel(effectiveMode);
  const isAgyMode = effectiveMode === IMAGE_GEN_MODE.AGY;
  const remoteTarget = useFederatedMediaTarget('image');
  const remoteTargetActive = effectiveMode !== IMAGE_GEN_MODE.GROK && remoteTarget.isRemote;
  const localBackendPending = statusLoading && !remoteTargetActive;
  const agy = useAgyModels(isAgyMode);

  const refreshStatus = useCallback((mode, localModelId) => {
    const requestToken = ++statusRequestToken.current;
    setStatusLoading(true);
    getImageGenStatus(mode, mode === IMAGE_GEN_MODE.LOCAL ? localModelId : undefined)
      .then((nextStatus) => {
        if (requestToken !== statusRequestToken.current) return;
        setStatus(nextStatus);
      })
      .catch(() => {
        if (requestToken !== statusRequestToken.current) return;
        setStatus({ connected: false, reason: 'Status check failed' });
      })
      .finally(() => {
        if (requestToken === statusRequestToken.current) setStatusLoading(false);
      });
  }, []);

  const configureBackends = useCallback((backends, savedMode) => {
    const previous = selectedModeRef.current;
    const next = (previous && backends.find((backend) => backend.id === previous)) ? previous
      : backends.find((backend) => backend.id === savedMode) ? savedMode
      : backends.length ? backends[0].id
      : savedMode;
    setAvailableBackends(backends);
    setSelectedMode(next);
    return next;
  }, []);

  return {
    status,
    statusLoading,
    availableBackends,
    effectiveMode,
    isLocalMode,
    isCloudMode,
    cloudModeLabel,
    isAgyMode,
    remoteTarget,
    remoteTargetActive,
    localBackendPending,
    agy,
    refreshStatus,
    setSelectedMode,
    configureBackends,
  };
}

export function useImageGenPageRuntime() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const settingsOpen = searchParams.get('settings') === '1';
  const openSettings = () => setSearchParams((previous) => {
    const next = new URLSearchParams(previous);
    next.set('settings', '1');
    return next;
  });
  const closeSettings = () => setSearchParams((previous) => {
    const next = new URLSearchParams(previous);
    next.delete('settings');
    return next;
  });
  const backend = useImageGenBackendRuntime();
  const form = useImageGenForm({ searchParams, setSearchParams, backend });
  const gallery = useImageGenGallery({ previewParam: searchParams.get('preview') });
  const [flux2Status, setFlux2Status] = useState(null);
  const [flux2InstallOpen, setFlux2InstallOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [errorMeta, setErrorMeta] = useState(null);
  const [localProgress, setLocalProgress] = useState(null);
  const [pendingQueued, setPendingQueued] = useState(0);
  const [stage, setStage] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [regenInfo, setRegenInfo] = useState(null);
  const { attach: attachJobEvents, eventSourceRef } = useMediaJobSse('image');
  const { progress: externalProgress, begin: beginGenerate, end: endGenerate, resume: resumeGenerate } = useImageGenProgress();
  useMediaCompletionRefresh({ onImageCompleted: gallery.refreshRecent });
  const modelDownload = useModelDownloadStatus({ kind: 'image' });
  const { present: hfTokenPresent, refresh: refreshHfTokenStatus } = useHfTokenStatus({ enabled: form.derived.needsHfTokenGate });
  const progress = externalProgress || localProgress;
  const progressPct = progress?.progress != null ? Math.round(progress.progress * 100) : null;
  const { fields, derived, images, actions } = form;
  const { effectiveMode, isCloudMode, remoteTargetActive } = backend;
  const effectiveAgyModel = backend.agy.models.includes(fields.agyModel) ? fields.agyModel : '';

  useEffect(() => {
    if (!effectiveMode) return;
    backend.refreshStatus(effectiveMode, fields.modelId);
  }, [effectiveMode, fields.modelId, backend.refreshStatus]);

  const refreshFlux2Status = useCallback((signal) => getFlux2Status({ modelId: fields.modelId, signal })
    .then((status) => { if (status) setFlux2Status(status); })
    .catch(() => {}), [fields.modelId]);

  const handleFlux2ModalClose = useCallback(() => setFlux2InstallOpen(false), []);
  const handleFlux2InstallComplete = useCallback(() => {
    refreshFlux2Status();
    backend.refreshStatus(effectiveMode, fields.modelId);
    toast.success('FLUX.2 runtime installed');
  }, [refreshFlux2Status, backend.refreshStatus, effectiveMode, fields.modelId]);

  useEffect(() => {
    if (!derived.sharesFlux2Venv) {
      setFlux2Status(null);
      return;
    }
    const controller = new AbortController();
    refreshFlux2Status(controller.signal);
    return () => controller.abort();
  }, [derived.sharesFlux2Venv, fields.modelId, refreshFlux2Status]);

  useEffect(() => {
    let active = true;
    getActiveImageJob().then(({ activeJob }) => {
      if (!active || !activeJob) return;
      actions.restoreActiveJob(activeJob);
      setGenerating(true);
      setStatusMsg('Resuming…');
      resumeGenerate(activeJob);
      attachJobEvents(activeJob.generationId, {
        onStatus: (message) => setStatusMsg(message.message),
        onProgress: (message) => setLocalProgress({ progress: message.progress }),
        onComplete: () => setGenerating(false),
        onError: () => setGenerating(false),
        onCanceled: () => setGenerating(false),
        onConnectionError: () => setGenerating(false),
      }).catch(() => {});
    }).catch(() => {});
    return () => {
      active = false;
      eventSourceRef.current?.close();
    };
  }, [actions.restoreActiveJob, attachJobEvents, eventSourceRef, resumeGenerate]);

  const regenAvailable = !!regenInfo?.available;
  const refreshRegenAvailability = useCallback(() => {
    getRegenAvailability().then((availability) => setRegenInfo(availability || null)).catch(() => {});
  }, []);
  useEffect(() => { refreshRegenAvailability(); }, [refreshRegenAvailability]);

  const wasSettingsOpenRef = useRef(false);
  useEffect(() => {
    if (wasSettingsOpenRef.current && !settingsOpen) {
      refreshRegenAvailability();
      form.settings.reloadBackends();
    }
    wasSettingsOpenRef.current = settingsOpen;
  }, [settingsOpen, refreshRegenAvailability, form.settings.reloadBackends]);

  const queueActive = pendingQueued > 0;
  const lastBusyRef = useRef(0);
  const pollQueue = useCallback(async () => {
    const jobs = await listMediaJobs({ kind: 'image' }).catch(() => null);
    if (!jobs) return;
    const stillBusy = jobs.filter((job) => job.status === 'queued' || job.status === 'running').length;
    const next = Math.max(0, stillBusy - (generating ? 1 : 0));
    if (stillBusy < lastBusyRef.current) gallery.refreshRecent();
    lastBusyRef.current = stillBusy;
    setPendingQueued((previous) => (previous === next ? previous : next));
  }, [generating, gallery.refreshRecent]);
  useAutoRefetch(pollQueue, 4000, { enabled: queueActive, pollOnly: true });

  const submitGenerationPayload = async () => {
    const composed = composeStyledPrompt(fields.prompt, fields.negativePrompt, derived.activeStylePresets);
    const width = clampImageEdge(fields.width);
    const height = clampImageEdge(fields.height);
    const payload = remoteTargetActive ? {
      prompt: composed.prompt,
      negativePrompt: composed.negativePrompt || undefined,
      width,
      height,
      steps: fields.steps ? Number(fields.steps) : undefined,
      guidance: fields.guidance ? Number(fields.guidance) : undefined,
      seed: fields.seed && Number(fields.seed) >= 0 ? Number(fields.seed) : undefined,
      ...backend.remoteTarget.submissionFields,
    } : isCloudMode ? {
      prompt: composed.prompt,
      negativePrompt: composed.negativePrompt || undefined,
      width,
      height,
      mode: effectiveMode,
      ...(effectiveAgyModel ? { cloudModel: effectiveAgyModel } : {}),
      cleanC2PA: fields.cleanC2PA,
      denoise: fields.denoise,
    } : {
      prompt: composed.prompt,
      negativePrompt: composed.negativePrompt || undefined,
      modelId: fields.modelId || undefined,
      width,
      height,
      steps: fields.steps ? Number(fields.steps) : undefined,
      guidance: fields.guidance ? Number(fields.guidance) : undefined,
      seed: fields.seed && Number(fields.seed) >= 0 ? Number(fields.seed) : undefined,
      quantize: fields.quantize,
      loraFilenames: fields.selectedLoras.map((lora) => lora.filename),
      loraScales: fields.selectedLoras.map((lora) => lora.scale),
      mode: IMAGE_GEN_MODE.LOCAL,
      cleanC2PA: fields.cleanC2PA,
      denoise: fields.denoise,
    };
    const hasInitImage = derived.i2iCapable && images.initImage.source != null;
    const hasReferenceImages = derived.populatedRefs.length > 0;
    if (hasInitImage || hasReferenceImages) {
      const initFields = hasInitImage ? {
        ...(images.initImage.source === 'upload'
          ? { initImage: images.initImage.file }
          : { initImageFile: images.initImage.name }),
        initImageStrength: images.initImageStrength,
      } : {};
      const referenceFields = hasReferenceImages ? {
        ...Object.fromEntries(derived.populatedRefs.map((slot, index) => [`referenceImage${index + 1}`, slot.file])),
        referenceStrengths: derived.populatedRefs.map((slot) => slot.strength),
      } : {};
      const formData = buildFormData({ ...payload, ...initFields, ...referenceFields });
      return { payload, data: await generateImageMultipart(formData, { silent: true }) };
    }
    return { payload, data: await generateImage(payload, { silent: true }) };
  };

  const startLocalGeneration = async () => {
    setLocalProgress({ progress: 0 });
    const { payload, data } = await submitGenerationPayload();
    const jobId = data.jobId || data.generationId;
    return attachJobEvents(jobId, {
      onStage: (message) => setStage({ name: message.stage, detail: message.detail }),
      onStatus: (message) => setStatusMsg(message.message),
      onProgress: (message) => {
        setLocalProgress({ progress: message.progress, phase: message.phase });
        setStatusMsg(message.message);
      },
      onComplete: (message) => {
        const localOnlyMeta = isCloudMode ? {} : {
          steps: payload.steps ?? derived.currentModel?.steps,
          guidance: payload.guidance ?? derived.currentModel?.guidance,
        };
        setResult({
          ...data,
          ...message.result,
          prompt: payload.prompt,
          negativePrompt: payload.negativePrompt,
          width: payload.width,
          height: payload.height,
          ...localOnlyMeta,
        });
        return message.result;
      },
      onError: (message) => {
        const generationError = new Error(message.error);
        if (message.kind) generationError.kind = message.kind;
        if (message.repo) generationError.repo = message.repo;
        return generationError;
      },
    });
  };

  const queueAdditional = async (count = 1) => {
    if (count < 1) return;
    const submissions = Array.from({ length: count }, () => (
      submitGenerationPayload().then(({ data }) => data).catch((generationError) => generationError)
    ));
    const results = await Promise.all(submissions);
    const queued = results.filter((result) => result && !(result instanceof Error)).length;
    const failed = results.length - queued;
    if (queued > 0) setPendingQueued((countValue) => countValue + queued);
    if (queued > 0) toast.success(count === 1 ? 'Queued' : `Queued ${queued}`);
    if (failed > 0) toast.error(`${failed} job(s) failed to queue`);
  };

  const handleGenerate = async (event) => {
    event?.preventDefault?.();
    if (form.remix.pending) return;
    if (derived.editImageMissing || derived.cloudNeedsPrompt) return;
    if (derived.localBackendPending || (!remoteTargetActive && derived.notConnected)) return;
    if (remoteTargetActive) {
      if (derived.remoteUnsupportedInputs) {
        toast.error(derived.remoteUnsupportedInputs);
        return;
      }
      const fresh = backend.remoteTarget.verify();
      if (!fresh.ok) {
        toast.error(fresh.message);
        return;
      }
    }
    const batch = derived.isAsyncMode ? Math.max(1, fields.batchCount) : 1;
    if (generating) return queueAdditional(batch);
    const width = clampImageEdge(fields.width);
    const height = clampImageEdge(fields.height);
    if (width !== fields.width) fields.setWidth(width);
    if (height !== fields.height) fields.setHeight(height);
    setGenerating(true);
    setStatusMsg('Starting...');
    setError(null);
    setErrorMeta(null);
    setResult(null);
    setStage(null);
    beginGenerate();

    try {
      if (derived.isAsyncMode) {
        const extras = batch > 1 ? queueAdditional(batch - 1) : Promise.resolve();
        await startLocalGeneration();
        await extras;
      } else {
        const composed = composeStyledPrompt(fields.prompt, fields.negativePrompt, derived.activeStylePresets);
        const payload = {
          prompt: composed.prompt,
          negativePrompt: composed.negativePrompt || undefined,
          width,
          height,
          steps: fields.steps ? Number(fields.steps) : 25,
          cfgScale: fields.cfgScale,
          mode: IMAGE_GEN_MODE.EXTERNAL,
          cleanC2PA: fields.cleanC2PA,
          denoise: fields.denoise,
        };
        if (fields.seed && Number(fields.seed) >= 0) payload.seed = Number(fields.seed);
        const data = await generateImage(payload, { silent: true });
        setResult({
          ...data,
          prompt: payload.prompt,
          negativePrompt: payload.negativePrompt,
          width,
          height,
          steps: payload.steps,
          cfgScale: payload.cfgScale,
        });
      }
      toast.success('Image generated');
      gallery.refreshRecent();
    } catch (generationError) {
      setError(generationError.message || 'Image generation failed');
      if (generationError.kind) setErrorMeta({ kind: generationError.kind, repo: generationError.repo });
      const firstLine = String(generationError.message || 'Image generation failed').split('\n')[0];
      toast.error(firstLine);
    } finally {
      setGenerating(false);
      setLocalProgress(null);
      setStage(null);
      endGenerate();
    }
  };

  const handleCancel = async () => {
    eventSourceRef.current?.close();
    await cancelImageGen().catch(() => {});
    setGenerating(false);
    setStatusMsg('Cancelled');
  };

  const handleRegenerate = async (image, options = {}) => {
    if (!image?.filename) throw new Error('Missing filename');
    if (options.method === 'light') {
      const variant = await regenerateGalleryImage(image.filename, { method: 'light' }).catch((generationError) => {
        toast.error(generationError.message || 'Failed to run light regen');
        throw generationError;
      });
      gallery.actions.prependVariant(variant);
      toast.success(`Light regen → ${variant.filename}`);
      return;
    }
    await regenerateGalleryImage(image.filename, { strength: options.strength, prompt: options.prompt }).catch((generationError) => {
      toast.error(generationError.message || 'Failed to start regeneration');
      throw generationError;
    });
    setPendingQueued((count) => count + 1);
    toast.success('Regenerating — the new image will appear when it finishes');
  };

  const sendToVideo = useCallback((item) => {
    const image = item?.raw || item;
    if (!image?.filename) return;
    const params = new URLSearchParams({ sourceImageFile: image.filename });
    const sourcePrompt = image.prompt || image.metadata?.prompt;
    const sourceNegative = image.negativePrompt || image.negative_prompt || image.metadata?.negativePrompt;
    if (sourcePrompt) params.set('prompt', sourcePrompt);
    if (sourceNegative) params.set('negativePrompt', sourceNegative);
    navigate(`/media/video?${params}`);
  }, [navigate]);

  const handleSendToImage = useCallback((item) => {
    const image = item?.raw || item;
    if (!image?.filename) return;
    actions.handleRemix(image, { applyModel: false });
    fields.setPrompt(image.prompt || '');
    actions.ensureI2iCapableMode();
    actions.setGalleryInitImage(image.filename);
  }, [actions.ensureI2iCapableMode, actions.handleRemix, actions.setGalleryInitImage, fields.setPrompt]);

  const handleSendTo3d = useCallback((item) => {
    const image = item?.raw || item;
    if (!image?.filename) return;
    navigate(`/3d?image=${encodeURIComponent(image.filename)}`);
  }, [navigate]);

  return {
    form,
    backend: { ...backend, effectiveAgyModel },
    generation: {
      handleGenerate,
      handleCancel,
      generating,
      statusMsg,
      errorMeta,
      progress,
      progressPct,
      pendingQueued,
      stage,
      stageLabel: stage ? (STAGE_LABELS[stage.name] || stage.name) : null,
      result,
      error,
      modelDownload,
      hfTokenPresent,
      refreshHfTokenStatus,
      flux2Status,
      refreshFlux2Status,
      needsFlux2Token: derived.isFlux2Model && !!flux2Status && flux2Status.venvInstalled && !flux2Status.hfTokenPresent,
      handleRegenerate,
    },
    gallery: {
      view: gallery.view,
      cards: {
        setPreview: gallery.preview.set,
        handleRemix: actions.handleRemix,
        handleSendToImage,
        sendToVideo,
        handleSendTo3d,
        handleDelete: gallery.actions.delete,
        handleToggleHidden: gallery.actions.toggleHidden,
        getCardProps: gallery.getCardProps,
        toggleGalleryStar: gallery.actions.toggleStar,
      },
      overlay: {
        value: gallery.preview.value,
        set: gallery.preview.set,
        items: gallery.preview.items,
        annotations: gallery.preview.annotations,
        updateAnnotation: gallery.preview.updateAnnotation,
        onPromptSaved: gallery.actions.promptSaved,
        onRemix: (item) => item?.raw && actions.handleRemix(item.raw),
        onSendToImage: (item) => item?.raw?.filename && handleSendToImage(item.raw),
        onSendToVideo: (item) => item?.raw?.filename && sendToVideo(item.raw),
        onSendTo3d: (item) => item?.raw?.filename && handleSendTo3d(item.raw),
        onClean: (item) => gallery.actions.clean(item?.raw),
        onRegenerate: (item, options) => handleRegenerate(item?.raw, options),
        onRemoveWatermark: (item) => gallery.actions.removeWatermark(item?.raw),
        regenAvailable,
        regenBounds: regenInfo,
      },
      picker: {
        value: images.galleryPicker,
        onClose: () => images.setGalleryPicker(null),
        onSelect: images.handleGallerySelect,
      },
    },
    header: {
      status: {
        loading: backend.statusLoading,
        value: backend.status,
        ready: derived.statusReady,
        unknown: derived.statusUnknown,
        mode: effectiveMode,
      },
      backends: {
        available: backend.availableBackends,
        value: effectiveMode,
        onChange: actions.switchMode,
      },
      remix: form.remix,
      actions: {
        onRefresh: () => backend.refreshStatus(effectiveMode, fields.modelId),
        onOpenSettings: openSettings,
        onInstallRuntime: () => setFlux2InstallOpen(true),
      },
    },
    settings: {
      open: settingsOpen,
      onClose: closeSettings,
    },
    flux2: {
      open: flux2InstallOpen,
      onClose: handleFlux2ModalClose,
      onComplete: handleFlux2InstallComplete,
      modelId: fields.modelId,
    },
  };
}
