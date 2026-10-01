import ToggleChip from '../ui/ToggleChip.jsx';
import { MUSIC_VIDEO_AUTOMATION_TOOLS, MUSIC_VIDEO_AUTOMATION_TOOL_IDS } from '../../lib/musicVideoAutomation.js';

const GROUPS = [['image', 'Image'], ['video', 'Video'], ['code', 'Code']];
const inputClass = 'w-full min-w-0 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm';

/** Tool picker + guidance + budget for an automation-first music video. */
export default function AutomationBriefFields({ idPrefix, draft, onChange }) {
  const picked = new Set(draft.tools);
  const allPicked = picked.size === MUSIC_VIDEO_AUTOMATION_TOOL_IDS.length;
  const toggle = (id) => onChange({
    tools: MUSIC_VIDEO_AUTOMATION_TOOL_IDS.filter((t) => (t === id ? !picked.has(t) : picked.has(t))),
  });
  return (
    <div className="space-y-3 min-w-0">
      <fieldset className="min-w-0" aria-labelledby={`${idPrefix}-tools-label`}>
        <div className="flex items-center justify-between gap-2 mb-1">
          <span id={`${idPrefix}-tools-label`} className="text-xs text-port-text-muted">Tools the agent may use</span>
          <button
            type="button"
            onClick={() => onChange({ tools: allPicked ? [] : [...MUSIC_VIDEO_AUTOMATION_TOOL_IDS] })}
            className="text-xs text-port-accent min-h-[44px] sm:min-h-0"
          >
            {allPicked ? 'Clear all' : 'Select all'}
          </button>
        </div>
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
                    onToggle={() => toggle(tool.id)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs text-port-text-muted mt-1">Analyze &amp; plan uses this guidance. Start production selects its own explicit provider pool and limits; the brief does not submit media jobs.</p>
      </fieldset>
      <div>
        <label htmlFor={`${idPrefix}-guidance`} className="block text-xs text-port-text-muted mb-1">Guidance</label>
        <textarea
          id={`${idPrefix}-guidance`}
          rows={3}
          maxLength={8000}
          value={draft.guidance}
          onChange={(e) => onChange({ guidance: e.target.value })}
          placeholder="Story, tone, pacing, what to avoid — the agent plans every shot against this."
          className={inputClass}
        />
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),18rem))] gap-3">
      <div>
        <label htmlFor={`${idPrefix}-checkin`} className="block text-xs text-port-text-muted mb-1">Cast &amp; Sets check-in</label>
        <select
          id={`${idPrefix}-checkin`}
          value={draft.castAndSetsCheckin || 'review'}
          onChange={(e) => onChange({ castAndSetsCheckin: e.target.value })}
          className={inputClass}
        >
          <option value="review">Stop for my review</option>
          <option value="auto">Auto-approve</option>
        </select>
        <p className="text-[11px] text-port-text-muted mt-1">Footage-led planning builds a cast &amp; sets sheet for your feedback. Code-first plans skip image batches unless a selected performance shot needs references.</p>
      </div>
      <div>
        <label htmlFor={`${idPrefix}-budget`} className="block text-xs text-port-text-muted mb-1">Budget cap (USD)</label>
        <input
          id={`${idPrefix}-budget`}
          type="number"
          min="0"
          step="1"
          inputMode="decimal"
          value={draft.budget}
          onChange={(e) => onChange({ budget: e.target.value })}
          placeholder="No cap"
          className={inputClass}
        />
      </div>
      </div>
    </div>
  );
}
