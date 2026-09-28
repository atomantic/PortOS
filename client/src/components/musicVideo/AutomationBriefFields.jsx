import { MUSIC_VIDEO_AUTOMATION_TOOLS } from '../../../../server/lib/musicVideoAutomation.js';

const GROUPS = [['image', 'Image'], ['video', 'Video'], ['code', 'Code']];
const inputClass = 'w-full min-w-0 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm';

// Free (local) tools — the default pick for a new autopilot brief, so nothing
// metered is spent until the director opts in.
export const DEFAULT_AUTOMATION_TOOLS = MUSIC_VIDEO_AUTOMATION_TOOLS.filter((t) => !t.metered).map((t) => t.id);

// Form draft ↔ wire shape. The draft keeps budget as the raw input string so
// an empty field reads as "no cap" rather than 0.
export const automationDraftFrom = (automation) => ({
  tools: automation?.tools ?? DEFAULT_AUTOMATION_TOOLS,
  guidance: automation?.guidance ?? '',
  budget: automation?.budgetUsd != null ? String(automation.budgetUsd) : '',
});
export const automationFromDraft = (draft) => {
  const budget = Number.parseFloat(draft.budget);
  return {
    tools: draft.tools,
    guidance: draft.guidance.trim(),
    budgetUsd: draft.budget.trim() && Number.isFinite(budget) && budget >= 0 ? budget : null,
  };
};

/** Tool picker + guidance + budget for an automation-first music video. */
export default function AutomationBriefFields({ idPrefix, draft, onChange }) {
  const picked = new Set(draft.tools);
  const allPicked = picked.size === MUSIC_VIDEO_AUTOMATION_TOOLS.length;
  const toggle = (id) => onChange({
    tools: MUSIC_VIDEO_AUTOMATION_TOOLS.map((t) => t.id).filter((t) => (t === id ? !picked.has(t) : picked.has(t))),
  });
  return (
    <div className="space-y-3 min-w-0">
      <fieldset className="min-w-0" aria-labelledby={`${idPrefix}-tools-label`}>
        <div className="flex items-center justify-between gap-2 mb-1">
          <span id={`${idPrefix}-tools-label`} className="text-xs text-port-text-muted">Tools the agent may use</span>
          <button
            type="button"
            onClick={() => onChange({ tools: allPicked ? [] : MUSIC_VIDEO_AUTOMATION_TOOLS.map((t) => t.id) })}
            className="text-xs text-port-accent min-h-[44px] sm:min-h-0"
          >
            {allPicked ? 'Clear all' : 'Select all'}
          </button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {GROUPS.map(([group, label]) => (
            <div key={group} className="border border-port-border rounded p-2 min-w-0">
              <div className="text-[11px] uppercase tracking-wide text-port-text-muted mb-1">{label}</div>
              {MUSIC_VIDEO_AUTOMATION_TOOLS.filter((t) => t.group === group).map((tool) => (
                <label key={tool.id} htmlFor={`${idPrefix}-tool-${tool.id}`} className="flex items-center gap-2 text-sm py-0.5 min-h-[32px] sm:min-h-0">
                  <input
                    id={`${idPrefix}-tool-${tool.id}`}
                    type="checkbox"
                    checked={picked.has(tool.id)}
                    onChange={() => toggle(tool.id)}
                  />
                  <span className="min-w-0 break-words">{tool.label}</span>
                  {tool.metered && <span className="ml-auto text-[10px] text-port-warning" title="Spends money or remote quota"><span aria-hidden="true">$</span><span className="sr-only">(metered)</span></span>}
                </label>
              ))}
            </div>
          ))}
        </div>
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
      <div className="max-w-[12rem]">
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
  );
}
