import { useRunwayCatalog } from '../../hooks/useRunwayCatalog.js';
import {
  FAL_DEFAULT_IMAGE_VIDEO_MODEL, FAL_IMAGE_VIDEO_MODELS, coerceFalVideoSeconds, describeFalVideoRate, falVideoResolutions, getFalVideoModel,
} from '../../lib/falVideoModels.js';
import { GROK_VIDEO_DURATIONS } from '../../lib/grokVideoClip.js';
import {
  RUNWAY_DEFAULT_IMAGE_VIDEO_MODEL, RUNWAY_VIDEO_MODELS, coerceRunwayVideoSeconds, describeRunwayVideoRate, getRunwayVideoModel, runwayVideoLengths, runwayVideoResolutions,
} from '../../lib/runwayVideoModels.js';
import { SOURCE_AUDIO_MUSIC, grokCoverage, performanceCapability } from '../../lib/musicVideoShotTiming.js';
import { localMusicVideoModels } from '../../../../server/lib/musicVideoLocalModels.js';
import { frameOptionsForModel } from '../../lib/videoGenParams.js';
import { safeReadJsonStorage, safeWriteJsonStorage } from '../../lib/safeStorage.js';

/**
 * Where one shot's clip renders, picked on its card: the project's saved
 * renderer, local LTX, Grok, or a fal.ai model. LTX is local only, so fal
 * offers only its curated start-frame models; a lip-synced shot renders on
 * fal's lip-sync route, so fal is one choice there, a music-driven shot offers
 * each music-driven model (the song slice drives the picture), and Grok (no
 * audio) and Runway (image-to-video only here) render cutaways only.
 * The pick is a value string: '' (saved), 'local', 'grok', 'fal', 'fal:<modelId>'
 * or 'runway:<modelId>'.
 *
 * A picked lane shows its own options, from the same definitions the Video Gen
 * form and the project's render settings read: the local model and clip length
 * (frame counts), Grok's clip lengths, and a fal model's lengths and
 * resolutions (a Runway model's likewise). Each length defaults to the
 * shortest one that covers the shot. `options` holds only what the director
 * changed: `{ modelId, numFrames, grokDuration, falDuration, falResolution,
 * runwayDuration, runwayResolution }`.
 *
 * A card opens on the last pick made on this device (lastRenderTarget), with
 * its local model or fal size; lengths stay sized to each shot.
 */
const BACKEND_LABELS = { local: 'Local LTX', grok: 'Grok', fal: 'fal.ai', runway: 'Runway' };
// The local render's frame rate when the request names none (generateVideo's default).
const LOCAL_FPS = 24;
const SELECT = 'min-w-0 max-w-full bg-port-bg border border-port-border rounded px-1 py-1 text-xs min-h-[44px] sm:min-h-0 disabled:opacity-50';

// The fal model a performance shot renders on: the lip-sync route, or the
// project's music-driven model for a music-driven shot. Never the cutaway model.
const falPerformanceLabel = (saved, scene) => {
  const capability = performanceCapability('fal', { scene, videoSettings: saved });
  return getFalVideoModel(capability?.modelId)?.label || 'lip-sync';
};

function savedLabel(saved, performance, scene) {
  if (saved.backend === 'fal') {
    return `fal.ai · ${performance ? falPerformanceLabel(saved, scene) : getFalVideoModel(saved.falModelId || FAL_DEFAULT_IMAGE_VIDEO_MODEL)?.label || 'video'}`;
  }
  if (saved.backend === 'runway' && !performance) {
    return `Runway · ${getRunwayVideoModel(saved.runwayModelId || RUNWAY_DEFAULT_IMAGE_VIDEO_MODEL)?.label || 'video'}`;
  }
  return BACKEND_LABELS[saved.backend] || 'install default';
}

export function renderTargetOptions({ performance, saved, endFrame = false, scene = null, runwayModels = RUNWAY_VIDEO_MODELS }) {
  return [
    { value: '', label: `Project setting · ${savedLabel(saved, performance, scene)}` },
    { value: 'local', label: performance ? 'Local LTX lip-sync (free)' : 'Local LTX (free)' },
    { value: 'grok', label: performance ? 'Grok (cutaways only)' : 'Grok', disabled: performance },
    ...(performance
      ? [
        { value: 'fal', label: `fal.ai · ${falPerformanceLabel(saved, scene)}` },
        // A music-driven shot can try another model that hears the song, priced per second.
        ...(scene?.performanceStyle === 'music' ? Object.values(SOURCE_AUDIO_MUSIC.fal).map((lane) => {
          const rate = describeFalVideoRate(lane.modelId, lane.defaultResolution);
          return { value: `fal:${lane.modelId}`, label: `fal.ai · ${getFalVideoModel(lane.modelId).label} + song audio${rate ? ` · ${rate}` : ''}` };
        }) : []),
      ]
      : FAL_IMAGE_VIDEO_MODELS.map((model) => {
        const rate = describeFalVideoRate(model.id);
        return { value: `fal:${model.id}`, label: `fal.ai · ${model.label}${rate ? ` · ${rate}` : ''}${endFrame && model.endImage ? ' · ends on end frame' : ''}` };
      })),
    // Runway takes no song audio, so a performance shot cannot render there.
    ...(performance
      ? [{ value: 'runway', label: 'Runway (cutaways only)', disabled: true }]
      : runwayModels.map((model) => {
        const rate = describeRunwayVideoRate(model.id);
        return { value: `runway:${model.id}`, label: `Runway · ${model.label}${rate ? ` · ${rate}` : ''}${endFrame && model.endImage ? ' · ends on end frame' : ''}` };
      })),
  ];
}

const LAST_PICK_KEY = 'portos.musicVideo.lastRenderOn';

/** Remember a card's pick for the next card opened on this device. */
export function rememberRenderTarget(pick, options = {}) {
  safeWriteJsonStorage(LAST_PICK_KEY, {
    pick, modelId: options.modelId || null, falResolution: options.falResolution || null, runwayResolution: options.runwayResolution || null,
  });
}

/**
 * The pick and options a card opens on: the last pick made on this device,
 * when this shot offers it (a lip-synced shot has one fal choice and no Grok),
 * else the project setting.
 */
export function lastRenderTarget({ performance, saved }) {
  const last = safeReadJsonStorage(LAST_PICK_KEY, null);
  let pick = typeof last?.pick === 'string' ? last.pick : '';
  if (performance && pick.startsWith('fal:')) pick = 'fal';
  if (!renderTargetOptions({ performance, saved }).some((option) => option.value === pick && !option.disabled)) pick = '';
  const falModel = pick.startsWith('fal:') ? getFalVideoModel(pick.slice(4)) : null;
  const runwayModel = pick.startsWith('runway:') ? getRunwayVideoModel(pick.slice(7)) : null;
  const options = pick === 'local' && last.modelId ? { modelId: last.modelId }
    : falModel && falVideoResolutions(falModel).includes(last.falResolution) ? { falResolution: last.falResolution }
      : runwayModel && runwayVideoResolutions(runwayModel).includes(last.runwayResolution) ? { runwayResolution: last.runwayResolution } : {};
  return { pick, options };
}

const isLtx25 = (model) => /^ltx25/.test(model?.runtime || '');

/**
 * Local models a shot can render on: image-to-video models for a cutaway, and
 * for a lip-sync or music-driven shot the audio-to-video models PortOS hands
 * the song slice (LTX-2.x, MiniMax H3 Ref2VA). Same rule the server checks.
 */
export const localModelChoices = (models, performance) => localMusicVideoModels(models, performance);

/**
 * The local model a shot renders on unless the director picks another: the
 * project's pinned local model, else LTX-2.5, else this install's default.
 * Never an empty "install default", so the picker always names the model.
 */
export function defaultLocalModelId({ models = [], saved = {}, defaultModel = '', performance = false }) {
  const choices = localModelChoices(models, performance);
  const has = (id) => !!id && choices.some((model) => model.id === id);
  if (has(saved.modelId)) return saved.modelId;
  return choices.find(isLtx25)?.id || (has(defaultModel) ? defaultModel : choices[0]?.id || '');
}

const shotSpan = (scene) => (typeof scene?.startSec === 'number' && typeof scene?.endSec === 'number' && scene.endSec > scene.startSec
  ? scene.endSec - scene.startSec : null);

/** The shortest frame count of `model` that covers the shot, else its longest; null for an untimed shot. */
export function coveringFrames(model, spanSec) {
  if (!(spanSec > 0)) return null;
  const frames = frameOptionsForModel(model);
  return frames.find((count) => count / LOCAL_FPS >= spanSec - 1e-6) ?? frames[frames.length - 1];
}

const falLengths = (model) => {
  const rule = model?.duration;
  if (rule?.kind === 'enum') return rule.values;
  if (rule?.kind === 'range') return Array.from({ length: rule.max - rule.min + 1 }, (_, i) => rule.min + i);
  return [];
};

/**
 * The settings overrides a pick and its options make for this render, or null
 * for the project's saved renderer. `context` carries what fills an unpicked
 * option: the installed local models, this install's default, the shot.
 */
export function renderTargetOverrides(value, saved, options = {}, context = {}) {
  if (!value) return null;
  const spanSec = shotSpan(context.scene);
  if (value === 'local') {
    // A remembered model this shot can't use (a non-lip-sync model on a lip-synced shot) falls back to the default.
    const choices = localModelChoices(context.models || [], context.performance);
    const picked = options.modelId && (!choices.length || choices.some((m) => m.id === options.modelId)) ? options.modelId : null;
    const modelId = picked || defaultLocalModelId({ ...context, saved });
    const model = (context.models || []).find((m) => m.id === modelId);
    const numFrames = context.performance ? null : options.numFrames || (model ? coveringFrames(model, spanSec) : null);
    return { backend: 'local', ...(modelId ? { modelId } : {}), ...(numFrames ? { numFrames } : {}) };
  }
  if (value === 'grok') {
    return { backend: 'grok', ...(options.grokDuration || spanSec != null ? { grokDuration: options.grokDuration || grokCoverage(spanSec).requestSec } : {}) };
  }
  if (value.startsWith('runway')) {
    const runwayModelId = value.slice(7) || null;
    if (!runwayModelId) return { backend: 'runway' };
    // Lengths and sizes are per model, so the saved ones only carry over to the saved model.
    const sameModel = runwayModelId === (saved.runwayModelId || RUNWAY_DEFAULT_IMAGE_VIDEO_MODEL);
    return {
      backend: 'runway', runwayModelId,
      ...(sameModel ? {} : { runwayDuration: null, runwayResolution: null }),
      ...(options.runwayDuration ? { runwayDuration: options.runwayDuration } : {}),
      ...(options.runwayResolution ? { runwayResolution: options.runwayResolution } : {}),
    };
  }
  const falModelId = value.slice(4) || null;
  if (!falModelId) return { backend: 'fal' };
  // A music-driven shot's pick is its music model, at that model's own default size.
  if (context.performance) {
    return { backend: 'fal', falMusicModelId: falModelId, ...(falModelId === saved.falMusicModelId ? {} : { falMusicResolution: null }) };
  }
  // Each model has its own resolutions, so the saved one only carries over to the saved model.
  const sameModel = falModelId === (saved.falModelId || FAL_DEFAULT_IMAGE_VIDEO_MODEL);
  // A picked model is the one this render uses, end frame or not.
  return {
    backend: 'fal', falModelId, falEndFrameModelId: falModelId,
    ...(sameModel ? {} : { falResolution: null, falDuration: null }),
    ...(options.falDuration ? { falDuration: options.falDuration } : {}),
    ...(options.falResolution ? { falResolution: options.falResolution } : {}),
  };
}

const formatSec = (sec) => `${Math.round(sec * 10) / 10}s`;

function OptionSelect({ id, label, value, onChange, disabled, children }) {
  return (
    <span className="flex min-w-0 items-center gap-1">
      <label htmlFor={id} className="text-xs text-port-text-muted">{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} className={SELECT}>{children}</select>
    </span>
  );
}

export default function SceneRenderTarget({
  id, value, onChange, options = {}, onOptionsChange, performance, saved, scene = null, models = [], defaultModel = '', disabled = false,
}) {
  const runwayCatalog = useRunwayCatalog();
  const set = (patch) => {
    const next = { ...options, ...patch };
    onOptionsChange?.(next);
    rememberRenderTarget(value, next);
  };
  const spanSec = shotSpan(scene);
  const overrides = renderTargetOverrides(value, saved, options, { models, defaultModel, performance, scene });
  const localChoices = localModelChoices(models, performance);
  const localModel = value === 'local' ? models.find((model) => model.id === overrides.modelId) : null;
  const falModel = value.startsWith('fal:') ? getFalVideoModel(overrides.falModelId) : null;
  const runwayModel = value.startsWith('runway:') ? getRunwayVideoModel(overrides.runwayModelId) : null;
  const coversLabel = (sec) => (spanSec != null ? `${formatSec(sec)} · covers shot` : `${formatSec(sec)} · default`);
  return (
    <>
      <span className="flex min-w-0 flex-1 basis-48 items-center gap-1 sm:flex-none">
        <label htmlFor={id} className="text-xs">Render on</label>
        <select id={id} value={value} onChange={(e) => { onChange(e.target.value); onOptionsChange?.({}); rememberRenderTarget(e.target.value); }} disabled={disabled}
          title="Where this shot's clip renders. Only this shot; the project setting stays as it is."
          className={`${SELECT} flex-1 sm:flex-none`}>
          {value.startsWith('runway:') && !runwayCatalog.videoModels.some((m) => `runway:${m.id}` === value) && <option value={value}>{value} (unavailable)</option>}
          {renderTargetOptions({ performance, saved, endFrame: Boolean(scene?.endImageId), scene, runwayModels: runwayCatalog.videoModels }).map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>
          ))}
        </select>
      </span>
      {value === 'local' && (
        <>
          <OptionSelect id={`${id}-model`} label="Model" value={overrides.modelId || ''} disabled={disabled || localChoices.length === 0}
            onChange={(modelId) => set({ modelId, numFrames: null })}>
            {localChoices.length === 0 && <option value="">{performance ? 'No lip-sync model installed' : 'No local model installed'}</option>}
            {localChoices.map((model) => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}
          </OptionSelect>
          {localModel && !performance && (
            <OptionSelect id={`${id}-length`} label="Clip length" value={overrides.numFrames || ''} disabled={disabled}
              onChange={(frames) => set({ numFrames: Number(frames) || null })}>
              {frameOptionsForModel(localModel).map((frames) => (
                <option key={frames} value={frames}>
                  {frames === coveringFrames(localModel, spanSec) ? coversLabel(frames / LOCAL_FPS) : formatSec(frames / LOCAL_FPS)}
                </option>
              ))}
            </OptionSelect>
          )}
        </>
      )}
      {value === 'grok' && (
        <OptionSelect id={`${id}-length`} label="Clip length" value={overrides.grokDuration || ''} disabled={disabled}
          onChange={(sec) => set({ grokDuration: Number(sec) || null })}>
          {overrides.grokDuration == null && <option value="">Default</option>}
          {GROK_VIDEO_DURATIONS.map((sec) => (
            <option key={sec} value={sec}>{spanSec != null && sec === grokCoverage(spanSec).requestSec ? coversLabel(sec) : formatSec(sec)}</option>
          ))}
        </OptionSelect>
      )}
      {falModel && !performance && (
        <>
          {falLengths(falModel).length > 0 && (
            <OptionSelect id={`${id}-length`} label="Clip length" value={options.falDuration || ''} disabled={disabled}
              onChange={(sec) => set({ falDuration: Number(sec) || null })}>
              <option value="">{coversLabel(coerceFalVideoSeconds(falModel, spanSec))}</option>
              {falLengths(falModel).map((sec) => <option key={sec} value={sec}>{formatSec(sec)}</option>)}
            </OptionSelect>
          )}
          {falVideoResolutions(falModel).length > 1 && (
            <OptionSelect id={`${id}-resolution`} label="Size" value={options.falResolution || ''} disabled={disabled}
              onChange={(falResolution) => set({ falResolution: falResolution || null })}>
              <option value="">{`${falModel.resolution.default} · default`}</option>
              {falVideoResolutions(falModel).filter((res) => res !== falModel.resolution.default).map((res) => (
                <option key={res} value={res}>{`${res} · ${describeFalVideoRate(falModel.id, res)}`}</option>
              ))}
            </OptionSelect>
          )}
        </>
      )}
      {runwayModel && !performance && (
        <>
          {runwayVideoLengths(runwayModel).length > 0 && (
            <OptionSelect id={`${id}-length`} label="Clip length" value={options.runwayDuration || ''} disabled={disabled}
              onChange={(sec) => set({ runwayDuration: Number(sec) || null })}>
              <option value="">{coversLabel(coerceRunwayVideoSeconds(runwayModel, spanSec))}</option>
              {runwayVideoLengths(runwayModel).map((sec) => <option key={sec} value={sec}>{formatSec(sec)}</option>)}
            </OptionSelect>
          )}
          {runwayVideoResolutions(runwayModel).length > 1 && (
            <OptionSelect id={`${id}-resolution`} label="Size" value={options.runwayResolution || ''} disabled={disabled}
              onChange={(runwayResolution) => set({ runwayResolution: runwayResolution || null })}>
              <option value="">{`${runwayModel.size.default} · default`}</option>
              {runwayVideoResolutions(runwayModel).filter((res) => res !== runwayModel.size.default).map((res) => (
                <option key={res} value={res}>{`${res} · ${describeRunwayVideoRate(runwayModel.id, res)}`}</option>
              ))}
            </OptionSelect>
          )}
        </>
      )}
    </>
  );
}
