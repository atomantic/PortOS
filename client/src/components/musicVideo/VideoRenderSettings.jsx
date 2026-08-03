import { GROK_VIDEO_DURATIONS } from '../../lib/grokVideoClip.js';

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
  const locked = saving || generating;
  return (
    <>
      <label htmlFor="mv-video-backend" className="sr-only">Scene video renderer</label>
      <select
        id="mv-video-backend"
        value={settings.backend}
        onChange={(e) => change({ backend: e.target.value || null })}
        disabled={locked}
        title="Saved renderer for this project's scene videos"
        className="bg-port-bg border border-port-border rounded px-1.5 py-1.5 text-sm disabled:opacity-50"
      >
        <option value="">Install default</option>
        <option value="local">Local video</option>
        <option value="grok">Grok video</option>
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
            className="bg-port-bg border border-port-border rounded px-1.5 py-1.5 text-sm disabled:opacity-50"
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
            className="max-w-[240px] bg-port-bg border border-port-border rounded px-1.5 py-1.5 text-sm disabled:opacity-50"
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
                className="max-w-[220px] bg-port-bg border border-port-border rounded px-1.5 py-1.5 text-sm disabled:opacity-50"
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
                className="bg-port-bg border border-port-border rounded px-1.5 py-1.5 text-sm disabled:opacity-50"
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
            className="bg-port-bg border border-port-border rounded px-1.5 py-1.5 text-sm disabled:opacity-50"
          >
            {GROK_VIDEO_DURATIONS.map((duration) => (
              <option key={duration} value={duration}>{duration}s clips</option>
            ))}
          </select>
        </>
      )}
    </>
  );
}
