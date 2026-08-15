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
} from '../../lib/videoGenParams.js';
import { VIDEO_TILING_OPTIONS } from '../../lib/videoTilingOptions';
import { isLtx2FamilyRuntime } from '../../lib/runnerFamilies';

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
  imageStrength, onImageStrengthChange,
  tiling, onTilingChange,
  disableAudio, onDisableAudioChange,
  noMusic, onNoMusicChange,
}) {
  // a2v derives its length + audio track from the uploaded audio, so chunking
  // and the audio flags don't apply there.
  const showAudioFlags = mode !== 'a2v';
  const showDisableAudio = showAudioFlags && supportsVideoAudioControls(currentModel);
  const showPromptAudioControls = showAudioFlags && supportsVideoAudioPromptControls(currentModel);
  const audioDisabled = showDisableAudio && disableAudio;
  // Chunk chaining seeds chunk N+1 from chunk N's last frame, so it needs i2v —
  // the same predicate the picker uses, not a second reading of supportedModes.
  const showChunks = mode !== 'a2v' && isModelAllowedForMode(currentModel, 'image');
  // ltx2 extend conditions on the source's latent rather than a single frame,
  // so image strength is meaningless for it.
  const showImageStrength = mode === 'image' || (mode === 'extend' && !isLtx2FamilyRuntime(currentModel?.runtime));
  const frameOptions = frameOptionsForModel(currentModel, numFrames);
  const fpsOptions = fpsOptionsForModel(currentModel);
  const samplerLocked = currentModel?.samplerLocked === true;

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
              <label htmlFor="chunks-select" className="block text-xs font-medium text-gray-400 mb-1" title="Chain N renders end-to-end. Each chunk's last frame seeds the next, then they're stitched into one clip. Wall time scales linearly with chunks.">
                Chunks
              </label>
              <select
                id="chunks-select"
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
              <label htmlFor="context-frames-select" className="block text-xs font-medium text-gray-400 mb-1" title="How much of the previous chunk each new chunk sees. A window carries the scene's motion across the seam; a single last frame gives the model a pose with no velocity, so movement stalls and restarts at every join.">
                Continuity
              </label>
              <select
                id="context-frames-select"
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
                    <label htmlFor={`chunk-prompt-${i}`} className="text-[11px] text-gray-500 w-12 shrink-0">
                      Chunk {i + 1}
                    </label>
                    <input
                      id={`chunk-prompt-${i}`}
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
            <label htmlFor="video-seed" className="block text-xs font-medium text-gray-400 mb-1">Seed</label>
            <div className="flex items-center gap-1">
              <input
                id="video-seed"
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

          <FormField
            label={<>Steps {currentModel?.steps && `(default: ${currentModel.steps})`}</>}
            labelClassName="block text-xs font-medium text-gray-400 mb-1"
          >
            <input
              type="number" min={1} max={150}
              value={steps}
              onChange={(e) => onStepsChange(e.target.value)}
              disabled={samplerLocked}
              title={samplerLocked ? 'This validated Lightning profile locks its sampler settings.' : undefined}
              placeholder={String(currentModel?.steps || 25)}
              className={inputCls}
            />
          </FormField>

          <FormField
            label={<>CFG Scale {currentModel?.guidance != null && `(default: ${currentModel.guidance})`}</>}
            labelClassName="block text-xs font-medium text-gray-400 mb-1"
          >
            <input
              type="number" min={0} max={20} step={0.5}
              value={guidanceScale}
              onChange={(e) => onGuidanceScaleChange(e.target.value)}
              disabled={samplerLocked}
              title={samplerLocked ? 'This validated Lightning profile locks its sampler settings.' : undefined}
              placeholder={String(currentModel?.guidance ?? 3.0)}
              className={inputCls}
            />
          </FormField>

          {samplerLocked && (
            <p className="col-span-2 sm:col-span-3 text-[10px] text-port-accent leading-snug">
              {currentModel?.samplerNote
                || `Lightning keeps its validated ${currentModel.steps}-step sampler, CFG ${currentModel.guidance}, and model-specific schedule locked.`}
            </p>
          )}

          {showImageStrength && (
            <div className="col-span-2 sm:col-span-3">
              <div className="flex items-center justify-between gap-3 mb-1">
                <label htmlFor="video-image-strength" className="block text-xs font-medium text-gray-400">Image Strength</label>
                <span className="text-[11px] text-gray-500">{imageStrength || '1.0'}</span>
              </div>
              <input
                id="video-image-strength"
                type="range" min={0} max={1} step={0.05}
                value={imageStrength || 1}
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
