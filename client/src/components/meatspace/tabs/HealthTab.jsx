import { useState, useEffect, useCallback } from 'react';
import * as api from '../../../services/api';
import StepsCard from '../StepsCard';
import HeartRateCard from '../HeartRateCard';
import SleepCard from '../SleepCard';
import HrvCard from '../HrvCard';

const RANGES = [
  { id: '7d', label: '7d', days: 7 },
  { id: '30d', label: '30d', days: 30 },
  { id: '90d', label: '90d', days: 90 },
  { id: '1y', label: '1y', days: 365 }
];

function getFromDate(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
}

export default function HealthTab() {
  const [range, setRange] = useState('7d');
  const [stepsData, setStepsData] = useState([]);
  const [hrData, setHrData] = useState([]);
  const [sleepData, setSleepData] = useState([]);
  const [hrvData, setHrvData] = useState([]);
  const [correlationData, setCorrelationData] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const days = RANGES.find(r => r.id === range)?.days ?? 7;
    const from = getFromDate(days);
    const to = new Date().toISOString().split('T')[0];

    const [steps, hr, sleep, hrv, correlation] = await Promise.all([
      api.getAppleHealthMetrics('step_count', from, to).catch(() => []),
      api.getAppleHealthMetrics('heart_rate', from, to).catch(() => []),
      api.getAppleHealthMetrics('sleep_analysis', from, to).catch(() => []),
      api.getAppleHealthMetrics('heart_rate_variability_sdnn', from, to).catch(() => []),
      api.getAppleHealthCorrelation(from, to).catch(() => null)
    ]);

    setStepsData(Array.isArray(steps) ? steps : []);
    setHrData(Array.isArray(hr) ? hr : []);
    setSleepData(Array.isArray(sleep) ? sleep : []);
    setHrvData(Array.isArray(hrv) ? hrv : []);
    setCorrelationData(correlation);
    setLoading(false);
  }, [range]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return (
    <div className="space-y-6">
      {/* Range selector */}
      <div className="flex items-center gap-1">
        {RANGES.map(r => (
          <button
            key={r.id}
            onClick={() => setRange(r.id)}
            className={`px-3 py-1.5 text-sm rounded-lg transition-colors font-medium ${
              range === r.id
                ? 'bg-port-accent/10 text-port-accent'
                : 'text-gray-400 hover:text-white hover:bg-port-border/50'
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>

      {/* Metric cards — 2-column grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <StepsCard data={stepsData} loading={loading} />
        <HeartRateCard data={hrData} loading={loading} />
        <SleepCard data={sleepData} loading={loading} />
        <HrvCard data={hrvData} loading={loading} />
      </div>

      {/* Correlation charts — wired in Task 2 */}
      <div />
    </div>
  );
}
