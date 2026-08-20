import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router';
import { RefreshCw, ScrollText, Wrench } from 'lucide-react';
import * as api from '../../../services/api';
import { formatDateTime, formatRuntime, formatBytes, timeAgo } from '../../../utils/formatters';
import BrailleSpinner from '../../BrailleSpinner';
import Banner from '../../ui/Banner';
import ConfirmButtonPair from '../../ui/ConfirmButtonPair';

/**
 * Read-only diagnostic over the append-only CoS run event ledger (#4540).
 *
 * The Runs tab next door shows what a run IS — the mutable record, updated in
 * place. This one shows how it got there: the ordered lifecycle stream, and the
 * status the server derives by replaying it. The two can legitimately disagree,
 * and when they do, the disagreement is the finding — a run whose record says
 * "running" but whose stream ends at `run.interrupted` is a kill that never
 * took; a run with three `run.runner-recovered` events has survived three
 * restarts. Neither is visible anywhere else.
 *
 * Everything here is a GET. The ledger is written only by the server's own
 * lifecycle boundaries, so there is nothing to mutate from the UI.
 */

/** Projection status → the badge classes for it. */
const STATUS_STYLES = {
  running: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  completed: 'bg-green-500/15 text-green-400 border-green-500/30',
  failed: 'bg-red-500/15 text-red-400 border-red-500/30',
  orphaned: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  interrupted: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  paused: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
  unknown: 'bg-port-border/40 text-port-text-muted border-port-border'
};

export function statusClasses(status) {
  return STATUS_STYLES[status] || STATUS_STYLES.unknown;
}

/**
 * The one-line "what else happened to this run" summary.
 *
 * Only counts that are actually non-zero appear: a run with no handoffs, no
 * reconnects and no pauses is the normal case, and printing three zeroes for it
 * would bury the runs where those numbers are the whole story.
 */
export function projectionAnnotations(projection) {
  const parts = [];
  if (projection.handoffCount > 0) parts.push(`${projection.handoffCount} handoff${projection.handoffCount === 1 ? '' : 's'}`);
  if (projection.recoveryCount > 0) parts.push(`${projection.recoveryCount} recovery${projection.recoveryCount === 1 ? '' : ' events'}`);
  if (projection.reconnectCount > 0) parts.push(`${projection.reconnectCount} reconnect${projection.reconnectCount === 1 ? '' : 's'}`);
  if (projection.pauseCount > 0) parts.push(`${projection.pauseCount} pause${projection.pauseCount === 1 ? '' : 's'}`);
  if (projection.orphaned) parts.push('orphaned');
  if (projection.interrupted) parts.push('interrupt requested');
  if (projection.prVerified === false) parts.push('PR unverified');
  return parts;
}

/** Render one event's redacted payload as compact `key=value` pairs. */
export function summarizeEventData(data) {
  if (!data || typeof data !== 'object') return '';
  return Object.entries(data)
    .map(([key, value]) => {
      if (value === null || value === undefined) return null;
      if (typeof value === 'object') return `${key}=${value.redacted ? `«${value.redacted}»` : '{…}'}`;
      return `${key}=${value}`;
    })
    .filter(Boolean)
    .join('  ');
}

/**
 * How each reconciliation finding reads to a human.
 *
 * `label` names the disagreement; `hint` says what it means, because the finding
 * ids are precise but not self-explanatory — "ledger-open" is meaningless until
 * you know it is the ledger that is missing something, not the run.
 */
export const RECONCILE_FINDINGS = {
  'record-open': {
    label: 'Record still open',
    hint: 'The ledger holds a verdict this run record never received. Repairable.'
  },
  'record-missing': {
    label: 'Run record missing',
    hint: 'The ledger knows this run; no metadata.json exists for it.'
  },
  'verdict-mismatch': {
    label: 'Verdict disagrees',
    hint: 'Both sides are closed and report different outcomes.'
  },
  'ledger-open': {
    label: 'Ledger missed the close',
    hint: 'The record is closed but no finalize event ever landed.'
  }
};

export function describeFinding(item) {
  const detail = item?.detail ?? {};
  if (item?.finding === 'verdict-mismatch') {
    return `ledger ${detail.ledgerSuccess ? 'success' : 'failure'} vs record ${detail.recordSuccess ? 'success' : 'failure'}`;
  }
  if (item?.finding === 'ledger-open') return `ledger ${detail.ledgerStatus}, record closed`;
  return `ledger ${detail.ledgerStatus ?? 'unknown'}`;
}

export default function RunEventsTab() {
  const [searchParams, setSearchParams] = useSearchParams();
  // Selection lives in the URL so a diagnostic is shareable and reload-safe.
  const selectedId = searchParams.get('run');

  const [stats, setStats] = useState(null);
  const [projections, setProjections] = useState([]);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // `null` = not fetched / failed, never conflated with a report that found
  // nothing — "the ledger and the records agree" and "we couldn't check" are
  // opposite conclusions.
  const [reconcile, setReconcile] = useState(null);
  const [confirmingRepair, setConfirmingRepair] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [repairResult, setRepairResult] = useState(null);

  const loadLedger = useCallback(async () => {
    setLoading(true);
    // `null` is the "could not fetch" sentinel; `[]` is a genuinely empty
    // ledger. Collapsing the two would render "no runs recorded" for a server
    // that is simply unreachable.
    const [nextStats, nextProjections, nextReconcile] = await Promise.all([
      api.getRunEventStats({ silent: true }).catch(() => null),
      api.getRunEventProjections({ limit: 100 }, { silent: true }).catch(() => null),
      api.getRunReconciliation({ limit: 100 }, { silent: true }).catch(() => null)
    ]);
    setStats(nextStats);
    setProjections(Array.isArray(nextProjections) ? nextProjections : []);
    setReconcile(nextReconcile);
    setLoadError(nextStats === null || nextProjections === null);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadLedger();
  }, [loadLedger]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    // `null` is the same could-not-fetch sentinel the list uses. Falling back to
    // an empty diagnostic would render "this run has no events" — a statement
    // about the ledger — for what is actually a statement about the network.
    api.getRunEventDiagnostic(selectedId, { silent: true })
      .catch(() => null)
      .then((next) => {
        if (cancelled) return;
        setDetail(next);
        setDetailLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedId]);

  // The one write on this page. Reloads the whole ledger afterwards rather than
  // patching the report in place: a repair appends a `run.reconciled` event, so
  // the projections and the stats it just changed have to be re-read anyway.
  const repair = async () => {
    setConfirmingRepair(false);
    setRepairing(true);
    const result = await api.repairRunRecords({ limit: 100 }).catch(() => null);
    setRepairResult(result);
    setRepairing(false);
    if (result) await loadLedger();
  };

  const select = (id) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set('run', id); else next.delete('run');
    setSearchParams(next, { replace: true });
  };

  if (loading) {
    return <div className="flex items-center justify-center py-12"><BrailleSpinner text="Loading run events" /></div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-port-text">Run Event Ledger</h2>
          <p className="text-sm text-port-text-muted">
            The ordered lifecycle stream behind every CoS run, and the status derived by replaying it.
          </p>
        </div>
        <button
          type="button"
          onClick={loadLedger}
          className="flex items-center gap-2 rounded border border-port-border px-3 py-1.5 text-sm text-port-text hover:bg-port-border/30"
        >
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      {loadError && (
        <Banner tone="error">Could not read the run event ledger. The values below may be incomplete.</Banner>
      )}

      {stats && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <LedgerStat label="Active generation" value={`${stats.activeEvents} / ${stats.maxActiveEvents}`} />
          <LedgerStat label="Archived" value={String(stats.archivedEvents)} />
          <LedgerStat label="Retention" value={`${stats.maxRetainedEvents} events · ${stats.maxEventAgeDays}d`} />
          <LedgerStat label="Oldest event" value={stats.oldestEventAt ? timeAgo(stats.oldestEventAt) : '—'} />
        </div>
      )}

      <ReconciliationPanel
        report={reconcile}
        onSelect={select}
        confirming={confirmingRepair}
        onAskRepair={() => setConfirmingRepair(true)}
        onCancelRepair={() => setConfirmingRepair(false)}
        onRepair={repair}
        repairing={repairing}
        result={repairResult}
      />

      {projections.length === 0 ? (
        <Banner tone="info">
          No lifecycle events recorded yet. The ledger fills as CoS agents spawn, hand off, pause, and finish.
        </Banner>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <ul className="max-h-[28rem] space-y-2 overflow-y-auto pr-1">
            {projections.map((projection) => (
              <li key={projection.id}>
                <button
                  type="button"
                  onClick={() => select(projection.id)}
                  className={`w-full rounded border px-3 py-2 text-left transition-colors ${
                    projection.id === selectedId
                      ? 'border-port-accent bg-port-accent/10'
                      : 'border-port-border hover:bg-port-border/20'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-xs text-port-text">{projection.id}</span>
                    <span className={`shrink-0 rounded border px-2 py-0.5 text-xs ${statusClasses(projection.status)}`}>
                      {projection.status}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-port-text-muted">
                    <span>{projection.eventCount} events</span>
                    <span>{timeAgo(projection.lastEventAt)}</span>
                    {projectionAnnotations(projection).map((note) => (
                      <span key={note} className="rounded bg-port-border/40 px-1.5 py-0.5">{note}</span>
                    ))}
                  </div>
                </button>
              </li>
            ))}
          </ul>

          <div className="rounded border border-port-border p-3">
            {!selectedId && (
              <p className="flex items-center gap-2 text-sm text-port-text-muted">
                <ScrollText className="h-4 w-4" /> Select a run to replay its lifecycle.
              </p>
            )}
            {selectedId && detailLoading && <BrailleSpinner text="Replaying" />}
            {selectedId && !detailLoading && detail === null && (
              <Banner tone="error">Could not load this run's events.</Banner>
            )}
            {selectedId && !detailLoading && detail !== null && <RunDiagnostic detail={detail} />}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Ledger vs. run records.
 *
 * The rest of this page reads the ledger on its own terms. This panel is the
 * only place the two halves of a run's history are put side by side, which is
 * where the interesting failures live: a record left open by a crash the ledger
 * saw, a verdict the two sides disagree on, a close event that never landed.
 *
 * Only `record-open` is repairable, and the repair is one-directional — the
 * ledger can close a record it holds the verdict for, never the reverse.
 */
function ReconciliationPanel({ report, onSelect, confirming, onAskRepair, onCancelRepair, onRepair, repairing, result }) {
  if (!report) {
    return <Banner tone="warning">Could not compare the ledger against the run records.</Banner>;
  }

  const findings = Array.isArray(report.findings) ? report.findings : [];
  const repairable = report.summary?.repairable ?? 0;
  // A ledger with nothing in it has nothing to reconcile; rendering "0 runs
  // compared" beside the empty-ledger banner below would say the same thing
  // twice and imply a check that had no subject.
  if ((report.summary?.checked ?? 0) === 0 && findings.length === 0) return null;

  return (
    <div className="rounded border border-port-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-port-text">Ledger vs. run records</h3>
          <p className="text-xs text-port-text-muted">
            {report.summary?.checked ?? 0} run{(report.summary?.checked ?? 0) === 1 ? '' : 's'} compared · {findings.length} disagreement{findings.length === 1 ? '' : 's'}
          </p>
        </div>
        {repairable > 0 && (confirming ? (
          <ConfirmButtonPair
            prompt={`Close ${repairable} run record${repairable === 1 ? '' : 's'}?`}
            confirmText="Close records"
            confirmIcon={Wrench}
            tone="warning"
            busy={repairing}
            busyText="Closing"
            onConfirm={onRepair}
            onCancel={onCancelRepair}
            ariaLabel="Confirm closing run records from the ledger"
          />
        ) : (
          <button
            type="button"
            onClick={onAskRepair}
            className="flex min-h-[36px] items-center gap-2 rounded border border-port-border px-3 py-1.5 text-sm text-port-text hover:bg-port-border/30"
          >
            <Wrench className="h-4 w-4" /> Close {repairable} from ledger
          </button>
        ))}
      </div>

      {result && (
        <Banner tone={result.repaired?.length ? 'success' : 'info'}>
          {result.repaired?.length
            ? `Closed ${result.repaired.length} run record${result.repaired.length === 1 ? '' : 's'} from the ledger.`
            : 'Nothing left to close — every repairable record had already been closed.'}
        </Banner>
      )}

      {findings.length === 0 ? (
        <p className="mt-2 text-xs text-port-text-muted">
          Every run record agrees with the stream that produced it.
        </p>
      ) : (
        <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto pr-1">
          {findings.map((item) => (
            <li key={`${item.runId}:${item.finding}`}>
              <button
                type="button"
                onClick={() => onSelect(item.runId)}
                className="w-full rounded border border-port-border px-2 py-1.5 text-left hover:bg-port-border/20"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="truncate font-mono text-xs text-port-text">{item.runId}</span>
                  <span className="shrink-0 text-xs text-port-text-muted">
                    {RECONCILE_FINDINGS[item.finding]?.label || item.finding}
                    {item.repairable ? ' · repairable' : ''}
                  </span>
                </div>
                <div className="text-xs text-port-text-muted">
                  {describeFinding(item)} — {RECONCILE_FINDINGS[item.finding]?.hint || ''}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LedgerStat({ label, value }) {
  return (
    <div className="rounded border border-port-border px-3 py-2">
      <div className="text-xs text-port-text-muted">{label}</div>
      <div className="text-sm font-medium text-port-text">{value}</div>
    </div>
  );
}

function RunDiagnostic({ detail }) {
  const projection = detail?.projection ?? null;
  const events = detail?.events ?? [];

  if (!projection && events.length === 0) {
    // A live run whose events have aged out of the ledger lands here — the run
    // may still exist, so this says "not in the ledger", not "not found".
    return <Banner tone="info">This run has no events in the ledger. It may have aged out of retention.</Banner>;
  }

  return (
    <div className="space-y-3">
      {projection && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <Field label="Status" value={projection.status} />
          <Field label="Agent" value={projection.agentId} />
          <Field label="Task" value={projection.taskId} />
          <Field label="Owner" value={projection.owner} />
          <Field label="Started" value={projection.startedAt ? formatDateTime(projection.startedAt) : null} />
          <Field label="Ended" value={projection.endedAt ? formatDateTime(projection.endedAt) : null} />
          <Field label="Duration" value={Number.isFinite(projection.durationMs) ? formatRuntime(projection.durationMs) : null} />
          <Field label="Exit code" value={projection.exitCode === null ? null : String(projection.exitCode)} />
          <Field label="Output" value={Number.isFinite(projection.outputBytes) ? formatBytes(projection.outputBytes) : null} />
          <Field label="PR verified" value={projection.prVerified === null ? null : String(projection.prVerified)} />
        </dl>
      )}

      <div className="max-h-72 overflow-y-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-port-text-muted">
            <tr>
              <th className="py-1 pr-2 font-normal">When</th>
              <th className="py-1 pr-2 font-normal">Event</th>
              <th className="py-1 font-normal">Detail</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.eventId} className="border-t border-port-border/60 align-top">
                <td className="whitespace-nowrap py-1 pr-2 text-port-text-muted">{formatDateTime(event.at)}</td>
                <td className="whitespace-nowrap py-1 pr-2 font-mono text-port-text">{event.kind}</td>
                <td className="break-all py-1 font-mono text-port-text-muted">{summarizeEventData(event.data)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Field({ label, value }) {
  return (
    <>
      <dt className="text-port-text-muted">{label}</dt>
      <dd className="truncate text-port-text">{value ?? '—'}</dd>
    </>
  );
}
