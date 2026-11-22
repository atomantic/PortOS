import { formatCount, formatDate } from '../../utils/formatters';

// A local measurement cites an in-app path (`/models/performance/results`), which `new URL` rejects
// without a base; name it as this machine instead of throwing out of the evidence table.
const sourceName = url => {
  try { return new URL(url).hostname; } catch { return 'This machine'; }
};

export default function ComparisonMetricEvidence({ metric }) {
  if (!metric) return <span>Needs research</span>;
  return <details><summary className="cursor-pointer">{metric.sources.length ? <>{metric.estimated ? 'Estimated' : 'Sourced'} · {formatCount(metric.sources.length)} references</> : 'Configured cost'}</summary>
    <p className="my-2 max-w-xl whitespace-normal text-port-text-muted">{metric.method}</p>
    <ul className="space-y-1">{metric.sources.map(source => <li key={source.url + source.retrievedAt}><a className="text-port-accent underline break-all" href={source.url} target="_blank" rel="noreferrer">{sourceName(source.url)}</a> · {formatDate(source.retrievedAt) || 'date not recorded'}<p className="max-w-xl whitespace-normal text-port-text-muted">{source.methodology}</p></li>)}</ul>
  </details>;
}
