/**
 * Settings > Features "Audit priority" section: each feature area's effective P0-P3 tier, where it came from, recent activity, and a pin control.
 *
 * Own pin changes apply from the PUT response; a cleared pin needs the server to re-resolve the tier, so it (and a clear announced by another tab on `feature-priorities:updated`) does one targeted reload. No timer.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import socket from '../../services/socket';
import BrailleSpinner from '../BrailleSpinner';
import { getFeaturePriorities, setFeaturePriorityPin } from '../../services/apiFeaturePriorities.js';
import useMounted from '../../hooks/useMounted.js';
import { formatDateNumeric } from '../../utils/formatters.js';

const TIER_CHOICES = ['P0', 'P1', 'P2', 'P3'];

const SOURCE_BADGES = {
  pinned: { label: 'Pinned', className: 'bg-port-accent/20 text-port-accent' },
  learned: { label: 'Learned', className: 'bg-port-success/20 text-port-success' },
  'feature-off': { label: 'Feature off', className: 'bg-gray-500/20 text-gray-300' },
  default: { label: 'Default', className: 'bg-port-border text-gray-300' },
};

const TIER_LEGEND = [
  ['P0', 'heavy daily use, audited first'],
  ['P1', 'normal'],
  ['P2', 'low use, real defects only'],
  ['P3', 'dormant, skipped'],
];

const pinRow = (row, tier) => ({ ...row, tier, source: 'pinned' });

const activityText = (row, learning) => {
  if (learning) return 'Still learning';
  const days = row.activeDays30 ?? 0;
  const last = row.lastActiveDay ? `, last ${formatDateNumeric(row.lastActiveDay, row.lastActiveDay)}` : '';
  return `Active ${days} of the last 30 days${last}`;
};

function SegmentButton({ active, disabled, onClick, children, label }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`min-h-[36px] min-w-[36px] px-3 py-1.5 text-xs rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${active
        ? 'bg-port-accent text-white'
        : 'text-gray-400 hover:text-white hover:bg-port-border/70'}`}
    >
      {children}
    </button>
  );
}

export function FeaturePrioritiesSection() {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [savingIds, setSavingIds] = useState(() => new Set());
  const dataRef = useRef(null);
  const loadGeneration = useRef(0);
  const pendingLoads = useRef(0);
  const mounted = useMounted();

  const commit = useCallback((updater) => {
    const next = updater(dataRef.current);
    dataRef.current = next;
    setData(next);
  }, []);

  // Last request wins: a reload started by a newer event supersedes an older response still in flight.
  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    pendingLoads.current += 1;
    const result = await getFeaturePriorities({ silent: true }).catch((err) => err instanceof Error ? err : new Error(String(err)));
    pendingLoads.current -= 1;
    if (!mounted.current || generation !== loadGeneration.current) return;
    if (result instanceof Error) {
      setLoadError(result);
      return;
    }
    setLoadError(null);
    commit(() => result);
  }, [commit]);

  const applyPin = useCallback(({ areaId, tier }) => {
    const row = dataRef.current?.areas?.find((entry) => entry.areaId === areaId);
    if (tier === null) {
      // Only a row that still shows a pin needs the server to re-resolve it; this also absorbs the echo of our own clear.
      if (!row || row.source === 'pinned') void load();
      return;
    }
    if (!row) return;
    commit((prev) => ({ ...prev, areas: prev.areas.map((entry) => (entry.areaId === areaId ? pinRow(entry, tier) : entry)) }));
    // A read already in flight may predate this pin and would overwrite it; supersede it with a fresh read rather than dropping it, since it may also carry another area's cleared pin.
    if (pendingLoads.current > 0) void load();
  }, [commit, load]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    socket.on('feature-priorities:updated', applyPin);
    return () => socket.off('feature-priorities:updated', applyPin);
  }, [applyPin]);

  const choose = async (row, tier) => {
    if (savingIds.has(row.areaId)) return;
    if (tier === null ? row.source !== 'pinned' : (row.source === 'pinned' && row.tier === tier)) return;
    setSavingIds((prev) => new Set(prev).add(row.areaId));
    // The wrapper's default error handling toasts a failed save; the row keeps its previous value.
    const saved = await setFeaturePriorityPin(row.areaId, tier).catch(() => null);
    if (mounted.current) {
      setSavingIds((prev) => {
        const next = new Set(prev);
        next.delete(row.areaId);
        return next;
      });
    }
    if (saved && mounted.current) applyPin(saved);
  };

  const learning = data ? data.evidenceDays < data.minEvidenceDays : false;

  return (
    <section aria-labelledby="audit-priority-heading" className="space-y-3">
      <div>
        <h2 id="audit-priority-heading" className="text-lg font-semibold text-white">Audit priority</h2>
        <p className="text-sm text-gray-400 mt-1">
          Scheduled code-quality audits favor the areas you use. Pin a tier to override what PortOS learned, or choose Auto to let it decide.
        </p>
        <p className="text-xs text-gray-500 mt-1">
          {TIER_LEGEND.map(([tier, meaning]) => `${tier} ${meaning}`).join(' · ')}. Security, privacy and data-safety audits always cover everything.
        </p>
        {learning && (
          <p className="text-sm text-port-warning mt-2">
            Still learning: every enabled area is treated as P1 until this install has {data.minEvidenceDays} days of activity ({data.evidenceDays} so far).
          </p>
        )}
      </div>

      {loadError && (
        <div role="alert" className="flex flex-wrap items-center gap-3 bg-port-card border border-port-border rounded-lg p-4 text-sm">
          <span className="text-port-error">{loadError.message || 'Failed to load audit priorities'}</span>
          <button
            type="button"
            onClick={() => load()}
            className="inline-flex items-center justify-center min-h-[44px] px-3 text-sm bg-port-border hover:bg-port-border/70 text-white rounded transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {!data && !loadError && <BrailleSpinner text="Loading audit priorities" />}

      {data && (
        <ul className="space-y-2">
          {data.areas.map((row) => {
            const badge = SOURCE_BADGES[row.source] || SOURCE_BADGES.default;
            const saving = savingIds.has(row.areaId);
            return (
              <li
                key={row.areaId}
                className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-port-card border border-port-border rounded-lg p-3"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-white break-words">{row.label}</h3>
                    <span className="text-xs font-mono text-white" data-testid={`tier-${row.areaId}`}>{row.tier}</span>
                    <span className={`text-xs px-1.5 py-0.5 rounded ${badge.className}`}>{badge.label}</span>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">{activityText(row, learning)}</p>
                </div>
                <div role="group" aria-label={`${row.label} audit priority`} className="inline-flex flex-wrap gap-1 rounded-lg border border-port-border p-1 shrink-0 self-start sm:self-center">
                  <SegmentButton active={row.source !== 'pinned'} disabled={saving} onClick={() => choose(row, null)} label={`${row.label}: Auto`}>Auto</SegmentButton>
                  {TIER_CHOICES.map((tier) => (
                    <SegmentButton
                      key={tier}
                      active={row.source === 'pinned' && row.tier === tier}
                      disabled={saving}
                      onClick={() => choose(row, tier)}
                      label={`${row.label}: ${tier}`}
                    >
                      {tier}
                    </SegmentButton>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export default FeaturePrioritiesSection;
