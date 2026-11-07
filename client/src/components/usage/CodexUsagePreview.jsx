import { useState } from 'react';
import * as api from '../../services/api';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { formatCount, timeAgo } from '../../utils/formatters';

const buttonClass = 'rounded-lg border border-port-border px-3 py-2 text-sm text-white hover:border-port-accent disabled:opacity-50 disabled:cursor-not-allowed';

const formatIssues = issues => Object.entries(issues || {}).map(([reason, count]) => `${reason.replaceAll('_', ' ')} (${formatCount(count)})`).join(', ');

export default function CodexUsagePreview({ job, onStatus, refreshStatus, coverage = null }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const isPreview = job?.mode === 'preview';
  const busy = job?.status === 'running' || job?.status === 'cancelling';
  const valid = from && to && from <= to && Date.parse(to) - Date.parse(from) < 366 * 86_400_000;
  const [preview, starting] = useAsyncAction(async () => {
    const status = await api.previewCodexUsage({ from, to }, { silent: true });
    onStatus(status);
    // The worker can complete before the start response reaches the browser.
    if (status.status === 'running') await refreshStatus();
  }, { errorMessage: 'Failed to preview Codex sources' });
  const [cancel, cancelling] = useAsyncAction(async () => {
    const status = await api.cancelCodexUsagePreview(job.id, { silent: true });
    onStatus(status);
    await refreshStatus();
  }, { errorMessage: 'Failed to cancel Codex preview' });
  const result = isPreview && job.status === 'complete' ? job.preview : null;

  return (
    <section className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 space-y-3" aria-label="Preview Codex history">
      <h3 className="text-sm font-medium text-white">Preview Codex history before repair</h3>
      {coverage && <div role="note" aria-label="Codex usage on hold" className="rounded-lg border border-port-warning/30 bg-port-warning/5 p-3 text-xs space-y-1">
        <p className="font-medium text-port-warning">Interactive Codex usage is on hold since {timeAgo(coverage.since, 'an unknown time')}. It is billed once its sources can be read; nothing is lost while it waits.</p>
        <p className="text-gray-400">Reasons: {formatIssues(coverage.issues)}.</p>
        {coverage.progress && <p className="text-gray-400">Indexed {formatCount(coverage.progress.indexed)} of {formatCount(coverage.progress.total)} sources. Indexing continues on the next scan.</p>}
        {coverage.sources?.length > 0 && <ul className="text-gray-400 break-words">{coverage.sources.map(({ source, issues }) => <li key={source}>{source}: {issues.join(', ').replaceAll('_', ' ')}</li>)}</ul>}
      </div>}
      <p className="text-xs text-gray-400">Inspect raw, compressed and archived sources without changing recorded usage. Choose up to 366 days, inclusive in UTC. No provider calls.</p>
      <form onSubmit={event => { event.preventDefault(); if (valid && !busy && !starting) void preview(); }} className="flex flex-wrap items-end gap-3">
        <label htmlFor="codex-preview-from" className="text-xs text-gray-400">From (UTC)
          <input id="codex-preview-from" type="date" required value={from} onChange={event => setFrom(event.target.value)} disabled={busy || starting} className="block bg-port-bg border border-port-border rounded p-2 text-white" />
        </label>
        <label htmlFor="codex-preview-to" className="text-xs text-gray-400">To (UTC)
          <input id="codex-preview-to" type="date" required value={to} onChange={event => setTo(event.target.value)} disabled={busy || starting} className="block bg-port-bg border border-port-border rounded p-2 text-white" />
        </label>
        <button type="submit" disabled={!valid || busy || starting} className={buttonClass}>Preview sources</button>
        {isPreview && busy && <button type="button" onClick={cancel} disabled={cancelling || job.status === 'cancelling'} className={buttonClass}>Cancel preview</button>}
      </form>
      {from && to && !valid && <p role="alert" className="text-xs text-port-warning">Choose an interval of 1 to 366 days, with From on or before To.</p>}
      {isPreview && busy && <p role="status" className="text-xs text-port-accent">{job.status === 'cancelling' ? 'Cancelling preview…' : 'Scanning bounded sources…'}</p>}
      {isPreview && job.status === 'cancelled' && <p role="status" className="text-xs text-gray-400">Preview cancelled. Recorded usage is unchanged.</p>}
      {isPreview && job.status === 'error' && <p role="alert" className="text-xs text-port-error">{job.error}</p>}
      {result && <div className="text-xs text-gray-400 space-y-2" role="status">
        <p>Preview: {result.range.from} to {result.range.to} (UTC, inclusive).</p>
        <p>{result.coverage.complete ? 'Source coverage complete within scan limits.' : 'Source coverage incomplete. Totals may omit sources or conflicts.'} Inspected {formatCount(result.coverage.filesInspected)} files; {formatCount(result.coverage.resolvedSessions)} resolved and {formatCount(result.coverage.unresolvedSessions)} unresolved sessions.</p>
        {Object.keys(result.coverage.issues || {}).length > 0 && <p>Coverage issues: {formatIssues(result.coverage.issues)}.</p>}
        {result.totals ? <p>Observed: {formatCount(result.totals.tokensIn)} input, {formatCount(result.totals.cacheReadTokens)} cached input and {formatCount(result.totals.tokensOut)} output tokens.</p> : <p>Observed totals unavailable.</p>}
        {Object.entries(result.byModel || {}).map(([model, counts]) => <p key={model}>{model}: {formatCount(counts.tokensIn)} input, {formatCount(counts.cacheReadTokens)} cached input, {formatCount(counts.tokensOut)} output.</p>)}
        <p className="text-port-warning">Prior ledger overlap is unknown. Observed counters are not proven missing usage. No adjustments are available from this preview; recorded usage is unchanged.</p>
      </div>}
    </section>
  );
}
