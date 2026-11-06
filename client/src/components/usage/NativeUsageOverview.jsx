import { useCallback, useEffect, useRef, useState } from 'react';
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

function SourceCard({ row, busy, error, onRead }) {
  const { family, label, native, legacy } = row;
  const account = family === 'codex';
  const read = native?.status === 'available' || native?.status === 'partial';
  const total = account ? native?.summary?.lifetimeTokens : native?.summary?.totalTokens;
  const coverage = native?.coverage;
  return (
    <section aria-label={`${label} native history`} className="min-w-0 rounded-xl border border-port-border bg-port-card p-3 sm:p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold text-white">{label}</h2>
        <button type="button" disabled={busy} onClick={onRead} className="inline-flex items-center gap-2 rounded-lg border border-port-border px-3 py-2 text-sm text-white hover:bg-port-border/30 disabled:opacity-50">
          {busy ? <BrailleSpinner /> : <RefreshCw size={14} aria-hidden="true" />}
          {busy ? 'Reading…' : account ? 'Refresh Codex' : `Read ${label} history`}
        </button>
      </div>
      <p className="text-xs text-gray-400">{account ? 'Currently signed-in Codex account · all devices in its reported scope' : 'Native files retained on this instance · account identity unverified'}</p>
      {error && <p role="alert" className="text-sm text-port-warning">{error} {read ? 'The previous snapshot remains below.' : ''}</p>}
      {read ? <>
        <div><p className="text-xs text-gray-400">{account ? 'Native lifetime tokens' : 'Measured retained tokens'}</p><p className="text-2xl font-semibold tabular-nums text-white">{unknownCount(total)}</p></div>
        {native.status === 'partial' && <p className="text-sm text-port-warning">Partial source coverage. This is not a complete usage total.</p>}
        {native.reason && <p className="text-xs text-gray-400">{native.reason}</p>}
        <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
          <div><dt className="text-gray-500">Read at</dt><dd className="text-gray-300">{formatDateTime(native.fetchedAt, 'Unknown')}</dd></div>
          <div><dt className="text-gray-500">Cost</dt><dd className="text-gray-300">Unknown · tokens are not a bill</dd></div>
          {account && <div><dt className="text-gray-500">Latest reported day</dt><dd className="text-gray-300">{formatDateNumeric(native.latestReportedDay, 'Unknown')}</dd></div>}
        </dl>
        {account && <DailyHistory buckets={native.dailyUsageBuckets} />}
      </> : <p className="text-sm text-gray-400">{native?.reason || (account ? 'Read the native account snapshot to see its history.' : 'Not scanned yet. Read retained native files without changing your usage records.')}</p>}
      {native?.status === 'unavailable' && <p className="text-sm text-port-warning">History unavailable. Check the source and retry the read.</p>}
      {coverage && <p className="text-xs text-gray-400">
          {formatCount(coverage.files)} files · {formatCount(coverage.measuredRecords)} measured records · {formatCount(coverage.missingUsageRecords)} missing usage · {formatCount(coverage.conflictingRecords)} conflicts · {formatCount(coverage.unreadableFiles)} unreadable files · {formatCount(coverage.invalidLines)} invalid lines
        {coverage.capped ? ' · scan limit reached' : ''}. Retention and completeness are unknown.
        </p>}
      {account && native?.status === 'unavailable' && <Link className="inline-flex rounded border border-port-border px-3 py-2 text-sm text-port-accent" to="/ai/services">Check Codex connection</Link>}
      <p className="text-xs text-gray-500">{account ? 'Account total is shown once, never summed across instances.' : 'Local retained records are not an account-wide total and are not summed across instances.'}</p>
      {legacy && <details className="border-t border-port-border pt-2 text-xs text-gray-400"><summary className="cursor-pointer">Legacy ledger comparison</summary><p className="mt-2">This instance recorded {unknownCount(legacy.tokens)} tokens ({legacy.provenance?.join(', ') || 'unknown provenance'}). Its scope does not match this native source. No difference is treated as a correction, and the counts are never added.</p></details>}
    </section>
  );
}

export default function NativeUsageOverview() {
  const [rows, setRows] = useState(FAMILIES);
  const [busy, setBusy] = useState({});
  const [errors, setErrors] = useState({});
  const requests = useRef(new Set());
  const mounted = useMounted();
  const read = useCallback(async family => {
    if (requests.current.has(family)) return;
    requests.current.add(family);
    setBusy(previous => ({ ...previous, [family]: true }));
    setErrors(previous => ({ ...previous, [family]: null }));
    const result = await api.getNativeUsageCoverage({ family }, { silent: true }).catch(() => null);
    requests.current.delete(family);
    if (!mounted.current) return;
    const row = result?.providers?.find(candidate => candidate.family === family);
    if (row) setRows(previous => previous.map(candidate => candidate.family === family ? row : candidate));
    else setErrors(previous => ({ ...previous, [family]: `Could not read ${FAMILIES.find(candidate => candidate.family === family)?.label} history.` }));
    setBusy(previous => ({ ...previous, [family]: false }));
  }, [mounted]);
  useEffect(() => { void read('codex'); }, [read]);
  return <div className="space-y-4">
    <p className="max-w-3xl text-sm text-gray-400">Provider-native history is the source for these counts. Snapshots are read on demand, with gaps left unknown. Existing PortOS records remain unchanged in Legacy analytics.</p>
    <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-2">
      {rows.map(row => <SourceCard key={row.family} row={row} busy={busy[row.family]} error={errors[row.family]} onRead={() => { void read(row.family); }} />)}
    </div>
  </div>;
}
