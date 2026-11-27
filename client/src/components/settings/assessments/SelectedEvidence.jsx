import { Link } from 'react-router';
import BrailleSpinner from '../../BrailleSpinner';
import { formatContextTokens, formatDurationMs, timeAgo, throughputLabel } from '../../../utils/formatters';
import { entryKey, PERFORMANCE_PATH } from './assessmentDetails';
import { StalePill, VerdictPill } from './AssessmentBadges';

export default function SelectedEvidence({ entry, report, runtimeLabelFor, loading, selected, search }) {
  if (!selected) {
    return (
      <aside className="bg-port-bg border border-port-border rounded-lg p-3 space-y-2" aria-label="Selected evidence">
        <h3 className="text-xs font-medium text-gray-300">Selected evidence</h3>
        <p className="text-[11px] text-gray-500">Choose a measured row to inspect its runtime, tuning, timing, and freshness evidence.</p>
      </aside>
    );
  }

  if (loading) {
    return (
      <aside className="bg-port-bg border border-port-border rounded-lg p-3" aria-label="Selected evidence">
        <BrailleSpinner text="Loading selected evidence" />
      </aside>
    );
  }

  if (!entry) {
    return (
      <aside className="bg-port-bg border border-port-border rounded-lg p-3 space-y-2" role="alert" aria-label="Selected evidence">
        <h3 className="text-xs font-medium text-gray-300">Selected evidence unavailable</h3>
        <p className="text-[11px] text-gray-500">
          This measurement is stale, deleted, or no longer installed. Nothing will run from this link.
        </p>
        <Link className="text-xs text-port-accent hover:underline" to={{ pathname: `${PERFORMANCE_PATH}/results`, search }}>
          Return to Results
        </Link>
      </aside>
    );
  }

  const performance = entry.performance || {};
  const tableRow = report?.throughputReport?.rows?.find((row) => entryKey(row) === entryKey(entry));
  const measuredContexts = entry.samples?.map((sample) => sample.contextTokens).filter(Number.isFinite);
  const contextBasis = measuredContexts?.length
    ? measuredContexts.map(formatContextTokens).join(', ')
    : (report?.defaultContextTokens || []).map(formatContextTokens).join(', ');
  const freshness = entry.staleness?.comparable === false
    ? 'Unknown'
    : entry.staleness?.stale
      ? 'Stale'
      : 'Current';
  const timingBasis = tableRow?.timingSource === 'runtime'
    ? 'Runtime-reported timing'
    : tableRow?.timingSource === 'stream-window'
      ? 'Observed stream window'
      : tableRow?.timingSource === 'wall-clock'
        ? 'End-to-end wall clock'
        : 'Timing basis unavailable';

  return (
    <aside className="bg-port-bg border border-port-border rounded-lg p-3 space-y-3" aria-label="Selected evidence">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-xs font-medium text-gray-300">Selected evidence</h3>
          <p className="text-sm text-white font-mono break-all mt-1">{entry.modelId}</p>
          <p className="text-[11px] text-gray-500">{runtimeLabelFor(entry.backend)}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <VerdictPill verdict={entry.verdict} />
          <StalePill staleness={entry.staleness} />
        </div>
      </div>

      {entry.reason && <p className="text-[11px] text-port-warning">{entry.reason}</p>}
      {entry.explanation && <p className="text-[11px] text-gray-400">{entry.explanation}</p>}

      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-[11px]">
        <div><dt className="text-gray-500">Launch tuning</dt><dd className="text-gray-200">{entry.tuningLabel || 'backend defaults'}</dd></div>
        <div><dt className="text-gray-500">Freshness</dt><dd className={freshness === 'Stale' ? 'text-port-warning' : 'text-gray-200'}>{freshness}</dd></div>
        <div><dt className="text-gray-500">Measured</dt><dd className="text-gray-200">{timeAgo(entry.assessedAt, 'unknown')}</dd></div>
        <div><dt className="text-gray-500">Timing basis</dt><dd className="text-gray-200">{timingBasis}</dd></div>
        <div><dt className="text-gray-500">Context samples</dt><dd className="text-gray-200">{contextBasis || 'not measured'}</dd></div>
        <div><dt className="text-gray-500">Max context</dt><dd className="text-gray-200">{Number.isFinite(performance.maxWorkingContextTokens) ? `${formatContextTokens(performance.maxWorkingContextTokens)} tokens` : 'not measured'}</dd></div>
        <div><dt className="text-gray-500">Throughput</dt><dd className="text-gray-200">{throughputLabel(performance) || 'not measured'}</dd></div>
        <div><dt className="text-gray-500">First token</dt><dd className="text-gray-200">{Number.isFinite(performance.meanTtftMs) ? formatDurationMs(performance.meanTtftMs) : 'not measured'}</dd></div>
      </dl>

      <Link
        className="inline-flex items-center text-xs text-port-accent hover:underline"
        to={{ pathname: `${PERFORMANCE_PATH}/results`, search }}
      >
        Clear selection
      </Link>
    </aside>
  );
}
