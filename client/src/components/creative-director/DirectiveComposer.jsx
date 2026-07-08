import { DELIVERABLE_OPTIONS } from '../../lib/creativeDirectorPlan.js';

/**
 * Directive composer fields (CDO Phase 4, #2186) — the studio "brief" a directive
 * project turns into a plan: goal text, a deliverable checklist, target
 * universe/series pickers, and a budget cap. Controlled + presentational: all
 * state is hoisted into the host (the list-page create form or the detail-page
 * "convert to directive" Drawer) so the Drawer's per-tab remount can't reset it
 * (the CLAUDE.md Drawer state-hoisting rule), and the host owns the submit
 * affordances (Create / Preview plan / Cancel).
 *
 * `directive` shape mirrors the server schema:
 *   { goal, deliverables: string[], constraints: { universeId, seriesId, budgetCap } }
 *
 * @param {{
 *   directive: object,
 *   onChange: (next: object) => void,
 *   universes?: Array<{id,name}>,
 *   series?: Array<{id,name,title?}>,
 *   idPrefix?: string,
 *   disabled?: boolean,
 * }} props
 */
export default function DirectiveComposer({
  directive,
  onChange,
  universes = [],
  series = [],
  idPrefix = 'directive',
  disabled = false,
}) {
  const goal = directive?.goal || '';
  const deliverables = Array.isArray(directive?.deliverables) ? directive.deliverables : [];
  const constraints = directive?.constraints || {};

  const patch = (next) => onChange({
    ...directive,
    ...next,
    constraints: { ...constraints, ...(next.constraints || {}) },
  });

  const toggleDeliverable = (id) => {
    const set = new Set(deliverables);
    if (set.has(id)) set.delete(id); else set.add(id);
    patch({ deliverables: Array.from(set) });
  };

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor={`${idPrefix}-goal`} className="block text-sm text-port-text-muted mb-1">
          Goal
        </label>
        <textarea
          id={`${idPrefix}-goal`}
          value={goal}
          disabled={disabled}
          onChange={(e) => patch({ goal: e.target.value })}
          placeholder="Produce a 6-issue noir comic in universe X, with covers, a polished manuscript, and a teaser trailer…"
          className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm h-28 font-mono disabled:opacity-50"
          maxLength={5000}
        />
      </div>

      <fieldset className="border-0 p-0 m-0">
        <legend className="text-sm text-port-text-muted mb-1.5">Deliverables</legend>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {DELIVERABLE_OPTIONS.map((opt) => {
            const checked = deliverables.includes(opt.id);
            return (
              <label
                key={opt.id}
                htmlFor={`${idPrefix}-deliverable-${opt.id}`}
                className={`flex items-center gap-2 text-sm px-2 py-1.5 rounded border cursor-pointer ${
                  checked ? 'border-port-accent bg-port-accent/10 text-port-accent' : 'border-port-border text-port-text-muted'
                } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <input
                  id={`${idPrefix}-deliverable-${opt.id}`}
                  type="checkbox"
                  className="accent-port-accent"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => toggleDeliverable(opt.id)}
                />
                {opt.label}
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor={`${idPrefix}-universe`} className="block text-sm text-port-text-muted mb-1">
            Target universe
          </label>
          <select
            id={`${idPrefix}-universe`}
            value={constraints.universeId || ''}
            disabled={disabled}
            onChange={(e) => patch({ constraints: { universeId: e.target.value || null } })}
            className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm disabled:opacity-50"
          >
            <option value="">— none —</option>
            {universes.map((u) => (
              <option key={u.id} value={u.id}>{u.name || u.id}</option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor={`${idPrefix}-series`} className="block text-sm text-port-text-muted mb-1">
            Target series
          </label>
          <select
            id={`${idPrefix}-series`}
            value={constraints.seriesId || ''}
            disabled={disabled}
            onChange={(e) => patch({ constraints: { seriesId: e.target.value || null } })}
            className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm disabled:opacity-50"
          >
            <option value="">— none —</option>
            {series.map((s) => (
              <option key={s.id} value={s.id}>{s.title || s.name || s.id}</option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label htmlFor={`${idPrefix}-budget`} className="block text-sm text-port-text-muted mb-1">
          Budget cap (autonomous actions/day — blank = use the shared default)
        </label>
        <input
          id={`${idPrefix}-budget`}
          type="number"
          min={0}
          max={100000}
          value={constraints.budgetCap ?? ''}
          disabled={disabled}
          onChange={(e) => {
            const v = e.target.value;
            patch({ constraints: { budgetCap: v === '' ? null : Math.max(0, Math.floor(Number(v)) || 0) } });
          }}
          placeholder="e.g. 50"
          className="w-full sm:w-48 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm disabled:opacity-50"
        />
      </div>
    </div>
  );
}
