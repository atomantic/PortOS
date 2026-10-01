import ToggleChip from '../ui/ToggleChip.jsx';
import { MUSIC_VIDEO_AUTOMATION_TOOLS, MUSIC_VIDEO_AUTOMATION_TOOL_IDS } from '../../lib/musicVideoAutomation.js';
import { autonomousMedium } from '../../lib/musicVideoAutonomous.js';

const GROUPS = [['image', 'Image'], ['video', 'Video'], ['code', 'Code']];
const inputClass = 'w-full min-w-0 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm';

/**
 * "How the video is made" — the render-tool chips plus a per-tool model pin for
 * each picked image/video tool. Shared by the Autonomous start drawer and the
 * music-video-autopilot Schedule settings, so the two cannot drift. Controlled:
 * `tools` is the picked id list, `models` the `{ toolId: model }` pins.
 */
export default function ToolPicker({ idPrefix = 'mv-auto', tools, models, onChange }) {
  const picked = new Set(tools);
  const medium = autonomousMedium(tools);
  const toggleTool = (id) => onChange({
    tools: MUSIC_VIDEO_AUTOMATION_TOOL_IDS.filter((t) => (t === id ? !picked.has(t) : picked.has(t))),
    models,
  });
  const modelTools = MUSIC_VIDEO_AUTOMATION_TOOLS.filter((t) => t.group !== 'code' && picked.has(t.id));

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
          {modelTools.map((tool) => (
            <div key={tool.id} className="min-w-0">
              <label htmlFor={`${idPrefix}-model-${tool.id}`} className="block text-xs text-port-text-muted mb-1">{tool.label} model (optional)</label>
              <input
                id={`${idPrefix}-model-${tool.id}`}
                value={models[tool.id] || ''}
                onChange={(e) => onChange({ tools, models: { ...models, [tool.id]: e.target.value } })}
                placeholder="Install default"
                maxLength={200}
                className={inputClass}
              />
            </div>
          ))}
        </div>
      )}
    </>
  );
}
