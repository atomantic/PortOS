import { useState, useEffect, useRef, useMemo } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import * as api from '../../services/api';
import MetricCard from './MetricCard';
import SleepCard from './SleepCard';

export default function HealthCategorySection({ category, from, to, expanded, onToggle, availableMetrics }) {
  const [metricData, setMetricData] = useState({});
  const [latestValues, setLatestValues] = useState({});
  const [loading, setLoading] = useState(false);
  const lastRangeRef = useRef(null);

  // Filter to only metrics that have data — stabilize the key list for deps
  const activeMetrics = category.metrics.filter(m => availableMetrics.has(m.key));
  const activeMetricKeys = useMemo(
    () => activeMetrics.map(m => m.key).join(','),
    [activeMetrics]
  );
  const rangeKey = `${from}|${to}`;

  const cacheKey = `${rangeKey}|${activeMetricKeys}`;

  useEffect(() => {
    if (!expanded || !from || !to || !activeMetricKeys) return;
    if (lastRangeRef.current === cacheKey) return;

    const keys = activeMetricKeys.split(',');
    let cancelled = false;
    setLoading(true);

    Promise.all(
      keys.map(key =>
        api.getAppleHealthMetrics(key, from, to)
          .then(data => ({ key, data: Array.isArray(data) ? data : [] }))
          .catch(() => ({ key, data: [] }))
      )
    ).then(results => {
      if (cancelled) return;
      const dataMap = {};
      const emptyMetrics = [];
      for (const r of results) {
        dataMap[r.key] = r.data;
        if (r.data.length === 0) emptyMetrics.push(r.key);
      }
      setMetricData(dataMap);
      lastRangeRef.current = cacheKey;
      setLoading(false);

      // Fetch latest values for metrics with no data in this range
      if (emptyMetrics.length > 0) {
        api.getLatestHealthMetrics(emptyMetrics)
          .then(latest => { if (!cancelled) setLatestValues(prev => ({ ...prev, ...latest })); })
          .catch(err => console.warn('fetch latest health metrics:', err?.message ?? String(err)));
      }
    });

    return () => { cancelled = true; };
  }, [activeMetricKeys, cacheKey, expanded, from, to]);

  if (activeMetrics.length === 0) return null;

  return (
    <div className="border border-port-border rounded-xl overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-6 py-4 bg-port-card hover:bg-port-border/30 transition-colors"
      >
        <div className="flex items-center gap-3">
          {expanded ? <ChevronDown size={16} className="text-gray-400" /> : <ChevronRight size={16} className="text-gray-400" />}
          <h2 className="text-sm font-semibold text-white uppercase tracking-wider">{category.label}</h2>
          <span className="text-xs text-gray-500">{activeMetrics.length} metrics</span>
        </div>
      </button>

      {expanded && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 p-6 bg-port-bg">
          {activeMetrics.map(metric =>
            metric.key === 'sleep_analysis' ? (
              <SleepCard key={metric.key} data={metricData[metric.key] ?? []} loading={loading} />
            ) : (
              <MetricCard
                key={metric.key}
                data={metricData[metric.key] ?? []}
                loading={loading}
                config={metric}
                latestValue={latestValues[metric.key] ?? null}
              />
            )
          )}
        </div>
      )}
    </div>
  );
}
