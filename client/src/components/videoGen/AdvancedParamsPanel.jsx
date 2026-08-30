/**
 * Local-backend sampler knobs — frames, chunks (plus optional per-chunk
 * prompt beats), fps, seed, steps, CFG scale, image strength, tiling and
 * the audio flags. Always visible in the main form card (no disclosure)
 * so the right-hand column can host Prompt from media.
 *
 * Presentational: all state and handlers are owned by the VideoGen page.
 */
import { Dice5 } from 'lucide-react';
import { FormField } from '../ui/FormField';
import {
  frameOptionsForModel, fpsOptionsForModel, CHUNK_OPTIONS,
  isModelAllowedForMode, supportsVideoAudioControls, supportsVideoAudioPromptControls,
  CONTEXT_FRAME_OPTIONS, supportsContextWindow,
  DEFAULT_SPEED_PROFILE_ID, speedProfilesForMode, selectedSpeedProfile,
  videoChainChunkModes,
  DEFAULT_DRAFT_DECODE_ID, draftDecodeOptionsForModel,
} from '../../lib/videoGenParams.js';
import { VIDEO_TILING_OPTIONS } from '../../lib/videoTilingOptions';
import { isLtx2FamilyRuntime } from '../../lib/runnerFamilies';
import {
  I2V_REFERENCE_MODE_OPTIONS, DEFAULT_I2V_REFERENCE_MODE,
  normalizeI2vReferenceMode, runtimeSupportsI2vReferenceMode,
} from '../../lib/videoReferenceModes';

const inputCls = 'w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50';

export default function AdvancedParamsPanel({
  mode,
  currentModel,
  numFrames, onNumFramesChange,
  chunks, onChunksChange, keyframesActive,
  chunkPrompts = [], onChunkPromptChange, chainingActive = false,
  contextFrames, onContextFramesChange,
  fps, onFpsChange,
  seed, onSeedChange, onRandomSeed,
  steps, onStepsChange,
  guidanceScale, onGuidanceScaleChange,
  speedProfileId = DEFAULT_SPEED_PROFILE_ID, onSpeedProfileChange,
  draftDecode = DEFAULT_DRAFT_DECODE_ID, onDraftDecodeChange,
  imageStrength, onImageStrengthChange,
  i2vReferenceMode = DEFAULT_I2V_REFERENCE_MODE, onI2vReferenceModeChange,
  effectiveImageStrength = null,
  tiling, onTilingChange,
  disableAudio, onDisableAudioChange,
  noMusic, onNoMusicChange,
  idPrefix = '',
}) {
  const fieldId = (id) => idPrefix ? `${idPrefix}-${id}` : id;
  // a2v derives its length + audio track from the uploaded audio, so chunking
  // and the audio flags don't apply there.
  const showAudioFlags = mode !== 'a2v';
  const showDisableAudio = showAudioFlags && supportsVideoAudioControls(currentModel);
  const showPromptAudioControls = showAudioFlags && noMusic != null && supportsVideoAudioPromptControls(currentModel);
  const audioDisabled = showDisableAudio && disableAudio;
  // Chunk chaining seeds chunk N+1 from chunk N's last frame, so it needs i2v —
  // the same predicate the picker uses, not a second reading of supportedModes.
  const showChunks = mode !== 'a2v' && isModelAllowedForMode(currentModel, 'image');
  // ltx2 extend conditions on the source's latent rather than a single frame,
  // so image strength is meaningless for it.
  const showImageStrength = mode === 'image' || (mode === 'extend' && !isLtx2FamilyRuntime(currentModel?.runtime));
  // The reference-mode promise (#4874) is an image-mode question only, and only
  // a runtime that carries per-image conditioning strength can keep anything but
  // the default. Rendering it read-only elsewhere would imply a choice that does
  // not exist, so the picker appears in image mode and explains itself when the
  // selected model cannot honor the loose option.
  const showReferenceMode = mode === 'image' && typeof onI2vReferenceModeChange === 'function';
  const referenceMode = normalizeI2vReferenceMode(i2vReferenceMode);
  // Which promises this model can actually keep. An unresolved `currentModel`
  // means "the catalog has not loaded yet", NOT "anchor only" — the same
  // deferral the form's snap-back makes, so the picker can't contradict the
  // state it is rendering: collapsing to Anchor here would disable the control
  // and claim "this model can only anchor" about a model nobody has seen.
  const supportedReferenceOptions = currentModel
    ? I2V_REFERENCE_MODE_OPTIONS.filter((o) => runtimeSupportsI2vReferenceMode(currentModel.runtime, o.value))
    : I2V_REFERENCE_MODE_OPTIONS;
  // A controlled <select> must never hold a value with no matching <option>.
  // A restored pick survives one render past a model switch — until the
  // snap-back effect lands — so keep it listed for exactly that window.
  const referenceOptions = supportedReferenceOptions.some((o) => o.value === referenceMode)
    ? supportedReferenceOptions
    : [...supportedReferenceOptions, I2V_REFERENCE_MODE_OPTIONS.find((o) => o.value === referenceMode)].filter(Boolean);
  const referencePromise = I2V_REFERENCE_MODE_OPTIONS.find((o) => o.value === referenceMode);
  const referenceModeLocked = supportedReferenceOptions.length < 2;
  // `0` is a legal strength (ignore the source entirely) and the retry editor
  // hands it over as a NUMBER, so presence has to be tested explicitly — a
  // `imageStrength || …` fallback renders the slider at 1 while the form still
  // submits 0, which is the control lying about the render it will produce.
  const hasExplicitStrength = imageStrength != null && imageStrength !== '';
  const displayedImageStrength = hasExplicitStrength
    ? imageStrength
    : (effectiveImageStrength != null ? effectiveImageStrength : 1);
  const frameOptions = frameOptionsForModel(currentModel, numFrames);
  const fpsOptions = fpsOptionsForModel(currentModel);
  const samplerLocked = currentModel?.samplerLocked === true;
  // Speed profiles (#4875). Only the profiles VALIDATED for what this request
  // will actually run are offered: a profile the server would decline is a dead
  // affordance that promises a speed-up the render then doesn't take. With none
  // applicable the picker is hidden entirely rather than shown holding only
  // "Quality".
  //
  // A CHAINED render is one clip whose chunks run in DIFFERENT modes, and the
  // server applies a profile to it only when every chunk accepts one — so the
  // gate takes the whole chunk-mode list. Without that, picking Fast with
  // Chunks = 4 would grey out Steps/CFG and then quietly run the entire chain
  // at the model default.
  const speedProfileModes = videoChainChunkModes({
    model: currentModel, mode, chaining: chainingActive, contextFrames,
  });
  // Preview-fidelity decode (#5423). The option list is server-declared and
  // rides on the model entry, so a model with no draft decoder yields [] and
  // renders NO control rather than a select with one real choice.
  const draftDecodeOptions = draftDecodeOptionsForModel(currentModel);
  const activeDraftDecode = draftDecodeOptions.find((o) => o.id === draftDecode) || null;
  const speedProfiles = speedProfilesForMode(currentModel, speedProfileModes);
  const showSpeedProfiles = !samplerLocked && speedProfiles.length > 0;
  // Resolved against the SAME set the picker offers, so a model with two
  // profiles can't lock Steps/CFG to one this request declines.
  const activeSpeedProfile = showSpeedProfiles
    ? selectedSpeedProfile(speedProfileId, currentModel, speedProfileModes)
    : null;
  // A profile drives steps AND CFG together, exactly as a samplerLocked model
  // does — leaving either editable would let the user half-override a
  // validated schedule and get neither its speed nor its quality.
  const samplerDriven = samplerLocked || !!activeSpeedProfile;
  const samplerDrivenTitle = samplerLocked
    ? 'This validated Lightning profile locks its sampler settings.'
    : activeSpeedProfile
      ? `The ${activeSpeedProfile.name} speed profile sets its own validated schedule. Switch to Quality to edit these.`
      : undefined;

  return (
    <div className="border-t border-port-border pt-3 space-y-3">
      <h2 className="text-xs font-medium text-gray-400 uppercase tracking-wide">Advanced</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <FormField label="Frames" labelClassName="block text-xs font-medium text-gray-400 mb-1">
            <select
              value={numFrames}
              onChange={(e) => onNumFramesChange(Number(e.target.value))}
              className={inputCls}
            >
              {frameOptions.map((f) => (
                <option key={f} value={f}>
                  {f} ({(f / fps).toFixed(1)}s @ {fps}fps){f === currentModel?.defaultFrames ? ' · default' : ''}
                </option>
              ))}
            </select>
            {numFrames > 241 && isModelAllowedForMode(currentModel, 'extend') && (
              <p className="text-[10px] text-gray-500 leading-snug mt-1">
                Past 241 frames a single-pass render may swap or OOM at 48 GB. For reliable longer clips, render up to ~10s and then use <strong>Extend</strong> on the result — it conditions on the source&apos;s full latent rather than a single last frame.
              </p>
            )}
          </FormField>

          {showChunks && (
            <div>
              <label htmlFor={fieldId('chunks-select')} className="block text-xs font-medium text-gray-400 mb-1" title="Chain N renders end-to-end. Each chunk's last frame seeds the next, then they're stitched into one clip. Wall time scales linearly with chunks.">
                Chunks
              </label>
              <select
                id={fieldId('chunks-select')}
                value={keyframesActive ? 1 : chunks}
                onChange={(e) => onChunksChange(Number(e.target.value))}
                disabled={keyframesActive}
                title={keyframesActive ? 'Multi-keyframe renders anchor a single clip — chunking is unavailable.' : undefined}
                className={`${inputCls} disabled:cursor-not-allowed`}
              >
                {CHUNK_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n === 1 ? '1 (single)' : `${n} (~${((n * numFrames) / fps).toFixed(0)}s total)`}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Continuation context window. Only meaningful once the request
              really chains AND the runtime has an extend pipeline to feed the
              window to — everywhere else the server seeds the next chunk from
              a single last frame regardless, so showing the control would be
              offering a knob that does nothing. */}
          {chainingActive && supportsContextWindow(currentModel) && (
            <div>
              <label htmlFor={fieldId('context-frames-select')} className="block text-xs font-medium text-gray-400 mb-1" title="How much of the previous chunk each new chunk sees. A window carries the scene's motion across the seam; a single last frame gives the model a pose with no velocity, so movement stalls and restarts at every join.">
                Continuity
              </label>
              <select
                id={fieldId('context-frames-select')}
                value={contextFrames}
                onChange={(e) => onContextFramesChange(Number(e.target.value))}
                className={inputCls}
              >
                {CONTEXT_FRAME_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? 'Last frame only' : `${n} frames (~${(n / fps).toFixed(1)}s)`}
                  </option>
                ))}
              </select>
              <p className="text-[10px] text-gray-500 leading-snug mt-1">
                Bigger windows hold motion better across joins but add render time per chunk.
              </p>
            </div>
          )}

          {/* Per-chunk prompt beats (#3695). Only shown when the request really
              chains — the parent derives `chainingActive` from the same
              predicate that decides whether `chunks` is submitted at all, so
              this editor can never appear for a mode the server pins to one
              chunk. One row per LIVE chunk; the parent keeps text for chunks
              beyond the current count, so lowering then raising the count
              restores what was typed. */}
          {chainingActive && (
            <div className="col-span-2 sm:col-span-3">
              <p className="block text-xs font-medium text-gray-400 mb-1">
                Per-chunk beats <span className="font-normal text-gray-500">(optional — blank uses the main prompt)</span>
              </p>
              <div className="space-y-1.5">
                {Array.from({ length: chunks }, (_, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <label htmlFor={fieldId(`chunk-prompt-${i}`)} className="text-[11px] text-gray-500 w-12 shrink-0">
                      Chunk {i + 1}
                    </label>
                    <input
                      id={fieldId(`chunk-prompt-${i}`)}
                      type="text"
                      value={chunkPrompts[i] || ''}
                      onChange={(e) => onChunkPromptChange(i, e.target.value)}
                      placeholder="Same as main prompt"
                      className={inputCls}
                    />
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-gray-500 leading-snug mt-1">
                Each chunk still continues from the previous chunk&apos;s last frame — beats steer what happens next rather than starting a new shot.
              </p>
            </div>
          )}

          <FormField label="FPS" labelClassName="block text-xs font-medium text-gray-400 mb-1">
            <select
              value={fps}
              onChange={(e) => onFpsChange(Number(e.target.value))}
              className={inputCls}
            >
              {fpsOptions.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </FormField>

          <div>
            <label htmlFor={fieldId('video-seed')} className="block text-xs font-medium text-gray-400 mb-1">Seed</label>
            <div className="flex items-center gap-1">
              <input
                id={fieldId('video-seed')}
                type="number"
                value={seed}
                onChange={(e) => onSeedChange(e.target.value)}
                placeholder="Random"
                className={`flex-1 ${inputCls}`}
              />
              <button
                type="button"
                onClick={onRandomSeed}
                className="p-2 text-gray-400 hover:text-white border border-port-border rounded-lg hover:bg-port-border/50 disabled:opacity-50 min-h-[40px] min-w-[40px] flex items-center justify-center"
                title="Randomize seed" aria-label="Randomize seed"
              >
                <Dice5 className="w-4 h-4" />
              </button>
            </div>
          </div>

          {draftDecodeOptions.length > 0 && (
            <FormField label="Decode" labelClassName="block text-xs font-medium text-gray-400 mb-1">
              <select
                value={activeDraftDecode ? draftDecode : DEFAULT_DRAFT_DECODE_ID}
                onChange={(e) => onDraftDecodeChange?.(e.target.value)}
                className={inputCls}
              >
                {draftDecodeOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}{option.sizeLabel ? ` · ${option.sizeLabel}` : ''}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-gray-500">
                {activeDraftDecode?.description || ''}
                {activeDraftDecode && activeDraftDecode.id !== DEFAULT_DRAFT_DECODE_ID
                  ? ' Finish and delivery renders always use the full decoder.'
                  : ''}
              </p>
            </FormField>
          )}

          {showSpeedProfiles && (
            <FormField label="Speed" labelClassName="block text-xs font-medium text-gray-400 mb-1">
              <select
                value={activeSpeedProfile ? speedProfileId : DEFAULT_SPEED_PROFILE_ID}
                onChange={(e) => onSpeedProfileChange(e.target.value)}
                className={inputCls}
              >
                <option value={DEFAULT_SPEED_PROFILE_ID}>Quality · default</option>
                {speedProfiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}{p.speedupLabel ? ` · ${p.speedupLabel}` : ''}
                  </option>
                ))}
              </select>
            </FormField>
          )}

          <FormField
            label={<>Steps {currentModel?.steps && `(default: ${currentModel.steps})`}</>}
            labelClassName="block text-xs font-medium text-gray-400 mb-1"
          >
            <input
              type="number" min={1} max={150}
              value={activeSpeedProfile ? '' : steps}
              onChange={(e) => onStepsChange(e.target.value)}
              disabled={samplerDriven}
              title={samplerDrivenTitle}
              placeholder={String(activeSpeedProfile?.steps ?? currentModel?.steps ?? 25)}
              className={inputCls}
            />
          </FormField>

          <FormField
            label={<>CFG Scale {currentModel?.guidance != null && `(default: ${currentModel.guidance})`}</>}
            labelClassName="block text-xs font-medium text-gray-400 mb-1"
          >
            <input
              type="number" min={0} max={20} step={0.5}
              value={activeSpeedProfile ? '' : guidanceScale}
              onChange={(e) => onGuidanceScaleChange(e.target.value)}
              disabled={samplerDriven}
              title={samplerDrivenTitle}
              placeholder={String(activeSpeedProfile?.guidance ?? currentModel?.guidance ?? 3.0)}
              className={inputCls}
            />
          </FormField>

          {samplerLocked && (
            <p className="col-span-2 sm:col-span-3 text-[10px] text-port-accent leading-snug">
              {currentModel?.samplerNote
                || `Lightning keeps its validated ${currentModel.steps}-step sampler, CFG ${currentModel.guidance}, and model-specific schedule locked.`}
            </p>
          )}

          {showReferenceMode && (
            <div className="col-span-2 sm:col-span-3">
              <label htmlFor={fieldId('video-reference-mode')} className="block text-xs font-medium text-gray-400 mb-1">Reference mode</label>
              <select
                id={fieldId('video-reference-mode')}
                value={referenceMode}
                disabled={referenceModeLocked}
                onChange={(e) => onI2vReferenceModeChange(e.target.value)}
                className={inputCls}
              >
                {referenceOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <p className="text-[10px] text-gray-500 leading-snug mt-1">{referencePromise?.promise}</p>
              {referenceModeLocked && (
                <p className="text-[10px] text-gray-500 leading-snug mt-1">
                  {currentModel?.name || 'This model'} can only anchor a reference. Pick an LTX-2.5 model to loosen it.
                </p>
              )}
            </div>
          )}

          {activeSpeedProfile && (
            <p className="col-span-2 sm:col-span-3 text-[10px] text-port-accent leading-snug">
              {activeSpeedProfile.description}
              {' '}Steps and CFG follow the profile ({activeSpeedProfile.steps}
              {activeSpeedProfile.stage2Steps != null ? `+${activeSpeedProfile.stage2Steps}` : ''} steps, CFG {activeSpeedProfile.guidance}).
              {' '}If a lever it needs is missing on this machine, the render still runs and says so rather than claiming the speed-up.
            </p>
          )}

          {showImageStrength && (
            <div className="col-span-2 sm:col-span-3">
              <div className="flex items-center justify-between gap-3 mb-1">
                <label htmlFor={fieldId('video-image-strength')} className="block text-xs font-medium text-gray-400">Image Strength</label>
                <span className="text-[11px] text-gray-500">{hasExplicitStrength || effectiveImageStrength != null ? String(displayedImageStrength) : '1.0'}</span>
              </div>
              <input
                id={fieldId('video-image-strength')}
                type="range" min={0} max={1} step={0.05}
                value={displayedImageStrength}
                onChange={(e) => onImageStrengthChange(e.target.value)}
                className="w-full accent-port-accent"
                title="Higher values preserve the source frame more strongly"
              />
            </div>
          )}

          {currentModel?.supportsTiling !== false && (
            <FormField className="col-span-2 sm:col-span-3" label="Tiling" labelClassName="block text-xs font-medium text-gray-400 mb-1">
              <select
                value={tiling}
                onChange={(e) => onTilingChange(e.target.value)}
                className={inputCls}
              >
                {VIDEO_TILING_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </FormField>
          )}

          {showDisableAudio && (
            <label className="col-span-2 sm:col-span-3 flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
              <input
                type="checkbox"
                checked={disableAudio}
                onChange={(e) => onDisableAudioChange(e.target.checked)}
                className="rounded"
              />
              Disable audio (LTX-2 only — speeds up generation)
            </label>
          )}
          {showPromptAudioControls && (
            <label
              className={`col-span-2 sm:col-span-3 flex items-center gap-2 text-xs cursor-pointer ${audioDisabled ? 'text-gray-600 cursor-not-allowed' : 'text-gray-400'}`}
              title="The model conditions generated audio on the prompt — appending 'no music, no soundtrack' at submit time pushes it toward ambient/diegetic sound only"
            >
              <input
                type="checkbox"
                checked={noMusic}
                disabled={audioDisabled}
                onChange={(e) => onNoMusicChange(e.target.checked)}
                className="rounded"
              />
              No music — keep ambient/diegetic sound only
            </label>
          )}
        </div>
    </div>
  );
}
