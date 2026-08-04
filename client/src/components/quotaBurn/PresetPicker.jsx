/**
 * Prompt-preset picker for `agent-prompt` burn jobs.
 *
 * A burn window is spent unattended, so the quality of the work prompt IS the
 * quality of the feature — and a blank textarea labeled "what should this
 * provider spend its remaining quota on?" is a hard question to answer well at
 * configuration time. The server ships worked answers
 * (`server/lib/quotaBurnPresets.js`); this is how they get picked.
 *
 * A one-shot ACTION, not a bound field: the select snaps back to its placeholder
 * after firing, because the job it seeded is editable afterward and nothing on
 * disk records which preset it came from — leaving a preset name selected would
 * claim the row still matches text the user may have rewritten.
 */

import { inputClass } from './fields';

export default function PresetPicker({ id, label, presets, jobType = null, onPick, hint }) {
  // Presets declare the job type they seed, so a plan with several job types
  // only ever offers the ones that can apply here.
  const rows = (presets || []).filter((preset) => !jobType || preset.jobType === jobType);
  if (!rows.length) return null;

  return (
    <label htmlFor={id} className="block text-xs text-gray-400">
      {label}
      <select
        id={id}
        className={inputClass}
        value=""
        onChange={(event) => {
          const picked = rows.find((preset) => preset.id === event.target.value);
          if (picked) onPick(picked);
        }}
      >
        <option value="">Choose a preset…</option>
        {rows.map((preset) => (
          <option key={preset.id} value={preset.id} title={preset.summary}>
            {preset.label} — {preset.summary}
          </option>
        ))}
      </select>
      {hint && <span className="block mt-1 text-[11px] text-gray-500">{hint}</span>}
    </label>
  );
}
