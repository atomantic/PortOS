/**
 * Editorial health panel (#1316) for the Editorial Checks page — turns the
 * point-in-time findings into something the author can MANAGE the draft with:
 *
 *  - the transparent severity-weighted HEALTH SCORE (per series, with a per-issue
 *    drill-down), and the READINESS signal under the configured gate;
 *  - the REVISION TREND — a score sparkline across the recorded runs plus the
 *    most-recent-revision delta, and the per-category REGRESSIONS (a category
 *    that got worse after an edit pass).
 *
 * Read-only over the same manuscript-review findings the triage view shows: the
 * server (`getEditorialHealth`) computes the score + trend; this renders it. The
 * readiness gate is the one editable control (it drives the autopilot's
 * convergence gate too). Refetches when `refreshKey` changes (e.g. after a run
 * completes), so the score reflects the freshest review.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Loader2, TrendingUp, TrendingDown } from 'lucide-react';
import toast from '../../ui/Toast';
import { getEditorialHealth, setEditorialReadinessGate } from '../../../services/api';
import {
  scoreBand,
  deltaDisplay,
  sparklineGeometry,
  orderedCategories,
  SEVERITY_ORDER,
  SEVERITY_LABELS,
  READINESS_GATE_LABELS,
  READINESS_GATE_ORDER,
} from '../../../lib/editorialHealth';

const SEVERITY_DOT = { high: 'bg-rose-400', medium: 'bg-amber-400', low: 'bg-gray-400' };

function SeverityBreakdown({ openBySeverity }) {
  const any = SEVERITY_ORDER.some((s) => (openBySeverity?.[s] || 0) > 0);
  if (!any) return <span className="text-[11px] text-port-success">No open findings</span>;
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {SEVERITY_ORDER.map((sev) => (
        <span key={sev} className="flex items-center gap-1 text-[11px] text-gray-400">
          <span className={`h-2 w-2 rounded-full ${SEVERITY_DOT[sev]}`} />
          {openBySeverity?.[sev] || 0} {SEVERITY_LABELS[sev].toLowerCase()}
        </span>
      ))}
    </span>
  );
}

function Sparkline({ points }) {
  const { points: poly, coords } = sparklineGeometry(points, { width: 140, height: 32, pad: 3 });
  if (!poly) return <span className="text-[11px] text-gray-600">Run editorial checks to start the trend</span>;
  const last = coords[coords.length - 1];
  return (
    <svg viewBox="0 0 140 32" width={140} height={32} className="h-8 w-[140px] max-w-full overflow-visible" role="img" aria-label="Editorial health score trend">
      <polyline points={poly} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-port-accent" />
      <circle cx={last.x} cy={last.y} r="2.5" className="fill-port-accent" />
    </svg>
  );
}

export default function EditorialHealthPanel({ seriesId, refreshKey = 0 }) {
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(false);
  const [savingGate, setSavingGate] = useState(false);
  const [showIssues, setShowIssues] = useState(false);

  // Guard against a stale response: switching series (or a fast refresh) can let
  // an older fetch resolve last and render the wrong series' health. Only the
  // latest requested series is allowed to write state.
  const activeSeriesRef = useRef(seriesId);
  useEffect(() => { activeSeriesRef.current = seriesId; }, [seriesId]);

  const load = useCallback((id) => {
    if (!id) { setHealth(null); return; }
    setLoading(true);
    // getEditorialHealth has no silent option here — request() toasts on failure;
    // just clear + swallow so the panel degrades to its empty state. Every state
    // write is gated on the series still being current (stale-response race).
    getEditorialHealth(id)
      .then((h) => { if (activeSeriesRef.current === id) setHealth(h && typeof h === 'object' ? h : null); })
      .catch(() => { if (activeSeriesRef.current === id) setHealth(null); })
      .finally(() => { if (activeSeriesRef.current === id) setLoading(false); });
  }, []);

  // Clear stale health when the SERIES changes (not on a same-series refresh) so
  // the loader shows instead of the previous series' score lingering in-flight.
  // A keyed effect on seriesId alone keeps a refreshKey-only bump from blanking
  // the panel mid-view.
  useEffect(() => { setHealth(null); }, [seriesId]);
  useEffect(() => { load(seriesId); }, [seriesId, refreshKey, load]);

  const onGateChange = (gate) => {
    setSavingGate(true);
    // Optimistic — reflect the picked gate, re-derive readiness on the refetch.
    setHealth((h) => (h ? { ...h, gate } : h));
    setEditorialReadinessGate(gate, { silent: true })
      .then(() => load(seriesId))
      .catch((err) => toast.error(err.message || 'Failed to update readiness gate'))
      .finally(() => setSavingGate(false));
  };

  if (!seriesId) return null;
  if (loading && !health) {
    return (
      <p className="flex items-center gap-2 text-sm text-gray-400">
        <Loader2 size={16} className="animate-spin" /> Loading editorial health…
      </p>
    );
  }
  if (!health) return null;

  const band = scoreBand(health.score);
  const delta = deltaDisplay(health.trend?.delta);
  const regressions = Array.isArray(health.trend?.regressions) ? health.trend.regressions : [];
  const categories = orderedCategories(health.openByCategory);
  const points = health.trend?.points || [];
  // The delta compares the two most recent revisions — only meaningful with ≥2
  // points (a single revision has nothing to compare against).
  const hasDelta = points.length >= 2;
  // Per-issue drill-down (#1316): issues carrying at least one open finding,
  // worst-scoring first. The series-scoped (null issueNumber) bucket renders last.
  const issueRows = (Array.isArray(health.perIssue) ? health.perIssue : [])
    .filter((p) => p.open > 0)
    .sort((a, b) => a.score - b.score);

  return (
    <section className="space-y-3 rounded-lg border border-port-border bg-port-card p-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-gray-400">
          <Activity size={15} className="text-port-accent" /> Editorial Health
        </h2>
        {health.ready ? (
          <span className="rounded-full bg-port-success/15 px-2 py-0.5 text-[10px] font-medium text-port-success">Ready</span>
        ) : (
          <span className="rounded-full bg-port-warning/15 px-2 py-0.5 text-[10px] font-medium text-port-warning">Not ready</span>
        )}
      </div>

      {/* Score + breakdown */}
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className={`text-3xl font-bold ${band.tone}`}>{health.score}</span>
            <span className="text-xs text-gray-500">/ 100 · {band.label}</span>
            {hasDelta ? (
              <span className={`flex items-center gap-0.5 text-xs ${delta.tone}`} title="Change since the previous revision">
                {delta.text}
              </span>
            ) : null}
          </div>
          <div className="mt-1.5 h-1.5 w-40 overflow-hidden rounded-full bg-port-border">
            <div className={`h-full ${band.bar}`} style={{ width: `${Math.max(0, Math.min(100, health.score))}%` }} />
          </div>
          <div className="mt-1.5"><SeverityBreakdown openBySeverity={health.openBySeverity} /></div>
        </div>
        <div className="sm:text-right">
          <span className="block text-[10px] uppercase tracking-wide text-gray-600">Score trend</span>
          <span className="text-port-accent"><Sparkline points={health.trend?.points} /></span>
        </div>
      </div>

      {/* Readiness gate control — also drives the autopilot convergence gate. */}
      <div className="flex flex-wrap items-center gap-2 border-t border-port-border/60 pt-2.5">
        <label htmlFor="eh-gate" className="text-[11px] text-gray-500">Ready when:</label>
        <select
          id="eh-gate"
          value={READINESS_GATE_ORDER.includes(health.gate) ? health.gate : 'noOpenHigh'}
          onChange={(e) => onGateChange(e.target.value)}
          disabled={savingGate}
          className="rounded border border-port-border bg-port-bg px-2 py-1 text-[11px] text-gray-200 focus:border-port-accent focus:outline-none disabled:opacity-50"
        >
          {READINESS_GATE_ORDER.map((g) => (
            <option key={g} value={g}>{READINESS_GATE_LABELS[g]}</option>
          ))}
        </select>
        {savingGate ? <Loader2 size={12} className="animate-spin text-gray-500" /> : null}
      </div>

      {/* Per-category breakdown + regressions */}
      {categories.length ? (
        <div className="border-t border-port-border/60 pt-2.5">
          <span className="block text-[10px] uppercase tracking-wide text-gray-600">Open by category</span>
          <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
            {categories.map(({ category, count }) => {
              const regressed = regressions.find((r) => r.category === category);
              return (
                <li key={category} className="flex items-center gap-1 text-[11px] text-gray-400">
                  <span className="text-gray-300">{category}</span>
                  <span className="text-gray-500">{count}</span>
                  {regressed ? (
                    <span className="flex items-center gap-0.5 text-port-error" title={`Regressed: ${regressed.from} → ${regressed.to} since the previous revision`}>
                      <TrendingUp size={11} />
                      {regressed.from}→{regressed.to}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {/* A clean run that improved on the prior revision gets a positive note. */}
      {!regressions.length && hasDelta && (health.trend?.delta || 0) > 0 ? (
        <p className="flex items-center gap-1 text-[11px] text-port-success">
          <TrendingDown size={11} className="rotate-180" /> No category regressed since the previous revision.
        </p>
      ) : null}

      {/* Per-issue drill-down — which issues carry the open findings. */}
      {issueRows.length ? (
        <div className="border-t border-port-border/60 pt-2.5">
          <button
            type="button"
            onClick={() => setShowIssues((v) => !v)}
            className="text-[10px] uppercase tracking-wide text-gray-500 hover:text-gray-300"
            aria-expanded={showIssues}
          >
            By issue ({issueRows.length}) {showIssues ? '▾' : '▸'}
          </button>
          {showIssues ? (
            <ul className="mt-1.5 space-y-1">
              {issueRows.map((p) => {
                const b = scoreBand(p.score);
                return (
                  <li key={p.issueNumber ?? 'series'} className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="text-gray-300">
                      {p.issueNumber != null ? `Issue ${p.issueNumber}` : 'Series-wide'}
                    </span>
                    <span className="flex items-center gap-2 text-gray-500">
                      <SeverityBreakdown openBySeverity={p.openBySeverity} />
                      <span className={`font-medium ${b.tone}`}>{p.score}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
