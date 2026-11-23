/**
 * VideoGen URL handoffs: music-render audio, ImageGen/Continue source image, Send-to-Video prompt and size, Remix bundle and `?lora=`.
 *
 * Use when: Internal slice composed by `useVideoGenForm`. It applies each deep link to the
 * field-state groups once and strips the one-shot params, so a refresh or back-nav never
 * re-clobbers edits the user made since.
 */

import { useEffect } from 'react';
import toast from '../ui/Toast';
import { trackAudioUrl } from '../../services/apiTracks.js';
import { isVideoLoraFamily, loraFamilyOf, videoLoraFamily } from '../../lib/runnerFamilies';
import { normalizeVideoTiling } from '../../lib/videoTilingOptions';

/** The handoff values the field state seeds its initial values from. */
export const readVideoGenIncoming = (searchParams) => ({
  incomingSourceImage: searchParams.get('sourceImageFile'),
  incomingAudioFilename: searchParams.get('audioFilename'),
  incomingPrompt: searchParams.get('prompt'),
  incomingNegativePrompt: searchParams.get('negativePrompt'),
  incomingWidth: searchParams.get('w'),
  incomingHeight: searchParams.get('h'),
});

/**
 * `fields` is the grouped state from `useVideoGenFieldState`. Returns
 * `dropSourceImageParam`, which the source-image pickers call so a gallery pick
 * or upload replaces the deep-linked image instead of fighting it.
 */
export function useVideoGenUrlPrefill({
  searchParams, setSearchParams, incoming, fields, models, modelId, availableLoras,
}) {
  const {
    incomingSourceImage, incomingAudioFilename, incomingPrompt, incomingNegativePrompt,
    incomingWidth, incomingHeight,
  } = incoming;
  const { setPrompt, setNegativePrompt, setStylePreset, setSelectedUniverse } = fields.prompt;
  const { setModelId, setRemixSourceModel, setSelectedLoras } = fields.model;
  const {
    setWidth, setHeight, sizeManuallySetRef, setNumFrames, setFps, setSeed, setSteps,
    setGuidanceScale, setTiling, setDisableAudio,
  } = fields.sampler;
  const { setMode, setSourceImageFile, setSourceImageUpload, setUnavailableSourceImageName } = fields.frames;
  const { setAudioFile, audioHandoffRef } = fields.conditioning;

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

  // Re-sync when ImageGen pipes a new image via ?sourceImageFile=...
  useEffect(() => {
    if (incomingSourceImage) {
      setSourceImageFile(incomingSourceImage);
      setSourceImageUpload(null);
      setUnavailableSourceImageName('');
      setMode((m) => (m === 'text' ? 'image' : m));
    }
  }, [incomingSourceImage]);
  // A prompt handed in through the URL (Continue, Send-to-Video, Remix) is the
  // COMPOSED prompt of an existing render — composeStyledPrompt already prefixed
  // it with whatever style layers produced it. Drop both pickers' selections
  // with it, or the next submit prefixes a style onto a prompt that already
  // carries one (the same double-styling applyRemix clears both pickers).
  useEffect(() => {
    if (incomingPrompt) {
      setPrompt(incomingPrompt);
      setStylePreset(null);
      setSelectedUniverse(null);
    }
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
  // Note: prompt/negativePrompt are captured by the field state's initial
  // useState; w/h are NOT in initial state (defaults are 768×512) and are
  // instead applied by the incomingWidth/incomingHeight effect above on first
  // render — which runs BEFORE this strip-pass since effects fire in
  // declaration order. The result is the same one-shot consumption, just via
  // two effects.
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
    const normalizedUrlTiling = normalizeVideoTiling(urlTiling);
    if (normalizedUrlTiling) setTiling(normalizedUrlTiling);
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

  const dropSourceImageParam = () => {
    if (!incomingSourceImage) return;
    const next = new URLSearchParams(searchParams);
    next.delete('sourceImageFile');
    setSearchParams(next, { replace: true });
  };

  return { dropSourceImageParam };
}

export default useVideoGenUrlPrefill;
