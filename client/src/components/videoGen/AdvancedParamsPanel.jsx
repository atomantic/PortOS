/**
 * "Advanced" disclosure for the local-backend sampler knobs — frames, chunks,
 * fps, seed, steps, CFG scale, image strength, tiling and the audio flags.
 *
 * Closed by default so the Generate button sits above the fold on /media/video
 * the way it already does on the sibling /media/image tab (issue #3279), which
 * keeps only Model + Resolution inline too. Every value lives in the VideoGen
 * page's state, so collapsing the panel never discards one — and the collapsed
 * summary line surfaces the values a remix most often carries in (frames, fps,
 * seed) without making the user expand to see them.
 *
 * Presentational: all state and handlers are owned by the VideoGen page.
 *
 * The body is conditionally rendered rather than merely hidden on purpose: a
 * number input that is out of its min/max range while invisible would make the
 * browser refuse the form submit ("invalid form control is not focusable"), so
 * a half-typed Steps/CFG value behind a collapsed panel must not be in the DOM.
 */
import { useState } from 'react';
import { ChevronDown, Dice5 } from 'lucide-react';
import { FormField } from '../ui/FormField';
import { FRAME_OPTIONS, FPS_OPTIONS } from '../../lib/videoGenParams.js';
import { VIDEO_TILING_OPTIONS } from '../../lib/videoTilingOptions';

const CHUNK_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8];

const inputCls = 'w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50';

export default function AdvancedParamsPanel({
  mode,
  currentModel,
  numFrames, onNumFramesChange,
  chunks, onChunksChange, keyframesActive,
  fps, onFpsChange,
  seed, onSeedChange, onRandomSeed,
  steps, onStepsChange,
  guidanceScale, onGuidanceScaleChange,
  imageStrength, onImageStrengthChange,
  tiling, onTilingChange,
  disableAudio, onDisableAudioChange,
  noMusic, onNoMusicChange,
}) {
  const [open, setOpen] = useState(false);
  // a2v derives its length + audio track from the uploaded audio, so chunking
  // and the audio flags don't apply there.
  const showAudioFlags = mode !== 'a2v';
  const showChunks = mode !== 'a2v';
  // ltx2 extend conditions on the source's latent rather than a single frame,
  // so image strength is meaningless for it.
  const showImageStrength = mode === 'image' || (mode === 'extend' && currentModel?.runtime !== 'ltx2');

  const summary = `${numFrames}f @ ${fps}fps · ${(numFrames / fps).toFixed(1)}s · seed ${seed === '' || seed == null ? 'random' : seed}`;

  return (
    <div className="border-t border-port-border pt-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="video-advanced-params"
        className="w-full flex items-center gap-2 text-xs font-medium text-gray-400 hover:text-white min-h-[32px]"
      >
        <ChevronDown className={`w-3.5 h-3.5 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} />
        <span>Advanced</span>
        <span className="font-normal text-[11px] text-gray-500 truncate">{summary}</span>
      </button>

      {open && (
        <div id="video-advanced-params" className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-3">
          <FormField label="Frames" labelClassName="block text-xs font-medium text-gray-400 mb-1">
            <select
              value={numFrames}
              onChange={(e) => onNumFramesChange(Number(e.target.value))}
              className={inputCls}
            >
              {FRAME_OPTIONS.map((f) => <option key={f} value={f}>{f} ({(f / fps).toFixed(1)}s @ {fps}fps)</option>)}
            </select>
            {numFrames > 241 && (
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

          <FormField label="FPS" labelClassName="block text-xs font-medium text-gray-400 mb-1">
            <select
              value={fps}
              onChange={(e) => onFpsChange(Number(e.target.value))}
              className={inputCls}
            >
              {FPS_OPTIONS.map((f) => <option key={f} value={f}>{f}</option>)}
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
              placeholder={String(currentModel?.guidance ?? 3.0)}
              className={inputCls}
            />
          </FormField>

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

          <FormField className="col-span-2 sm:col-span-3" label="Tiling" labelClassName="block text-xs font-medium text-gray-400 mb-1">
            <select
              value={tiling}
              onChange={(e) => onTilingChange(e.target.value)}
              className={inputCls}
            >
              {VIDEO_TILING_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </FormField>

          {showAudioFlags && (
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
          {showAudioFlags && (
            <label
              className={`col-span-2 sm:col-span-3 flex items-center gap-2 text-xs cursor-pointer ${disableAudio ? 'text-gray-600 cursor-not-allowed' : 'text-gray-400'}`}
              title="LTX-2 conditions audio on the prompt — appending 'no music, no soundtrack' at submit time pushes the model toward ambient/diegetic sound only"
            >
              <input
                type="checkbox"
                checked={noMusic}
                disabled={disableAudio}
                onChange={(e) => onNoMusicChange(e.target.checked)}
                className="rounded"
              />
              No music — keep ambient/diegetic sound only (LTX-2)
            </label>
          )}
        </div>
      )}
    </div>
  );
}
