/**
 * Author / edit a user-defined editorial check (#1346): name + prompt + scope +
 * category + severity, no code change. Presentational — persistence is lifted to
 * PipelineEditorialChecks (onSave returns a Promise; the form shows a spinner and
 * stays open until it resolves). The user only describes WHAT to look for; the
 * JSON output contract is enforced server-side, so there's no contract field.
 */
import { useState } from 'react';
import { Loader2, Save, X } from 'lucide-react';
import { CHECK_SCOPE_ORDER, scopeLabel } from '../../../lib/editorialChecks';

// Scopes mirror the server registry's CHECK_SCOPES (via the client scope-order
// catalog); severities have no client mirror so they live here.
const SCOPES = CHECK_SCOPE_ORDER;
const SEVERITIES = ['high', 'medium', 'low'];

const blankDraft = {
  label: '',
  description: '',
  prompt: '',
  scope: 'issue',
  category: 'custom',
  severityDefault: 'medium',
};

// Pull only the editable fields off an existing resolved check row so editing a
// custom check prefills without dragging along id/config/enabled.
const draftFromCheck = (check) => ({
  label: check?.label ?? '',
  description: check?.description ?? '',
  prompt: check?.prompt ?? '',
  scope: SCOPES.includes(check?.scope) ? check.scope : 'issue',
  category: check?.category || 'custom',
  severityDefault: SEVERITIES.includes(check?.severityDefault) ? check.severityDefault : 'medium',
});

export default function EditorialCustomCheckForm({ check = null, saving = false, onSave, onCancel }) {
  const isEdit = !!check;
  const [draft, setDraft] = useState(() => (isEdit ? draftFromCheck(check) : { ...blankDraft }));
  const set = (key, value) => setDraft((d) => ({ ...d, [key]: value }));

  const canSave = draft.label.trim().length > 0 && draft.prompt.trim().length > 0 && !saving;

  const submit = (e) => {
    e.preventDefault();
    if (!canSave) return;
    onSave({
      label: draft.label.trim(),
      description: draft.description.trim(),
      prompt: draft.prompt.trim(),
      scope: draft.scope,
      category: draft.category.trim() || 'custom',
      severityDefault: draft.severityDefault,
    });
  };

  const fieldClass = 'w-full rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm text-gray-100 focus:border-port-accent focus:outline-none';

  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border border-port-accent/40 bg-port-card p-3">
      <h3 className="text-sm font-semibold text-gray-100">
        {isEdit ? 'Edit custom check' : 'New custom check'}
      </h3>

      <div className="flex flex-col gap-1">
        <label htmlFor="cc-label" className="text-xs text-gray-300">Name</label>
        <input
          id="cc-label"
          type="text"
          value={draft.label}
          maxLength={120}
          onChange={(e) => set('label', e.target.value)}
          placeholder="e.g. Anachronistic technology"
          className={fieldClass}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="cc-description" className="text-xs text-gray-300">Description <span className="text-gray-500">(optional)</span></label>
        <input
          id="cc-description"
          type="text"
          value={draft.description}
          maxLength={500}
          onChange={(e) => set('description', e.target.value)}
          placeholder="A short summary shown in the catalog"
          className={fieldClass}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="cc-prompt" className="text-xs text-gray-300">What to look for</label>
        <textarea
          id="cc-prompt"
          value={draft.prompt}
          rows={5}
          maxLength={8000}
          onChange={(e) => set('prompt', e.target.value)}
          placeholder="Describe what the LLM should flag in the manuscript. The JSON output format is added automatically."
          className={`${fieldClass} resize-y font-mono text-xs`}
        />
        <p className="text-[11px] text-gray-500">
          Just describe the problem to catch — PortOS appends the manuscript and the required findings JSON format.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="cc-scope" className="text-xs text-gray-300">Scope</label>
          <select id="cc-scope" value={draft.scope} onChange={(e) => set('scope', e.target.value)} className={fieldClass}>
            {SCOPES.map((s) => <option key={s} value={s}>{scopeLabel(s)}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="cc-category" className="text-xs text-gray-300">Category</label>
          <input
            id="cc-category"
            type="text"
            value={draft.category}
            maxLength={60}
            onChange={(e) => set('category', e.target.value)}
            className={fieldClass}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="cc-severity" className="text-xs text-gray-300">Default severity</label>
          <select id="cc-severity" value={draft.severityDefault} onChange={(e) => set('severityDefault', e.target.value)} className={fieldClass}>
            {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center gap-1 rounded border border-port-border px-3 py-1.5 text-sm text-gray-300 hover:bg-port-border/40"
        >
          <X size={14} /> Cancel
        </button>
        <button
          type="submit"
          disabled={!canSave}
          className="inline-flex items-center gap-1.5 rounded bg-port-accent px-3 py-1.5 text-sm text-white hover:bg-port-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {isEdit ? 'Save changes' : 'Create check'}
        </button>
      </div>
    </form>
  );
}
