import { IMAGE_GEN_MODE, IMAGE_PIN_MODES, modeLabel, supportsCloudModelOverride } from '../../lib/imageGenBackends';
import { safeReadJsonStorage, safeWriteJsonStorage } from '../../lib/safeStorage.js';
import ImageModelField from '../imageGen/ImageModelField.jsx';
import { COMPACT_SELECT, RenderOnSelect } from '../media/RenderOnSelect.jsx';

// Separate from the clip tab's key: a video pick must not become the next frame's service.
export const LAST_FRAME_RENDER_KEY = 'portos.musicVideo.lastFrameRenderOn';

const modelTaken = (mode) => mode === IMAGE_GEN_MODE.LOCAL || supportsCloudModelOverride(mode);

/** What the project pin currently names, for the "Project setting" option. */
export function frameRenderProjectLabel(project) {
  const mode = project?.imageMode;
  if (!mode || mode === 'auto') return 'Auto';
  const name = modeLabel(mode);
  return project.imageModelId ? `${name} · ${project.imageModelId}` : name;
}

export function frameRenderTargetOptions(project) {
  return [
    { value: '', label: `Project setting · ${frameRenderProjectLabel(project)}` },
    ...IMAGE_PIN_MODES.map((mode) => ({ value: mode, label: modeLabel(mode) })),
  ];
}

/**
 * The generateImage fields a frame pick adds, or null to follow the project pin.
 * An explicit mode wins on the server and blocks the project model from leaking,
 * so a blank model means that backend's saved default.
 */
export function frameRenderTargetOverrides(value, options = {}) {
  if (!IMAGE_PIN_MODES.includes(value)) return null;
  const model = typeof options.modelId === 'string' ? options.modelId.trim() : '';
  if (value === IMAGE_GEN_MODE.LOCAL) return { mode: value, ...(model ? { modelId: model } : {}) };
  if (supportsCloudModelOverride(value)) return { mode: value, ...(model ? { cloudModel: model } : {}) };
  return { mode: value };
}

/** Remember a frame-tab pick for the next shot opened on this device. */
export function rememberFrameRenderTarget(pick, options = {}) {
  safeWriteJsonStorage(LAST_FRAME_RENDER_KEY, { pick: pick || '', modelId: options.modelId || null });
}

/** The pick and model a frame tab opens on, or the project setting when the saved pick is not one this tab offers. */
export function lastFrameRenderTarget() {
  const last = safeReadJsonStorage(LAST_FRAME_RENDER_KEY, null);
  const pick = IMAGE_PIN_MODES.includes(last?.pick) ? last.pick : '';
  const modelId = typeof last?.modelId === 'string' && last.modelId.trim() ? last.modelId.trim() : null;
  return { pick, options: pick && modelId && modelTaken(pick) ? { modelId } : {} };
}

/**
 * Where one shot's frames render. '' follows the project image service; any
 * other value is this render only. The model control is the same one the
 * project pin uses.
 */
export default function SceneFrameRenderTarget({
  id, value, onChange, options = {}, onOptionsChange, project = null, disabled = false,
}) {
  const setModel = (modelId) => {
    const next = { modelId: modelId || null };
    onOptionsChange?.(next);
    rememberFrameRenderTarget(value, next);
  };
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <RenderOnSelect id={id} value={value} disabled={disabled} options={frameRenderTargetOptions(project)}
        title="Where this shot's frames render. Only this shot; the project image service stays as it is."
        onChange={(next) => { onChange(next); onOptionsChange?.({}); rememberFrameRenderTarget(next, {}); }} />
      <ImageModelField id={`${id}-model`} mode={value} value={options.modelId || null} disabled={disabled}
        commit="change" inline className={`${COMPACT_SELECT} flex-1`} onChange={setModel} />
    </div>
  );
}
