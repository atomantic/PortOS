import { useEffect, useState } from 'react';
import ToggleChip from '../ui/ToggleChip.jsx';
import { MUSIC_VIDEO_AUTOMATION_TOOLS, MUSIC_VIDEO_AUTOMATION_TOOL_IDS } from '../../lib/musicVideoAutomation.js';
import { autonomousMedium } from '../../lib/musicVideoAutonomous.js';
import { getVideoGenModelContext } from '../../services/apiImageVideo.js';

const GROUPS = [['image', 'Image'], ['video', 'Video'], ['code', 'Code']];
const LOCAL_VIDEO_TOOL_ID = 'video:local';
const inputClass = 'w-full min-w-0 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm';

/**
 * The local-video `<select>` while its catalog loads, after it fails, or once
 * the hardware-compatible models are in. A blank value is the install default.
 * A pin the catalog no longer lists stays selected, so a save cannot drop it.
 */
function localVideoModelSelectState({ catalog, failed, pinned }) {
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  const loading = catalog == null && !failed;
  const defaultId = typeof catalog?.defaultModel === 'string' ? catalog.defaultModel : '';
  const defaultName = models.find((model) => model.id === defaultId)?.name || defaultId;
  const blankDetail = failed
    ? ''
    : models.length === 0
      ? 'no compatible local model'
      : (defaultName || 'no compatible local model');
  const known = models.some((model) => model.id === pinned);
  const options = [
    ...(pinned && (loading || !known) ? [{ id: pinned, name: loading ? pinned : `${pinned} (unavailable on this machine)` }] : []),
    ...(loading ? [] : models.map((model) => ({ id: model.id, name: model.name || model.id }))),
  ];
  let status = '';
  if (failed) status = 'Could not load local video models.';
  else if (!loading && models.length === 0) status = 'No local video models are compatible with this machine.';
  return {
    blankLabel: loading ? 'Loading models…' : (blankDetail ? `Install default (${blankDetail})` : 'Install default'),
    options,
    status,
    disabled: loading,
  };
}

/** Probe-free video catalog, fetched only while Local video gen is picked. */
function useLocalVideoModels(enabled) {
  const [catalog, setCatalog] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    setCatalog(null);
    setFailed(false);
    getVideoGenModelContext({ silent: true })
      .then((next) => {
        if (active) setCatalog(next && typeof next === 'object' ? next : { models: [] });
      })
      .catch(() => {
        if (!active) return;
        setCatalog({ models: [] });
        setFailed(true);
      });
    return () => { active = false; };
  }, [enabled]);
  return { catalog: enabled ? catalog : null, failed: enabled && failed };
}

/**
 * "How the video is made" — the render-tool chips plus a per-tool model pin for
 * each picked image/video tool. Shared by the Autonomous start drawer and the
 * music-video-autopilot Schedule settings, so the two cannot drift. Controlled:
 * `tools` is the picked id list, `models` the `{ toolId: model }` pins.
 * Local video gen chooses from the install's video-model catalog. A blank pin
 * is the install default. Other tools still take a model id.
 */
export default function ToolPicker({ idPrefix = 'mv-auto', tools, models, onChange }) {
  const picked = new Set(tools);
  const medium = autonomousMedium(tools);
  const toggleTool = (id) => onChange({
    tools: MUSIC_VIDEO_AUTOMATION_TOOL_IDS.filter((t) => (t === id ? !picked.has(t) : picked.has(t))),
    models,
  });
  const modelTools = MUSIC_VIDEO_AUTOMATION_TOOLS.filter((t) => t.group !== 'code' && picked.has(t.id));
  const localVideo = useLocalVideoModels(modelTools.some((tool) => tool.id === LOCAL_VIDEO_TOOL_ID));
  const setModel = (toolId, value) => onChange({ tools, models: { ...models, [toolId]: value } });

  return (
    <>
      <fieldset className="min-w-0" aria-labelledby={`${idPrefix}-tools-label`}>
        <span id={`${idPrefix}-tools-label`} className="block text-xs text-port-text-muted mb-1">How the video is made</span>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {GROUPS.map(([group, label]) => (
            <div key={group} className="border border-port-border rounded p-2 min-w-0">
              <div className="text-[11px] uppercase tracking-wide text-port-text-muted mb-1">{label}</div>
              <div className="flex flex-wrap gap-1.5">
                {MUSIC_VIDEO_AUTOMATION_TOOLS.filter((t) => t.group === group).map((tool) => (
                  <ToggleChip
                    key={tool.id}
                    id={`${idPrefix}-tool-${tool.id}`}
                    label={tool.metered ? `${tool.label} $` : tool.label}
                    hint={tool.metered ? 'Spends money or remote quota' : undefined}
                    checked={picked.has(tool.id)}
                    onToggle={() => toggleTool(tool.id)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-port-text-muted mt-1">
          {medium === 'code'
            ? 'Only “Render with code” is picked: the video is drawn by code — no images or footage are generated.'
            : 'Image and video tools drive the production run; it stops at the generation limit and the budget.'}
        </p>
      </fieldset>

      {modelTools.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-3">
          {modelTools.map((tool) => {
            const fieldId = `${idPrefix}-model-${tool.id}`;
            const value = models[tool.id] || '';
            if (tool.id !== LOCAL_VIDEO_TOOL_ID) {
              return (
                <div key={tool.id} className="min-w-0">
                  <label htmlFor={fieldId} className="block text-xs text-port-text-muted mb-1">{tool.label} model (optional)</label>
                  <input
                    id={fieldId}
                    value={value}
                    onChange={(e) => setModel(tool.id, e.target.value)}
                    placeholder="Install default"
                    maxLength={200}
                    className={inputClass}
                  />
                </div>
              );
            }
            const select = localVideoModelSelectState({ catalog: localVideo.catalog, failed: localVideo.failed, pinned: value });
            const statusId = `${fieldId}-status`;
            return (
              <div key={tool.id} className="min-w-0">
                <label htmlFor={fieldId} className="block text-xs text-port-text-muted mb-1">{tool.label} model (optional)</label>
                <select
                  id={fieldId}
                  value={value}
                  disabled={select.disabled}
                  aria-describedby={select.status ? statusId : undefined}
                  onChange={(e) => setModel(tool.id, e.target.value)}
                  className={inputClass}
                >
                  <option value="">{select.blankLabel}</option>
                  {select.options.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
                </select>
                {select.status && <p id={statusId} role="status" className="text-[11px] text-port-warning mt-1">{select.status}</p>}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
