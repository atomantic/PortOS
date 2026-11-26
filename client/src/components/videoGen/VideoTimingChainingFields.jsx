import { Dice5 } from 'lucide-react';
import { FormField } from '../ui/FormField';
import {
  frameOptionsForModel, fpsOptionsForModel, CHUNK_OPTIONS,
  isIcLoraMode, isModelAllowedForMode,
  contextFrameOptionsForModel, selectedContextFramesForModel, supportsContextWindow,
} from '../../lib/videoGenParams.js';

export default function VideoTimingChainingFields({
  mode, currentModel, fieldId, inputCls,
  numFrames, onNumFramesChange,
  chunks, onChunksChange, keyframesActive,
  chunkPrompts = [], onChunkPromptChange, chainingActive,
  contextFrames, onContextFramesChange,
  fps, onFpsChange,
  seed, onSeedChange, onRandomSeed,
  batchSize = 1, onBatchSizeChange,
}) {
  const showFrames = !(mode === 'a2v' && currentModel?.audioDurationDriven === true);
  // Chunk chaining seeds chunk N+1 from chunk N's last frame, so it needs i2v —
  // the same predicate the picker uses, not a second reading of supportedModes.
  const showChunks = mode !== 'a2v' && !isIcLoraMode(mode) && isModelAllowedForMode(currentModel, 'image');
  const temporalAvailable = supportsContextWindow(currentModel);
  const continuationCapability = currentModel?.continuationCapability;
  const contextOptions = contextFrameOptionsForModel(currentModel);
  const displayedContext = selectedContextFramesForModel(currentModel, contextFrames);
  const frameOptions = frameOptionsForModel(currentModel, numFrames);
  const fpsOptions = fpsOptionsForModel(currentModel);
  const supportsWarmBatch = currentModel?.supportsWarmBatch;

  return (
    <>
      {showFrames && <FormField label="Frames" labelClassName="block text-xs font-medium text-gray-400 mb-1">
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
      </FormField>}

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

      {chainingActive && (
        <div className="min-w-0">
          <label htmlFor={fieldId('context-frames-select')} className="block text-xs font-medium text-gray-400 mb-1">
            Continuity
          </label>
          <select
            id={fieldId('context-frames-select')}
            value={displayedContext}
            onChange={(e) => onContextFramesChange(Number(e.target.value))}
            className={inputCls}
          >
            {contextOptions.map((n) => (
              <option key={n} value={n}>
                {n === 0 ? 'Last frame only' : `${n} frames (~${(n / fps).toFixed(1)}s)`}
              </option>
            ))}
            {!temporalAvailable && <option disabled value="unavailable">Temporal context unavailable</option>}
          </select>
          <p className="text-[10px] text-gray-500 leading-snug mt-1 break-words">
            {temporalAvailable
              ? 'A temporal window carries motion across joins; last frame only uses a still.'
              : `Temporal context unavailable: ${continuationCapability?.unavailableReason || 'This runtime has no verified temporal continuation contract.'}`}
            {continuationCapability?.backendPin && ` Backend: ${continuationCapability.backendPin}.`}
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

      {onBatchSizeChange && (
        <div>
          <label htmlFor={fieldId('video-batch-size')} className="block text-xs font-medium text-gray-400 mb-1">Renders in batch</label>
          <select id={fieldId('video-batch-size')} className={inputCls}
            value={supportsWarmBatch && !chainingActive ? batchSize : 1}
            disabled={!supportsWarmBatch || chainingActive}
            onChange={(event) => onBatchSizeChange(Number(event.target.value))}>
            {Array.from({ length: 20 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}
          </select>
          <p className="mt-1 text-xs text-gray-500">
            {!supportsWarmBatch ? 'Warm batching is available for local MiniMax H3 MLX models.'
              : chainingActive ? 'Use one chunk to batch separate videos.'
                : 'Sequential videos reuse the model and prompt. Blank seed: random each time. Number: increment per render.'}
          </p>
        </div>
      )}
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
            className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 p-2 text-gray-400 hover:text-white border border-port-border rounded-lg hover:bg-port-border/50 disabled:opacity-50 min-h-[40px] min-w-[40px] flex items-center justify-center"
            title="Use a random seed for each render" aria-label="Randomize seed"
          >
            <Dice5 className="w-4 h-4" />
          </button>
        </div>
      </div>
    </>
  );
}
