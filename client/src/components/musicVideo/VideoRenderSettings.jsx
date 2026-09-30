import { GROK_VIDEO_DURATIONS } from '../../lib/grokVideoClip.js';
import {
  FAL_DEFAULT_IMAGE_VIDEO_MODEL, FAL_IMAGE_VIDEO_MODELS, describeFalVideoRate, falVideoResolutions, getFalVideoModel,
} from '../../lib/falVideoModels.js';
import { SOURCE_AUDIO_LIPSYNC } from '../../lib/musicVideoShotTiming.js';

const falSelectCls = 'w-full max-w-full bg-port-bg border border-port-border rounded px-1.5 py-1.5 text-sm disabled:opacity-50 sm:w-auto min-h-[44px] sm:min-h-0';
const falOptionLabel = (model) => {
  const rate = describeFalVideoRate(model.id);
  return rate ? `${model.label} · ${rate}` : model.label;
};

// The project's saved scene-video render pins (backend → generation mode →
// model → audio-reactive LoRA/strength, or Grok clip duration). Every control
// persists through useMusicVideoModelSettings' `change`, and locks while a save
// is in flight or any scene clip is generating, so the job payload and the
// board's displayed setting cannot disagree.
export default function VideoRenderSettings({ videoSettings, generating }) {
  const {
    settings, saving, models, modelsLoading, defaultModel, effectiveModelId,
    audioReactiveModels, audioReactiveLoras, detectedAudioReactiveLora,
    audioReactiveReady, audioReactiveSelected, change,
  } = videoSettings;
  // fal.ai (#8968) is image-to-video only here — every scene render already
  // starts from the director's chosen reference frame, so the model picker
  // offers the curated start-frame models (lib/falVideoModels.js), each with
  // its list rate; blank is the default (Hailuo-02 image-to-video). The
  // resolution alphabet is per model, so a model change clears the pin.
  // Performance (lip-sync) takes always render on the lip-sync route, with
  // their own resolution pin (default 1080P).
  // The audio-reactive lane stays local-only (root AGENTS.md's environmental-
  // motion contract needs an independently verified provider capability).
  const locked = saving || generating;
  const falModel = getFalVideoModel(settings.falModelId || FAL_DEFAULT_IMAGE_VIDEO_MODEL);
  const falResolutions = falVideoResolutions(falModel);
  const lipSync = SOURCE_AUDIO_LIPSYNC.fal;
  return (
    <>
      <label htmlFor="mv-video-backend" className="sr-only">Scene video renderer</label>
      <select
        id="mv-video-backend"
        value={settings.backend}
        onChange={(e) => change({ backend: e.target.value || null })}
        disabled={locked}
        title="Saved renderer for this project's scene videos"
        className="w-full max-w-full bg-port-bg border border-port-border rounded px-1.5 py-1.5 text-sm disabled:opacity-50 min-h-[44px] sm:min-h-0 sm:w-auto"
      >
        <option value="">Install default</option>
        <option value="local">Local video</option>
        {/* Grok's CLI lane takes no audio, so it renders cutaways only —
            performance (lip-sync) shots need fal.ai (#8977). */}
        <option value="grok">Grok video (cutaway only)</option>
        <option value="fal">fal.ai video</option>
      </select>
      {settings.backend === 'local' && (
        <>
          <label htmlFor="mv-generation-mode" className="sr-only">Scene generation mode</label>
          <select
            id="mv-generation-mode"
            value={settings.generationMode}
            onChange={(e) => {
              const generationMode = e.target.value;
              const compatibleModel = audioReactiveModels.find((model) => model.id === effectiveModelId)
                || audioReactiveModels[0];
              change({
                generationMode,
                ...(generationMode === 'audioReactive' && detectedAudioReactiveLora
                  ? { audioReactiveLora: detectedAudioReactiveLora.filename }
                  : {}),
                ...(generationMode === 'audioReactive' && compatibleModel
                  ? { modelId: compatibleModel.id }
                  : {}),
              });
            }}
            disabled={locked}
            title="Prompt motion uses the reference frame; audio reactive also conditions motion on this scene's song segment"
            className="w-full max-w-full bg-port-bg border border-port-border rounded px-1.5 py-1.5 text-sm disabled:opacity-50 min-h-[44px] sm:min-h-0 sm:w-auto"
          >
            <option value="image">Prompt motion</option>
            <option value="audioReactive" disabled={!detectedAudioReactiveLora}>Audio reactive</option>
          </select>
          <label htmlFor="mv-video-model" className="sr-only">Local video model</label>
          <select
            id="mv-video-model"
            value={settings.modelId}
            onChange={(e) => change({ modelId: e.target.value })}
            disabled={locked || models.length === 0}
            title="Saved local image-to-video model for this project"
            className="w-full max-w-full bg-port-bg border border-port-border rounded px-1.5 py-1.5 text-sm disabled:opacity-50 min-h-[44px] sm:min-h-0 sm:w-auto sm:max-w-[240px]"
          >
            <option value="">
              {defaultModel
                ? `Local default · ${models.find((model) => model.id === defaultModel)?.name || defaultModel}`
                : 'Local default model'}
            </option>
            {(audioReactiveSelected ? audioReactiveModels : models).map((model) => (
              <option key={model.id} value={model.id}>{model.name || model.id}</option>
            ))}
          </select>
          {audioReactiveSelected && (
            <>
              <label htmlFor="mv-audio-reactive-lora" className="sr-only">Audio reactive LoRA</label>
              <select
                id="mv-audio-reactive-lora"
                value={settings.audioReactiveLora || detectedAudioReactiveLora?.filename || ''}
                onChange={(e) => change({ audioReactiveLora: e.target.value })}
                disabled={locked || audioReactiveLoras.length === 0}
                title="Saved audio-reactive LoRA version for this project"
                className="w-full max-w-full bg-port-bg border border-port-border rounded px-1.5 py-1.5 text-sm disabled:opacity-50 min-h-[44px] sm:min-h-0 sm:w-auto sm:max-w-[220px]"
              >
                {audioReactiveLoras.length === 0 && <option value="">No audio-reactive LoRA installed</option>}
                {audioReactiveLoras.map((lora) => (
                  <option key={lora.filename} value={lora.filename}>
                    {lora.name || lora.filename}
                  </option>
                ))}
              </select>
              <label htmlFor="mv-audio-reactive-scale" className="sr-only">Audio reactive LoRA strength</label>
              <select
                id="mv-audio-reactive-scale"
                value={settings.audioReactiveScale}
                onChange={(e) => change({ audioReactiveScale: Number(e.target.value) })}
                disabled={locked}
                title="How strongly the song drives visible motion"
                className="w-full max-w-full bg-port-bg border border-port-border rounded px-1.5 py-1.5 text-sm disabled:opacity-50 min-h-[44px] sm:min-h-0 sm:w-auto"
              >
                <option value={1}>Reactive 1.0×</option>
                <option value={1.2}>Reactive 1.2×</option>
                <option value={1.5}>Reactive 1.5×</option>
              </select>
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded ${
                  audioReactiveReady
                    ? 'bg-port-success/20 text-port-success'
                    : (modelsLoading ? 'bg-port-warning/20 text-port-warning' : 'bg-port-error/20 text-port-error')
                }`}
                title={detectedAudioReactiveLora?.filename || 'Audio-reactive LoRA not installed'}
              >
                {audioReactiveReady
                  ? 'song-conditioned · no vocals'
                  : (modelsLoading ? 'checking local runtime…' : 'audio-reactive unavailable')}
              </span>
            </>
          )}
        </>
      )}
      {settings.backend === 'grok' && (
        <>
          <label htmlFor="mv-grok-duration" className="sr-only">Grok scene clip duration</label>
          <select
            id="mv-grok-duration"
            value={settings.grokDuration}
            onChange={(e) => change({ grokDuration: Number(e.target.value) })}
            disabled={locked}
            title="Native duration for each Grok scene clip"
            className="w-full max-w-full bg-port-bg border border-port-border rounded px-1.5 py-1.5 text-sm disabled:opacity-50 min-h-[44px] sm:min-h-0 sm:w-auto"
          >
            {GROK_VIDEO_DURATIONS.map((duration) => (
              <option key={duration} value={duration}>{duration}s clips</option>
            ))}
          </select>
        </>
      )}
      {settings.backend === 'fal' && (
        <>
          <label htmlFor="mv-fal-model" className="sr-only">fal.ai cutaway model</label>
          <select
            id="mv-fal-model"
            value={settings.falModelId || ''}
            onChange={(e) => change({ falModelId: e.target.value || null, falResolution: null })}
            disabled={locked}
            title="fal.ai image-to-video model for this project's cutaway scenes (list price per generated second)"
            className={`${falSelectCls} sm:max-w-[280px]`}
          >
            <option value="">{`Default · ${falOptionLabel(getFalVideoModel(FAL_DEFAULT_IMAGE_VIDEO_MODEL))}`}</option>
            {FAL_IMAGE_VIDEO_MODELS.filter((model) => model.id !== FAL_DEFAULT_IMAGE_VIDEO_MODEL).map((model) => (
              <option key={model.id} value={model.id}>{falOptionLabel(model)}</option>
            ))}
            {/* A model pinned on a peer with a newer catalog: kept, but it
                cannot be priced here. */}
            {settings.falModelId && !falModel && (
              <option value={settings.falModelId}>{`${settings.falModelId} · cost unknown`}</option>
            )}
          </select>
          {falResolutions.length > 0 && (
            <>
              <label htmlFor="mv-fal-resolution" className="sr-only">fal.ai cutaway resolution</label>
              <select
                id="mv-fal-resolution"
                value={falResolutions.includes(settings.falResolution) ? settings.falResolution : ''}
                onChange={(e) => change({ falResolution: e.target.value || null })}
                disabled={locked}
                title="Output resolution for fal.ai cutaway renders — higher costs more per second"
                className={falSelectCls}
              >
                <option value="">{`${falModel.resolution.default} (model default)`}</option>
                {falResolutions.map((res) => (
                  <option key={res} value={res}>{`${res} · ${describeFalVideoRate(falModel.id, res)}`}</option>
                ))}
              </select>
            </>
          )}
          <label htmlFor="mv-fal-duration" className="sr-only">fal.ai scene clip duration</label>
          <input
            id="mv-fal-duration"
            type="number"
            min={1}
            max={60}
            value={settings.falDuration ?? ''}
            onChange={(e) => change({ falDuration: e.target.value === '' ? null : Number(e.target.value) })}
            disabled={locked}
            placeholder="shot length"
            title="Clip length in seconds for this project's fal.ai cutaway renders. Blank renders the shortest length the model offers that covers each shot (the model default for an untimed scene)."
            className="w-full max-w-full bg-port-bg border border-port-border rounded px-1.5 py-1.5 text-sm disabled:opacity-50 min-h-[44px] sm:min-h-0 sm:w-24"
          />
          <label htmlFor="mv-fal-lipsync-resolution" className="sr-only">fal.ai lip-sync resolution</label>
          <select
            id="mv-fal-lipsync-resolution"
            value={settings.falLipSyncResolution || ''}
            onChange={(e) => change({ falLipSyncResolution: e.target.value || null })}
            disabled={locked}
            title={`Output resolution for performance (lip-sync) takes on ${lipSync.label}`}
            className={falSelectCls}
          >
            <option value="">{`Lip-sync ${lipSync.defaultResolution} (default)`}</option>
            {lipSync.resolutions.map((res) => (
              <option key={res} value={res}>{`Lip-sync ${res} · ${describeFalVideoRate(lipSync.modelId, res)}`}</option>
            ))}
          </select>
        </>
      )}
    </>
  );
}
