import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Skull } from 'lucide-react';
import * as api from '../services/api';
import DeathClockCountdown from './DeathClockCountdown';

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
      <DeathClockCountdown deathDate={deathData.deathDate} size="sm" />
      <div className="mt-2 flex justify-between text-xs">
        <span className="text-gray-600">LE: {deathData.lifeExpectancy?.total}y</span>
        <span className="text-gray-600">{deathData.percentComplete}% complete</span>
      </div>
    </Link>
  );
}
