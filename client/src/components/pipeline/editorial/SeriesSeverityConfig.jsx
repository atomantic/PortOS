/**
 * Per-series severity config panel (#1616) for the Editorial Checks page.
 *
 * Two per-series overrides, both saved through the parent's serialized silent
 * save tail (`onSaveField(field, value)`):
 *
 *  - SEVERITY WEIGHTS — the health-score penalty weights (high/medium/low). The
 *    defaults are high:12 / medium:5 / low:1; an unset series shows the defaults.
 *    A weight input round-trips a single key; an empty input clears that key back
 *    to the default (an absent key in the stored override → default applies).
 *  - BLOCKING SEVERITIES — which severities count as blocking for each autopilot
 *    gate (arc, beatContinuity, editorial). Checkboxes over high/medium/low; an
 *    unset gate shows the gate's default set. Unchecking ALL boxes for a gate
 *    persists an explicit empty array = "nothing blocks this gate" (distinct from
 *    "unset → defaults"), so the gate is honored as-is on the next run.
 *
 * Display always shows the EFFECTIVE (override-merged-with-default) values, and
 * saves merge the touched key onto the series' STORED override (not the merged
 * effective values) so an untouched key/gate stays absent and keeps tracking the
 * default. Mirrors the server's mergeSeverityWeights / resolveBlockingSet
 * semantics so the UI never lies about what the autopilot will do.
 */
import { useEffect, useState } from 'react';

export const DEFAULT_SEVERITY_WEIGHTS = { high: 12, medium: 5, low: 1 };
export const DEFAULT_BLOCKING_SEVERITIES = {
  arc: ['high', 'medium'],
  beatContinuity: ['high', 'medium'],
  editorial: ['high'],
};
const SEVERITIES = ['high', 'medium', 'low'];
const SEVERITY_LABELS = { high: 'High', medium: 'Medium', low: 'Low' };
const GATES = [
  { id: 'arc', label: 'Arc verification' },
  { id: 'beatContinuity', label: 'Beat continuity' },
  { id: 'editorial', label: 'Editorial review' },
];

const isNonNegNumber = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

// Effective weight for a severity: the stored override when it's a valid
// non-negative number, else the frozen default. Mirrors mergeSeverityWeights.
function effectiveWeight(override, sev) {
  const raw = override && typeof override === 'object' ? override[sev] : undefined;
  return isNonNegNumber(raw) ? raw : DEFAULT_SEVERITY_WEIGHTS[sev];
}

// Effective blocking set for a gate: the stored array when present (even empty),
// else the gate's default. Mirrors resolveBlockingSet (Array.isArray first).
function effectiveBlocking(override, gate) {
  const raw = override && typeof override === 'object' ? override[gate] : undefined;
  if (Array.isArray(raw)) return raw.filter((s) => SEVERITIES.includes(s));
  return DEFAULT_BLOCKING_SEVERITIES[gate];
}

export default function SeriesSeverityConfig({ series, onSaveField, saving = false }) {
  const weightsOverride = series && typeof series.severityWeights === 'object' && series.severityWeights
    ? series.severityWeights : {};
  const blockingOverride = series && typeof series.blockingSeverities === 'object' && series.blockingSeverities
    ? series.blockingSeverities : {};

  // Draft state for the number inputs so typing doesn't fight the controlled
  // value. Re-seeded from the persisted effective values whenever the series id
  // or its stored weights change (covers a failed-save revert too — the parent
  // leaves the series record untouched on failure, so the effective values are
  // still the persisted ones).
  const seriesId = series?.id || '';
  const [draft, setDraft] = useState({});
  useEffect(() => {
    setDraft({
      high: String(effectiveWeight(weightsOverride, 'high')),
      medium: String(effectiveWeight(weightsOverride, 'medium')),
      low: String(effectiveWeight(weightsOverride, 'low')),
    });
  }, [seriesId, JSON.stringify(weightsOverride)]);

  if (!series) return null;

  // Persist a single weight key. An empty/invalid input CLEARS the key (absent →
  // default); a valid number sets it. Built onto the STORED override so untouched
  // keys stay absent.
  const commitWeight = (sev, rawText) => {
    const next = { ...weightsOverride };
    const trimmed = (rawText ?? '').trim();
    if (trimmed === '') {
      delete next[sev];
    } else {
      const num = Number(trimmed);
      if (!Number.isFinite(num) || num < 0) {
        // Invalid → revert the draft to the persisted effective value, no save.
        setDraft((d) => ({ ...d, [sev]: String(effectiveWeight(weightsOverride, sev)) }));
        return;
      }
      next[sev] = num;
    }
    // No-op guard: if nothing actually changed vs the stored override, skip.
    if (JSON.stringify(next) === JSON.stringify(weightsOverride)) return;
    onSaveField('severityWeights', next);
  };

  // Toggle one severity for one gate. Built onto the STORED override so an
  // untouched gate stays absent (tracks the default). An explicit empty array is
  // preserved (= nothing blocks this gate).
  const toggleBlocking = (gate, sev) => {
    const current = effectiveBlocking(blockingOverride, gate);
    const nextSet = current.includes(sev)
      ? current.filter((s) => s !== sev)
      : [...current, sev];
    // Order canonically (high → low) for a stable persisted shape.
    const ordered = SEVERITIES.filter((s) => nextSet.includes(s));
    const next = { ...blockingOverride, [gate]: ordered };
    onSaveField('blockingSeverities', next);
  };

  return (
    <section className="space-y-3 rounded border border-port-border bg-port-card/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-200">Severity tuning (this series)</h3>
        {saving ? <span className="text-xs text-gray-500">Saving…</span> : null}
      </div>

      {/* Severity weights */}
      <div className="space-y-1.5">
        <p className="text-xs text-gray-400">
          Health-score weights — points deducted per open finding. Blank = default.
        </p>
        <div className="flex flex-wrap gap-3">
          {SEVERITIES.map((sev) => {
            const id = `sev-weight-${sev}`;
            return (
              <div key={sev} className="flex items-center gap-1.5">
                <label htmlFor={id} className="text-xs text-gray-300">{SEVERITY_LABELS[sev]}</label>
                <input
                  id={id}
                  type="number"
                  min="0"
                  step="1"
                  inputMode="numeric"
                  value={draft[sev] ?? ''}
                  placeholder={String(DEFAULT_SEVERITY_WEIGHTS[sev])}
                  onChange={(e) => setDraft((d) => ({ ...d, [sev]: e.target.value }))}
                  onBlur={(e) => commitWeight(sev, e.target.value)}
                  className="w-16 rounded border border-port-border bg-port-bg px-2 py-1 text-sm text-gray-100 focus:border-port-accent focus:outline-none"
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Blocking severities per gate */}
      <div className="space-y-1.5">
        <p className="text-xs text-gray-400">
          Blocking severities — which findings pause each autopilot gate. None checked = nothing blocks.
        </p>
        <div className="grid gap-2 sm:grid-cols-3">
          {GATES.map((gate) => {
            const blocking = effectiveBlocking(blockingOverride, gate.id);
            return (
              <fieldset key={gate.id} className="rounded border border-port-border/60 p-2">
                <legend className="px-1 text-xs font-medium text-gray-300">{gate.label}</legend>
                <div className="flex flex-col gap-1">
                  {SEVERITIES.map((sev) => {
                    const id = `block-${gate.id}-${sev}`;
                    return (
                      <label key={sev} htmlFor={id} className="flex items-center gap-1.5 text-xs text-gray-300">
                        <input
                          id={id}
                          type="checkbox"
                          checked={blocking.includes(sev)}
                          onChange={() => toggleBlocking(gate.id, sev)}
                          className="h-3.5 w-3.5 rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent"
                        />
                        {SEVERITY_LABELS[sev]}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            );
          })}
        </div>
      </div>
    </section>
  );
}
