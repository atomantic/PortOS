import { useCallback, useEffect, useState } from 'react';
import { Activity, AlertTriangle, RefreshCw, Server } from 'lucide-react';
import { getFleetLlmHostUsage } from '../../services/apiProviders';
import { useAutoRefetch } from '../../hooks/useAutoRefetch';
import { formatCount, formatDurationMs, timeAgo } from '../../utils/formatters';
import Banner from '../ui/Banner';

/**
 * Who is using this machine's GPU.
 *
 * The host's own status card already answers "am I serving?" with a queue
 * depth. This answers the question underneath it — WHICH machine is spending
 * the GPU, how much of it, and when — because on a shared host the depth alone
 * cannot tell an operator whether their own agent or a federated peer is the
 * reason a generation is waiting.
 *
 * Every client is keyed by its address; the label beside it is resolved on the
 * server from the peer list or the tailnet. A caller matching neither is shown
 * as unrecognized rather than hidden, which is the case worth seeing.
 */
export default function FleetHostUsage({ pollMs = 10000 }) {
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    // Silent: this panel polls, and a transient failure belongs in its own
    // inline banner rather than in a toast every ten seconds.
    getFleetLlmHostUsage({ silent: true })
      .then((value) => { setReport(value); setError(''); })
      .catch(() => setError('Could not read this host\'s usage. It is still serving — only the report is unavailable.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);
  useAutoRefetch(load, pollMs, { pollOnly: true, immediate: false });

  const clients = report?.clients || [];
  const totals = report?.totals;

  return (
    <section className="space-y-3 text-sm" aria-label="Model host usage">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium flex items-center gap-2"><Activity size={16} className="text-port-accent" />Who is using this host</h3>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 text-gray-400 hover:text-white"
          title="Refresh host usage"
          aria-label="Refresh host usage"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {error && <Banner tone="error">{error}</Banner>}

      {report && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Stat label="Generating now" value={formatCount(report.activeRequests, { fallback: '0' })} accent={report.activeRequests > 0} />
            <Stat label="Waiting" value={formatCount(report.queue?.queued ?? 0, { fallback: '0' })} />
            <Stat label="Requests served" value={formatCount(totals?.requests, { fallback: '0' })} />
            <Stat
              label="Tokens generated"
              value={formatCount(totals?.completionTokens, { fallback: '0' })}
              note={totals?.requests > 0 && totals.tokenReports < totals.requests
                ? `${formatCount(totals.tokenReports, { fallback: '0' })} of ${formatCount(totals.requests, { fallback: '0' })} reported counts`
                : null}
            />
          </div>

          {clients.length === 0 ? (
            <p className="text-xs text-gray-400">
              No machine has called this host yet. Counts start at the first request and are kept for 30 days.
            </p>
          ) : (
            <ul className="space-y-2">
              {clients.map((client) => (
                <li key={client.address} className="rounded-lg border border-port-border bg-port-bg p-3 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    {client.activeRequests > 0
                      ? <span className="flex h-2 w-2 rounded-full bg-port-success animate-pulse shrink-0" title="Generating right now" />
                      : <span className="flex h-2 w-2 rounded-full bg-port-border shrink-0" />}
                    <Server size={14} className="text-port-accent shrink-0" />
                    <span className="text-white truncate">{client.label || client.address}</span>
                    {!client.known && (
                      <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-port-warning/20 text-port-warning" title="This address matches no federated peer and no node on this tailnet">
                        <AlertTriangle size={11} />Unrecognized
                      </span>
                    )}
                    {client.activeRequests > 0 && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-port-success/20 text-port-success">
                        {formatCount(client.activeRequests, { fallback: '0' })} generating
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-400">
                    {formatCount(client.requests, { fallback: '0' })} requests
                    {' · '}{formatCount(client.promptTokens, { fallback: '0' })} prompt / {formatCount(client.completionTokens, { fallback: '0' })} generated tokens
                    {client.tokenReports < client.requests && ` (counts from ${formatCount(client.tokenReports, { fallback: '0' })})`}
                    {client.errors > 0 && ` · ${formatCount(client.errors, { fallback: '0' })} failed`}
                    {' · last used '}{timeAgo(client.lastSeen)}
                  </p>
                  {client.models.length > 0 && (
                    <p className="text-xs text-gray-500 truncate">Models: {client.models.join(', ')}</p>
                  )}
                </li>
              ))}
            </ul>
          )}

          {report.recent.length > 0 && (
            <details className="rounded-lg border border-port-border bg-port-bg p-3">
              <summary className="cursor-pointer text-xs text-gray-400">Recent requests ({formatCount(report.recent.length, { fallback: '0' })})</summary>
              <ul className="mt-2 space-y-1">
                {report.recent.map((event) => (
                  <li key={event.id} className="text-xs text-gray-400 flex flex-wrap gap-x-2">
                    <span className="text-gray-300">{event.label || event.address}</span>
                    <span>{timeAgo(event.finishedAt)}</span>
                    <span>{formatDurationMs(event.durationMs)}</span>
                    {/* Null means the response reported no counts, which is not the same as zero. */}
                    <span>{event.completionTokens === null ? 'tokens not reported' : `${formatCount(event.completionTokens, { fallback: '0' })} tokens`}</span>
                    {typeof event.status === 'number' && event.status >= 400 && (
                      <span className="text-port-warning">HTTP {event.status}</span>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <p className="text-xs text-gray-500">
            Counted at the shared API queue, so it covers every machine using this host — including this one. Token counts come from the model's own reply and are missing for a streamed request whose client did not ask for them. Nothing from a request or its response is stored.
          </p>
        </>
      )}
    </section>
  );
}

function Stat({ label, value, note, accent = false }) {
  return (
    <div className="rounded-lg border border-port-border bg-port-bg px-3 py-2">
      <p className={`text-lg font-semibold ${accent ? 'text-port-success' : 'text-white'}`}>{value}</p>
      <p className="text-xs text-gray-400">{label}</p>
      {note && <p className="text-[11px] text-gray-500 mt-0.5">{note}</p>}
    </div>
  );
}
