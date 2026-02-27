import { useState, useEffect, useRef } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import * as api from '../../services/api';
import MetricCard from './MetricCard';
import SleepCard from './SleepCard';

export default function HealthCategorySection({ category, from, to, expanded, onToggle, availableMetrics }) {
  const [metricData, setMetricData] = useState({});
  const [loading, setLoading] = useState(false);
  const lastRangeRef = useRef(null);

  // Filter to only metrics that have data
  const activeMetrics = category.metrics.filter(m => availableMetrics.has(m.key));
  if (activeMetrics.length === 0) return null;

  const rangeKey = `${from}|${to}`;

  useEffect(() => {
    if (!expanded || !from || !to) return;
    if (lastRangeRef.current === rangeKey && Object.keys(metricData).length > 0) return;

    let cancelled = false;
    setLoading(true);

    Promise.all(
      activeMetrics.map(m =>
        api.getAppleHealthMetrics(m.key, from, to)
          .then(data => ({ key: m.key, data: Array.isArray(data) ? data : [] }))
          .catch(() => ({ key: m.key, data: [] }))
      )
    ).then(results => {
      if (cancelled) return;
      const dataMap = {};
      for (const r of results) dataMap[r.key] = r.data;
      setMetricData(dataMap);
      lastRangeRef.current = rangeKey;
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [expanded, rangeKey]);

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
              <MetricCard key={metric.key} data={metricData[metric.key] ?? []} loading={loading} config={metric} />
            )
          )}
        </div>
      )}
    </div>
  );
}
