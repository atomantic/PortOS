import { useState, useEffect, useRef, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import toast from '../components/ui/Toast';
import { extractLastFrame } from '../services/api';
import { composeStyledPrompt } from '../lib/composeStyledPrompt';
import { videoLoraFamily, VIDEO_LORA_FAMILIES } from '../lib/runnerFamilies';
import { randomSeed } from '../lib/genUtils';
import { VIDEO_RESOLUTIONS, snapAspectToImage } from '../lib/videoGenResolutions';
import { clampImageEdge } from '../lib/imageGenResolutions';
import { GROK_VIDEO_DEFAULT_DURATION } from '../lib/grokVideoClip.js';
import { VIDEO_TILING_ENUM_SET } from '../lib/videoTilingOptions';
import {
  VIDEO_EDGE_BOUNDS,
  videoModelMemoryGb, computeFflfSafeFrames, isModelAllowedForMode,
  icLoraSpecForMode, icResolutionIssue,
} from '../lib/videoGenParams.js';

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
 */
export function useVideoGenForm({ models, status, availableLoras, grokEnabled }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const incomingSourceImage = searchParams.get('sourceImageFile');
  const incomingPrompt = searchParams.get('prompt');
  const incomingNegativePrompt = searchParams.get('negativePrompt');
  const incomingWidth = searchParams.get('w');
  const incomingHeight = searchParams.get('h');

  // Grok Build CLI video backend (#2859 phase 2) — surfaced only when the
  // user enabled Grok in Settings → Image Gen (one toggle covers image +
  // video). 'local' keeps every existing flow untouched.
  const [backend, setBackend] = useState('local');
  const [grokDuration, setGrokDuration] = useState(GROK_VIDEO_DEFAULT_DURATION);

  const [mode, setMode] = useState(incomingSourceImage ? 'image' : 'text');
  const [prompt, setPrompt] = useState(incomingPrompt || '');
  const [negativePrompt, setNegativePrompt] = useState(incomingNegativePrompt || '');
  const [stylePreset, setStylePreset] = useState(null);
  const [modelId, setModelId] = useState('');
  const [width, setWidth] = useState(768);
  const [height, setHeight] = useState(512);
  // Set once the size has been chosen deliberately — the user picking a preset,
  // or an explicit size arriving via Continue/Remix/restore. While it's false,
  // selecting an I2V source image auto-snaps W×H to the source's aspect ratio
  // (so the default frame doesn't cover-crop the subject). The snap itself does
  // NOT set this, so re-picking a different source still re-snaps until the user
  // takes the size into their own hands.
  const sizeManuallySetRef = useRef(false);
  const [numFrames, setNumFrames] = useState(121);
  const [fps, setFps] = useState(24);
  const [chunks, setChunks] = useState(1);
  const [steps, setSteps] = useState('');
  const [guidanceScale, setGuidanceScale] = useState('');
  const [imageStrength, setImageStrength] = useState('');
  const [seed, setSeed] = useState('');
  const [tiling, setTiling] = useState('auto');
  const [disableAudio, setDisableAudio] = useState(false);
  // Video LoRAs (ltx2 runtime only) — `{ filename, name, scale }` entries the
  // LoraPicker owns; `availableLoras` is the full installed library filtered
  // by the picker to the model's video family. See videoLoraFamily().
  const [selectedLoras, setSelectedLoras] = useState([]);
  // "No music" appends a soundscape constraint at submit time. LTX-2
  // conditions audio on prompt text — adding "no music, no soundtrack"
  // pushes the model toward ambient/diegetic sound (footsteps, room tone)
  // and away from generated background music, which is hard to remove
  // cleanly in post. Source: phosphene LTX-2 prompting guide.
  const [noMusic, setNoMusic] = useState(false);
  const [sourceImageFile, setSourceImageFile] = useState(incomingSourceImage || null);
  const [sourceImageUpload, setSourceImageUpload] = useState(null);
  const [lastImageFile, setLastImageFile] = useState(null);
  const [lastImageUpload, setLastImageUpload] = useState(null);
  // Multi-keyframe FFLF (ltx2 runtime only): the user anchors 2–8 gallery
  // images at specific pixel-frame indices and the model interpolates between
  // them. This is a distinct server path from the legacy first/last pair
  // (the route rejects mixing the two) — `keyframesMode` flips fflf between
  // the two pickers. Each entry is { file, index } where file is a gallery
  // basename; the route resolves it to an absolute path. Keyframes are
  // gallery-only (no per-frame upload) because the route only accepts
  // gallery references for them.
  const [keyframesMode, setKeyframesMode] = useState(false);
  const [keyframes, setKeyframes] = useState([]);
  const [extendFromVideoId, setExtendFromVideoId] = useState('');
  const [extendingFrame, setExtendingFrame] = useState(false);
  // a2v mode — direct audio upload only (no gallery for audio yet). The File
  // is sent as multipart field name 'audioFile'; the server stages it under
  // data/uploads, then the python helper passes it to AudioToVideoPipeline.
  const [audioFile, setAudioFile] = useState(null);
  // IC-LoRA remix modes (issue #3100) — the reference clip is either a fresh
  // upload (multipart field 'icReference') or a prior render picked by history
  // id. The two are mutually exclusive server-side, so the panel's Clear drops
  // both. `icStrength` weights the reference conditioning channel.
  const [icReferenceFile, setIcReferenceFile] = useState(null);
  const [icReferenceVideoId, setIcReferenceVideoId] = useState('');
  // Image-kind IC references (Ingredients, #3112) — 2-8 gallery basenames rather
  // than the single clip above. Gallery-only, mirroring the route: the reference
  // list is a separate submit field (icReferenceImageFiles) so a clip can never
  // ride into an image-kind weight (which would silently produce garbage).
  const [icReferenceImageFiles, setIcReferenceImageFiles] = useState([]);
  const [icStrength, setIcStrength] = useState(1.0);
  const [icSkipStage2, setIcSkipStage2] = useState(false);
  // Display-only: the reference clip name(s) of an IN-FLIGHT render restored via
  // /active. An upload isn't re-derivable from its basename, so this can't
  // repopulate the picker — it just tells the user what the running job is
  // conditioned on instead of showing an empty panel.
  const [icReferenceNames, setIcReferenceNames] = useState([]);
  // Tracks the last stale modelId we already toasted about so the
  // validateModelId effect fires the "original model gone" toast exactly once
  // per unique stale id, even if the effect re-runs (e.g. models list updates).
  const staleModelToastRef = useRef(null);

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
  useEffect(() => {
    if (incomingPrompt) setPrompt(incomingPrompt);
  }, [incomingPrompt]);
  useEffect(() => {
    if (incomingNegativePrompt) setNegativePrompt(incomingNegativePrompt);
  }, [incomingNegativePrompt]);
  // When "Continue" pipes a video's last frame here, also sync the resolution
  // so the new render matches the source. Width/height get rounded to the
  // model's 64-pixel grid server-side, so off-grid sources still work.
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
    if (get('modelId')) setModelId(get('modelId'));
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
  // the server keeps its own 64-grid clamp. Gallery picks resolve to
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
      const snapped = snapAspectToImage(VIDEO_RESOLUTIONS, img.naturalWidth, img.naturalHeight);
      if (snapped) { setWidth(snapped.w); setHeight(snapped.h); }
    };
    img.src = src;
    return () => { cancelled = true; };
  }, [sourceImageFile, sourceUploadUrl]);

  // ?lora=<filename> preselects a video LoRA when the user clicks "Test" on a
  // video LoRA card in /media/loras. Mirrors the ImageGen ?lora= handoff:
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
      // this. A non-ltx2 LoRA needs no switch (the image picker tolerates it).
      const isVideoLora = (match.loraCompatKey || match.runnerFamily) === VIDEO_LORA_FAMILIES.LTX_VIDEO;
      const cur = models.find((m) => m.id === modelId);
      if (isVideoLora && !videoLoraFamily(cur)) {
        if (!models.length) return; // re-runs when models loads (in deps)
        const ltx2Model = models.find((m) => m.runtime === 'ltx2');
        if (ltx2Model) setModelId(ltx2Model.id);
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
    setModelId(fallback);
  }, [modelId, models, status?.defaultModel, status?.systemMemoryGb, mode, visibleModels]);

  const currentModel = models.find((m) => m.id === modelId);

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
    () => (loraFamily
      ? availableLoras.filter((l) => (l.loraCompatKey || l.runnerFamily) === loraFamily)
      : []),
    [availableLoras, loraFamily],
  );

  // Installed LTX-video LoRAs regardless of the selected model's runtime. When
  // the user picks an LTX-2.x model whose runtime can't fuse LoRAs (a quantized
  // mlx_video model — loraFamily is null), the picker is correctly hidden, but
  // silently doing so reads as a bug. Use this to explain *why* the LoRA is
  // unavailable and point at the models that CAN run it. The `/ltx-?2/i` scope
  // matches the server's LTX-2.x capability family (see isMlxVideoLtxLoraCapable)
  // so the hint never fires for a non-LTX-2.x model where the advice wouldn't apply.
  const installedVideoLoras = useMemo(
    () => availableLoras.filter(
      (l) => (l.loraCompatKey || l.runnerFamily) === VIDEO_LORA_FAMILIES.LTX_VIDEO,
    ),
    [availableLoras],
  );
  // Gated on the quantized-mlx_video case specifically (runtime mlx_video +
  // loraFamily null = a quantized LTX-2.x model) so the hint copy's "quantized
  // runtime isn't supported yet" wording always matches what triggered it.
  const showLtxLoraUnsupportedHint = !loraFamily && installedVideoLoras.length > 0
    && currentModel?.runtime === 'mlx_video'
    && /ltx-?2/i.test(`${currentModel?.id || ''} ${currentModel?.repo || ''} ${currentModel?.name || ''}`);

  // Multi-keyframe availability + validation. Keyframes are an ltx2-runtime
  // primitive (the route 400s with KEYFRAMES_REQUIRE_LTX2 otherwise), so the
  // picker only offers itself when the selected model runs on ltx2. Mirror
  // the server's accept rules (server/routes/videoGen.js ~line 574) so the
  // form blocks before a doomed POST: 2–8 entries, each pinned to a gallery
  // file, indices strictly ascending and within [0, numFrames-1].
  const keyframesSupported = currentModel?.runtime === 'ltx2';
  const keyframesActive = mode === 'fflf' && keyframesMode && keyframesSupported;
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
  const maxSafeFrames = useMemo(
    () => computeFflfSafeFrames(width, height, numFrames, status?.fflfLtx2PixelBudget),
    [width, height, numFrames, status?.fflfLtx2PixelBudget],
  );
  const keyframesError = useMemo(() => {
    if (!keyframesActive) return null;
    if (keyframes.length < 2) return 'Add at least 2 keyframes.';
    if (keyframes.length > 8) return 'Use at most 8 keyframes.';
    let prev = -1;
    for (let i = 0; i < keyframes.length; i++) {
      const kf = keyframes[i];
      if (!kf.file) return `Keyframe ${i + 1} needs a gallery image.`;
      if (!Number.isInteger(kf.index) || kf.index < 0) return `Keyframe ${i + 1} needs a frame index ≥ 0.`;
      if (kf.index > numFrames - 1) return `Keyframe ${i + 1} frame ${kf.index} must be below numFrames (${numFrames}).`;
      // Effective cap from the resolution-dependent pixel budget (< numFrames at
      // higher resolutions). Mirrors the worker's clamp so we don't POST a
      // render that 400s with LTX2_FFLF_PIXEL_BUDGET_EXCEEDED.
      if (maxSafeFrames < numFrames && kf.index > maxSafeFrames - 1) {
        return `Keyframe ${i + 1} frame ${kf.index} exceeds the ${width}×${height} pixel budget (max frame ${maxSafeFrames - 1}). Lower the resolution or raise FFLF_LTX2_PIXEL_BUDGET.`;
      }
      if (kf.index <= prev) return 'Keyframe frame indices must be strictly ascending.';
      prev = kf.index;
    }
    return null;
  }, [keyframesActive, keyframes, numFrames, maxSafeFrames, width, height]);
  const keyframesBlocked = keyframesActive && !!keyframesError;

  // Preset pick or custom W×H edit — mark the size as manually set so aspect-snap
  // on image upload stops overriding it (same flag the remix/deep-link paths set).
  // ResolutionField passes a transient 0 mid-edit and blur-snaps each edge to the
  // 64..2048 bound; the preview + FFLF-budget math guard against a transient 0,
  // and the server floors both dims to a multiple of 64 (generateVideo in
  // local.js) before enforcing the per-tier pixel budget.
  const handleResolutionChange = (w, h) => {
    setWidth(w); setHeight(h); sizeManuallySetRef.current = true;
  };
  const handleRandomSeed = () => setSeed(randomSeed());
  // Switching model drops the sampler overrides — steps/guidanceScale are
  // per-model defaults, and carrying one model's numbers onto another is
  // usually wrong.
  const handleModelChange = (nextId) => {
    setModelId(nextId); setSteps(''); setGuidanceScale('');
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
  const handleExtendPick = async (videoId) => {
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
    // ltx2 runtime: native ExtendPipeline conditions on the entire source
    // video's latent, so we DON'T need a last-frame PNG. Skip the ffmpeg
    // extract roundtrip — the route resolves the video id to a disk path
    // server-side. Saves ~1s per pick + avoids the i2v fallback when the
    // extract fails.
    if (currentModel?.runtime === 'ltx2') {
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
  // can iterate (tweak the prompt, swap seeds, etc.) without re-typing.
  // Mirrors ImageGen.handleRemix — in-page state set so the form jumps to
  // the new values without a navigation. The `item` is the raw video sidecar
  // (not the normalized MediaPreview shape).
  const applyRemix = (item) => {
    if (!item) return;
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
    if (item.modelId) setModelId(item.modelId);
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
    // disableAudio: always set explicitly (true/false) so the toggle reliably
    // matches the remixed render. Skipping the false branch would leave the
    // toggle stuck ON when the user remixes a clip that had audio enabled.
    const remixDisableAudio = item.disableAudio ?? item.disable_audio;
    setDisableAudio(remixDisableAudio === true);
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
    if (typeof p.disableAudio === 'boolean') setDisableAudio(p.disableAudio);
    if (p.mode === 'grok') {
      // Grok job: 'grok' is the queue discriminator, not a semantic video
      // mode — restore the backend switch and the real t2v/i2v mode.
      setBackend('grok');
      setMode(p.videoMode === 'image' ? 'image' : 'text');
      if (p.duration) setGrokDuration(p.duration);
    } else if (p.mode) setMode(p.mode);
    if (p.chunks && p.chunks > 1) setChunks(p.chunks);
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

  // In Extend mode the source image is populated asynchronously after the
  // user picks a prior video — until that extraction lands, sourceImageFile
  // is empty and the request would silently fall back to T2V while still
  // sending mode='extend'. Block submit/enqueue until the extend frame is
  // actually ready (and unblocks the disabled state on the buttons too).
  // ltx2-extend doesn't need a frame extraction — the route resolves the
  // video id directly. Block only on extendFromVideoId being unset (and on
  // legacy runtime, also wait for the extracted frame).
  const extendModeBlocked = mode === 'extend' && (
    !extendFromVideoId
    || (currentModel?.runtime !== 'ltx2' && (extendingFrame || !sourceImageFile))
  );
  // a2v requires an audio upload AND an ltx2-runtime model — the legacy
  // mlx_video runtime has no audio-conditioned pipeline. Block submit when
  // either is missing so the request fails the form, not the worker.
  const a2vModeBlocked = mode === 'a2v' && (!audioFile || currentModel?.runtime !== 'ltx2');
  // IC-LoRA remix needs a reference clip AND an ltx2-runtime model, and the
  // resolution must divide by the weight's reference-downscale factor (the
  // server rejects otherwise). Block submit for all three so the request fails
  // the form rather than the worker.
  // An image-kind weight is satisfied by min..max FILLED gallery rows (blank rows
  // are dropped from the payload, so an unfilled row must block rather than
  // silently submit a short list the route would 400).
  const icFilledImageRefs = icReferenceImageFiles.filter(Boolean).length;
  const icLoraModeBlocked = icModeActive && (
    (icImageKind
      ? (icFilledImageRefs < icSpec.minReferences || icFilledImageRefs > icSpec.maxReferences)
      : (!icReferenceFile && !icReferenceVideoId))
    || currentModel?.runtime !== 'ltx2'
    || !!icResolutionIssue(icSpec, width, height)
  );

  // Snapshot the current form into a generate-payload. Used both by the
  // inline Generate button and by enqueue, so the two paths stay in lockstep.
  const isGrok = grokEnabled && backend === 'grok';

  const buildGeneratePayload = () => {
    const composed = composeStyledPrompt(prompt, negativePrompt, stylePreset);
    if (isGrok) {
      // Grok's image-first flow reads only these fields; width/height ride
      // along so the server maps them to the closest supported aspect ratio.
      return {
        backend: 'grok',
        prompt: composed.prompt,
        negativePrompt: composed.negativePrompt,
        grokDuration,
        width: clampImageEdge(width, VIDEO_EDGE_BOUNDS),
        height: clampImageEdge(height, VIDEO_EDGE_BOUNDS),
        mode: mode === 'image' ? 'image' : 'text',
        sourceImageFile: mode === 'image' ? (sourceImageFile || '') : '',
        sourceImage: mode === 'image' ? (sourceImageUpload || '') : '',
      };
    }
    // Append "no music, no soundtrack" only when the toggle is on AND audio
    // generation is itself active — there's no point steering audio output
    // when audio is disabled outright. Idempotent: if the user already
    // typed "no music" we avoid double-appending.
    const promptOut = (noMusic && !disableAudio && !/no music/i.test(composed.prompt))
      ? `${composed.prompt}\n\nno music, no soundtrack`
      : composed.prompt;
    // Legacy first/last-frame fflf: the two-image picker is mutually exclusive
    // with multi-keyframe mode on the server, so its image fields only ride
    // along when keyframes aren't active.
    const legacyFflf = mode === 'fflf' && !keyframesActive;
    return {
      // The page's backend toggle IS an explicit choice — send it so the
      // server's #3231 video pin ladder can't reroute a Local render to a
      // pinned grok backend behind the UI's back.
      backend: 'local',
      prompt: promptOut,
      negativePrompt: composed.negativePrompt,
      modelId,
      // Clamp/floor to the runner's edge bounds so a transient 0 (field cleared
      // mid-edit) or off-grid value can't 400 the server — mirrors ImageGen's
      // submit-time clampImageEdge guard.
      width: clampImageEdge(width, VIDEO_EDGE_BOUNDS),
      height: clampImageEdge(height, VIDEO_EDGE_BOUNDS),
      numFrames,
      fps,
      steps: steps || '',
      guidanceScale: guidanceScale || '',
      seed: seed || '',
      tiling,
      disableAudio: disableAudio ? 'true' : 'false',
      mode,
      imageStrength: imageStrength || '',
      // ltx2-extend bypasses the last-frame i2v path: we send the source
      // video's history id directly so the server resolves it to a disk
      // path and routes through ExtendPipeline. Legacy extend (mlx_video)
      // still uses sourceImageFile populated from extractLastFrame.
      // keyframes goes as a JSON string — buildFormData would otherwise
      // stringify each {file,index} object to "[object Object]" (it appends
      // arrays element-by-element); the route's zod preprocess JSON-parses it
      // and strips any unknown keys, so sending the entries verbatim is safe.
      keyframes: keyframesActive ? JSON.stringify(keyframes) : '',
      // Video LoRAs (ltx2 only) ride as the universal parallel-array contract
      // (loraFilenames + loraScales) — the SAME shape ImageGen submits and a
      // history requeue emits — so buildFormData appends them as repeated
      // multipart keys and the route needs no bespoke shape. Only sent when the
      // model's runtime supports LoRAs (else the route 400s LORAS_REQUIRE_LTX2);
      // undefined fields are dropped by buildFormData.
      loraFilenames: (loraFamily && selectedLoras.length) ? selectedLoras.map((l) => l.filename) : undefined,
      loraScales: (loraFamily && selectedLoras.length) ? selectedLoras.map((l) => l.scale) : undefined,
      sourceImageFile: (mode === 'image' || legacyFflf
        || (mode === 'extend' && currentModel?.runtime !== 'ltx2'))
        ? (sourceImageFile || '') : '',
      sourceImage: (mode === 'image' || legacyFflf) ? (sourceImageUpload || '') : '',
      lastImageFile: legacyFflf ? (lastImageFile || '') : '',
      lastImage: legacyFflf ? (lastImageUpload || '') : '',
      extendFromVideoId: (mode === 'extend' && currentModel?.runtime === 'ltx2')
        ? (extendFromVideoId || '') : '',
      // Audio File goes through under the multipart field 'audioFile'. Server
      // routes it to the durable uploads dir and into the a2v helper.
      audioFile: mode === 'a2v' ? (audioFile || '') : '',
      // IC-LoRA remix: the reference clip rides as either the 'icReference'
      // multipart upload OR an icReferenceVideoIds history id — never both (the
      // route rejects that with IC_LORA_REFERENCE_CONFLICT).
      // Image-kind weights take gallery stills on their own field; the clip
      // fields stay empty for them (the route rejects mixing the two kinds with
      // IC_LORA_REFERENCE_KIND_MISMATCH).
      icReference: (icModeActive && !icImageKind) ? (icReferenceFile || '') : '',
      icReferenceVideoIds: (icModeActive && !icImageKind && !icReferenceFile) ? (icReferenceVideoId || '') : '',
      icReferenceImageFiles: icImageKind ? icReferenceImageFiles.filter(Boolean) : undefined,
      icStrength: icModeActive ? icStrength : '',
      icSkipStage2: icModeActive && icSkipStage2 ? 'true' : '',
      // Keyframes and IC references each anchor a single clip — the route
      // rejects chunks > 1 with KEYFRAMES_CHUNKS_CONFLICT /
      // IC_LORA_CHUNKS_CONFLICT, so suppress chunking for both.
      chunks: mode !== 'a2v' && !keyframesActive && !icModeActive && chunks > 1 ? chunks : '',
    };
  };

  return {
    // Backend + mode
    backend, isGrok, handleBackendChange,
    grokDuration, setGrokDuration,
    mode, handleModeChange,
    // Prompt + style
    prompt, setPrompt,
    negativePrompt, setNegativePrompt,
    stylePreset, setStylePreset,
    // Model
    modelId, handleModelChange, currentModel, visibleModels,
    loraFamily, videoLoras, installedVideoLoras, showLtxLoraUnsupportedHint,
    selectedLoras, setSelectedLoras,
    // Sampler / output
    width, height, handleResolutionChange,
    numFrames, setNumFrames,
    fps, setFps,
    chunks, setChunks,
    steps, setSteps,
    guidanceScale, setGuidanceScale,
    imageStrength, setImageStrength,
    seed, setSeed, handleRandomSeed,
    tiling, setTiling,
    disableAudio, setDisableAudio,
    noMusic, setNoMusic,
    // Frames
    sourceImageFile, sourceImageUpload, sourceUploadUrl,
    pickSourceImage, uploadSourceImage, clearSourceImage,
    lastImageFile, lastImageUpload, lastUploadUrl,
    pickLastImage, uploadLastImage, clearLastImage,
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
    applyRemix, applyResumedParams, buildGeneratePayload,
  };
}

export default useVideoGenForm;
