import { formatCount } from '../../utils/formatters';

export default function ComparisonMetricEvidence({ metric }) {
  if (!metric) return <span>Needs research</span>;
  return <details><summary className="cursor-pointer">{metric.sources.length ? <>{metric.estimated ? 'Estimated' : 'Sourced'} · {formatCount(metric.sources.length)} references</> : 'Configured cost'}</summary>
    <p className="my-2 max-w-xl whitespace-normal text-port-text-muted">{metric.method}</p>
    <ul className="space-y-1">{metric.sources.map(source => <li key={source.url + source.retrievedAt}><a className="text-port-accent underline break-all" href={source.url} target="_blank" rel="noreferrer">{new URL(source.url).hostname}</a> · {source.retrievedAt.slice(0, 10)}<p className="max-w-xl whitespace-normal text-port-text-muted">{source.methodology}</p></li>)}</ul>
  </details>;
}
