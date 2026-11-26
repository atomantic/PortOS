import { Cloud, Cpu, Layers, Loader2, Sparkles } from 'lucide-react';
import BackendChipStrip from '../media/BackendChipStrip';
import ListLoadError from '../ui/ListLoadError';
import { FABLELOOM_RENDER_FORMATS } from '../../../../server/lib/fableLoomProduction.js';

const IMAGE_BACKENDS = [
  { id: 'auto', label: 'Auto', icon: Layers },
  { id: 'local', label: 'Local', icon: Cpu },
  { id: 'codex', label: 'Codex', icon: Cloud },
  { id: 'grok', label: 'Grok', icon: Cloud },
  { id: 'agy', label: 'Agy', icon: Sparkles },
  { id: 'runway', label: 'Runway', icon: Cloud },
];

const VIDEO_BACKENDS = [
  { id: 'auto', label: 'Auto', icon: Layers },
  { id: 'local', label: 'Local', icon: Cpu },
  { id: 'grok', label: 'Grok', icon: Cloud },
];


const modelOptions = (models, selected) => {
  const options = (Array.isArray(models) ? models : [])
    .filter((model) => model?.id)
    .map((model) => ({ id: model.id, label: model.name || model.id }));
  if (selected && !options.some((option) => option.id === selected)) {
    return [{ id: selected, label: `${selected} (unavailable)` }, ...options];
  }
  return options;
};

export default function LoomRenderFormatControls({
  mode, assetScope, image, video, effort, setEffort, renderFormat, saveRenderFormat, savingRenderFormat,
}) {
  const { mode: imageMode, setMode: setImageMode, model: imageModel, setModel: setImageModel, modelList: imageModelList } = image;
  const { mode: videoMode, setMode: setVideoMode, model: videoModel, setModel: setVideoModel, modelList: videoModelList } = video;
  return (
    <div className="rounded bg-port-card border border-port-border p-2.5 space-y-2">
      <div className="text-[10px] uppercase font-semibold text-port-text-muted">Render settings</div>
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="fableloom-render-format" className="text-[11px] text-port-text-muted w-14">Output</label>
          <select
            id="fableloom-render-format"
            value={renderFormat.formatId}
            onChange={(event) => saveRenderFormat(event.target.value)}
            disabled={savingRenderFormat}
            className="text-[11px] bg-port-bg border border-port-border rounded px-1.5 py-1 text-port-text disabled:opacity-50"
          >
            {FABLELOOM_RENDER_FORMATS.map((format) => (
              <option key={format.formatId} value={format.formatId}>
                {format.label} · {format.width}×{format.height}
              </option>
            ))}
          </select>
          {savingRenderFormat && <Loader2 size={11} className="animate-spin text-port-text-muted" aria-label="Saving output format" />}
          <span className="text-[10px] text-port-text-muted">
            {mode === 'exact_inputs'
              ? 'Exact-input mode preserves each asset’s recorded dimensions.'
              : 'Shared by storyboard images and video clips; 16:9 landscape is the default.'}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-port-text-muted w-14">Images</span>
          <BackendChipStrip
            availableBackends={IMAGE_BACKENDS}
            value={imageMode || 'auto'}
            onChange={(value) => {
              const nextMode = value === 'auto' ? null : value;
              setImageMode(nextMode);
              if (nextMode && nextMode !== 'local') setImageModel(null);
            }}
            size="sm"
            ariaLabel="Image provider"
          />
          {(imageMode === 'local' || !imageMode) && (
            <label htmlFor="fableloom-image-model" className="sr-only">Image model</label>
          )}
          {(imageMode === 'local' || !imageMode) && (
            <select
              id="fableloom-image-model"
              value={imageModel || ''}
              onChange={(event) => setImageModel(event.target.value || null)}
              className="text-[11px] bg-port-bg border border-port-border rounded px-1.5 py-1 text-port-text"
            >
              <option value="">Saved image model</option>
              {modelOptions(imageModelList.items, imageModel).map((modelOption) => (
                <option key={modelOption.id} value={modelOption.id}>{modelOption.label}</option>
              ))}
            </select>
          )}
          {imageModelList.state === 'error' && (
            <ListLoadError className="basis-full" what="image models" error={imageModelList.error} onRetry={imageModelList.retry} />
          )}
        </div>
        {assetScope === 'all' && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-port-text-muted w-14">Video</span>
            <BackendChipStrip
              availableBackends={VIDEO_BACKENDS}
              value={videoMode || 'auto'}
              onChange={(value) => {
                const nextMode = value === 'auto' ? null : value;
                setVideoMode(nextMode);
                if (nextMode && nextMode !== 'local') setVideoModel(null);
              }}
              size="sm"
              ariaLabel="Video provider"
            />
            {(videoMode === 'local' || !videoMode) && (
              <label htmlFor="fableloom-video-model" className="sr-only">Video model</label>
            )}
            {(videoMode === 'local' || !videoMode) && (
              <select
                id="fableloom-video-model"
                value={videoModel || ''}
                onChange={(event) => setVideoModel(event.target.value || null)}
                className="text-[11px] bg-port-bg border border-port-border rounded px-1.5 py-1 text-port-text"
              >
                <option value="">Saved video model</option>
                {modelOptions(videoModelList.items, videoModel).map((modelOption) => (
                  <option key={modelOption.id} value={modelOption.id}>{modelOption.label}</option>
                ))}
              </select>
            )}
            {videoModelList.state === 'error' && (
              <ListLoadError className="basis-full" what="video models" error={videoModelList.error} onRetry={videoModelList.retry} />
            )}
          </div>
        )}
        <div className="flex items-center gap-2">
          <label htmlFor="fableloom-render-effort" className="text-[11px] text-port-text-muted w-14">Effort</label>
          <select
            id="fableloom-render-effort"
            value={effort || ''}
            onChange={(event) => setEffort(event.target.value || null)}
            className="text-[11px] bg-port-bg border border-port-border rounded px-1.5 py-1 text-port-text"
          >
            <option value="">Provider default</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
          <span className="text-[10px] text-port-text-muted">Used when the selected provider supports it.</span>
        </div>
      </div>
    </div>
  );
}
