/**
 * One catalog row in the Editorial Checks page (#1285): a registered editorial
 * check with its enable toggle, kind/severity badges, and an expandable config
 * form built from the check's `configFields` render descriptors.
 *
 * Presentational — all persistence is lifted to PipelineEditorialChecks:
 *   onToggle(checkId, nextEnabled)            → optimistic enable/disable PATCH
 *   onConfigSave(checkId, nextConfig)         → PATCH the global config blob (Promise)
 *   onSeveritySave(checkId, severity|null)    → PATCH the per-check severity override
 *                                               (#1596); `null` clears it back to the
 *                                               registry default. Optional — the
 *                                               selector only renders when wired.
 *   onSeriesConfigSave(checkId, patch)        → merge a PARTIAL per-series override
 *                                               ({ [key]: value }) for this check (#1591);
 *                                               pass `null` to clear the whole override.
 *                                               Sending only the changed key (not the
 *                                               whole config) lets the page compose rapid
 *                                               multi-field edits without dropping one.
 * The card only owns the in-progress *input* draft; committed values come back
 * down through `check.config` (global) and `seriesConfig` (the selected series'
 * override for this check, when a series is selected).
 */
import { memo, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Pencil, Sliders, Trash2 } from 'lucide-react';
import ToggleSwitch from '../../ToggleSwitch';
import CheckKindBadge from './CheckKindBadge';

const SEVERITY_BADGE = {
  high: 'bg-rose-500/15 text-rose-300',
  medium: 'bg-amber-500/15 text-amber-300',
  low: 'bg-gray-500/15 text-gray-300',
};
const SEVERITY_LEVELS = ['high', 'medium', 'low'];

function ConfigField({ checkId, field, value, disabled, onCommit, resetNonce = 0 }) {
  const inputId = `cfg-${checkId}-${field.key}`;
  const [draft, setDraft] = useState(value);
  // Re-seed when the committed value changes underneath us (e.g. save resolved),
  // OR when `resetNonce` bumps — used to revert the draft to the persisted value
  // after a failed save, so the input never lingers on an unsaved threshold the
  // runner won't use.
  useEffect(() => { setDraft(value); }, [value, resetNonce]);

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

function EditorialCheckCard({
  check, saving = false, onToggle, onConfigSave, onSeveritySave, onEdit, onDelete,
  seriesId = '', seriesConfig = null, seriesSaving = false, seriesResetNonce = 0, onSeriesConfigSave,
}) {
  const [expanded, setExpanded] = useState(false);
  const [seriesExpanded, setSeriesExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const hasConfig = Array.isArray(check.configFields) && check.configFields.length > 0;
  const isCustom = !!check.isCustom;
  // Effective severity (#1596): the stored override or the registry default.
  // `severityOverride` is the raw stored level (null when defaulting), so the
  // selector can show "Default" distinctly from a level pinned to that value.
  const effectiveSeverity = check.severity || check.severityDefault;
  const canSetSeverity = typeof onSeveritySave === 'function';
  // A per-series override panel is only meaningful when a series is selected, the
  // check is tunable, and the parent wired a save handler (#1591).
  const canOverride = hasConfig && !!seriesId && typeof onSeriesConfigSave === 'function';
  const hasSeriesOverride = !!seriesConfig && Object.keys(seriesConfig).length > 0;

  return (
    <div className="rounded-lg border border-port-border bg-port-card p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium text-gray-100">{check.label}</span>
            <CheckKindBadge kind={check.kind} />
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded ${SEVERITY_BADGE[effectiveSeverity] || SEVERITY_BADGE.low}`}
              title={check.severityOverride ? `Overridden — default is ${check.severityDefault}` : 'Default severity'}
            >
              {effectiveSeverity}{check.severityOverride ? '*' : ''}
            </span>
            {isCustom ? (
              <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-emerald-500/30 bg-emerald-500/15 text-emerald-300">
                custom
              </span>
            ) : null}
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

      {canSetSeverity ? (
        <div className="flex items-center gap-2">
          <label htmlFor={`sev-${check.id}`} className="text-[11px] text-gray-400">Severity</label>
          <select
            id={`sev-${check.id}`}
            value={check.severityOverride || ''}
            disabled={saving}
            aria-label={`Severity for ${check.label}`}
            onChange={(e) => onSeveritySave(check.id, e.target.value || null)}
            className="rounded border border-port-border bg-port-bg px-1.5 py-0.5 text-[11px] text-gray-100 focus:border-port-accent focus:outline-none disabled:opacity-50"
          >
            <option value="">Default ({check.severityDefault})</option>
            {SEVERITY_LEVELS.map((level) => (
              <option key={level} value={level}>{level}</option>
            ))}
          </select>
        </div>
      ) : null}

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

      {canOverride ? (
        <div className="border-t border-port-border/60 pt-2">
          <button
            type="button"
            onClick={() => setSeriesExpanded((v) => !v)}
            className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-200"
            aria-expanded={seriesExpanded}
          >
            {seriesExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <Sliders size={12} />
            Override for this series
            {hasSeriesOverride ? (
              <span className="ml-1 rounded bg-port-accent/15 px-1.5 py-0.5 text-[10px] text-port-accent">active</span>
            ) : null}
          </button>
          {seriesExpanded ? (
            <div className="mt-2 space-y-2.5">
              <p className="text-[11px] text-gray-500">
                Tune this check for the selected series only. Untouched fields fall through to the global value above.
              </p>
              {check.configFields.map((field) => (
                <ConfigField
                  // Prefix the checkId so the per-series input ids never collide
                  // with the global form's (`cfg-<checkId>-<key>`).
                  key={field.key}
                  checkId={`series-${check.id}`}
                  field={field}
                  value={seriesConfig?.[field.key] ?? check.config?.[field.key]}
                  disabled={seriesSaving}
                  resetNonce={seriesResetNonce}
                  // Send ONLY the changed key — the page merges it onto the freshest
                  // server-confirmed map, so a rapid second field edit (built before the
                  // first save lands) can't drop the first via a stale full-config snapshot.
                  onCommit={(key, val) => onSeriesConfigSave(check.id, { [key]: val })}
                />
              ))}
              {hasSeriesOverride ? (
                <button
                  type="button"
                  onClick={() => onSeriesConfigSave(check.id, null)}
                  disabled={seriesSaving}
                  className="inline-flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-200 disabled:opacity-50"
                >
                  {seriesSaving ? <Loader2 size={12} className="animate-spin" /> : null}
                  Reset to global
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {isCustom && (onEdit || onDelete) ? (
        <div className="flex items-center justify-end gap-2 border-t border-port-border/60 pt-2">
          {confirmDelete ? (
            <>
              <span className="mr-auto text-[11px] text-gray-400">Delete this check?</span>
              <button
                type="button"
                onClick={() => { setConfirmDelete(false); onDelete?.(check.id); }}
                disabled={saving}
                className="inline-flex items-center gap-1 rounded bg-port-error/20 px-2 py-1 text-[11px] text-rose-300 hover:bg-port-error/30 disabled:opacity-50"
              >
                <Trash2 size={12} /> Delete
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="rounded border border-port-border px-2 py-1 text-[11px] text-gray-300 hover:bg-port-border/40"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              {onEdit ? (
                <button
                  type="button"
                  onClick={() => onEdit(check.id)}
                  disabled={saving}
                  className="inline-flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-200 disabled:opacity-50"
                >
                  <Pencil size={12} /> Edit
                </button>
              ) : null}
              {onDelete ? (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  disabled={saving}
                  className="inline-flex items-center gap-1 text-[11px] text-rose-400 hover:text-rose-300 disabled:opacity-50"
                >
                  <Trash2 size={12} /> Delete
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

// Memoized so a parent re-render (run/selection state ticks) only re-renders the
// cards whose own row changed — onToggle/onConfigSave are stable (useCallback).
export default memo(EditorialCheckCard);
