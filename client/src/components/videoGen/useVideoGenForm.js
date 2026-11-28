/**
 * `useVideoGenForm(...)` returns the VideoGen form as named groups (lane, prompt, model, sampler, frames, …) plus the payload builder.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router';
import toast from '../ui/Toast';
import { extractLastFrame } from '../../services/apiImageVideo.js';
import { videoLoraFamily, isVideoLoraFamily, loraFamilyOf, VIDEO_LORA_FAMILIES, isLtx2FamilyRuntime } from '../../lib/runnerFamilies';
import {
  DEFAULT_I2V_REFERENCE_MODE, isDefaultI2vReferenceMode,
  runtimeSupportsI2vReferenceMode, resolveI2vReferenceStrength,
} from '../../lib/videoReferenceModes';
import {
  resolutionOptionsForModel, defaultResolutionForModel, snapAspectToImage,
} from '../../lib/videoGenResolutions';
import {
  supportsContextWindow,
  videoModelMemoryGb, isModelAllowedForMode, videoModelModeOptions,
  normalizeFramesForModel, normalizeFpsForModel, audioDurationToFrames,
  icLoraSpecForMode,
  textEncoderOptionsForModel, normalizeTextEncoderForModel,
  normalizeSpeedProfileForModel,
} from '../../lib/videoGenParams.js';
import { falExtraReferenceLimit } from '../../lib/falVideoModels.js';
import { RUNWAY_DEFAULT_IMAGE_VIDEO_MODEL, getRunwayVideoModel } from '../../lib/runwayVideoModels.js';
import { RUNWAY_SPECIAL_VIDEO_MODELS, getRunwaySpecialVideoModel, RUNWAY_SPECIAL_VIDEO_MODES } from '../../../../server/lib/runwaySpecialVideoModels.js';
import { HOSTED_VIDEO_BACKENDS, useVideoGenBackendCaps } from './useVideoGenBackendCaps.js';
import { useVideoGenFieldState } from './useVideoGenFieldState.js';
import { useVideoGenRemixResume } from './useVideoGenRemixResume.js';
import { useVideoGenSubmitFlow } from './useVideoGenSubmitFlow.js';
import { useVideoGenUrlPrefill, readVideoGenIncoming } from './useVideoGenUrlPrefill.js';
import { useVideoGenValidation } from './useVideoGenValidation.js';

/**
 * VideoGen form state + request shaping (issue #3291).
 *
 * Owns every field the /media/video form submits, the URL-param prefill paths
 * (ImageGen handoff, Continue, Remix, ?lora=), the mode/backend transitions
 * that clear now-irrelevant inputs, the derived model/keyframe/IC gates, and
 * `buildGeneratePayload()` — the single client-side source of truth for the
 * shape `server/routes/videoGen.js` validates. `VideoGen.jsx` keeps the
 * fetching (status/model-context/history/gallery), the SSE run pipeline, the
 * batch queue, and the rendering.
 *
 * The caller supplies the fetched context the form has to react to:
 *   - `models` / `modelContext` — from `getVideoGenModelContext()`; drive the
 *     model dropdown, the default-model seed, and the mode-compatibility
 *     fallback. Deliberately NOT `getVideoGenStatus()`: that route shells out
 *     to python, and the picker must not wait on the interpreter probe.
 *   - `availableLoras` — the installed LoRA library, for name resolution.
 *   - `grokEnabled` — the Media Gen Settings toggle that reveals the
 *     Local/Grok backend switch.
 *   - `remoteSubmissionFields` — `{ mediaProviderPeerId, mediaProviderEngine,
 *     modelId }` from `useFederatedMediaTarget` when the user picked a peer as
 *     the render target (#4348), else null. Present, it makes
 *     `buildGeneratePayload()` emit the text-to-video-only shape the federated
 *     wire accepts — kept here rather than in the page so there stays exactly
 *     one builder for what `server/routes/videoGen.js` validates.
 *   - `displaySleepEnabled` — the page's effective choice (settings default,
 *     overridable per render) for whether a local MLX render should sleep the
 *     display. `buildGeneratePayload()` only attaches it when the SELECTED
 *     MODEL actually has the mitigation (`currentModel.sleepsDisplayDuringRender`),
 *     so the page doesn't need its own copy of that gate to build the payload —
 *     only to decide whether to show the control at all.
 */
// Object URL for a selected upload File so previews render before submit;
// revoked on change or unmount so blobs are released.
function useFileObjectUrl(file) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!(file instanceof File)) { setUrl(null); return undefined; }
    const nextUrl = URL.createObjectURL(file);
    setUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [file]);
  return url;
}

export function useVideoGenForm({
  models, modelContext, availableLoras, grokEnabled, falEnabled = false, reactorEnabled = false, runwayEnabled = false, geminiEnabled = false, higgsfieldEnabled = false, googleEnabled = false,
  remoteSubmissionFields = null, displaySleepEnabled = false,
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const incoming = readVideoGenIncoming(searchParams);
  const fields = useVideoGenFieldState(incoming);
  const {
    prompt, setPrompt, negativePrompt, setNegativePrompt,
    stylePreset, setStylePreset, selectedUniverse, setSelectedUniverse,
  } = fields.prompt;
  const {
    modelId, setModelId, setRemixSourceModel,
    remixModelFallback, setRemixModelFallback, staleModelToastRef,
    selectedLoras, setSelectedLoras, a2vLoraStageStrengths, setA2vLoraStageStrengths,
    textEncoderId, setTextEncoderId, speedProfileId, setSpeedProfileId,
    streamingMode, setStreamingMode,
  } = fields.model;
  const {
    width, setWidth, height, setHeight, sizeManuallySetRef,
    numFrames, setNumFrames, fps, setFps, chunks, setChunks,
    chunkPrompts, setChunkPrompts, contextFrames, setContextFrames,
    steps, setSteps, guidanceScale, setGuidanceScale,
    imageStrength, setImageStrength, i2vReferenceMode, setI2vReferenceMode,
    batchSize, setBatchSize, seed, setSeed, tiling, setTiling,
    disableAudio, setDisableAudio, noMusic, setNoMusic,
  } = fields.sampler;
  const {
    mode, setMode, sourceImageFile, setSourceImageFile, sourceImageUpload, setSourceImageUpload,
    unavailableSourceImageName, setUnavailableSourceImageName,
    lastImageFile, setLastImageFile, lastImageUpload, setLastImageUpload,
    keyframesMode, setKeyframesMode, keyframes, setKeyframes,
    extendFromVideoId, setExtendFromVideoId, extendingFrame, setExtendingFrame,
  } = fields.frames;
  const {
    audioFile, setAudioFile, audioDurationSec, setAudioDurationSec,
    icReferenceFile, setIcReferenceFile, icReferenceVideoId, setIcReferenceVideoId,
    icReferenceImageFiles, setIcReferenceImageFiles, icReferenceNames, setIcReferenceNames,
    icStrength, setIcStrength, icSkipStage2, setIcSkipStage2,
    referenceImageFiles, setReferenceImageFiles,
    unavailableReferenceImageNames,
    referenceVideoIds, setReferenceVideoIds, referenceAudioFiles, setReferenceAudioFiles,
  } = fields.conditioning;

  const caps = useVideoGenBackendCaps({
    enabled: { grok: grokEnabled, fal: falEnabled, reactor: reactorEnabled, runway: runwayEnabled, gemini: geminiEnabled, higgsfield: higgsfieldEnabled, google: googleEnabled },
    mode,
  });
  const {
    backend, setBackend, hostedLane, applyResumedLane,
    isGrok, isFal, isReactor, isRunway, isGemini, isHiggsfield, isGoogle,
  } = caps;
  const { falModel } = caps.fal;
  const { runwayModelId, setRunwayModelId, setRunwayInputs } = caps.runway;
  const { higgsfieldModel } = caps.higgsfield;
  const { googleModel } = caps.google;

  const { dropSourceImageParam } = useVideoGenUrlPrefill({
    searchParams, setSearchParams, incoming, fields, models, modelId, availableLoras,
  });

  // Seed the model dropdown from the server's default once the model context
  // lands, without clobbering a Remix/deep-link/user pick that already set it.
  useEffect(() => {
    if (modelContext?.defaultModel) setModelId((prev) => prev || modelContext.defaultModel);
  }, [modelContext?.defaultModel]);

  const sourceUploadUrl = useFileObjectUrl(sourceImageUpload);
  const lastUploadUrl = useFileObjectUrl(lastImageUpload);

  // Auto-snap the default W×H to a selected I2V source image's aspect ratio so
  // the server's cover-crop (force_original_aspect_ratio=increase,crop in
  // local.js#resizeImage) doesn't silently cut the subject out of a mismatched
  // frame. Only fires while the user hasn't taken the size into their own hands
  // (sizeManuallySetRef) — the inputs stay fully editable for power users, and
  // the server keeps its own model-aware grid clamp. Gallery picks resolve to
  // /data/images/<file>; uploads reuse the object URL built above. The load is
  // async, so guard the apply against a newer pick (cancelled) and a late-
  // arriving manual size change (the ref re-check).
  useEffect(() => {
    if (sizeManuallySetRef.current) return;
    const src = sourceImageFile ? `/data/images/${sourceImageFile}` : sourceUploadUrl;
    if (!src) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled || sizeManuallySetRef.current) return;
      const activeModel = models.find((model) => model.id === modelId);
      const snapped = snapAspectToImage(
        resolutionOptionsForModel(activeModel),
        img.naturalWidth,
        img.naturalHeight,
      );
      if (snapped) { setWidth(snapped.w); setHeight(snapped.h); }
    };
    img.src = src;
    return () => { cancelled = true; };
  }, [sourceImageFile, sourceUploadUrl, modelId, models]);

  // Keep compatibility fallbacks separate from discoverable models in other modes.
  const visibleModels = useMemo(
    () => models.filter((m) => isModelAllowedForMode(m, mode)),
    [models, mode],
  );
  const otherModeModels = useMemo(
    () => models.filter((model) => !isModelAllowedForMode(model, mode)),
    [models, mode],
  );

  // Every model transition — including automatic compatibility fallback —
  // drops sampler overrides from the prior model. Keeping one transition path
  // prevents a mode change from carrying LTX/Wan steps or CFG to its fallback.
  const applyModelSelection = useCallback((nextId) => {
    const nextModel = models.find((model) => model.id === nextId);
    setModelId(nextId);
    setNumFrames((current) => normalizeFramesForModel(current, nextModel));
    setFps((current) => normalizeFpsForModel(current, nextModel));
    setSteps('');
    setGuidanceScale('');
    if (!supportsContextWindow(nextModel)) setContextFrames(0);
  }, [models]);

  // Validate `modelId` once models are loaded. Two failure modes covered:
  //  1. A Remix URL (or hand-edited link) carries a `modelId` that no longer
  //     exists in the catalog — <ModelSelect> shows nothing and `currentModel`
  //     is undefined, which then breaks resolution suggestions and submit.
  //  2. The picked model exists but isn't compatible with the current mode
  //     (e.g. switching into a2v while an mlx_video model is selected). The
  //     server would 400 on submit; we proactively swap to a compatible model.
  // a2v fallback preference: highest-memory model that fits this machine
  // (leaving headroom for the OS + text encoder) > the largest if none fit.
  // Other modes: the context's defaultModel (if compatible) > first
  // compatible model.
  useEffect(() => {
    if (!modelId || models.length === 0) return;
    const current = models.find((m) => m.id === modelId);
    const currentCompatible = current && isModelAllowedForMode(current, mode);
    if (currentCompatible) return;
    let fallback = '';
    if (mode === 'a2v') {
      // Reserve ~16 GB headroom for the OS + text encoder + working set.
      // Anything that fits within `systemMemoryGb - reserveGb` is "runnable"
      // on this machine; among those, pick the largest (highest quality).
      // If nothing fits (constrained box), fall back to the smallest model
      // so the user can at least try, and the install banner / OOM surfaces
      // the real constraint instead of a silent dropdown change.
      const reserveGb = 16;
      // typeof === 'number' (not `modelContext?.systemMemoryGb ? ...`) so a
      // server legitimately reporting a tiny number (0 GB after rounding on a
      // sub-GB box) flows through the `fits` check and lands on the smallest
      // model. The truthiness shortcut would collapse 0 with "absent" and pick
      // the LARGEST model on a tiny machine.
      const budget = typeof modelContext?.systemMemoryGb === 'number'
        ? Math.max(0, modelContext.systemMemoryGb - reserveGb)
        : Number.POSITIVE_INFINITY;
      const sortedDesc = [...visibleModels].sort(
        (a, b) => videoModelMemoryGb(b) - videoModelMemoryGb(a),
      );
      const fits = sortedDesc.find((m) => videoModelMemoryGb(m) <= budget);
      fallback = (fits || sortedDesc[sortedDesc.length - 1])?.id || '';
    } else {
      const defaultModel = models.find((m) => m.id === modelContext?.defaultModel);
      if (defaultModel && isModelAllowedForMode(defaultModel, mode)) {
        fallback = defaultModel.id;
      } else {
        fallback = visibleModels[0]?.id || modelContext?.defaultModel || models[0]?.id || '';
      }
    }
    if (!fallback || fallback === modelId) return;
    // Toast only for the stale-id case (model removed from catalog). The
    // mode-incompatibility swap is expected behavior after a mode change —
    // no need to surface it. Name the destination model so users on a2v
    // don't think they landed on `modelContext.defaultModel` (they may not have —
    // a2v picks the largest-fits model, which is often a dgrauet entry).
    if (!current && staleModelToastRef.current !== modelId) {
      staleModelToastRef.current = modelId;
      const fallbackName = models.find((m) => m.id === fallback)?.name || fallback;
      toast(`Original model "${modelId}" is no longer available — switched to "${fallbackName}"`);
    }
    applyModelSelection(fallback);
  }, [modelId, models, modelContext?.defaultModel, modelContext?.systemMemoryGb, mode, visibleModels, applyModelSelection]);

  const currentModel = models.find((m) => m.id === modelId);

  // LTX-2.5's A2V runner needs an explicit frame canvas even though the user
  // thinks in audio duration. Snap the browser-probed duration UP to the
  // model's causal-VAE grid for an honest preview. The server repeats this from
  // ffprobe on the staged upload, so direct API callers get the same contract.
  // MiniMax Ref2VA is excluded: its wrapper windows arbitrary audio internally.
  useEffect(() => {
    if (mode !== 'a2v' || currentModel?.audioDurationDriven !== true
      || currentModel?.arbitraryLengthAudio === true) return;
    const frames = audioDurationToFrames(audioDurationSec, fps, currentModel?.frameStride);
    if (frames == null || frames > Number(currentModel?.maxNumFrames)) return;
    setNumFrames(frames);
  }, [audioDurationSec, currentModel, fps, mode]);

  const { applyRemix, applyFinish, applyResumedParams } = useVideoGenRemixResume({
    fields, models, modelContext, availableLoras, setBackend, applyResumedLane, dropSourceImageParam,
  });

  // Until the user deliberately chooses a size, model changes carry their own
  // native default canvas. This is material for H3: the shared 768x512 default
  // is an off-distribution wiring-test size, while its trained 16:9 canvas is
  // 1344x768. Apply it even while a source image is loading (or fails to load),
  // then let its onload callback choose the closest native aspect preset.
  // Remix/Continue/user edits set sizeManuallySetRef so they are preserved.
  useEffect(() => {
    if (!currentModel || sizeManuallySetRef.current) return;
    const next = defaultResolutionForModel(currentModel);
    setWidth(next.w);
    setHeight(next.h);
  }, [currentModel, sourceImageFile, sourceUploadUrl]);

  // Remix/deep-link/resume paths set model + sampler fields independently.
  // Reconcile them once the model is known so a legacy LTX 8n+1 frame count
  // cannot reach a Wan 4n+1 runner (and a model-specific fps stays selectable).
  // Reconciled here rather than in applyModelSelection so the remix / resume /
  // deep-link paths are covered too: they set modelId and textEncoderId
  // independently, and a conditioner the newly-resolved model can't load would
  // otherwise sit in the <select> with no matching <option> until submit 400'd.
  useEffect(() => {
    if (!currentModel) return;
    setNumFrames((current) => normalizeFramesForModel(current, currentModel));
    setFps((current) => normalizeFpsForModel(current, currentModel));
    setTextEncoderId((current) => normalizeTextEncoderForModel(current, currentModel));
    // Same reconcile for the speed profile: a model switch must not leave a
    // profile selected that the new entry never declared, or submit would send
    // a schedule the server declines and the picker would show a phantom.
    setSpeedProfileId((current) => normalizeSpeedProfileForModel(current, currentModel));
  }, [currentModel]);

  // Substitutable prompt conditioners the selected model can load, straight off
  // the server-decorated entry. Empty for every runtime without substitutions,
  // which is what hides the picker — the page never re-derives that from a
  // runtime name.
  const textEncoderOptions = textEncoderOptionsForModel(currentModel);

  // Video-LoRA family for the selected model — 'ltx-video' on ltx2, else null.
  // When null the picker is hidden and no LoRAs ride along on submit (the
  // route would 400 with LORAS_REQUIRE_LTX2). Derived, not state, so it tracks
  // the model dropdown without an effect.
  const loraFamily = videoLoraFamily(currentModel);
  // Strictly restrict the video picker to LoRAs whose family IS the video
  // family. The shared LoraPicker treats a missing compat key as "compatible"
  // (reasonable for image, where an unknown LoRA is usually still some image
  // family), but for video that would surface hand-dropped / pre-sidecar IMAGE
  // LoRAs — selecting one would send an incompatible adapter to the LTX
  // transformer (the route only checks file-exists + ltx2) and fail the render.
  // Video LoRAs always carry an explicit `ltx-video` family (HF import sets it),
  // so an exact-match filter here is the correct strict mode.
  const videoLoras = useMemo(
    () => (loraFamily ? availableLoras.filter((l) => loraFamilyOf(l) === loraFamily) : []),
    [availableLoras, loraFamily],
  );

  // Installed video LoRAs bucketed by family, regardless of the selected model.
  // One pass instead of one filter per family, and the source for the
  // "why is the picker gone" hint below.
  const installedVideoLorasByFamily = useMemo(() => {
    const buckets = new Map();
    for (const l of availableLoras) {
      const family = loraFamilyOf(l);
      if (!isVideoLoraFamily(family)) continue;
      buckets.set(family, (buckets.get(family) || 0) + 1);
    }
    return buckets;
  }, [availableLoras]);

  // When the picker is hidden but the user HAS a LoRA of the family the selected
  // model's runtime would use, silently hiding it reads as a bug — say why, and
  // say the right why. The two cases need different advice, so the hint carries
  // its own copy: a quantized mlx_video LTX-2.x model is fixed by switching
  // models, while H3 is blocked by its installed runtime plus adapter probe and
  // switching models is wrong advice. `null` when there is nothing useful to explain.
  const loraUnavailableHint = useMemo(() => {
    if (loraFamily) return null;
    const ltxCount = installedVideoLorasByFamily.get(VIDEO_LORA_FAMILIES.LTX_VIDEO) || 0;
    // Scoped to LTX-2.x mlx_video (see isMlxVideoLtxLoraCapable) so the copy's
    // "quantized runtime" wording always matches what triggered it.
    if (ltxCount > 0 && currentModel?.runtime === 'mlx_video'
      && /ltx-?2/i.test(`${currentModel?.id || ''} ${currentModel?.repo || ''} ${currentModel?.name || ''}`)) {
      return { count: ltxCount, kind: 'ltx' };
    }
    const h3Count = installedVideoLorasByFamily.get(VIDEO_LORA_FAMILIES.MINIMAX_H3) || 0;
    if (h3Count > 0 && currentModel?.runtime === 'minimax_h3') return { count: h3Count, kind: 'minimax_h3' };
    return null;
  }, [loraFamily, installedVideoLorasByFamily, currentModel]);

  // Multi-keyframe availability + validation. Keyframes are an ltx2-runtime
  // primitive (the route 400s with KEYFRAMES_REQUIRE_LTX2 otherwise), so the
  // picker only offers itself when the selected model runs on ltx2. Mirror
  // the server's accept rules (server/routes/videoGen.js ~line 574) so the
  // form blocks before a doomed POST: 2–8 entries, each pinned to a gallery
  // file, indices strictly ascending and within [0, numFrames-1].
  const keyframesSupported = isLtx2FamilyRuntime(currentModel?.runtime);
  const keyframesActive = mode === 'fflf' && keyframesMode && keyframesSupported;
  // Whether an FFLF last frame is a real anchor or just a hint. The server
  // decorates each model with `lastFrameAnchored` from the one runtime list
  // (server/services/videoGen/runtimes.js), so this can't drift from the
  // resize/forwarding decision the render path makes off the same flag.
  const lastFrameIsAdvisory = !currentModel?.lastFrameAnchored;
  // A loose reference needs a runtime that carries per-image conditioning
  // strength (LTX-2.5 today) AND an image-mode render to loosen. Both are read
  // from the shared contract the server gates on, so the picker can never offer
  // an option the POST would 400 on.
  const referenceModeSupported = runtimeSupportsI2vReferenceMode(currentModel?.runtime, 'inspire');
  // The grok lane (like every hosted lane, `hostedLane` from
  // useVideoGenBackendCaps) reads only prompt/dims/source-image/duration, so its
  // image_to_video always anchors and the promise collapses to the default there.
  const referenceModeApplies = mode === 'image' && !hostedLane;
  // The strength the render will actually use, for the slider readout — an
  // untouched slider under Inspire still resolves to the contract's low default
  // rather than the pipeline's 1.0, and the panel must say so.
  const effectiveImageStrength = resolveI2vReferenceStrength(i2vReferenceMode, imageStrength);
  useEffect(() => {
    if (isDefaultI2vReferenceMode(i2vReferenceMode)) return;
    // The mode half is always knowable. The RUNTIME half is not: `currentModel`
    // is undefined until the catalog loads, and reading that as "unsupported"
    // would clear a restored Inspire pick during a page resume before the model
    // it belongs to is even known — the render would then keep its promise while
    // the form denied making one. Defer to the post-load pass instead.
    if (referenceModeApplies && (!currentModel || referenceModeSupported)) return;
    setI2vReferenceMode(DEFAULT_I2V_REFERENCE_MODE);
  }, [currentModel, i2vReferenceMode, referenceModeApplies, referenceModeSupported]);
  // IC-LoRA remix mode is on. `icSpec` is the registry entry (reference count +
  // the resolution-divisibility rule its encoder imposes); null outside the
  // family, so every consumer gates on `icModeActive` first.
  const icSpec = icLoraSpecForMode(mode);
  const icModeActive = !!icSpec;
  // Which input surface this weight wants — `image` swaps the single clip
  // upload/history pair for the 2-8 gallery row list.
  const icImageKind = icSpec?.referenceKind === 'image';
  // Pad the row list up to the weight's MINIMUM whenever an image-kind mode is
  // active. Without rows the panel renders an empty list with nothing to fill,
  // and the panel's remove button floors at min so it can't get back down.
  // Derived from the registry (never a hardcoded 2) and driven from an effect so
  // every entry path is covered — the mode bar, a ?mode= deep link, and an
  // /active resume — not just handleModeChange.
  useEffect(() => {
    if (!icImageKind) return;
    setIcReferenceImageFiles((prev) => (
      prev.length >= icSpec.minReferences
        ? prev
        : [...prev, ...Array.from({ length: icSpec.minReferences - prev.length }, () => '')]
    ));
  }, [icImageKind, icSpec?.minReferences]);
  // The worker clamps FFLF/ltx2 numFrames down to fit a pixel-frame budget that
  // depends on resolution, so at default 768×512 the real frame ceiling is far
  // below numFrames. Compute the same cap the server enforces so the picker can
  // gate indices (and the auto-seed) against it. Falls back to numFrames when
  // the budget hasn't loaded yet (server still enforces the real cap).
  // Preset pick or custom W×H edit — mark the size as manually set so aspect-snap
  // on image upload stops overriding it (same flag the remix/deep-link paths set).
  // ResolutionField passes a transient 0 mid-edit and blur-snaps each edge to the
  // 64..2048 bound; the preview + FFLF-budget math guard against a transient 0,
  // and the server floors both dims to the selected model's declared grid
  // (generateVideo in local.js) before enforcing the per-tier pixel budget.
  const handleResolutionChange = (w, h) => {
    setWidth(w); setHeight(h); sizeManuallySetRef.current = true;
  };
  const handleRandomSeed = () => setSeed('');
  // Switching model drops the sampler overrides — steps/guidanceScale are
  // per-model defaults, and carrying one model's numbers onto another is
  // usually wrong.
  const handleModelChange = (nextId) => {
    const nextModel = models.find((model) => model.id === nextId);
    if (!isModelAllowedForMode(nextModel, mode)) {
      const nextMode = videoModelModeOptions(nextModel)[0]?.value;
      if (!nextMode) return;
      handleModeChange(nextMode);
    }
    setRemixSourceModel(null);
    setRemixModelFallback(null);
    applyModelSelection(nextId);
  };

  const clearSourceImage = () => {
    setSourceImageFile(null);
    setSourceImageUpload(null);
    setUnavailableSourceImageName('');
    dropSourceImageParam();
  };
  const clearLastImage = () => {
    setLastImageFile(null);
    setLastImageUpload(null);
  };
  // Switching to a gallery pick must drop any pending upload and the deep-link
  // URL param; otherwise the next render would still POST the stale upload
  // (req.files wins) while the preview shows the gallery image.
  const pickSourceImage = (filename) => {
    setSourceImageUpload(null);
    setUnavailableSourceImageName('');
    dropSourceImageParam();
    setSourceImageFile(filename);
  };
  // Clear any gallery pick + URL param when an upload is chosen — otherwise the
  // preview keeps rendering the old gallery image while the POST sends the
  // upload.
  const uploadSourceImage = (file) => {
    if (file && (sourceImageFile || incoming.incomingSourceImage)) clearSourceImage();
    if (file) setUnavailableSourceImageName('');
    setSourceImageUpload(file);
  };
  const pickLastImage = (filename) => {
    setLastImageUpload(null);
    setLastImageFile(filename);
  };
  const uploadLastImage = (file) => {
    if (file && lastImageFile) setLastImageFile(null);
    setLastImageUpload(file);
  };

  const {
    a2vDurationError,
    a2vModeBlocked,
    chainingActive,
    extendModeBlocked,
    icLoraModeBlocked,
    keyframesBlocked,
    keyframesError,
    maxSafeFrames,
  } = useVideoGenValidation({
    audioDurationSec,
    audioFile,
    chunks,
    currentModel,
    extendFromVideoId,
    extendingFrame,
    fps,
    height,
    icImageKind,
    icModeActive,
    icReferenceFile,
    icReferenceImageFiles,
    icReferenceVideoId,
    icSpec,
    keyframes,
    keyframesActive,
    mode,
    numFrames,
    pixelBudget: modelContext?.fflfLtx2PixelBudget,
    sourceImageFile,
    sourceImageUpload,
    unavailableSourceImageName,
    width,
  });

  // The last addressable frame index — the smaller of numFrames and the
  // resolution-dependent pixel-budget cap (maxSafeFrames), minus 1. Seeding new
  // keyframe rows against this keeps the auto-seeded index inside the budget the
  // server enforces, so toggling keyframes on at a high resolution doesn't seed
  // an index that immediately trips keyframesError.
  const lastSeedableIndex = Math.max(0, Math.min(numFrames, maxSafeFrames) - 1);
  // Multi-keyframe list mutators. A new row defaults its index to the prior
  // row's index + 1 (clamped to the last addressable frame) so the strictly-
  // ascending invariant holds out of the box without the user hand-typing it.
  const addKeyframe = () => setKeyframes((prev) => {
    if (prev.length >= 8) return prev;
    const lastIndex = prev.length ? prev[prev.length - 1].index : -1;
    const nextIndex = Math.min(lastIndex + 1, lastSeedableIndex);
    return [...prev, { file: '', index: nextIndex }];
  });
  const updateKeyframe = (i, patch) => setKeyframes((prev) =>
    prev.map((kf, idx) => (idx === i ? { ...kf, ...patch } : kf)));
  const removeKeyframe = (i) => setKeyframes((prev) => prev.filter((_, idx) => idx !== i));
  // Toggling multi-keyframe mode on seeds two empty rows anchored at the first
  // and last frame (the FFLF mental model, and the minimum 2 the server
  // requires) and drops the legacy first/last pair (the route rejects mixing
  // them). Toggling off clears the keyframe list for the same reason.
  const toggleKeyframesMode = () => setKeyframesMode((on) => {
    const next = !on;
    if (next) {
      clearSourceImage();
      clearLastImage();
      setKeyframes((prev) => (prev.length >= 2 ? prev : [
        { file: '', index: 0 },
        { file: '', index: Math.max(1, lastSeedableIndex) },
      ]));
    } else {
      setKeyframes([]);
    }
    return next;
  });

  // IC reference-row mutators. The add/remove buttons clamp to the weight's
  // registry bounds so the list can never leave the range the route accepts.
  const addIcReferenceImage = () => setIcReferenceImageFiles((prev) => (
    prev.length >= icSpec.maxReferences ? prev : [...prev, '']
  ));
  const updateIcReferenceImage = (i, file) => setIcReferenceImageFiles((prev) => (
    prev.map((f, idx) => (idx === i ? file : f))
  ));
  const removeIcReferenceImage = (i) => setIcReferenceImageFiles((prev) => (
    prev.length <= icSpec.minReferences ? prev : prev.filter((_, idx) => idx !== i)
  ));
  // Extra reference rows for a reference-to-video model. The model's
  // `maxReferenceImages` counts the first-frame input, so rows cap one lower.
  // A Higgsfield reference render has no start frame, so every row is a reference.
  const maxExtraReferenceImages = isFal ? falExtraReferenceLimit(falModel, mode) : isHiggsfield ? higgsfieldModel.maxReferenceImages : isGoogle ? googleModel.maxReferenceImages : Math.max(0, (Number(isRunway
    ? getRunwayVideoModel(runwayModelId || RUNWAY_DEFAULT_IMAGE_VIDEO_MODEL)?.referenceImages?.max
    : currentModel?.maxReferenceImages) || 0) - 1);
  const addReferenceImage = () => setReferenceImageFiles((prev) => (
    prev.length >= maxExtraReferenceImages ? prev : [...prev, '']
  ));
  const updateReferenceImage = (i, file) => setReferenceImageFiles((prev) => (
    prev.map((f, idx) => (idx === i ? file : f))
  ));
  const removeReferenceImage = (i) => setReferenceImageFiles((prev) => prev.filter((_, idx) => idx !== i));
  const maxReferenceVideos = Number(currentModel?.maxReferenceVideos) || 0;
  const maxReferenceAudios = Number(currentModel?.maxReferenceAudios) || 0;
  const addReferenceVideo = () => setReferenceVideoIds((prev) => (prev.length >= maxReferenceVideos ? prev : [...prev, '']));
  const pickReferenceVideo = (i, id) => setReferenceVideoIds((prev) => prev.map((v, idx) => (idx === i ? id : v)));
  const removeReferenceVideo = (i) => setReferenceVideoIds((prev) => prev.filter((_, idx) => idx !== i));
  const addReferenceAudio = (file) => setReferenceAudioFiles((prev) => (prev.length >= maxReferenceAudios ? prev : [...prev, file]));
  const removeReferenceAudio = (i) => setReferenceAudioFiles((prev) => prev.filter((_, idx) => idx !== i));
  // Upload and history pick are mutually exclusive server-side
  // (IC_LORA_REFERENCE_CONFLICT), so setting one clears the other — along with
  // the in-flight render's read-only name hint, which would otherwise name a
  // clip that is no longer what the form would submit.
  const pickIcReferenceFile = (f) => {
    setIcReferenceFile(f);
    if (f) { setIcReferenceVideoId(''); setIcReferenceNames([]); }
  };
  const pickIcReferenceVideoId = (id) => {
    setIcReferenceVideoId(id);
    if (id) { setIcReferenceFile(null); setIcReferenceNames([]); }
  };

  // Switching mode resets the now-irrelevant fields so a stale choice from
  // a prior mode can't sneak into the next generation. (Prompt/seed/etc.
  // carry over because they apply to all modes.)
  const handleModeChange = (next) => {
    setMode(next);
    if (next !== mode) setRunwayInputs({});
    if (isRunway) setRunwayModelId(RUNWAY_SPECIAL_VIDEO_MODELS.find((m) => m.mode === next)?.id || (getRunwaySpecialVideoModel(runwayModelId) ? '' : runwayModelId));
    if (RUNWAY_SPECIAL_VIDEO_MODES.includes(next)) {
      clearSourceImage();
      clearLastImage();
      setExtendFromVideoId('');
      setChunks(1);
    }
    // Audio is only meaningful in a2v mode — drop it on every other switch
    // so a stale upload from a prior pick doesn't sneak into a non-a2v post.
    if (next !== 'a2v') setAudioFile(null);
    // Multi-keyframe is fflf-only — drop it on every other switch so a stale
    // keyframe list can't sneak into the next post (the route would 400 on a
    // non-fflf mode anyway, but keep the form honest).
    if (next !== 'fflf') { setKeyframesMode(false); setKeyframes([]); }
    const nextIcSpec = icLoraSpecForMode(next);
    if (nextIcSpec) {
      // IC conditioning replaces extend inputs, while LTX 2.5 References can
      // also use an opening frame. Chaining is rejected for every IC mode.
      if (next !== 'ic-ingredients-25') clearSourceImage();
      clearLastImage();
      setExtendFromVideoId('');
      setChunks(1);
      if (next === 'ic-ingredients-25') {
        setNumFrames((current) => Math.max(121, 1 + 8 * Math.ceil(((Number(current) || 1) - 1) / 8)));
        setIcSkipStage2(false);
      }
      // Control and Colorize take different reference videos: Control wants a
      // depth/pose/edge pass, Colorize wants a desaturated source. Carrying the
      // clip across two different IC modes would silently submit a control pass
      // as a "B&W clip to restore" and produce plausible garbage, so the
      // reference is dropped on any real mode change — same as every other
      // mode-specific input above. The resumed-render hint goes with it, or the
      // new mode's panel would name the OLD mode's clip as what's conditioning
      // an in-flight render.
      if (next !== mode) {
        setIcReferenceFile(null);
        setIcReferenceVideoId('');
        setIcReferenceNames([]);
        // Just clear — the pad-to-minimum effect below re-seeds empty rows. Doing
        // it there rather than here covers every path that lands on an IC mode
        // (mode bar, ?mode= deep link, an /active resume), not only this handler.
        setIcReferenceImageFiles([]);
      }
      return;
    }
    // The IC-LoRA reference channel only exists in the IC remix modes — the
    // route 400s IC_LORA_MODE_MISMATCH if one rides along elsewhere. The
    // resumed-render hint clears with it so a round trip out through a non-IC
    // mode and back can't resurface a name for a clip that's no longer set.
    setIcReferenceFile(null);
    setIcReferenceVideoId('');
    setIcReferenceNames([]);
    setUnavailableSourceImageName('');
    if (next === 'text') {
      clearSourceImage();
      clearLastImage();
      setExtendFromVideoId('');
    } else if (next === 'image') {
      clearLastImage();
      setExtendFromVideoId('');
    } else if (next === 'fflf') {
      setExtendFromVideoId('');
    } else if (next === 'extend') {
      clearLastImage();
      // Drop any source image carried over from a prior mode — extend will
      // populate sourceImageFile fresh from the picked video's last frame
      // via handleExtendPick. Without this, switching from image/fflf into
      // extend leaves a stale source that gets silently submitted alongside
      // an empty extendFromVideoId.
      clearSourceImage();
    } else if (next === 'a2v') {
      // Audio-to-video may also condition on a reference image (required by
      // MiniMax H3 Ref2VA, optional on LTX), so preserve the source picker.
      clearLastImage();
      setExtendFromVideoId('');
      // disableAudio strips the output audio track — in a2v mode that would
      // remove the user's uploaded audio, defeating the mode entirely.
      // noMusic appends a prompt constraint for text-conditioned audio gen;
      // a2v uses uploaded audio so the constraint is meaningless there too.
      setDisableAudio(false);
      setNoMusic(false);
      setChunks(1);
      // Auto-select to a compatible audio-to-video runtime is handled by the
      // modelId-validation effect, which re-runs on every mode change.
    }
  };

  // Grok's image_to_video supports text (image-first) and image modes only, so
  // switching to it snaps an unsupported mode back to the nearest one. Route
  // through handleModeChange (not a bare setMode) so the snapped-away mode's
  // inputs are cleared too — otherwise a stale a2v audio file or IC reference
  // clip survives the switch and reappears if the user flips back.
  const handleBackendChange = (id) => {
    setBackend(id);
    if (id !== 'runway' && RUNWAY_SPECIAL_VIDEO_MODES.includes(mode)) handleModeChange('text');
    if (HOSTED_VIDEO_BACKENDS.has(id) && mode !== 'text' && mode !== 'image') {
      handleModeChange((sourceImageFile || sourceImageUpload) ? 'image' : 'text');
    }
  };

  // Extend mode: the user picks a prior video; we extract its last frame
  // (lazily — only when picked, since extraction shells out to ffmpeg) and
  // use that as the source image for image-to-video.
  //
  // The pick token guards against a slow-then-fast race: if the user picks
  // video A, then quickly switches to video B, A's extract response could
  // arrive after B's and overwrite sourceImageFile with the wrong frame.
  // Capture the token at request time and only apply the result when it
  // still matches the latest pick.
  const extendPickTokenRef = useRef(0);
  // Fill a prompt field the user hasn't claimed: blank, or still holding the
  // exact text an earlier pick put there. Text the user typed is never
  // clobbered, and re-picking a different source still replaces a stale
  // auto-fill. Returns whether it filled.
  const autofilledRef = useRef({});
  const fillIfUntouched = (key, value, current, setter) => {
    if (!value || (current.trim() && current !== autofilledRef.current[key])) return false;
    setter(value);
    autofilledRef.current[key] = value;
    return true;
  };
  // Continuing a shot almost always means continuing its direction too, so
  // picking a source render drops that render's own prompt into the form
  // instead of leaving the user to retype it. A source with no prompt (a clip
  // we didn't generate, or a legacy render made before prompts were stamped)
  // is a no-op, not a wipe.
  const prefillPromptFromSource = (source) => {
    if (!source) return;
    const srcPrompt = (source.prompt === '(no prompt)' ? '' : source.prompt || '').trim();
    const srcNeg = (source.negativePrompt || source.negative_prompt || '').trim();
    // History stores the COMPOSED prompt (composeStyledPrompt prefixes the
    // preset), so either picker left selected would compose itself a second time
    // on the next submit — the same reason applyRemix clears both.
    if (fillIfUntouched('prompt', srcPrompt, prompt, setPrompt)) {
      setStylePreset(null);
      setSelectedUniverse(null);
    }
    fillIfUntouched('negativePrompt', srcNeg, negativePrompt, setNegativePrompt);
  };
  // `source` is the history record behind `videoId`, supplied by the picker
  // that rendered it — the hook never needs the whole history list for this.
  const handleExtendPick = async (videoId, source = null) => {
    // Bumping the token cancels any in-flight extract from a prior pick:
    // the awaited promise still resolves, but the result-application block
    // sees the mismatch and bails. Clearing the spinner here too means a
    // fast-clear (`videoId === ''`) doesn't strand the "Extracting…" UI
    // when an earlier extract is mid-flight.
    const token = ++extendPickTokenRef.current;
    setExtendFromVideoId(videoId);
    if (!videoId) {
      clearSourceImage();
      setExtendingFrame(false);
      return;
    }
    // Carry the source render's prompt forward before the runtime branch below,
    // so both the ltx2 (no extraction) and legacy (ffmpeg extract) paths prefill.
    prefillPromptFromSource(source);
    // ltx2 runtime: native ExtendPipeline conditions on the entire source
    // video's latent, so we DON'T need a last-frame PNG. Skip the ffmpeg
    // extract roundtrip — the route resolves the video id to a disk path
    // server-side. Saves ~1s per pick + avoids the i2v fallback when the
    // extract fails.
    if (isLtx2FamilyRuntime(currentModel?.runtime)) {
      setExtendingFrame(false);
      return;
    }
    setExtendingFrame(true);
    const res = await extractLastFrame(videoId, { silent: true }).catch((err) => {
      toast.error(err.message || 'Failed to extract last frame');
      return null;
    });
    // Stale completion: a newer pick (or clear) is now authoritative. Do
    // nothing — the newer call already set/will set the spinner correctly,
    // and the clear-path above resets it on empty pick. Touching it from
    // the stale request could prematurely hide "Extracting…" while the
    // current pick (B) is still in flight after a fast pick A → pick B.
    if (token !== extendPickTokenRef.current) return;
    setExtendingFrame(false);
    if (res?.filename) {
      setSourceImageFile(res.filename);
      setSourceImageUpload(null);
    }
  };

  // Edit one beat. The backing array is only ever GROWN (never truncated on a
  // chunk-count change) so lowering the count and raising it again restores the
  // text the user already typed; submit and the editor slice to the live count.
  const setChunkPromptAt = (index, value) => {
    setChunkPrompts((prev) => {
      const next = prev.slice();
      while (next.length <= index) next.push('');
      next[index] = value;
      return next;
    });
  };

  // Snapshot the validated fields used by each submission lane.
  const { grokDuration } = caps.grok;
  const { falDuration, falModelId, falResolution, falGenerateAudio } = caps.fal;
  const { runwayDuration, runwayResolution, runwayInputs } = caps.runway;
  const { higgsfieldModelId, higgsfieldDuration, higgsfieldResolution, higgsfieldGenerateAudio } = caps.higgsfield;
  const { googleModelId, googleDuration, googleResolution, googleGenerateAudio } = caps.google;
  const { reactorClipId, reactorSeconds, reactorSeed, reactorAspect } = caps.reactor;
  const submissionState = {
    hostedLane, grokDuration, falDuration, falModelId, falResolution, falGenerateAudio,
    reactorClipId, reactorSeconds, reactorSeed, reactorAspect, remoteSubmissionFields,
    runwayModelId, runwayDuration, runwayResolution, runwayInputs,
    higgsfieldModelId, higgsfieldDuration, higgsfieldResolution, higgsfieldGenerateAudio,
    googleModelId, googleDuration, googleResolution, googleGenerateAudio,
    displaySleepEnabled,
    prompt, negativePrompt, stylePreset, selectedUniverse,
    width, height, mode, sourceImageFile, sourceImageUpload,
    numFrames, fps, steps, guidanceScale, seed, batchSize,
    currentModel, modelId, tiling, textEncoderId, speedProfileId, streamingMode,
    disableAudio, noMusic, imageStrength, i2vReferenceMode,
    keyframesActive, keyframes, loraFamily, selectedLoras, a2vLoraStageStrengths,
    lastImageFile, lastImageUpload, extendFromVideoId, audioFile,
    icModeActive, icImageKind, icReferenceFile, icReferenceVideoId,
    icReferenceImageFiles, icStrength, icSkipStage2, referenceImageFiles, referenceVideoIds, referenceAudioFiles,
    chainingActive, chunks, chunkPrompts, contextFrames,
  };
  const { buildGeneratePayload, envelopedPrompt } = useVideoGenSubmitFlow(submissionState);

  // Each group is one concern a panel renders, so a panel takes the group it
  // needs rather than the whole form. Field names stay unique across groups.
  return {
    lane: {
      backend, hostedLane, isGrok, isFal, isReactor, isRunway, isGemini, isHiggsfield, isGoogle,
      handleBackendChange, mode, handleModeChange,
    },
    grok: caps.grok,
    fal: caps.fal,
    runway: caps.runway,
    higgsfield: caps.higgsfield,
    google: caps.google,
    reactor: caps.reactor,
    prompt: {
      prompt, setPrompt,
      // The exact prompt a render would be submitted with right now (style preset
      // + no-music envelope). The LoRA picker's #4665 trigger hint reads THIS, not
      // the raw textarea, so it can never disagree with the server-side weave.
      envelopedPrompt,
      negativePrompt, setNegativePrompt,
      stylePreset, setStylePreset,
      selectedUniverse, setSelectedUniverse,
    },
    model: {
      modelId, handleModelChange, currentModel, visibleModels, otherModeModels, remixModelFallback,
      loraFamily, videoLoras, loraUnavailableHint,
      selectedLoras, setSelectedLoras,
      a2vLoraStageStrengths, setA2vLoraStageStrengths,
      textEncoderId, setTextEncoderId, textEncoderOptions,
      speedProfileId, setSpeedProfileId,
      streamingMode, setStreamingMode,
    },
    sampler: {
      width, height, handleResolutionChange,
      numFrames, setNumFrames,
      fps, setFps,
      chunks, setChunks,
      chunkPrompts, setChunkPromptAt, chainingActive,
      contextFrames, setContextFrames,
      steps, setSteps,
      guidanceScale, setGuidanceScale,
      imageStrength, setImageStrength,
      i2vReferenceMode, setI2vReferenceMode,
      referenceModeSupported, effectiveImageStrength,
      batchSize, setBatchSize,
      seed, setSeed, handleRandomSeed,
      tiling, setTiling,
      disableAudio, setDisableAudio,
      noMusic, setNoMusic,
    },
    frames: {
      sourceImageFile, sourceImageUpload, sourceUploadUrl, unavailableSourceImageName,
      pickSourceImage, uploadSourceImage, clearSourceImage,
      lastImageFile, lastImageUpload, lastUploadUrl,
      pickLastImage, uploadLastImage, clearLastImage, lastFrameIsAdvisory,
    },
    keyframes: {
      keyframesMode, keyframes, keyframesSupported, keyframesActive, keyframesError, keyframesBlocked,
      toggleKeyframesMode, addKeyframe, updateKeyframe, removeKeyframe,
    },
    extend: { extendFromVideoId, extendingFrame, handleExtendPick, extendModeBlocked },
    audio: {
      audioDurationSec, setAudioDurationSec,
      audioFile, setAudioFile, a2vDurationError, a2vModeBlocked,
    },
    ic: {
      icSpec, icModeActive, icImageKind, icLoraModeBlocked,
      icReferenceFile, icReferenceVideoId, icReferenceNames, icReferenceImageFiles,
      pickIcReferenceFile, pickIcReferenceVideoId,
      addIcReferenceImage, updateIcReferenceImage, removeIcReferenceImage,
      icStrength, setIcStrength,
      icSkipStage2, setIcSkipStage2,
    },
    references: {
      referenceImageFiles, unavailableReferenceImageNames, addReferenceImage, updateReferenceImage, removeReferenceImage,
      referenceVideoIds, maxReferenceVideos, addReferenceVideo, pickReferenceVideo, removeReferenceVideo,
      referenceAudioFiles, maxReferenceAudios, addReferenceAudio, removeReferenceAudio,
    },
    // Prefill + submit
    actions: { applyRemix, applyFinish, applyResumedParams, buildGeneratePayload },
  };
}

export default useVideoGenForm;
