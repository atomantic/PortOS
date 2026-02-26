import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Skull } from 'lucide-react';
import * as api from '../services/api';
import { useDeathClock } from '../hooks/useDeathClock';

export default function DeathClockWidget() {
  const [deathData, setDeathData] = useState(null);
  const [loaded, setLoaded] = useState(false);

  const fetchData = useCallback(async () => {
    const data = await api.getDeathClock().catch(() => null);
    setDeathData(data);
    setLoaded(true);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const countdown = useDeathClock(deathData?.deathDate);

  if (!loaded || deathData?.error || !deathData?.deathDate) return null;

  return (
    <Link
      to="/meatspace/overview"
      className="bg-port-card border border-port-border rounded-xl p-4 h-full block hover:border-gray-600 transition-colors"
    >
      <div className="flex items-center gap-2 mb-3">
        <Skull size={16} className="text-gray-500" />
        <h3 className="text-sm font-semibold text-white">Death Clock</h3>
      </div>
      {countdown && (
        <div className="flex gap-2 text-center">
          <TimeUnit value={countdown.years} label="yr" />
          <TimeUnit value={countdown.months} label="mo" />
          <TimeUnit value={countdown.days} label="d" />
          <TimeUnit value={countdown.hours} label="h" />
          <TimeUnit value={countdown.minutes} label="m" />
          <TimeUnit value={countdown.seconds} label="s" />
        </div>
      )}
      <div className="mt-2 flex justify-between text-xs">
        <span className="text-gray-600">LE: {deathData.lifeExpectancy?.total}y</span>
        <span className="text-gray-600">{deathData.percentComplete}% complete</span>
      </div>
    </Link>
  );
}

function TimeUnit({ value, label }) {
  return (
    <div className="flex-1">
      <div className="text-lg font-mono font-bold text-gray-300">{value}</div>
      <div className="text-xs text-gray-600">{label}</div>
    </div>
  );
}
