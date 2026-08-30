import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router';
import toast from '../components/ui/Toast';
import { extractLastFrame } from '../services/api';
import { trackAudioUrl } from '../services/apiTracks.js';
import { videoLoraFamily, isVideoLoraFamily, loraFamilyOf, VIDEO_LORA_FAMILIES, isLtx2FamilyRuntime } from '../lib/runnerFamilies';
import {
  DEFAULT_I2V_REFERENCE_MODE, isDefaultI2vReferenceMode, normalizeI2vReferenceMode,
  runtimeSupportsI2vReferenceMode, resolveI2vReferenceStrength,
} from '../lib/videoReferenceModes';
import { randomSeed } from '../lib/genUtils';
import {
  resolutionOptionsForModel, defaultResolutionForModel, snapAspectToImage,
} from '../lib/videoGenResolutions';
import { VIDEO_TILING_ENUM_SET } from '../lib/videoTilingOptions';
import {
  MAX_CHUNKS,
  videoModelMemoryGb, isModelAllowedForMode,
  normalizeFramesForModel, normalizeFpsForModel,
  icLoraSpecForMode,
  textEncoderOptionsForModel, normalizeTextEncoderForModel,
  textEncoderIdFromRecord,
  normalizeSpeedProfileForModel, speedProfileIdFromRecord,
  DEFAULT_DRAFT_DECODE_ID, draftDecodeOptionsForModel,
  resolveDraftDecodeForModel, draftDecodeFromRecord,
} from '../lib/videoGenParams.js';
import { useVideoGenFieldState } from './useVideoGenFieldState.js';
import { useVideoGenSubmitFlow } from './useVideoGenSubmitFlow.js';
import { useVideoGenValidation } from './useVideoGenValidation.js';

// A Remix is an editing starting point. A fixed sampler profile (for example,
// MiniMax H3) cannot honor a negative prompt, steps, or CFG override, so
// restoring it as the active model leaves the very values Remix just loaded
// trapped behind disabled inputs. Prefer an editable text-to-video model in
// that case; the source model stays available in the picker for a faithful
// re-render.
const hasEditableRemixControls = (model) => (
  model?.samplerLocked !== true && model?.supportsNegativePrompt !== false
);

const editableRemixModel = (models, defaultModelId) => {
  const candidates = models.filter((model) => (
    isModelAllowedForMode(model, 'text') && hasEditableRemixControls(model)
  ));
  return candidates.find((model) => model.id === defaultModelId) || candidates[0] || null;
};

/**
 * VideoGen form state + request shaping (issue #3291).
 *
 * Owns every field the /media/video form submits, the URL-param prefill paths
 * (ImageGen handoff, Continue, Remix, ?lora=), the mode/backend transitions
 * that clear now-irrelevant inputs, the derived model/keyframe/IC gates, and
 * `buildGeneratePayload()` — the single client-side source of truth for the
 * shape `server/routes/videoGen.js` validates. `VideoGen.jsx` keeps the
 * fetching (status/models/history/gallery), the SSE run pipeline, the batch
 * queue, and the rendering.
 *
 * The caller supplies the fetched context the form has to react to:
 *   - `models` / `status` — from `getVideoGenStatus()`; drive the model
 *     dropdown, the default-model seed, and the mode-compatibility fallback.
 *   - `availableLoras` — the installed LoRA library, for name resolution.
 *   - `grokEnabled` — the Settings → Image Gen toggle that reveals the
 *     Local/Grok backend switch.
 *   - `remoteSubmissionFields` — `{ mediaProviderPeerId, mediaProviderEngine,
 *     modelId }` from `useFederatedMediaTarget` when the user picked a peer as
 *     the render target (#4348), else null. Present, it makes
 *     `buildGeneratePayload()` emit the text-to-video-only shape the federated
 *     wire accepts — kept here rather than in the page so there stays exactly
 *     one builder for what `server/routes/videoGen.js` validates.
 */
export function useVideoGenForm({ models, status, availableLoras, grokEnabled, remoteSubmissionFields = null }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const incomingSourceImage = searchParams.get('sourceImageFile');
  const incomingAudioFilename = searchParams.get('audioFilename');
  const incomingPrompt = searchParams.get('prompt');
  const incomingNegativePrompt = searchParams.get('negativePrompt');
  const incomingWidth = searchParams.get('w');
  const incomingHeight = searchParams.get('h');

  const {
    audioFile, setAudioFile, audioHandoffRef,
    backend, setBackend,
    chunks, setChunks,
    chunkPrompts, setChunkPrompts,
    contextFrames, setContextFrames,
    disableAudio, setDisableAudio,
    extendingFrame, setExtendingFrame,
    extendFromVideoId, setExtendFromVideoId,
    fps, setFps,
    grokDuration, setGrokDuration,
    guidanceScale, setGuidanceScale,
    height, setHeight,
    i2vReferenceMode, setI2vReferenceMode,
    icReferenceFile, setIcReferenceFile,
    icReferenceImageFiles, setIcReferenceImageFiles,
    icReferenceNames, setIcReferenceNames,
    icReferenceVideoId, setIcReferenceVideoId,
    icSkipStage2, setIcSkipStage2,
    icStrength, setIcStrength,
    imageStrength, setImageStrength,
    keyframes, setKeyframes,
    keyframesMode, setKeyframesMode,
    lastImageFile, setLastImageFile,
    lastImageUpload, setLastImageUpload,
    mode, setMode,
    modelId, setModelId,
    negativePrompt, setNegativePrompt,
    noMusic, setNoMusic,
    numFrames, setNumFrames,
    prompt, setPrompt,
    remixModelFallback, setRemixModelFallback,
    remixSourceModel, setRemixSourceModel,
    seed, setSeed,
    selectedLoras, setSelectedLoras,
    sizeManuallySetRef,
    speedProfileId, setSpeedProfileId,
    draftDecode, setDraftDecode,
    staleModelToastRef,
    steps, setSteps,
    stylePreset, setStylePreset,
    sourceImageFile, setSourceImageFile,
    sourceImageUpload, setSourceImageUpload,
    textEncoderId, setTextEncoderId,
    tiling, setTiling,
    width, setWidth,
  } = useVideoGenFieldState({
    incomingAudioFilename,
    incomingNegativePrompt,
    incomingPrompt,
    incomingSourceImage,
  });

  // Music renders live in the shared library rather than in the browser's
  // local file picker. Turn a render's deep-link filename into the same File
  // object the upload panel produces, so the existing multipart submit path,
  // size checks, and server staging remain the single source of truth.
  useEffect(() => {
    if (!incomingAudioFilename || audioHandoffRef.current === incomingAudioFilename) return;
    audioHandoffRef.current = incomingAudioFilename;
    let cancelled = false;
    setMode('a2v');
    setAudioFile(null);
    fetch(trackAudioUrl(incomingAudioFilename))
      .then((response) => {
        if (!response.ok) throw new Error('The selected music render could not be loaded.');
        return response.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        const type = blob.type || 'audio/wav';
        setAudioFile(new File([blob], incomingAudioFilename, { type }));
        setSearchParams((prev) => {
          const next = new URLSearchParams(prev);
          next.delete('audioFilename');
          return next;
        }, { replace: true });
      })
      .catch((error) => {
        if (!cancelled) toast.error(error.message || 'Failed to load the music render');
      });
    return () => { cancelled = true; };
  }, [incomingAudioFilename, setSearchParams]);
  // Seed the model dropdown from the server's default once /status lands,
  // without clobbering a Remix/deep-link/user pick that already set it.
  useEffect(() => {
    if (status?.defaultModel) setModelId((prev) => prev || status.defaultModel);
  }, [status?.defaultModel]);

  // Re-sync when ImageGen pipes a new image via ?sourceImageFile=...
  useEffect(() => {
    if (incomingSourceImage) {
      setSourceImageFile(incomingSourceImage);
      setSourceImageUpload(null);
      setMode((m) => (m === 'text' ? 'image' : m));
    }
  }, [incomingSourceImage]);
  // A prompt handed in through the URL (Continue, Send-to-Video, Remix) is the
  // COMPOSED prompt of an existing render — composeStyledPrompt already prefixed
  // it with whatever style preset produced it. Drop the picker's selection with
  // it, or the next submit prefixes a preset onto a prompt that already carries
  // one (the same double-styling applyRemix clears the preset to avoid).
  useEffect(() => {
    if (incomingPrompt) { setPrompt(incomingPrompt); setStylePreset(null); }
  }, [incomingPrompt]);
  useEffect(() => {
    if (incomingNegativePrompt) setNegativePrompt(incomingNegativePrompt);
  }, [incomingNegativePrompt]);
  // When "Continue" pipes a video's last frame here, also sync the resolution
  // so the new render matches the source. Width/height get rounded to the
  // selected model's declared resolution grid server-side, so off-grid sources
  // still work.
  useEffect(() => {
    const w = Number(incomingWidth);
    const h = Number(incomingHeight);
    if (Number.isFinite(w) && w > 0) { setWidth(w); sizeManuallySetRef.current = true; }
    if (Number.isFinite(h) && h > 0) { setHeight(h); sizeManuallySetRef.current = true; }
  }, [incomingWidth, incomingHeight]);

  // Remix payload from MediaPreview (?modelId=…&numFrames=…&seed=…). Populate
  // form state once on mount, then strip the params so a hot-reload or back-
  // nav doesn't re-clobber edits the user has made since. Mirrors the
  // ImageGen remix-prefill effect.
  //
  // Gating: presence of any remix-only key (modelId / numFrames / fps / seed
  // / steps / guidanceScale / tiling / disableAudio) marks the URL as a Remix
  // bundle — the Continue and SendToVideo paths set sourceImageFile +/-
  // prompt/w/h but never the remix-only keys, so they keep their URL state.
  // When it IS a remix, we ALSO strip prompt/negativePrompt/w/h from the URL.
  // Note: prompt/negativePrompt are captured by initial useState (lines above);
  // w/h are NOT in initial state (defaults are 768×512) and are instead applied
  // by the separate incomingWidth/incomingHeight effect on first render —
  // which runs BEFORE this strip-pass since effects fire in declaration order.
  // The result is the same one-shot consumption, just via two effects.
  useEffect(() => {
    const remixGateKeys = ['modelId', 'numFrames', 'fps', 'seed', 'steps', 'guidanceScale', 'tiling', 'disableAudio'];
    const present = remixGateKeys.filter((k) => searchParams.get(k) != null);
    if (present.length === 0) return;
    const get = (k) => searchParams.get(k);
    if (get('modelId')) {
      setModelId(get('modelId'));
      setRemixSourceModel({ id: get('modelId'), preserveConditioning: false });
    }
    const nf = Number(get('numFrames'));
    if (Number.isFinite(nf) && nf > 0) setNumFrames(nf);
    const f = Number(get('fps'));
    if (Number.isFinite(f) && f > 0) setFps(f);
    if (get('seed') != null) setSeed(get('seed'));
    if (get('steps')) setSteps(get('steps'));
    // guidanceScale=0 is a meaningful value (CFG off); test for presence,
    // not truthiness, so "0" round-trips through Remix correctly.
    if (get('guidanceScale') != null && get('guidanceScale') !== '') setGuidanceScale(get('guidanceScale'));
    // tiling: URL params are user-controlled; only accept values defined in
    // VIDEO_TILING_OPTIONS so a hand-edited URL or stale link can't push the
    // <select> into an invalid state and 400 the next POST.
    const urlTiling = get('tiling');
    if (urlTiling && VIDEO_TILING_ENUM_SET.has(urlTiling)) setTiling(urlTiling);
    // disableAudio is a boolean; accept the common encodings a hand-edited URL
    // might carry ('1' from our own Remix builder, 'true' from a manual share).
    // Anything else (absent, '0', 'false', garbage) means "default off".
    const audioParam = (get('disableAudio') || '').toLowerCase();
    setDisableAudio(audioParam === '1' || audioParam === 'true');
    const stripKeys = [...remixGateKeys, 'prompt', 'negativePrompt', 'w', 'h'];
    setSearchParams((prev) => {
      const n = new URLSearchParams(prev);
      stripKeys.forEach((k) => n.delete(k));
      return n;
    }, { replace: true });
  }, []);

  // Object URLs for the currently-selected upload Files so we can render
  // real previews before the files ever hit the server. Revoked on change /
  // unmount so the blobs are released.
  const [sourceUploadUrl, setSourceUploadUrl] = useState(null);
  useEffect(() => {
    if (!(sourceImageUpload instanceof File)) { setSourceUploadUrl(null); return; }
    const url = URL.createObjectURL(sourceImageUpload);
    setSourceUploadUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [sourceImageUpload]);
  const [lastUploadUrl, setLastUploadUrl] = useState(null);
  useEffect(() => {
    if (!(lastImageUpload instanceof File)) { setLastUploadUrl(null); return; }
    const url = URL.createObjectURL(lastImageUpload);
    setLastUploadUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [lastImageUpload]);

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

  // ?lora=<filename> preselects a video LoRA when the user clicks "Test" on a
  // video LoRA card in /models/loras. Mirrors the ImageGen ?lora= handoff:
  // defer until the library has loaded (for name/scale/triggers), append the
  // LoRA's trigger words, then strip the param so a refresh doesn't re-add it.
  useEffect(() => {
    const fromUrl = searchParams.get('lora');
    if (!fromUrl || !availableLoras.length) return;
    const match = availableLoras.find((l) => l.filename === fromUrl);
    if (match) {
      // A video (ltx-video) LoRA only renders on an ltx2 model. The default
      // video model is often mlx_video (e.g. ltx23_distilled_q4 on macOS), where
      // the picker is hidden and the payload omits the LoRA — so the Test
      // handoff would silently no-op. Switch to an available ltx2 model first.
      // Wait for `models` to load before deciding (the LoRA library usually
      // loads first); the mode is still the default 'text', with which every
      // ltx2 model is compatible, so the modelId-validation effect won't undo
      // this. A non-video LoRA needs no switch (the image picker tolerates it).
      // Family-agnostic on BOTH sides: an incoming H3 LoRA must be recognized as
      // video (else the Test handoff from /models/loras lands in the no-op
      // branch), and the model it switches to must be one whose family matches,
      // not an ltx2 model that would reject it.
      const incomingFamily = loraFamilyOf(match);
      const cur = models.find((m) => m.id === modelId);
      if (isVideoLoraFamily(incomingFamily) && videoLoraFamily(cur) !== incomingFamily) {
        if (!models.length) return; // re-runs when models loads (in deps)
        const compatible = models.find((m) => videoLoraFamily(m) === incomingFamily);
        if (compatible) setModelId(compatible.id);
      }
      setSelectedLoras((prev) => prev.find((s) => s.filename === fromUrl) ? prev : [...prev, {
        filename: match.filename,
        name: match.name,
        scale: typeof match.recommendedScale === 'number' ? match.recommendedScale : 1.0,
      }]);
      if (match.triggerWords?.length) {
        setPrompt((p) => { const add = match.triggerWords.join(', '); return p && p.trim() ? `${p}, ${add}` : add; });
      }
    }
    setSearchParams((prev) => { const next = new URLSearchParams(prev); next.delete('lora'); return next; }, { replace: true });
  }, [availableLoras, models]);

  // Models filtered to the current mode's compatibility. Drives the
  // <ModelSelect> options and the auto-select fallback so the user can't
  // land on a model the server will reject.
  const visibleModels = useMemo(
    () => models.filter((m) => isModelAllowedForMode(m, mode)),
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
  // Other modes: status.defaultModel (if compatible) > first compatible model.
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
      // typeof === 'number' (not `status?.systemMemoryGb ? ...`) so a server
      // legitimately reporting a tiny number (0 GB after rounding on a
      // sub-GB box) flows through the `fits` check and lands on the
      // smallest model. The truthiness shortcut would collapse 0 with
      // "absent" and pick the LARGEST model on a tiny machine.
      const budget = typeof status?.systemMemoryGb === 'number'
        ? Math.max(0, status.systemMemoryGb - reserveGb)
        : Number.POSITIVE_INFINITY;
      const sortedDesc = [...visibleModels].sort(
        (a, b) => videoModelMemoryGb(b) - videoModelMemoryGb(a),
      );
      const fits = sortedDesc.find((m) => videoModelMemoryGb(m) <= budget);
      fallback = (fits || sortedDesc[sortedDesc.length - 1])?.id || '';
    } else {
      const defaultModel = models.find((m) => m.id === status?.defaultModel);
      if (defaultModel && isModelAllowedForMode(defaultModel, mode)) {
        fallback = defaultModel.id;
      } else {
        fallback = visibleModels[0]?.id || status?.defaultModel || models[0]?.id || '';
      }
    }
    if (!fallback || fallback === modelId) return;
    // Toast only for the stale-id case (model removed from catalog). The
    // mode-incompatibility swap is expected behavior after a mode change —
    // no need to surface it. Name the destination model so users on a2v
    // don't think they landed on `status.defaultModel` (they may not have —
    // a2v picks the largest-fits model, which is often a dgrauet entry).
    if (!current && staleModelToastRef.current !== modelId) {
      staleModelToastRef.current = modelId;
      const fallbackName = models.find((m) => m.id === fallback)?.name || fallback;
      toast(`Original model "${modelId}" is no longer available — switched to "${fallbackName}"`);
    }
    applyModelSelection(fallback);
  }, [modelId, models, status?.defaultModel, status?.systemMemoryGb, mode, visibleModels, applyModelSelection]);

  const currentModel = models.find((m) => m.id === modelId);

  // A source model can reach this hook either through a URL handoff before
  // /status has populated `models`, or from the in-page gallery after it has.
  // Resolve both cases here. The fallback is deliberately limited to models
  // that can run a text remix and expose all restored prompt/sampler controls;
  // if no such model is installed we leave the source selected rather than
  // silently changing a faithful re-render.
  useEffect(() => {
    if (!remixSourceModel || models.length === 0) return;
    const source = models.find((model) => model.id === remixSourceModel.id);
    if (source && !remixSourceModel.preserveConditioning && !hasEditableRemixControls(source)) {
      const target = editableRemixModel(models, status?.defaultModel);
      if (target) {
        setModelId(target.id);
        setRemixModelFallback({
          sourceName: source.name || source.id,
          targetName: target.name || target.id,
          samplerLocked: source.samplerLocked === true,
          negativePromptUnsupported: source.supportsNegativePrompt === false,
        });
      }
    } else {
      setRemixModelFallback(null);
    }
    setRemixSourceModel(null);
  }, [remixSourceModel, models, status?.defaultModel]);

  // Until the user deliberately chooses a size, model changes carry their own
  // native default canvas. This is material for H3: the shared 768x512 default
  // is an off-distribution wiring-test size, while its trained 16:9 canvas is
  // 1344x768. A source image still wins through the aspect-snap effect above,
  // and Remix/Continue/user edits set sizeManuallySetRef so they are preserved.
  useEffect(() => {
    if (!currentModel || sizeManuallySetRef.current || sourceImageFile || sourceUploadUrl) return;
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
    // And the same for the decode: only some models declare a draft decoder, so
    // a switch away from one must not leave "Draft" selected on a model whose
    // renders would silently be full decodes. `resolveDraftDecodeForModel` also
    // clamps a DELIVERY model to Full — applyFinish covers the Finish button,
    // but a model picked by hand (or restored from history) reaches here instead.
    setDraftDecode((current) => resolveDraftDecodeForModel(current, currentModel, models));
  }, [currentModel, models]);

  // Substitutable prompt conditioners the selected model can load, straight off
  // the server-decorated entry. Empty for every runtime without substitutions,
  // which is what hides the picker — the page never re-derives that from a
  // runtime name.
  const textEncoderOptions = textEncoderOptionsForModel(currentModel);

  // Decode choices the selected model declares, straight off the
  // server-decorated entry (lib/videoDraftDecoders.js
  // `publicVideoDraftDecodeOptions`). Empty for every model with no draft
  // decoder, which is what hides the control — the page never re-derives that
  // from a runtime name.
  const draftDecodeOptions = draftDecodeOptionsForModel(currentModel);

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
  // Hoisted above the reference-mode derivation below, which needs it: the grok
  // lane reads only prompt/dims/source-image/duration, so its image_to_video
  // always anchors and the promise has to collapse to the default there.
  const isGrok = grokEnabled && backend === 'grok';
  const referenceModeApplies = mode === 'image' && !isGrok;
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
  const handleRandomSeed = () => setSeed(randomSeed());
  // Switching model drops the sampler overrides — steps/guidanceScale are
  // per-model defaults, and carrying one model's numbers onto another is
  // usually wrong.
  const handleModelChange = (nextId) => {
    setRemixSourceModel(null);
    setRemixModelFallback(null);
    applyModelSelection(nextId);
  };

  const dropSourceImageParam = () => {
    if (!incomingSourceImage) return;
    const next = new URLSearchParams(searchParams);
    next.delete('sourceImageFile');
    setSearchParams(next, { replace: true });
  };

  const clearSourceImage = () => {
    setSourceImageFile(null);
    setSourceImageUpload(null);
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
    dropSourceImageParam();
    setSourceImageFile(filename);
  };
  // Clear any gallery pick + URL param when an upload is chosen — otherwise the
  // preview keeps rendering the old gallery image while the POST sends the
  // upload.
  const uploadSourceImage = (file) => {
    if (file && (sourceImageFile || incomingSourceImage)) clearSourceImage();
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
    a2vModeBlocked,
    chainingActive,
    extendModeBlocked,
    icLoraModeBlocked,
    keyframesBlocked,
    keyframesError,
    maxSafeFrames,
  } = useVideoGenValidation({
    audioFile,
    chunks,
    currentModel,
    extendFromVideoId,
    extendingFrame,
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
    pixelBudget: status?.fflfLtx2PixelBudget,
    sourceImageFile,
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
    // Audio is only meaningful in a2v mode — drop it on every other switch
    // so a stale upload from a prior pick doesn't sneak into a non-a2v post.
    if (next !== 'a2v') setAudioFile(null);
    // Multi-keyframe is fflf-only — drop it on every other switch so a stale
    // keyframe list can't sneak into the next post (the route would 400 on a
    // non-fflf mode anyway, but keep the form honest).
    if (next !== 'fflf') { setKeyframesMode(false); setKeyframes([]); }
    const nextIcSpec = icLoraSpecForMode(next);
    if (nextIcSpec) {
      // IC conditioning replaces the frame/extend inputs entirely, and chaining
      // is rejected server-side (IC_LORA_CHUNKS_CONFLICT) — clear them so no
      // stale value implies it's being used.
      clearSourceImage();
      clearLastImage();
      setExtendFromVideoId('');
      setChunks(1);
      // Every IC mode takes a video, but NOT the same video: Control wants a
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
      // a2v takes audio only — buildGeneratePayload omits sourceImageFile +
      // sourceImage in this mode, so dropping them here keeps state honest
      // (no stale image survives in the form to imply it's being used).
      // The python helper supports an optional first-frame image, but the
      // UI doesn't expose it yet (see PR description "Out of scope"). Once
      // we add a gallery-pick path for the first frame, restore the source-
      // image state pass-through here.
      clearSourceImage();
      clearLastImage();
      setExtendFromVideoId('');
      // disableAudio strips the output audio track — in a2v mode that would
      // remove the user's uploaded audio, defeating the mode entirely.
      // noMusic appends a prompt constraint for text-conditioned audio gen;
      // a2v uses uploaded audio so the constraint is meaningless there too.
      setDisableAudio(false);
      setNoMusic(false);
      setChunks(1);
      // Auto-select to a compatible ltx2-runtime model is handled by the
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
    if (id === 'grok' && mode !== 'text' && mode !== 'image') {
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
    // preset), so a preset left selected would prefix itself a second time on
    // the next submit — the same reason applyRemix clears it.
    if (fillIfUntouched('prompt', srcPrompt, prompt, setPrompt)) setStylePreset(null);
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

  // Remix a prior render: hand all its params back into the form so the user
  // can iterate (tweak the prompt, sampler, seed, etc.) without re-typing.
  // Fixed-profile sources reconcile to an editable compatible model above;
  // otherwise the original model remains selected for a faithful re-render.
  // Mirrors ImageGen.handleRemix — in-page state set so the form jumps to
  // the new values without a navigation. The `item` is the raw video sidecar
  // (not the normalized MediaPreview shape).
  const applyRemix = (item, { preferEditableModel = true } = {}) => {
    if (!item) return;
    setRemixSourceModel(null);
    setRemixModelFallback(null);
    setStylePreset(null);
    // prompt: always set explicitly. Legacy entries can be missing `prompt`
    // (normalizeVideo surfaces them as '(no prompt)') — clear the form instead
    // of leaving whatever the user previously typed, matching the
    // useMediaPreviewActions.handleRemix '(no prompt)' filter.
    const nextPrompt = item.prompt && item.prompt !== '(no prompt)' ? item.prompt : '';
    setPrompt(nextPrompt);
    // negativePrompt: always set explicitly so remixing a clip with no
    // negative prompt clears any value the user previously typed. Skipping the
    // else-branch would leave stale form text and break the "round-trip
    // original settings" expectation.
    const neg = item.negativePrompt || item.negative_prompt || '';
    setNegativePrompt(neg);
    // Set modelId unconditionally when present. If models hasn't loaded yet
    // (race on initial mount), this avoids dropping the value silently — the
    // post-load validation effect (`Validate modelId once models are loaded`)
    // will fall back to defaultModel if the id doesn't end up in the catalog.
    if (item.modelId) {
      setModelId(item.modelId);
      setRemixSourceModel(preferEditableModel
        ? {
          id: item.modelId,
          preserveConditioning: !!item.textEncoderId
            || (Array.isArray(item.loraFilenames) && item.loraFilenames.length > 0),
        }
        : null);
      if (!preferEditableModel) setRemixModelFallback(null);
    }
    if (item.width) { setWidth(item.width); sizeManuallySetRef.current = true; }
    if (item.height) { setHeight(item.height); sizeManuallySetRef.current = true; }
    if (item.numFrames) setNumFrames(item.numFrames);
    if (item.fps) setFps(item.fps);
    if (item.seed != null) setSeed(String(item.seed));
    // steps/guidanceScale: always set explicitly. Legacy entries (created
    // before these were persisted) lack these fields — clear the form to the
    // empty-string sentinel rather than leaving the prior render's value
    // behind. The form treats '' as "use model default" so this is the
    // faithful round-trip for missing fields.
    setSteps(item.steps != null && item.steps !== '' ? String(item.steps) : '');
    const guidance = item.guidanceScale ?? item.guidance_scale ?? item.guidance;
    setGuidanceScale(guidance != null && guidance !== '' ? String(guidance) : '');
    // tiling must match the VIDEO_TILING_OPTIONS enum. Legacy sidecars sometimes
    // store a boolean here — silently ignore unknown values so the <select>
    // stays valid and the next POST doesn't 400.
    if (typeof item.tiling === 'string' && VIDEO_TILING_ENUM_SET.has(item.tiling)) setTiling(item.tiling);
    // ALWAYS set explicitly, like steps/guidanceScale above: history stamps the
    // strength only when it applied, so a missing field means "the model default"
    // and has to clear a leftover value rather than steer a render the user asked
    // to reproduce faithfully.
    setImageStrength(item.imageStrength != null && item.imageStrength !== '' ? String(item.imageStrength) : '');
    // The reference mode is NOT restored, on purpose. Remix drops to text mode
    // below and clears every conditioning input, so there is no reference left for
    // a promise to be about — carrying one forward would attach the record's
    // Inspire label to whatever image the user picks next. Reset it outright, the
    // same way the source image and keyframes are cleared.
    setI2vReferenceMode(DEFAULT_I2V_REFERENCE_MODE);
    // ALWAYS set explicitly (like steps/guidanceScale above): history records the
    // conditioner only when it wasn't the stock one, so a missing field means
    // 'stock' and must clear a leftover override rather than silently reusing it
    // on a render the user asked to reproduce faithfully. The currentModel effect
    // snaps an id this model can't load back to stock.
    setTextEncoderId(textEncoderIdFromRecord(item.textEncoderId));
    setSpeedProfileId(speedProfileIdFromRecord(item.speedProfileId));
    setDraftDecode(draftDecodeFromRecord(item.draftDecode));
    // disableAudio: always set explicitly (true/false) so the toggle reliably
    // matches the remixed render. Skipping the false branch would leave the
    // toggle stuck ON when the user remixes a clip that had audio enabled.
    const remixDisableAudio = item.disableAudio ?? item.disable_audio;
    setDisableAudio(remixDisableAudio === true);
    // Per-chunk beats (#3695): ALWAYS set explicitly, like prompt/negativePrompt
    // above. A stitched chain entry carries the beats it rendered with; anything
    // else carries none, and leaving the form's beats behind would steer a
    // "faithful reproduction" remix with text from the render the user was
    // previously composing. `null` (an absent beat) maps back to the editor's ''.
    setChunkPrompts(Array.isArray(item.chunkPrompts)
      ? item.chunkPrompts.map((cp) => (typeof cp === 'string' ? cp : ''))
      : []);
    // Chunk count comes from the stitched entry's own chunk list — beats only
    // ride to the server while `chunks > 1`, so restoring the beats without the
    // count would leave them typed-but-inert. A non-chained entry resets to 1
    // rather than inheriting whatever the form last had.
    setChunks(Array.isArray(item.chainedFrom) && item.chainedFrom.length > 1
      ? Math.min(item.chainedFrom.length, MAX_CHUNKS)
      : 1);
    // Reset to text-to-video mode and clear any stale conditioning inputs from
    // image / fflf / extend / a2v / IC-remix modes. Without this, clicking Remix
    // while currently in (e.g.) image mode would carry the old source image into
    // the next submit even though Remix is meant to faithfully reproduce the
    // prior (text-to-video) render. Cross-page Remix already lands the user in
    // text mode because /media/video without `sourceImageFile` defaults that way.
    setMode('text');
    setSourceImageFile(null);
    setSourceImageUpload(null);
    setLastImageFile(null);
    setLastImageUpload(null);
    setExtendFromVideoId('');
    setAudioFile(null);
    // IC-LoRA reference: the record only stamps the clip's BASENAME (history is
    // user-facing and never carries staging paths), so a remix can't re-derive
    // the reference — clear it rather than restore a half-set mode the user
    // would submit unknowingly. The dials DO round-trip.
    setIcReferenceFile(null);
    setIcReferenceVideoId('');
    setIcReferenceImageFiles([]);
    if (typeof item.icStrength === 'number') setIcStrength(item.icStrength);
    setIcSkipStage2(item.icSkipStage2 === true);
    // Restore the LoRA picker from the render record. `item` here is the RAW
    // history record (the gallery passes `handleRemixVideo(item.raw)` and every
    // field above — prompt/modelId/width/… — is read off it directly), so the
    // LoRAs live on `item.loraFilenames`/`item.loraScales` (the parallel-array
    // contract the record is stamped with). Names resolve from the loaded
    // library, falling back to the filename. The picker self-hides when the
    // remixed model isn't ltx2, and the payload omits LoRAs there.
    if (Array.isArray(item.loraFilenames) && item.loraFilenames.length) {
      setSelectedLoras(item.loraFilenames.map((filename, i) => ({
        filename,
        name: availableLoras.find((a) => a.filename === filename)?.name || filename,
        scale: typeof item.loraScales?.[i] === 'number' ? item.loraScales[i] : 1.0,
      })));
    } else {
      setSelectedLoras([]);
    }
  };

  // Finish a draft (#3696): restore the draft's provenance exactly as Remix
  // does, then switch to its declared delivery model. Steps/guidance are reset
  // to the empty-string sentinel ("use the model's own defaults") rather than
  // carried over — the draft's 4-step / guidance-1.0 sampler is the whole thing
  // Finish is meant to leave behind, and copying it to the delivery model would
  // reproduce the draft at full cost. The seed IS carried (applyRemix restores
  // it), which is what makes the finished render the same composition.
  //
  // This only fills the form. Nothing is submitted — the user still has to
  // press Generate, so no provider call fires off a gallery click.
  const applyFinish = (item, deliveryModelId) => {
    if (!item || !deliveryModelId) return;
    applyRemix(item, { preferEditableModel: false });
    // Force the local backend: the delivery model is a local registry entry, so
    // finishing while the form happens to be on the Grok backend would leave
    // `isGrok` true and submit a Grok payload that ignores the model entirely.
    setBackend('local');
    setModelId(deliveryModelId);
    setRemixSourceModel(null);
    setRemixModelFallback(null);
    setSteps('');
    setGuidanceScale('');
    // Finish is the delivery render, so it always decodes on the full decoder.
    // The server enforces the same thing from the other side — a model the
    // finish graph names as a delivery target is declined by
    // `draftDecodeDeclineReason`, and a Finish target is one by definition —
    // but forcing it here means the user SEES the control agree with what will
    // happen rather than reading Draft on a render that will ignore it.
    setDraftDecode(DEFAULT_DRAFT_DECODE_ID);
  };

  // Repopulate the form from an in-flight (or queued) render restored via
  // /active, so a page reload doesn't lose what the running job is rendering.
  // The page owns the SSE re-attach; this only replays the params into state.
  const applyResumedParams = (p = {}) => {
    if (p.prompt) setPrompt(p.prompt);
    if (p.negativePrompt) setNegativePrompt(p.negativePrompt);
    if (p.modelId) setModelId(p.modelId);
    if (p.width) { setWidth(p.width); sizeManuallySetRef.current = true; }
    if (p.height) { setHeight(p.height); sizeManuallySetRef.current = true; }
    if (p.numFrames) setNumFrames(p.numFrames);
    if (p.fps) setFps(p.fps);
    if (p.steps != null) setSteps(String(p.steps));
    if (p.guidanceScale != null) setGuidanceScale(String(p.guidanceScale));
    if (p.seed != null) setSeed(String(p.seed));
    if (p.tiling) setTiling(p.tiling);
    // Conditioning promise + strength. Both are echoed only when they applied, so
    // absence means "the defaults" and must CLEAR whatever the form last held —
    // a resumed page that kept a stale Inspire pick would describe the running
    // render's frame one wrongly.
    setImageStrength(p.imageStrength != null && p.imageStrength !== '' ? String(p.imageStrength) : '');
    setI2vReferenceMode(normalizeI2vReferenceMode(p.i2vReferenceMode));
    // Resume echoes the field only for a non-stock render, so absence is 'stock'.
    setTextEncoderId(textEncoderIdFromRecord(p.textEncoderId));
    setSpeedProfileId(speedProfileIdFromRecord(p.speedProfileId));
    setDraftDecode(draftDecodeFromRecord(p.draftDecode));
    if (typeof p.disableAudio === 'boolean') setDisableAudio(p.disableAudio);
    if (p.mode === 'grok') {
      // Grok job: 'grok' is the queue discriminator, not a semantic video
      // mode — restore the backend switch and the real t2v/i2v mode.
      setBackend('grok');
      setMode(p.videoMode === 'image' ? 'image' : 'text');
      if (p.duration) setGrokDuration(p.duration);
    } else if (p.mode) setMode(p.mode);
    if (p.chunks && p.chunks > 1) setChunks(p.chunks);
    // 0 is a real restored value ("last frame only"), so this can't gate on
    // truthiness the way `chunks` does — that would silently upgrade a render
    // the user deliberately put on last-frame chaining back to a window.
    // Absence is tested separately from the numeric check rather than folded
    // into one `Number.isFinite(...)`: the route persists a number today, but a
    // share link or hand-rolled client sends `'0'`, and a bare isFinite on the
    // raw value rejects that string while `Number(null)`/`Number('')` are both
    // a finite 0 that would wrongly clear the default. Same shape the
    // `guidanceScale` restore above uses, for the same round-tripping reason.
    if (p.contextFrames != null && p.contextFrames !== '' && Number.isFinite(Number(p.contextFrames))) {
      setContextFrames(Number(p.contextFrames));
    }
    // Per-chunk beats (#3695). The server normalizes an absent beat to null;
    // the editor's shape is '' for the same thing, so map back on restore.
    if (Array.isArray(p.chunkPrompts) && p.chunkPrompts.length) {
      setChunkPrompts(p.chunkPrompts.map((cp) => (typeof cp === 'string' ? cp : '')));
    }
    // Multi-keyframe FFLF: the route maps the stored { path, index } back to
    // { file, index } (gallery basename) for us, so restore the picker
    // state directly. >= 2 mirrors the server's accept floor; flipping
    // keyframesMode on re-renders the multi-keyframe picker (the model was
    // ltx2 for the job to have keyframes, so keyframesSupported holds once
    // setModelId above resolves).
    if (Array.isArray(p.keyframes) && p.keyframes.length >= 2) {
      setKeyframes(p.keyframes.map((kf) => ({ file: kf.file, index: kf.index })));
      setKeyframesMode(true);
    }
    // IC-LoRA remix: the dials round-trip, but the reference clip can't —
    // /active echoes only its basename (an upload isn't re-derivable from
    // one). That's fine while the job runs (the render already holds the real
    // path); the panel's submit gate correctly blocks a NEW render until the
    // user re-picks a reference. The names ride into a read-only hint.
    if (typeof p.icStrength === 'number') setIcStrength(p.icStrength);
    if (typeof p.icSkipStage2 === 'boolean') setIcSkipStage2(p.icSkipStage2);
    if (Array.isArray(p.icReferenceNames) && p.icReferenceNames.length) {
      setIcReferenceNames(p.icReferenceNames);
    }
    // Unlike a clip, an image-kind reference IS re-derivable: it's a gallery
    // basename, which is exactly the submit shape. So the resumed form
    // repopulates its picker and the submit gate unblocks without a re-pick.
    if (Array.isArray(p.icReferenceImageFiles) && p.icReferenceImageFiles.length) {
      setIcReferenceImageFiles(p.icReferenceImageFiles);
    }
    // Restore the LoRA picker — params carry { filename, scale } basenames;
    // resolve the display name from the loaded library (falls back to the
    // filename if the library hasn't loaded yet or the LoRA was deleted).
    if (Array.isArray(p.loras) && p.loras.length) {
      setSelectedLoras(p.loras.map((l) => ({
        filename: l.filename,
        name: availableLoras.find((a) => a.filename === l.filename)?.name || l.filename,
        scale: typeof l.scale === 'number' ? l.scale : 1.0,
      })));
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

  // Snapshot the current validated state into a wire payload. The submit flow
  // stays pure so all three backend contracts can be tested independently.
  const submissionState = {
    isGrok, grokDuration, remoteSubmissionFields,
    prompt, negativePrompt, stylePreset,
    width, height, mode, sourceImageFile, sourceImageUpload,
    numFrames, fps, steps, guidanceScale, seed,
    currentModel, models, modelId, tiling, textEncoderId, speedProfileId, draftDecode,
    disableAudio, noMusic, imageStrength, i2vReferenceMode,
    keyframesActive, keyframes, loraFamily, selectedLoras,
    lastImageFile, lastImageUpload, extendFromVideoId, audioFile,
    icModeActive, icImageKind, icReferenceFile, icReferenceVideoId,
    icReferenceImageFiles, icStrength, icSkipStage2,
    chainingActive, chunks, chunkPrompts, contextFrames,
  };
  const { buildGeneratePayload, envelopedPrompt } = useVideoGenSubmitFlow(submissionState);

  return {
    // Backend + mode
    backend, isGrok, handleBackendChange,
    grokDuration, setGrokDuration,
    mode, handleModeChange,
    // Prompt + style
    prompt, setPrompt,
    // The exact prompt a render would be submitted with right now (style preset
    // + no-music envelope). The LoRA picker's #4665 trigger hint reads THIS, not
    // the raw textarea, so it can never disagree with the server-side weave.
    envelopedPrompt,
    negativePrompt, setNegativePrompt,
    stylePreset, setStylePreset,
    remixModelFallback,
    // Model
    modelId, handleModelChange, currentModel, visibleModels,
    loraFamily, videoLoras, loraUnavailableHint,
    selectedLoras, setSelectedLoras,
    // Sampler / output
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
    seed, setSeed, handleRandomSeed,
    tiling, setTiling,
    textEncoderId, setTextEncoderId, textEncoderOptions,
    speedProfileId, setSpeedProfileId,
    draftDecode, setDraftDecode, draftDecodeOptions,
    disableAudio, setDisableAudio,
    noMusic, setNoMusic,
    // Frames
    sourceImageFile, sourceImageUpload, sourceUploadUrl,
    pickSourceImage, uploadSourceImage, clearSourceImage,
    lastImageFile, lastImageUpload, lastUploadUrl,
    pickLastImage, uploadLastImage, clearLastImage, lastFrameIsAdvisory,
    // Keyframes
    keyframesMode, keyframes, keyframesSupported, keyframesActive, keyframesError, keyframesBlocked,
    toggleKeyframesMode, addKeyframe, updateKeyframe, removeKeyframe,
    // Extend
    extendFromVideoId, extendingFrame, handleExtendPick, extendModeBlocked,
    // Audio-to-video
    audioFile, setAudioFile, a2vModeBlocked,
    // IC-LoRA remix
    icSpec, icModeActive, icImageKind, icLoraModeBlocked,
    icReferenceFile, icReferenceVideoId, icReferenceNames, icReferenceImageFiles,
    pickIcReferenceFile, pickIcReferenceVideoId,
    addIcReferenceImage, updateIcReferenceImage, removeIcReferenceImage,
    icStrength, setIcStrength,
    icSkipStage2, setIcSkipStage2,
    // Prefill + submit
    applyRemix, applyFinish, applyResumedParams, buildGeneratePayload,
  };
}

export default useVideoGenForm;
