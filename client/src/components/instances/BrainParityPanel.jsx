/**
 * Brain parity audit for one peer (issue #4519).
 *
 * The sync-status badges above this panel report delta-log CURSOR positions —
 * "we've pulled everything you published". They cannot tell you whether the two
 * brains actually hold the same records, so a peer that silently dropped a
 * record (or never synced this direction at all) still reads "synced". This
 * panel runs the record-level audit and names what's out of parity.
 *
 * Deliberately on demand: the audit exchanges a full manifest, which no routine
 * 60s sync cycle should pay for. Stored results (from the last run) render
 * immediately on load; the button re-runs it.
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, ScanSearch, RefreshCw } from 'lucide-react';
import Pill from '../ui/Pill';
import { runBrainParityCheck } from '../../services/api';
import { timeAgo } from '../../utils/formatters';

// Statuses in the order they're worth reading: what we hold and they don't,
// what they hold and we don't, then same-id-different-clock drift.
const STATUS_META = [
  { key: 'local-only', label: 'only here', tone: 'warning' },
  { key: 'peer-only', label: 'only there', tone: 'warning' },
  { key: 'diverged', label: 'diverged', tone: 'warning' },
];

const REASON_HELP = {
  'peer-not-found': 'This peer is no longer in the registry.',
  'peer-unreachable': 'The peer did not answer. Parity is unknown until it is back online.',
  'peer-too-old': 'This peer predates the reconcile endpoints. Update it to audit parity.',
  'fetch-failed': 'The peer answered with an error. Parity is unknown.',
};

const REASON_LABELS = {
  'peer-not-found': 'peer removed',
  'peer-unreachable': 'unreachable',
  'peer-too-old': 'older peer',
  'fetch-failed': 'check failed',
};

const outOfParityCount = (summary) =>
  STATUS_META.reduce((total, { key }) => total + (summary?.[key] ?? 0), 0);

/**
 * One-line verdict for the collapsed header.
 *
 * A checksum mismatch with zero out-of-parity records is its own finding, not a
 * clean result: the two sides hold the same record ids with the same clocks but
 * different contents, which only the whole-brain checksum can see.
 */
function verdict(report) {
  if (!report) return { label: 'not checked', tone: 'note' };
  if (report.available === false) return { label: REASON_LABELS[report.reason] || 'unavailable', tone: 'note' };
  const outOfParity = outOfParityCount(report.summary);
  if (outOfParity > 0) return { label: `${outOfParity} out of parity`, tone: 'warning' };
  if (report.checksums?.match === false) return { label: 'content mismatch', tone: 'warning' };
  return { label: 'in parity', tone: 'success' };
}

export default function BrainParityPanel({ peer, report: storedReport }) {
  const [expanded, setExpanded] = useState(false);
  const [running, setRunning] = useState(false);
  // A fresh run supersedes the stored report for this card. Kept in local state
  // (not pushed to the peer record) because a parity report is a point-in-time
  // audit result, not peer configuration.
  const [freshReport, setFreshReport] = useState(null);
  const [error, setError] = useState(null);

  const report = freshReport ?? storedReport ?? null;
  const { label, tone } = verdict(report);

  const runCheck = async () => {
    setRunning(true);
    setError(null);
    // `silent` — this panel renders its own inline error rather than toasting,
    // since an unreachable peer is an expected outcome of an audit.
    const result = await runBrainParityCheck(peer.id, { silent: true }).catch(() => null);
    const next = result?.reports?.[0] ?? null;
    if (next) {
      setFreshReport(next);
      setExpanded(true);
    } else {
      setError('Parity check failed. Try again once the peer is reachable.');
    }
    setRunning(false);
  };

  const types = (report?.byType || []).filter((entry) => entry.records?.length > 0);

  return (
    <div className="mt-2 pt-2 border-t border-port-border/50">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex items-center gap-1.5 flex-1 text-left group"
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown size={12} className="text-gray-500" /> : <ChevronRight size={12} className="text-gray-500" />}
          <ScanSearch size={12} className="text-gray-500" />
          <span className="text-[10px] text-gray-500 uppercase tracking-wider font-medium group-hover:text-gray-400 transition-colors">
            Brain parity
          </span>
          <Pill tone={tone} size="xs" bordered={false} className="ml-auto">{label}</Pill>
        </button>
        <button
          type="button"
          onClick={runCheck}
          disabled={running}
          className="inline-flex items-center gap-1 text-[10px] text-port-accent bg-port-accent/10 hover:bg-port-accent/20 rounded px-1.5 py-0.5 transition-colors disabled:opacity-50"
          title="Compare every brain record with this peer — on demand, not part of the sync cycle"
        >
          <RefreshCw size={10} className={running ? 'animate-spin' : ''} />
          {running ? 'Checking…' : 'Check'}
        </button>
      </div>

      {expanded && (
        <div className="mt-2 space-y-2 text-xs">
          {error && <p className="text-port-warning">{error}</p>}

          {!report && !error && (
            <p className="text-gray-500">
              Sync badges above show delta-log positions, not verified record-level parity. Run a check to compare
              every brain record with this peer.
            </p>
          )}

          {report?.available === false && (
            <p className="text-gray-500">{REASON_HELP[report.reason] || 'Parity could not be determined.'}</p>
          )}

          {report?.available && (
            <>
              <div className="flex flex-wrap items-center gap-1.5">
                <Pill tone="muted" size="xs" bordered={false}>{report.summary.total} records compared</Pill>
                {STATUS_META.map(({ key, label: statusLabel, tone: statusTone }) => (
                  report.summary[key] > 0 && (
                    <Pill key={key} tone={statusTone} size="xs" bordered={false}>
                      {report.summary[key]} {statusLabel}
                    </Pill>
                  )
                ))}
                {outOfParityCount(report.summary) === 0 && (
                  <Pill tone="success" size="xs" bordered={false}>every record matches</Pill>
                )}
              </div>

              {report.checksums?.match === false && outOfParityCount(report.summary) === 0 && (
                <p className="text-port-warning">
                  Every record id and timestamp matches, but the whole-brain checksums differ — at least one record
                  body differs between the two installs. The next sync cycle will pull the peer&apos;s copy.
                </p>
              )}

              {types.length > 0 && (
                <ul className="space-y-1">
                  {types.map((entry) => (
                    <li key={entry.type}>
                      <div className="flex items-center gap-1.5">
                        <span className="text-gray-300">{entry.type}</span>
                        {STATUS_META.map(({ key, label: statusLabel }) => (
                          entry.counts[key] > 0 && (
                            <span key={key} className="text-[10px] text-gray-500">
                              {entry.counts[key]} {statusLabel}
                            </span>
                          )
                        ))}
                      </div>
                      <div className="mt-0.5 text-[10px] text-gray-600 font-mono break-all">
                        {entry.records.map((record) => record.id).join(', ')}
                        {entry.truncated && ' … (stored sample — re-run for the full list)'}
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {report.checkedAt && (
                <p className="text-[10px] text-gray-600">Checked {timeAgo(report.checkedAt)}</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
