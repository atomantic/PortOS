/**
 * Author / edit a user-defined editorial check (#1346): name + prompt + scope +
 * category + severity, no code change. Presentational — persistence is lifted to
 * PipelineEditorialChecks (onSave returns a Promise; the form shows a spinner and
 * stays open until it resolves). The user only describes WHAT to look for; the
 * JSON output contract is enforced server-side, so there's no contract field.
 *
 * Dry-run preview (#1607): when the parent supplies `onPreview` (an async fn that
 * runs the DRAFT against the selected series WITHOUT saving) and `canPreview`
 * (a series is selected), a "Preview on this series" button runs the draft and
 * renders sample findings inline — so the author can judge noise/scope before
 * committing the check to the catalog.
 */
import { useEffect, useRef, useState } from 'react';
import { FlaskConical, Loader2, Save, X } from 'lucide-react';
import { CHECK_SCOPE_ORDER, scopeLabel, SEVERITY_BADGE_CLASSES } from '../../../lib/editorialChecks';

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

export default function EditorialCustomCheckForm({ check = null, saving = false, onSave, onCancel, onPreview = null, canPreview = false, previewTarget = null }) {
  const isEdit = !!check;
  const [draft, setDraft] = useState(() => (isEdit ? draftFromCheck(check) : { ...blankDraft }));

  // Preview (#1607) — transient dry-run state, local to the form (it never
  // persists). A preview describes ONE exact draft+series; it goes stale the
  // moment either changes, so we clear it on any edit and invalidate any
  // in-flight request via a generation ref (a slow response for the old draft/
  // series must not overwrite the UI after the user moved on).
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const previewReqRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Invalidate + clear any preview when the draft or the target series changes.
  const invalidatePreview = () => {
    previewReqRef.current += 1;
    setPreview(null);
    setPreviewError('');
    setPreviewing(false);
  };
  // A draft edit invalidates a prior/in-flight preview (it described a different draft).
  const set = (key, value) => {
    setDraft((d) => ({ ...d, [key]: value }));
    invalidatePreview();
  };
  // The form stays mounted across a series switch (only new↔edit remounts via the
  // key), so reset the preview when the target series changes too.
  useEffect(() => { invalidatePreview(); }, [previewTarget]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasRequiredFields = draft.label.trim().length > 0 && draft.prompt.trim().length > 0;
  const canSave = hasRequiredFields && !saving;

  // Shared payload so submit and preview send the IDENTICAL draft shape — a
  // preview that diverged from what gets saved would mislead the author.
  const buildPayload = () => ({
    label: draft.label.trim(),
    description: draft.description.trim(),
    prompt: draft.prompt.trim(),
    scope: draft.scope,
    category: draft.category.trim() || 'custom',
    severityDefault: draft.severityDefault,
  });

  const canPreviewNow = !!onPreview && canPreview && hasRequiredFields && !previewing && !saving;

  const runPreview = () => {
    if (!canPreviewNow) return;
    const reqId = (previewReqRef.current += 1);
    // Gate every state write on staleness (this request still current) AND mount
    // — a draft edit / series switch / unmount during the request drops its result.
    const isCurrent = () => mountedRef.current && reqId === previewReqRef.current;
    setPreviewing(true);
    setPreviewError('');
    setPreview(null);
    Promise.resolve(onPreview(buildPayload()))
      .then((res) => { if (isCurrent()) setPreview(res || { findings: [] }); })
      .catch((err) => { if (isCurrent()) setPreviewError(err?.message || 'Preview failed'); })
      .finally(() => { if (isCurrent()) setPreviewing(false); });
  };

  const submit = (e) => {
    e.preventDefault();
    if (!canSave) return;
    onSave(buildPayload());
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

      <div className="flex flex-wrap items-center justify-end gap-2">
        {onPreview ? (
          <button
            type="button"
            onClick={runPreview}
            disabled={!canPreviewNow}
            title={canPreview ? 'Run this draft against the selected series without saving' : 'Select a series above to preview'}
            className="mr-auto inline-flex items-center gap-1.5 rounded border border-port-border px-3 py-1.5 text-sm text-gray-300 hover:bg-port-border/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {previewing ? <Loader2 size={14} className="animate-spin" /> : <FlaskConical size={14} />}
            Preview on this series
          </button>
        ) : null}
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

      {/* Preview hint: only when previewing is offered but no series is selected. */}
      {onPreview && !canPreview ? (
        <p className="text-[11px] text-gray-500">Select a series above to preview this check before saving.</p>
      ) : null}

      {/* Dry-run results (#1607) — sample findings only; nothing is persisted. */}
      {previewError ? (
        <p className="rounded border border-port-error/40 bg-port-error/10 p-2 text-xs text-port-error" role="alert">{previewError}</p>
      ) : null}
      {preview ? <PreviewResults preview={preview} /> : null}
    </form>
  );
}

// Renders the transient dry-run outcome: the gate-skip / empty / invalid notices,
// or the sample findings list. Pure presentational — the findings are never
// seeded into the review (#1607).
function PreviewResults({ preview }) {
  if (preview.invalid) {
    return <p className="rounded border border-port-border bg-port-bg p-2 text-xs text-gray-400">Fill in a name and prompt to preview this check.</p>;
  }
  if (preview.skipped) {
    return <p className="rounded border border-port-border bg-port-bg p-2 text-xs text-gray-400">Nothing to preview yet — this series has no manuscript content.</p>;
  }
  const findings = Array.isArray(preview.findings) ? preview.findings : [];
  if (findings.length === 0) {
    return <p className="rounded border border-port-success/40 bg-port-success/10 p-2 text-xs text-port-success">No sample findings — this check flagged nothing on the current manuscript.</p>;
  }
  return (
    <div className="space-y-2 rounded-lg border border-port-border bg-port-bg p-2">
      <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500">
        Sample findings ({findings.length}) — preview only, not saved
      </p>
      <ul className="space-y-2">
        {findings.map((f, i) => (
          <li key={i} className="rounded border border-port-border/70 bg-port-card p-2 text-xs">
            <div className="flex items-center gap-2">
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${SEVERITY_BADGE_CLASSES[f.severity] || SEVERITY_BADGE_CLASSES.medium}`}>
                {f.severity || 'medium'}
              </span>
              {f.location ? <span className="truncate text-gray-400">{f.location}</span> : null}
            </div>
            {f.problem ? <p className="mt-1 text-gray-200">{f.problem}</p> : null}
            {f.suggestion ? <p className="mt-1 text-gray-400"><span className="text-gray-500">Fix:</span> {f.suggestion}</p> : null}
            {f.anchorQuote ? <p className="mt-1 border-l-2 border-port-border pl-2 italic text-gray-500">“{f.anchorQuote}”</p> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
