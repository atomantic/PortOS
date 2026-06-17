/**
 * One catalog row in the Editorial Checks page (#1285): a registered editorial
 * check with its enable toggle, kind/severity badges, and an expandable config
 * form built from the check's `configFields` render descriptors.
 *
 * Presentational — all persistence is lifted to PipelineEditorialChecks:
 *   onToggle(checkId, nextEnabled)      → optimistic enable/disable PATCH
 *   onConfigSave(checkId, nextConfig)   → PATCH the full config blob (Promise)
 * The card only owns the in-progress *input* draft; committed values come back
 * down through `check.config`.
 */
import { memo, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Sliders } from 'lucide-react';
import ToggleSwitch from '../../ToggleSwitch';

const KIND_BADGE = {
  deterministic: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  llm: 'bg-purple-500/15 text-purple-300 border-purple-500/30',
};
const SEVERITY_BADGE = {
  high: 'bg-rose-500/15 text-rose-300',
  medium: 'bg-amber-500/15 text-amber-300',
  low: 'bg-gray-500/15 text-gray-300',
};

function ConfigField({ checkId, field, value, disabled, onCommit }) {
  const inputId = `cfg-${checkId}-${field.key}`;
  const [draft, setDraft] = useState(value);
  // Re-seed when the committed value changes underneath us (e.g. save resolved).
  useEffect(() => { setDraft(value); }, [value]);

  if (field.type === 'boolean') {
    return (
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={inputId} className="text-xs text-gray-300">{field.label}</label>
        <ToggleSwitch
          size="sm"
          enabled={!!draft}
          disabled={disabled}
          ariaLabel={field.label}
          onChange={() => { const next = !draft; setDraft(next); onCommit(field.key, next); }}
        />
      </div>
    );
  }

  const commit = () => {
    let next = draft;
    if (field.type === 'number') {
      next = Number(draft);
      if (!Number.isFinite(next)) { setDraft(value); return; }
      if (typeof field.min === 'number') next = Math.max(field.min, next);
      if (typeof field.max === 'number') next = Math.min(field.max, next);
      setDraft(next);
    }
    if (next !== value) onCommit(field.key, next);
  };

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-xs text-gray-300">{field.label}</label>
      <input
        id={inputId}
        type={field.type === 'number' ? 'number' : 'text'}
        value={draft ?? ''}
        min={field.min}
        max={field.max}
        step={field.step}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
        className="w-full rounded border border-port-border bg-port-bg px-2 py-1 text-sm text-gray-100 focus:border-port-accent focus:outline-none disabled:opacity-50"
      />
      {field.help ? <p className="text-[11px] text-gray-500">{field.help}</p> : null}
    </div>
  );
}

function EditorialCheckCard({ check, saving = false, onToggle, onConfigSave }) {
  const [expanded, setExpanded] = useState(false);
  const hasConfig = Array.isArray(check.configFields) && check.configFields.length > 0;

  return (
    <div className="rounded-lg border border-port-border bg-port-card p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium text-gray-100">{check.label}</span>
            <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${KIND_BADGE[check.kind] || KIND_BADGE.deterministic}`}>
              {check.kind === 'llm' ? 'LLM' : 'rule'}
            </span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${SEVERITY_BADGE[check.severityDefault] || SEVERITY_BADGE.low}`}>
              {check.severityDefault}
            </span>
          </div>
          <p className="text-xs text-gray-400">{check.description}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {saving ? <Loader2 size={14} className="animate-spin text-gray-500" /> : null}
          <ToggleSwitch
            enabled={check.enabled}
            disabled={saving}
            ariaLabel={`${check.enabled ? 'Disable' : 'Enable'} ${check.label}`}
            onChange={() => onToggle(check.id, !check.enabled)}
          />
        </div>
      </div>

      {hasConfig ? (
        <div className="border-t border-port-border/60 pt-2">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-200"
            aria-expanded={expanded}
          >
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <Sliders size={12} />
            Configure ({check.configFields.length})
          </button>
          {expanded ? (
            <div className="mt-2 space-y-2.5">
              {check.configFields.map((field) => (
                <ConfigField
                  key={field.key}
                  checkId={check.id}
                  field={field}
                  value={check.config?.[field.key]}
                  disabled={saving}
                  onCommit={(key, val) => onConfigSave(check.id, { ...check.config, [key]: val })}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// Memoized so a parent re-render (run/selection state ticks) only re-renders the
// cards whose own row changed — onToggle/onConfigSave are stable (useCallback).
export default memo(EditorialCheckCard);
