import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { appendTriggerWords } from '../lib/loraTriggers';
import { composeStyledPrompt } from '../lib/composeStyledPrompt';
import { universeStylePreset } from '../lib/universeStylePreset';
import { RUNNER_FAMILIES, loraCompatKey, usesDiffusersRunner } from '../lib/runnerFamilies';
import {
  IMAGE_GEN_MODE,
  LOCAL_IMAGEGEN_DEFAULT_MODEL,
  cloudPromptRequired,
  deriveAvailableBackends,
  imageGenReadiness,
  isI2iCapableMode,
  pickI2iMode,
  referenceSlotsFor,
  supportsReferenceStrength,
} from '../lib/imageGenBackends';
import { clampImageDimensions } from '../lib/imageGenResolutions';
import { peerModelRequiresInput } from '../lib/federatedMediaReadiness.js';
import { DEFAULT_NEGATIVE_PROMPT } from '../lib/imageGenDefaults';
import { resolveCleanersFromConfig } from '../lib/imageCleaners';
import useMounted from './useMounted';
import toast from '../components/ui/Toast';
import {
  getGalleryImages,
  getSettings,
  listImageModels,
  listLorasFull,
} from '../services/api';

const REFERENCE_SLOT_COUNT = 10;
const EMPTY_REF_SLOT = { file: null, previewUrl: null, strength: 1.0 };
const IMAGE_GEN_RESTORE_PARAM_KEYS = ['prompt', 'negativePrompt', 'modelId', 'width', 'height', 'seed', 'steps', 'guidance', 'quantize'];
const IMAGE_GEN_HANDOFF_PARAM_KEYS = ['remix', ...IMAGE_GEN_RESTORE_PARAM_KEYS, 'initImageFile'];

const revokeIfBlob = (url) => {
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
};

export function useImageGenForm({ searchParams, setSearchParams, backend }) {
  const {
    status,
    effectiveMode,
    isLocalMode,
    isCloudMode,
    cloudModeLabel,
    availableBackends,
    remoteTarget,
    remoteTargetActive,
    localBackendPending,
    setSelectedMode,
    configureBackends,
  } = backend;
  const [models, setModels] = useState([]);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [modelsLoadFailed, setModelsLoadFailed] = useState(false);
  const [availableLoras, setAvailableLoras] = useState([]);
  const [lorasLoaded, setLorasLoaded] = useState(false);
  const [lorasLoadFailed, setLorasLoadFailed] = useState(false);
  const [remixHandoff, setRemixHandoff] = useState(null);
  const remixLookupSequenceRef = useRef(0);
  const remixHandoffPending = remixHandoff?.status === 'loading' || remixHandoff?.status === 'restoring';
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState(DEFAULT_NEGATIVE_PROMPT);
  const [optionsOpen, setOptionsOpen] = useState(() => (
    window.matchMedia?.('(min-width: 1024px)').matches ?? false
  ));
  const [stylePreset, setStylePreset] = useState(null);
  const [selectedUniverse, setSelectedUniverse] = useState(null);
  const [modelId, setModelId] = useState('');
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(1024);
  const [steps, setSteps] = useState('');
  const [guidance, setGuidance] = useState('');
  const [cfgScale, setCfgScale] = useState(7);
  const [quantize, setQuantize] = useState('8');
  const [seed, setSeed] = useState('');
  const [selectedLoras, setSelectedLoras] = useState([]);
  const [agyModel, setAgyModel] = useState('');
  const [savedAgyModel, setSavedAgyModel] = useState('');
  const [savedLocalModelId, setSavedLocalModelId] = useState(null);
  const [initImage, setInitImage] = useState({ source: null, file: null, name: null, previewUrl: null });
  const initImagePreviewRef = useRef(initImage.previewUrl);
  initImagePreviewRef.current = initImage.previewUrl;
  const mountedRef = useMounted();
  const pickSeqRef = useRef({ init: 0, refs: [] });
  const [initImageStrength, setInitImageStrength] = useState(0.4);
  const [galleryPicker, setGalleryPicker] = useState(null);
  const [referenceImages, setReferenceImages] = useState(() => Array.from({ length: REFERENCE_SLOT_COUNT }, () => ({ ...EMPTY_REF_SLOT })));
  const [batchCount, setBatchCount] = useState(1);
  const [cleanC2PA, setCleanC2PA] = useState(true);
  const [denoise, setDenoise] = useState(false);
  const [savedCleanC2PAByMode, setSavedCleanC2PAByMode] = useState({});
  const [savedDenoiseByMode, setSavedDenoiseByMode] = useState({});
  const wantI2iModeRef = useRef(false);

  useEffect(() => {
    const desktopOptions = window.matchMedia?.('(min-width: 1024px)');
    if (!desktopOptions) return undefined;
    const syncOptionsToViewport = () => setOptionsOpen(desktopOptions.matches);
    syncOptionsToViewport();
    desktopOptions.addEventListener('change', syncOptionsToViewport);
    return () => desktopOptions.removeEventListener('change', syncOptionsToViewport);
  }, []);

  const reloadBackends = useCallback(() => getSettings().then((settings) => {
    const backends = deriveAvailableBackends(settings);
    const perMode = {
      external: resolveCleanersFromConfig(settings?.imageGen?.external, IMAGE_GEN_MODE.EXTERNAL),
      local: resolveCleanersFromConfig(settings?.imageGen?.local, IMAGE_GEN_MODE.LOCAL),
      codex: resolveCleanersFromConfig(settings?.imageGen?.codex, IMAGE_GEN_MODE.CODEX),
      grok: resolveCleanersFromConfig(settings?.imageGen?.grok, IMAGE_GEN_MODE.GROK),
      agy: resolveCleanersFromConfig(settings?.imageGen?.agy, IMAGE_GEN_MODE.AGY),
    };
    const c2 = {
      external: perMode.external.cleanC2PA,
      local: perMode.local.cleanC2PA,
      codex: perMode.codex.cleanC2PA,
      grok: perMode.grok.cleanC2PA,
      agy: perMode.agy.cleanC2PA,
    };
    const dn = {
      external: perMode.external.denoise,
      local: perMode.local.denoise,
      codex: perMode.codex.denoise,
      grok: perMode.grok.denoise,
      agy: perMode.agy.denoise,
    };
    const saved = settings?.imageGen?.mode || IMAGE_GEN_MODE.EXTERNAL;
    const next = configureBackends(backends, saved);
    setSavedAgyModel(settings?.imageGen?.agy?.model || '');
    setSavedLocalModelId(settings?.imageGen?.local?.modelId || '');
    setSavedCleanC2PAByMode(c2);
    setSavedDenoiseByMode(dn);
    setCleanC2PA(c2[next] === true);
    setDenoise(dn[next] === true);
  }).catch(() => {
    setSavedLocalModelId('');
  }), [configureBackends]);

  const switchMode = useCallback((next) => {
    setSelectedMode(next);
    setCleanC2PA(savedCleanC2PAByMode[next] === true);
    setDenoise(savedDenoiseByMode[next] === true);
  }, [savedCleanC2PAByMode, savedDenoiseByMode, setSelectedMode]);

  useEffect(() => {
    let active = true;
    listImageModels().then((loadedModels) => {
      if (!active) return;
      setModels(loadedModels);
      setModelsLoadFailed(false);
      setModelsLoaded(true);
    }).catch(() => {
      if (!active) return;
      setModelsLoadFailed(true);
      setModelsLoaded(true);
    });
    listLorasFull().then((loadedLoras) => {
      if (!active) return;
      setAvailableLoras(loadedLoras);
      setLorasLoadFailed(false);
      setLorasLoaded(true);
    }).catch(() => {
      if (!active) return;
      setLorasLoadFailed(true);
      setLorasLoaded(true);
    });
    reloadBackends();
    return () => { active = false; };
  }, [reloadBackends]);

  const restoreActiveJob = useCallback((activeJob) => {
    setStylePreset(null);
    setSelectedUniverse(null);
    if (activeJob.prompt) setPrompt(activeJob.prompt);
    if (activeJob.negativePrompt != null) setNegativePrompt(activeJob.negativePrompt);
    if (activeJob.modelId) setModelId(activeJob.modelId);
    if (activeJob.width) setWidth(activeJob.width);
    if (activeJob.height) setHeight(activeJob.height);
    if (activeJob.steps != null) setSteps(activeJob.steps);
    if (activeJob.guidance != null) setGuidance(activeJob.guidance);
    if (activeJob.seed != null) setSeed(activeJob.seed);
    if (activeJob.quantize != null) setQuantize(String(activeJob.quantize));
  }, []);

  useEffect(() => {
    if (modelId || savedLocalModelId === null || !models.length) return;
    const preferredId = models.some((model) => model.id === savedLocalModelId)
      ? savedLocalModelId
      : LOCAL_IMAGEGEN_DEFAULT_MODEL;
    setModelId(models.some((model) => model.id === preferredId) ? preferredId : models[0].id);
  }, [models, savedLocalModelId, modelId]);

  useEffect(() => {
    const fromUrl = searchParams.get('lora');
    if (!fromUrl || !availableLoras.length) return;
    const match = availableLoras.find((lora) => lora.filename === fromUrl);
    if (!match) return;
    setSelectedLoras((previous) => previous.find((selected) => selected.filename === fromUrl) ? previous : [...previous, {
      filename: match.filename,
      name: match.name,
      scale: typeof match.recommendedScale === 'number' ? match.recommendedScale : 1.0,
    }]);
    if (match.triggerWords?.length) {
      setPrompt((current) => appendTriggerWords(current, match.triggerWords));
    }
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      next.delete('lora');
      return next;
    }, { replace: true });
  }, [searchParams, availableLoras]);

  useEffect(() => {
    const initFile = searchParams.get('initImageFile');
    const present = IMAGE_GEN_RESTORE_PARAM_KEYS.filter((key) => searchParams.get(key) != null);
    if (!initFile && present.length === 0) return;
    const get = (key) => searchParams.get(key);
    if (get('prompt')) {
      setPrompt(get('prompt'));
      setStylePreset(null);
      setSelectedUniverse(null);
    }
    if (get('negativePrompt')) setNegativePrompt(get('negativePrompt'));
    if (get('modelId')) setModelId(get('modelId'));
    if (get('width')) setWidth(Number(get('width')));
    if (get('height')) setHeight(Number(get('height')));
    if (get('seed') != null) setSeed(get('seed'));
    if (get('steps')) setSteps(get('steps'));
    if (get('guidance')) setGuidance(get('guidance'));
    if (get('quantize')) setQuantize(get('quantize'));
    if (initFile && initImage.source == null) {
      setInitImage({ source: 'gallery', file: null, name: initFile, previewUrl: `/data/images/${initFile}` });
      wantI2iModeRef.current = true;
    }
    if (searchParams.get('remix')) return;
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      IMAGE_GEN_HANDOFF_PARAM_KEYS.forEach((key) => next.delete(key));
      return next;
    }, { replace: true });
  }, []);

  const normalizeImageOrientation = async (file) => {
    const bitmap = await window.createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
    if (!bitmap) return file;
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) return file;
    const newName = file.name.replace(/\.[^.]+$/, '.png');
    return new File([blob], newName, { type: 'image/png' });
  };

  const readImageDimensions = async (file) => {
    const bitmap = await window.createImageBitmap(file).catch(() => null);
    if (!bitmap) return null;
    const dimensions = { width: bitmap.width, height: bitmap.height };
    bitmap.close?.();
    return dimensions;
  };

  const handleRemix = useCallback((item, { applyModel = true } = {}) => {
    const image = item?.raw || item;
    setStylePreset(null);
    setSelectedUniverse(null);
    setPrompt(image.prompt ?? image.metadata?.prompt ?? '');
    setNegativePrompt(image.negativePrompt ?? image.negative_prompt ?? image.metadata?.negativePrompt ?? '');
    if (image.seed != null) setSeed(String(image.seed));
    if (image.steps) setSteps(String(image.steps));
    if (image.guidance != null) setGuidance(String(image.guidance));
    if (image.quantize) setQuantize(String(image.quantize));
    if (image.width) setWidth(image.width);
    if (image.height) setHeight(image.height);
    if (applyModel && image.modelId && models.some((model) => model.id === image.modelId)) setModelId(image.modelId);
    const sidecarFilenames = image.loraFilenames?.length
      ? image.loraFilenames
      : (image.loraPaths || []).map((path) => path.split(/[\\/]/).pop());
    const restored = sidecarFilenames.map((filename, index) => {
      const match = availableLoras.find((lora) => lora.filename === filename);
      return match ? { filename: match.filename, name: match.name, scale: image.loraScales?.[index] ?? 1.0 } : null;
    }).filter(Boolean);
    setSelectedLoras(restored);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [availableLoras, models]);

  const handlePickInitImage = async (event) => {
    const raw = event.target.files?.[0];
    if (!raw) return;
    const myPick = ++pickSeqRef.current.init;
    const file = await normalizeImageOrientation(raw);
    if (!mountedRef.current) return;
    if (myPick !== pickSeqRef.current.init) return;
    revokeIfBlob(initImagePreviewRef.current);
    setInitImage({ source: 'upload', file, name: file.name, previewUrl: URL.createObjectURL(file) });
    const dimensions = await readImageDimensions(file);
    if (myPick !== pickSeqRef.current.init) return;
    const clamped = dimensions && clampImageDimensions(dimensions.width, dimensions.height);
    if (clamped) {
      setWidth(clamped.width);
      setHeight(clamped.height);
    }
  };

  const handleClearInitImage = () => {
    revokeIfBlob(initImage.previewUrl);
    setInitImage({ source: null, file: null, name: null, previewUrl: null });
  };

  const handlePickGalleryInitImage = (item) => {
    if (!item?.filename) return;
    if (item.raw) {
      handleRemix(item.raw, { applyModel: false });
      setPrompt(item.raw.prompt || '');
    }
    revokeIfBlob(initImage.previewUrl);
    setInitImage({ source: 'gallery', file: null, name: item.filename, previewUrl: item.previewUrl || `/data/images/${item.filename}` });
  };

  const handlePickReferenceImage = async (slotIndex, event) => {
    const raw = event.target.files?.[0];
    if (!raw) return;
    const sequences = pickSeqRef.current.refs;
    const myPick = sequences[slotIndex] = (sequences[slotIndex] ?? 0) + 1;
    const file = await normalizeImageOrientation(raw);
    if (!mountedRef.current) return;
    if (myPick !== pickSeqRef.current.refs[slotIndex]) return;
    const previewUrl = URL.createObjectURL(file);
    setReferenceImages((previous) => {
      const next = [...previous];
      revokeIfBlob(next[slotIndex]?.previewUrl);
      next[slotIndex] = { file, previewUrl, strength: next[slotIndex]?.strength ?? 1.0 };
      return next;
    });
  };

  const handleClearReferenceImage = (slotIndex) => {
    setReferenceImages((previous) => {
      const next = [...previous];
      revokeIfBlob(next[slotIndex]?.previewUrl);
      next[slotIndex] = { ...EMPTY_REF_SLOT };
      return next;
    });
  };

  const handleReferenceStrengthChange = (slotIndex, strength) => {
    setReferenceImages((previous) => {
      const next = [...previous];
      next[slotIndex] = { ...next[slotIndex], strength };
      return next;
    });
  };

  const galleryImageToFile = async (filename) => {
    const response = await fetch(`/data/images/${encodeURIComponent(filename)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    return new File([blob], filename, { type: blob.type || 'image/png' });
  };

  const handlePickGalleryReferenceImage = async (slotIndex, item) => {
    if (!item?.filename) return;
    const file = await galleryImageToFile(item.filename).catch((error) => {
      toast.error(`Failed to load reference image: ${error.message}`);
      return null;
    });
    if (!file) return;
    setReferenceImages((previous) => {
      const next = [...previous];
      revokeIfBlob(next[slotIndex]?.previewUrl);
      next[slotIndex] = { file, previewUrl: item.previewUrl || `/data/images/${item.filename}`, strength: next[slotIndex]?.strength ?? 1.0 };
      return next;
    });
  };

  const handleGallerySelect = (item) => {
    if (galleryPicker?.kind === 'reference') handlePickGalleryReferenceImage(galleryPicker.slot, item);
    else handlePickGalleryInitImage(item);
  };

  const previewUrlsRef = useRef({ init: null, refs: [] });
  useEffect(() => {
    previewUrlsRef.current = {
      init: initImage.previewUrl,
      refs: referenceImages.map((slot) => slot.previewUrl),
    };
  });
  useEffect(() => () => {
    const { init, refs } = previewUrlsRef.current;
    revokeIfBlob(init);
    for (const url of refs) revokeIfBlob(url);
  }, []);

  const currentModel = models.find((model) => model.id === modelId);
  const isFlux2Model = currentModel?.runner === RUNNER_FAMILIES.FLUX2;
  const sharesFlux2Venv = isFlux2Model || usesDiffusersRunner(currentModel);
  const isEditOnlyModel = currentModel?.editOnly === true;
  const editImageMissing = isLocalMode && isEditOnlyModel && initImage.source == null;
  const isQwen21Model = currentModel?.pipelineClass === 'QwenImage21Pipeline';
  const i2iCapable = isI2iCapableMode(effectiveMode);
  const referenceSlotCount = referenceSlotsFor(effectiveMode, {
    hasInitImage: initImage.source != null,
    maxSlots: isLocalMode && isQwen21Model ? REFERENCE_SLOT_COUNT : 4,
    localSupportsReferences: isFlux2Model || isQwen21Model,
    localInputCap: isQwen21Model ? 10 : null,
  });
  const activeStylePresets = useMemo(() => [
    selectedUniverse ? universeStylePreset(selectedUniverse) : null,
    stylePreset,
  ].filter(Boolean), [selectedUniverse, stylePreset]);
  const styledPrompt = useMemo(
    () => composeStyledPrompt(prompt, negativePrompt, activeStylePresets).prompt,
    [prompt, negativePrompt, activeStylePresets],
  );
  const activeReferenceImages = useMemo(
    () => referenceImages.slice(0, referenceSlotCount),
    [referenceImages, referenceSlotCount],
  );
  const populatedRefs = useMemo(
    () => activeReferenceImages.filter((slot) => slot.file != null),
    [activeReferenceImages],
  );
  const droppedRefCount = useMemo(
    () => referenceImages.slice(referenceSlotCount).filter((slot) => slot.file != null).length,
    [referenceImages, referenceSlotCount],
  );
  const remoteUnsupportedInputs = useMemo(() => {
    if (!remoteTargetActive) return null;
    const model = remoteTarget.model;
    const present = [
      ['an init image', initImage.source != null && !remoteTarget.acceptsInput('initImage')],
      ['reference images', populatedRefs.length > 0 && !remoteTarget.acceptsInput('referenceImages')],
      ['LoRA weights', selectedLoras.length > 0],
    ].filter(([, unsupported]) => unsupported).map(([label]) => label);
    if (present.length) {
      return `The selected peer model cannot take ${present.join(' and ')} — clear it to render on this peer.`;
    }
    if (peerModelRequiresInput(model) && initImage.source == null) {
      return `${model?.modelName || 'The selected peer model'} renders only from a source image — add an init image, or pick a text-to-image model.`;
    }
    return null;
  }, [remoteTargetActive, remoteTarget.model, remoteTarget.acceptsInput, initImage.source, populatedRefs.length, selectedLoras.length]);
  const remoteBlocked = remoteTargetActive
    ? (remoteTarget.blockedReason || remoteUnsupportedInputs)
    : null;
  const hasCloudInputImage = initImage.source != null || populatedRefs.length > 0;
  const cloudNeedsPrompt = cloudPromptRequired(effectiveMode, hasCloudInputImage) && !prompt.trim();
  const cloudPromptHint = hasCloudInputImage
    ? `${cloudModeLabel} always needs a prompt, even with a reference image`
    : `${cloudModeLabel} text-to-image needs a prompt`;
  const currentRunnerFamily = currentModel?.runner || RUNNER_FAMILIES.MFLUX;
  const currentCompatKey = loraCompatKey(currentModel);
  const needsHfTokenGate = isLocalMode && !!currentModel?.requiresHfToken && !isFlux2Model;
  const statusReadiness = imageGenReadiness(status);
  const statusReady = statusReadiness === 'ready';
  const statusUnknown = statusReadiness === 'unknown';
  const notConnected = status && status.connected === false;

  useEffect(() => {
    if (!wantI2iModeRef.current) return;
    if (i2iCapable) {
      wantI2iModeRef.current = false;
      return;
    }
    if (!availableBackends.length) return;
    const mode = pickI2iMode(availableBackends);
    if (mode) {
      switchMode(mode);
      wantI2iModeRef.current = false;
    }
  }, [availableBackends, i2iCapable, switchMode]);

  const ensureI2iCapableMode = useCallback(() => {
    if (i2iCapable) return;
    const mode = pickI2iMode(availableBackends);
    if (mode) switchMode(mode);
    else wantI2iModeRef.current = true;
  }, [i2iCapable, availableBackends, switchMode]);

  const setGalleryInitImage = useCallback((filename) => {
    revokeIfBlob(initImagePreviewRef.current);
    setInitImage({ source: 'gallery', file: null, name: filename, previewUrl: `/data/images/${filename}` });
    setInitImageStrength(0.4);
  }, []);

  const handleModelChange = useCallback((nextModelId) => {
    setModelId(nextModelId);
    setSteps('');
    setGuidance('');
  }, []);

  const handleResolutionChange = useCallback((nextWidth, nextHeight) => {
    setWidth(nextWidth);
    setHeight(nextHeight);
  }, []);

  const consumeRemixHandoff = useCallback(() => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      IMAGE_GEN_HANDOFF_PARAM_KEYS.forEach((key) => next.delete(key));
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const lookupRemixHandoff = useCallback((filename) => {
    const sequence = ++remixLookupSequenceRef.current;
    setRemixHandoff({ filename, status: 'loading' });
    getGalleryImages([filename], { silent: true }).then((items) => {
      if (sequence !== remixLookupSequenceRef.current) return;
      const record = items?.[0];
      setRemixHandoff(record
        ? { filename, status: 'restoring', record }
        : { filename, status: 'missing' });
    }).catch(() => {
      if (sequence === remixLookupSequenceRef.current) {
        setRemixHandoff({ filename, status: 'error' });
      }
    });
  }, []);

  const remixHandoffFilename = searchParams.get('remix');
  useEffect(() => {
    if (!remixHandoffFilename) return;
    lookupRemixHandoff(remixHandoffFilename);
    return () => { remixLookupSequenceRef.current += 1; };
  }, [remixHandoffFilename, lookupRemixHandoff]);

  useEffect(() => {
    if (!remixHandoff) return;
    if (remixHandoff.status === 'missing' || remixHandoff.status === 'error') {
      consumeRemixHandoff();
      return;
    }
    if (remixHandoff.status !== 'restoring') return;
    if (modelsLoadFailed || lorasLoadFailed) {
      setRemixHandoff({ ...remixHandoff, status: 'error', failure: 'catalog' });
      consumeRemixHandoff();
      return;
    }
    if (!modelsLoaded || !lorasLoaded) return;
    handleRemix(remixHandoff.record);
    setRemixHandoff(null);
    consumeRemixHandoff();
  }, [remixHandoff, modelsLoaded, lorasLoaded, modelsLoadFailed, lorasLoadFailed, handleRemix, consumeRemixHandoff]);

  useEffect(() => {
    if (remixHandoffFilename) return;
    setRemixHandoff((current) => (
      current?.status === 'loading' || current?.status === 'restoring' ? null : current
    ));
  }, [remixHandoffFilename]);

  const retryRemixHandoff = useCallback(() => {
    const filename = remixHandoff?.filename;
    if (!filename) return;
    if (remixHandoff.failure === 'catalog') {
      if (modelsLoadFailed) {
        setModelsLoaded(false);
        setModelsLoadFailed(false);
        listImageModels().then((loadedModels) => {
          setModels(loadedModels);
          setModelsLoaded(true);
        }).catch(() => {
          setModelsLoadFailed(true);
          setModelsLoaded(true);
        });
      }
      if (lorasLoadFailed) {
        setLorasLoaded(false);
        setLorasLoadFailed(false);
        listLorasFull().then((loadedLoras) => {
          setAvailableLoras(loadedLoras);
          setLorasLoaded(true);
        }).catch(() => {
          setLorasLoadFailed(true);
          setLorasLoaded(true);
        });
      }
    }
    lookupRemixHandoff(filename);
  }, [remixHandoff, modelsLoadFailed, lorasLoadFailed, lookupRemixHandoff]);

  const dismissRemixHandoff = useCallback(() => {
    remixLookupSequenceRef.current += 1;
    setRemixHandoff(null);
    consumeRemixHandoff();
  }, [consumeRemixHandoff]);

  return {
    fields: {
      prompt,
      setPrompt,
      negativePrompt,
      setNegativePrompt,
      optionsOpen,
      setOptionsOpen,
      stylePreset,
      setStylePreset,
      selectedUniverse,
      setSelectedUniverse,
      modelId,
      setModelId,
      width,
      setWidth,
      height,
      setHeight,
      steps,
      setSteps,
      guidance,
      setGuidance,
      cfgScale,
      setCfgScale,
      quantize,
      setQuantize,
      seed,
      setSeed,
      selectedLoras,
      setSelectedLoras,
      agyModel,
      setAgyModel,
      batchCount,
      setBatchCount,
      cleanC2PA,
      setCleanC2PA,
      denoise,
      setDenoise,
    },
    catalogs: {
      models,
      availableLoras,
    },
    settings: {
      savedAgyModel,
      savedCleanC2PAByMode,
      savedDenoiseByMode,
      reloadBackends,
    },
    images: {
      initImage,
      initImageStrength,
      setInitImageStrength,
      galleryPicker,
      setGalleryPicker,
      activeReferenceImages,
      handlePickInitImage,
      handleClearInitImage,
      handlePickReferenceImage,
      handleClearReferenceImage,
      handleReferenceStrengthChange,
      handleGallerySelect,
    },
    derived: {
      currentModel,
      isFlux2Model,
      sharesFlux2Venv,
      isEditOnlyModel,
      isQwen21Model,
      i2iCapable,
      referenceSlotCount,
      showReferenceStrength: supportsReferenceStrength(effectiveMode) && isFlux2Model,
      styledPrompt,
      activeStylePresets,
      populatedRefs,
      droppedRefCount,
      remoteUnsupportedInputs,
      remoteBlocked,
      remoteTargetActive,
      editImageMissing,
      cloudNeedsPrompt,
      cloudPromptHint,
      currentRunnerFamily,
      currentCompatKey,
      needsHfTokenGate,
      statusReady,
      statusUnknown,
      notConnected,
      localBackendPending,
      isAsyncMode: isLocalMode || isCloudMode || remoteTargetActive,
    },
    actions: {
      handleModelChange,
      handleResolutionChange,
      handleRemix,
      switchMode,
      ensureI2iCapableMode,
      setGalleryInitImage,
      restoreActiveJob,
    },
    remix: {
      state: remixHandoff,
      pending: remixHandoffPending,
      retry: retryRemixHandoff,
      dismiss: dismissRemixHandoff,
    },
  };
}
