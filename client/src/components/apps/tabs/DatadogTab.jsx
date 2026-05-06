import { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw, AlertTriangle, Clock, ExternalLink } from 'lucide-react';
import BrailleSpinner from '../../BrailleSpinner';
import * as api from '../../../services/api';

const TIME_RANGES = [
  { value: '1h', label: 'Last 1 hour', ms: 60 * 60 * 1000 },
  { value: '6h', label: 'Last 6 hours', ms: 6 * 60 * 60 * 1000 },
  { value: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60 * 1000 },
  { value: '7d', label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
];

export default function DatadogTab({ app }) {
  const [errors, setErrors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [timeRange, setTimeRange] = useState('24h');
  const [expandedErrorId, setExpandedErrorId] = useState(null);
  const [ddSite, setDdSite] = useState(null);
  const abortRef = useRef(null);

  const dd = app?.datadog;
  const configured = dd?.enabled && dd?.instanceId && dd?.serviceName && dd?.environment;

  useEffect(() => {
    // Always reset on instance change so the previous app's site doesn't linger.
    setDdSite(null);
    if (!dd?.instanceId) return;
    let cancelled = false;
    api.getDatadogInstances().then(res => {
      if (cancelled) return;
      const inst = (res.instances || {})[dd.instanceId];
      if (inst?.site) setDdSite(inst.site);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [dd?.instanceId]);

  const fetchErrors = useCallback(async () => {
    if (!dd?.enabled || !dd?.instanceId || !dd?.serviceName || !dd?.environment) { setLoading(false); return; }
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setFetchFailed(false);
    const range = TIME_RANGES.find(r => r.value === timeRange);
    const fromTime = new Date(Date.now() - range.ms).toISOString();
    const result = await api.searchDatadogErrors(dd.instanceId, dd.serviceName, dd.environment, fromTime, { signal: controller.signal, silent: true }).catch(err => {
      if (err.name === 'AbortError') return 'aborted';
      return null;
    });
    if (controller.signal.aborted) return;
    if (result === 'aborted') return;
    if (result) {
      setErrors(result.data || []);
    } else {
      setFetchFailed(true);
    }
    setLoading(false);
  }, [dd?.enabled, dd?.instanceId, dd?.serviceName, dd?.environment, timeRange]);

  useEffect(() => {
    fetchErrors();
    return () => { if (abortRef.current) abortRef.current.abort(); };
  }, [fetchErrors]);

  if (!configured) {
    return (
      <div className="p-6 text-center">
        <AlertTriangle size={32} className="mx-auto text-port-warning mb-3" />
        <p className="text-gray-400 mb-2">DataDog monitoring is not configured for this app.</p>
        <p className="text-gray-500 text-sm">
          Enable DataDog in the app settings and set a Service Name and Environment.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">DataDog Errors</h2>
          <p className="text-sm text-gray-400">
            Service: <span className="text-gray-300">{dd.serviceName}</span>
            {' '}&middot; Env: <span className="text-gray-300">{dd.environment}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={timeRange}
            onChange={e => setTimeRange(e.target.value)}
            aria-label="Error time range"
            className="px-3 py-1.5 bg-port-bg border border-port-border rounded-lg text-sm text-white focus:border-port-accent focus:outline-hidden"
          >
            {TIME_RANGES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          <button
            type="button"
            onClick={fetchErrors}
            disabled={loading}
            aria-label="Refresh errors"
            className="p-2 bg-port-bg border border-port-border rounded-lg text-gray-400 hover:text-white hover:border-port-accent transition-colors disabled:opacity-50"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {loading ? (
        <BrailleSpinner text="Fetching errors from DataDog" />
      ) : fetchFailed ? (
        <div className="p-8 text-center bg-port-card border border-port-border rounded-lg">
          <AlertTriangle size={24} className="mx-auto text-port-error mb-2" />
          <p className="text-port-error font-medium">Failed to fetch errors</p>
          <p className="text-gray-500 text-sm mt-1">Could not reach DataDog. Check the instance configuration.</p>
        </div>
      ) : errors.length === 0 ? (
        <div className="p-8 text-center bg-port-card border border-port-border rounded-lg">
          <p className="text-port-success font-medium">No errors found</p>
          <p className="text-gray-500 text-sm mt-1">No error-level logs in the selected time range.</p>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-gray-400">
            {errors.length} error{errors.length !== 1 ? 's' : ''} found
            {errors.length >= 100 && <span className="text-port-warning ml-1">(results may be truncated)</span>}
          </p>
          {errors.map((err, idx) => {
            const attrs = err.attributes || {};
            const errId = err.id || attrs.timestamp || `${attrs.message}-${idx}`;
            const message = attrs.message || attrs.attributes?.message || 'Unknown error';
            const timestamp = attrs.timestamp || err.id?.split?.('-')?.[0];
            const service = attrs.service || dd.serviceName;
            const status = attrs.status || 'error';
            const expanded = expandedErrorId === errId;

            return (
              <div
                key={errId}
                className="bg-port-card border border-port-border rounded-lg overflow-hidden"
              >
                <button
                  type="button"
                  onClick={() => setExpandedErrorId(expanded ? null : errId)}
                  aria-expanded={expanded}
                  className="w-full text-left px-4 py-3 hover:bg-port-border/30 transition-colors"
                >
                  <div className="flex items-start gap-3">
                    <AlertTriangle size={16} className="text-port-error mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white truncate">{message}</p>
                      <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                        {timestamp && (
                          <span className="flex items-center gap-1">
                            <Clock size={12} />
                            {new Date(timestamp).toLocaleString()}
                          </span>
                        )}
                        <span className="px-1.5 py-0.5 bg-port-error/20 text-port-error rounded">{status}</span>
                        <span className="text-gray-600">{service}</span>
                      </div>
                    </div>
                  </div>
                </button>

                {expanded && (
                  <div className="px-4 py-3 border-t border-port-border bg-port-bg">
                    <pre className="text-xs text-gray-300 whitespace-pre-wrap break-words max-h-64 overflow-auto">
                      {JSON.stringify(attrs, null, 2)}
                    </pre>
                    {attrs.attributes?.['dd.trace_id'] && ddSite && (
                      <a
                        href={`https://${ddSite.replace(/^api\./, 'app.')}/apm/trace/${attrs.attributes['dd.trace_id']}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 mt-2 text-xs text-port-accent hover:underline"
                      >
                        <ExternalLink size={12} /> View Trace in DataDog
                      </a>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
