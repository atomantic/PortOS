import { useCallback, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { RefreshCw } from 'lucide-react';
import * as api from '../../services/api';
import useMounted from '../../hooks/useMounted';
import BrailleSpinner from '../BrailleSpinner';
import { formatCount, formatDateNumeric, formatDateTime, formatMonthYear } from '../../utils/formatters';

const FAMILIES = [
  { family: 'codex', label: 'Codex' }, { family: 'claude', label: 'Claude Code' },
  { family: 'agy', label: 'Antigravity' }, { family: 'grok', label: 'Grok' },
];
const unknownCount = value => formatCount(value, { fallback: 'Unknown' });

function DailyHistory({ buckets }) {
  const [searchParams, setSearchParams] = useSearchParams();
  if (buckets === null) return <p className="text-sm text-gray-400">Daily history was not reported.</p>;
  if (!buckets?.length) return <p className="text-sm text-gray-400">No daily buckets were returned. Missing days are not assumed to be zero.</p>;
  const months = [...new Set(buckets.map(bucket => bucket.startDate.slice(0, 7)))].sort().reverse();
  const requested = searchParams.get('nativeMonth');
  const month = months.includes(requested) ? requested : months[0];
  const days = buckets.filter(bucket => bucket.startDate.startsWith(`${month}-`));
  return (
    <details className="border-t border-port-border pt-3">
      <summary className="cursor-pointer text-sm text-white">Daily native token history</summary>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label htmlFor="native-usage-month" className="text-sm text-gray-400">Reported month</label>
        <select id="native-usage-month" value={month} onChange={event => {
          const next = new URLSearchParams(searchParams);
          next.set('nativeMonth', event.target.value);
          setSearchParams(next);
        }} className="rounded border border-port-border bg-port-bg px-2 py-2 text-sm text-white">
          {months.map(value => <option key={value} value={value}>{formatMonthYear(`${value}-01`)}</option>)}
        </select>
      </div>
      <table className="mt-3 w-full text-sm">
        <caption className="pb-2 text-left text-xs text-gray-400">Provider calendar dates; timezone and missing-day coverage are unknown.</caption>
        <thead><tr className="border-b border-port-border text-gray-400"><th scope="col" className="py-2 text-left">Date</th><th scope="col" className="py-2 text-right">Native tokens</th></tr></thead>
        <tbody>{days.map(day => <tr key={day.startDate} className="border-b border-port-border/50"><td className="py-1.5">{formatDateNumeric(day.startDate)}</td><td className="py-1.5 text-right tabular-nums">{formatCount(day.tokens)}</td></tr>)}</tbody>
      </table>
    </details>
  );
}

const COUNTERS = [
  ['tokensIn', 'Input tokens'], ['tokensOut', 'Output tokens'],
  ['cacheReadTokens', 'Cache read tokens'], ['cacheWriteTokens', 'Cache write tokens'],
  ['thinkingOutputTokens', 'Thinking output tokens'], ['responseOutputTokens', 'Response output tokens'],
  ['reasoningTokens', 'Reasoning tokens'], ['modelCalls', 'Model calls'],
];

function Counters({ totals, family, tokenFields }) {
  return <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
    <div className="sm:col-span-2"><dt className="text-gray-400">{family === 'codex' ? 'Native lifetime tokens' : 'Measured retained tokens'}</dt><dd className="text-2xl font-semibold tabular-nums text-white">{unknownCount(family === 'codex' ? totals?.lifetimeTokens : totals?.totalTokens)}</dd>
      {tokenFields?.totalTokens && <dd className="text-xs text-gray-500">{tokenFields.totalTokens}</dd>}
    </div>
    {family !== 'codex' && COUNTERS.filter(([key]) => !['thinkingOutputTokens', 'responseOutputTokens'].includes(key) || family === 'agy').filter(([key]) => !['reasoningTokens', 'modelCalls'].includes(key) || key in (totals ?? {})).map(([key, label]) => <div key={key}>
      <dt className="text-gray-400">{label}</dt><dd className="tabular-nums text-white">{unknownCount(totals?.[key])}</dd>
      {tokenFields?.[key] && <dd className="text-xs text-gray-500">{tokenFields[key]}</dd>}
    </div>)}
  </dl>;
}

function Findings({ findings }) {
  return findings?.length ? <ul className="list-inside list-disc text-xs text-port-warning">{[...new Set(findings)].map(code => <li key={code}>{code}</li>)}</ul> : null;
}

function Evidence({ label, value }) {
  return <div className="min-w-0"><dt className="text-gray-500">{label}</dt><dd className="break-words text-gray-300">
    {value === null || value === undefined ? 'Unknown' : typeof value === 'object' ? <dl className="ml-2 space-y-1">{Object.entries(value).map(([key, item]) => <Evidence key={key} label={key.replace(/([A-Z])/g, ' $1')} value={item} />)}</dl> : typeof value === 'number' ? formatCount(value) : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : value}
  </dd></div>;
}

function Cost({ cost }) {
  const signal = cost?.nativeCostSignal;
  return <div className="text-xs text-gray-400">
    <p>Cost: Unknown · tokens and native cost ticks are not a bill.</p>
    {signal && <dl className="mt-2 space-y-1">
      <div><dt>Native cost ticks (unverified scope)</dt><dd className="tabular-nums">{unknownCount(signal.knownCostUsdTicks)}</dd></div>
      <Evidence label="Cost signal coverage" value={{ measuredRecords: signal.measuredRecords ?? signal.records, missingRecords: signal.missingRecords, conflictingRecords: signal.conflictingRecords }} />
    </dl>}
  </div>;
}

function AccountUnion({ matrix, family }) {
  return <div className="space-y-2 border-t border-port-border pt-3">
    <h3 className="text-sm font-semibold text-white">Selected account union</h3>
    <p className="text-xs text-gray-400">{matrix?.merge?.status ?? 'Unknown'} · Peer reports are not collected by this read. This is not a fleet-complete total.</p>
    <Findings findings={matrix?.merge?.reasons} />
    {['merged', 'partial'].includes(matrix?.merge?.status) && <Counters totals={matrix.merge.totals} family={family} />}
    {!matrix?.accounts?.length && <p className="text-xs text-gray-400">No usable account selection. Local measurements above remain separate.</p>}
    {matrix?.accounts?.map(account => <div key={account.accountLabel} className="space-y-2 rounded border border-port-border p-2">
      <h4 className="text-sm text-white">{account.accountLabel} · {account.status}</h4>
      <p className="text-xs text-gray-400">{unknownCount(account.members?.length)} selected members · {unknownCount(account.membersWithoutReport?.length)} members without reports</p>
      {account.membersWithoutReport?.length > 0 && <p className="text-xs text-port-warning">Missing peer reports prevent a complete selected-account view.</p>}
      {account.status !== 'refused' && account.totals && <Counters totals={account.totals} family={family} />}
      <Cost cost={account.cost} />
      <Findings findings={account.findings} />
      <details className="text-xs"><summary className="cursor-pointer text-gray-400">Account coverage</summary><dl><Evidence label="Coverage" value={account.coverage} /></dl></details>
    </div>)}
    {matrix?.unresolvedParticipants?.length > 0 && <p className="text-xs text-port-warning">{formatCount(matrix.unresolvedParticipants.length)} participants have unresolved account selection.</p>}
  </div>;
}

function SourceCard({ family, label, provider, matrix, scanned }) {
  const account = family === 'codex';
  return <section aria-label={`${label} native history`} className="min-w-0 rounded-xl border border-port-border bg-port-card p-3 sm:p-4 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold text-white">{label}</h2><span className="text-xs text-gray-400">{provider?.status ?? (scanned ? 'unavailable' : 'Not scanned')}</span></div>
    <p className="text-xs text-gray-400">{account ? 'Account snapshot read on this instance · shown once, never summed across instances' : 'Native files retained on this instance · not an account-wide total'}</p>
    {!scanned ? <p className="text-sm text-gray-400">Not scanned yet. Read native sources without changing your usage records.</p> : <>
      <Counters totals={provider?.totals} family={family} tokenFields={provider?.tokenFields} />
      {provider?.status === 'partial' && <p className="text-sm text-port-warning">Partial source coverage. This is not a complete usage total.</p>}
      {(!provider || ['unavailable', 'absent'].includes(provider.status)) && <p className="text-sm text-port-warning">History unavailable or source absent. Check the source and retry the read.</p>}
      <Findings findings={provider?.findings} />
      {family === 'agy' && <p className="text-xs text-gray-400">Input, output, and cache counters may overlap. A combined total is unknown; separate counters are not added together.</p>}
      <Cost cost={provider?.cost} />
      <p className="text-xs text-gray-400">Runtime: {provider?.runtime?.versions?.length ? provider.runtime.versions.join(', ') : 'Unknown'} · Retention and completeness are unknown.</p>
      <details className="text-xs"><summary className="cursor-pointer text-gray-400">Source coverage and limits</summary>
        <dl className="mt-2 space-y-2">
          <Evidence label="Source" value={provider?.source} /><Evidence label="Validator" value={provider?.validator} />
          <div><dt className="text-gray-500">Earliest observed</dt><dd>{(account ? formatDateNumeric : formatDateTime)(provider?.freshness?.earliestObserved, 'Unknown')}</dd></div>
          <div><dt className="text-gray-500">Latest observed</dt><dd>{(account ? formatDateNumeric : formatDateTime)(provider?.freshness?.latestObserved, 'Unknown')}</dd></div>
          <Evidence label="Date boundary" value={provider?.dateBoundary} /><Evidence label="Coverage" value={provider?.coverage} />
          <Evidence label="Scan limits" value={provider?.scanCaps} /><Evidence label="Duplicates" value={provider?.duplicates} />
          {provider?.nativeUsageCoverage && <Evidence label="Persisted usage coverage" value={provider.nativeUsageCoverage} />}
          {provider?.nativeAgyCoverage && <Evidence label="Antigravity metadata coverage" value={provider.nativeAgyCoverage} />}
          <Evidence label="Missing intervals" value={provider?.missingIntervals} />
        </dl>
      </details>
      {account && <DailyHistory buckets={provider?.totals?.dailyBuckets ?? null} />}
      {account && provider?.status === 'unavailable' && <Link className="inline-flex rounded border border-port-border px-3 py-2 text-sm text-port-accent" to="/ai/services">Check Codex connection</Link>}
      <AccountUnion matrix={matrix} family={family} />
    </>}
  </section>;
}

export default function NativeUsageOverview() {
  const [snapshot, setSnapshot] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const request = useRef(false);
  const mounted = useMounted();
  const read = useCallback(async () => {
    if (request.current) return;
    request.current = true;
    setBusy(true);
    const result = await api.getNativeUsageMatrix({ silent: true }).catch(() => null);
    request.current = false;
    if (!mounted.current) return;
    if (result) setSnapshot(result);
    setError(!result);
    setBusy(false);
  }, [mounted]);
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="max-w-3xl text-sm text-gray-400">Read-only local native history. One bounded read captures all four providers. Peer reports are not collected; existing PortOS usage records remain unchanged.</p>
      <button type="button" disabled={busy} onClick={() => { void read(); }} className="inline-flex items-center gap-2 rounded-lg border border-port-border px-3 py-2 text-sm text-white hover:bg-port-border/30 disabled:opacity-50">
        {busy ? <BrailleSpinner /> : <RefreshCw size={14} aria-hidden="true" />}{busy ? 'Reading…' : snapshot ? 'Refresh native sources' : 'Read native sources'}
      </button>
    </div>
    {error && <p role="alert" className="text-sm text-port-warning">Could not read native sources. {snapshot ? 'Stale: the previous snapshot remains below. Retry to get current values.' : 'No snapshot was captured. Retry the read.'}</p>}
    {snapshot && <p className="text-xs text-gray-400">Snapshot read at {formatDateTime(snapshot.capturedAt ?? snapshot.generatedAt, 'Unknown')} · Local instance only</p>}
    <Findings findings={snapshot?.refusals?.map(({ code, family }) => `${family ?? 'All providers'}: ${code}`)} />
    <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-2">
      {FAMILIES.map(row => <SourceCard key={row.family} {...row} scanned={snapshot !== null} provider={snapshot?.providers?.find(provider => provider.family === row.family)} matrix={snapshot?.families?.find(family => family.family === row.family)} />)}
    </div>
  </div>;
}
