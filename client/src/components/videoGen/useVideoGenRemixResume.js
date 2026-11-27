/** Restores VideoGen form fields from history, a draft, or a queued render. */
import { useEffect } from 'react';
import { DEFAULT_I2V_REFERENCE_MODE, normalizeI2vReferenceMode } from '../../lib/videoReferenceModes';
import { normalizeVideoTiling } from '../../lib/videoTilingOptions';
import {
  MAX_CHUNKS, supportsContextWindow, isModelAllowedForMode,
  textEncoderIdFromRecord, speedProfileIdFromRecord,
} from '../../lib/videoGenParams.js';
import { videoStreamingModeFromRecord } from '../../lib/videoStreamingMode.js';

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

export function useVideoGenRemixResume({ fields, models, modelContext, availableLoras, setBackend, applyResumedLane, dropSourceImageParam }) {
  const {
    setPrompt, setNegativePrompt, setStylePreset, setSelectedUniverse,
  } = fields.prompt;
  const {
    modelId, setModelId, remixSourceModel, setRemixSourceModel, setRemixModelFallback,
    setSelectedLoras, setA2vLoraStageStrengths, setTextEncoderId, setSpeedProfileId, setStreamingMode,
  } = fields.model;
  const {
    setWidth, setHeight, sizeManuallySetRef, setNumFrames, setFps, setChunks, setChunkPrompts,
    setContextFrames, setSteps, setGuidanceScale, setImageStrength, setI2vReferenceMode, setBatchSize,
    setSeed, setTiling, setDisableAudio,
  } = fields.sampler;
  const {
    setMode, setSourceImageFile, setSourceImageUpload, setUnavailableSourceImageName,
    setLastImageFile, setLastImageUpload, setKeyframesMode, setKeyframes, setExtendFromVideoId,
  } = fields.frames;
  const {
    setAudioFile, setIcReferenceFile, setIcReferenceVideoId, setIcReferenceImageFiles,
    setIcReferenceNames, setIcStrength, setIcSkipStage2, setReferenceImageFiles,
    setUnavailableReferenceImageNames, setReferenceVideoIds, setReferenceAudioFiles,
  } = fields.conditioning;

  // A source model can reach this hook either through a URL handoff before the
  // model context has populated `models`, or from the in-page gallery after it
  // has. Resolve both cases here. The fallback is deliberately limited to models
  // that can run a text remix and expose all restored prompt/sampler controls;
  // if no such model is installed we leave the source selected rather than
  // silently changing a faithful re-render.
  useEffect(() => {
    if (!remixSourceModel || models.length === 0) return;
    const source = models.find((model) => model.id === remixSourceModel.id);
    if (source && !remixSourceModel.preserveConditioning && !hasEditableRemixControls(source)) {
      const target = editableRemixModel(models, modelContext?.defaultModel);
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
  }, [remixSourceModel, models, modelContext?.defaultModel]);

  // `applyRemix` resolves each restored LoRA's DISPLAY NAME out of the installed
  // library at apply time, falling back to the raw filename. The cross-page
  // Remix handoff (#6290) can apply before that library has landed — the page
  // fetches the LoRA list and the history list as independent mount effects with
  // no ordering — so re-resolve once it arrives, or the picker sits on
  // `lora-example-v7.safetensors` for the session. Filename and scale (what the
  // payload is built from) are untouched; only the label is filled in.
  useEffect(() => {
    if (!availableLoras.length) return;
    setSelectedLoras((prev) => {
      let changed = false;
      const next = prev.map((selected) => {
        const name = availableLoras.find((l) => l.filename === selected.filename)?.name;
        if (!name || name === selected.name) return selected;
        changed = true;
        return { ...selected, name };
      });
      return changed ? next : prev;
    });
  }, [availableLoras]);

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
    setSelectedUniverse(null);
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
    const tiling = normalizeVideoTiling(item.tiling);
    if (tiling) setTiling(tiling);
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
    setStreamingMode(videoStreamingModeFromRecord(item.streamingMode));
    setA2vLoraStageStrengths(item.a2vLoraStageStrengths ?? [1, 1]);
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
    setUnavailableSourceImageName('');
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
    setIcReferenceNames([]);
    setReferenceImageFiles([]);
    setUnavailableReferenceImageNames([]);
    setReferenceVideoIds([]);
    setReferenceAudioFiles([]);
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
  };

  // Repopulate the form from an in-flight (or queued) render restored via
  // /active, so a page reload doesn't lose what the running job is rendering.
  // The page owns the SSE re-attach; this only replays the params into state.
  const applyResumedParams = (p = {}) => {
    setStylePreset(null);
    setSelectedUniverse(null);
    if (p.prompt) setPrompt(p.prompt);
    setUnavailableSourceImageName(p.mode === 'ic-ingredients-25' ? (p.unavailableSourceImageName || '') : '');
    if (p.mode === 'ic-ingredients-25') {
      setSourceImageFile(p.sourceImageFile || null);
      setSourceImageUpload(null);
      dropSourceImageParam();
    }
    if (p.negativePrompt) setNegativePrompt(p.negativePrompt);
    if (p.modelId) setModelId(p.modelId);
    if (p.width) { setWidth(p.width); sizeManuallySetRef.current = true; }
    if (p.height) { setHeight(p.height); sizeManuallySetRef.current = true; }
    if (p.numFrames) setNumFrames(p.numFrames);
    if (p.fps) setFps(p.fps);
    if (p.steps != null) setSteps(String(p.steps));
    if (p.guidanceScale != null) setGuidanceScale(String(p.guidanceScale));
    setBatchSize(p.batchSize ?? 1);
    setSeed(p.seed == null ? '' : String(p.seed));
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
    setStreamingMode(videoStreamingModeFromRecord(p.streamingMode));
    setA2vLoraStageStrengths(p.a2vLoraStageStrengths ?? [1, 1]);
    if (typeof p.disableAudio === 'boolean') setDisableAudio(p.disableAudio);
    // A hosted job's `p.mode` is its queue discriminator; the lane restore
    // hands back the real video mode.
    const laneMode = applyResumedLane(p);
    if (laneMode) setMode(laneMode);
    else if (p.mode) setMode(p.mode);
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
    const resumedModel = models.find((model) => model.id === (p.modelId || modelId));
    if (p.continuityStrategy === 'frame' || (resumedModel && !supportsContextWindow(resumedModel))) {
      setContextFrames(0);
    } else if (p.contextFrames != null && p.contextFrames !== '' && Number.isFinite(Number(p.contextFrames))) {
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
    setIcReferenceFile(null);
    setIcReferenceVideoId('');
    setIcReferenceNames(Array.isArray(p.icReferenceNames) ? p.icReferenceNames : []);
    // Unlike a clip, an image-kind reference IS re-derivable: it's a gallery
    // basename, which is exactly the submit shape. So the resumed form
    // repopulates its picker and the submit gate unblocks without a re-pick.
    setIcReferenceImageFiles(Array.isArray(p.icReferenceImageFiles) ? p.icReferenceImageFiles : []);
    setReferenceImageFiles(Array.isArray(p.referenceImageFiles) ? p.referenceImageFiles : []);
    setUnavailableReferenceImageNames(Array.isArray(p.unavailableReferenceImageNames) ? p.unavailableReferenceImageNames : []);
    setReferenceVideoIds(Array.isArray(p.referenceVideoIds) ? p.referenceVideoIds : []);
    // Uploaded voice files cannot be reconstructed from the display-only names.
    setReferenceAudioFiles([]);
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

  return { applyRemix, applyFinish, applyResumedParams };
}
