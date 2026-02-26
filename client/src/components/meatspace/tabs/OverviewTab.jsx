import { useState, useEffect, useCallback } from 'react';
import * as api from '../../../services/api';
import DeathClockCountdown from '../DeathClockCountdown';
import LEVTracker from '../LEVTracker';
import BrailleSpinner from '../../BrailleSpinner';

export default function OverviewTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    const result = await api.getMeatspaceOverview().catch(() => null);
    setData(result);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, [fetchData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <BrailleSpinner text="Loading" />
      </div>
    );
  }

  if (!data) {
    return <p className="text-gray-500">Failed to load overview data.</p>;
  }

  const { deathClock, lev, summary } = data;

  return (
    <div className="space-y-6">
      {/* Death Clock */}
      {deathClock?.error ? (
        <div className="bg-port-card border border-port-border rounded-xl p-6">
          <p className="text-port-warning">{deathClock.error}</p>
        </div>
      ) : (
        <DeathClockCountdown
          deathDate={deathClock?.deathDate}
          lifeExpectancy={deathClock?.lifeExpectancy}
          percentComplete={deathClock?.percentComplete}
        />
      )}

      {/* LEV Tracker */}
      <LEVTracker lev={lev} />

      {/* Health Summary */}
      <div className="bg-port-card border border-port-border rounded-xl p-6">
        <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-4">Data Summary</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <span className="text-xs text-gray-500">Daily Entries</span>
            <p className="text-2xl font-bold text-white">{summary?.totalEntries || 0}</p>
          </div>
          <div>
            <span className="text-xs text-gray-500">Last Entry</span>
            <p className="text-lg font-semibold text-gray-300">{summary?.lastEntryDate || 'None'}</p>
          </div>
          <div>
            <span className="text-xs text-gray-500">Genome Data</span>
            <p className={`text-lg font-semibold ${summary?.hasGenomeData ? 'text-port-success' : 'text-gray-500'}`}>
              {summary?.hasGenomeData ? 'Active' : 'Missing'}
            </p>
          </div>
          <div>
            <span className="text-xs text-gray-500">Lifestyle Profile</span>
            <p className={`text-lg font-semibold ${summary?.hasLifestyleData ? 'text-port-success' : 'text-gray-500'}`}>
              {summary?.hasLifestyleData ? 'Active' : 'Not Set'}
            </p>
          </div>
        </div>
      </div>

      {/* Quick Info */}
      {deathClock && !deathClock.error && (
        <div className="bg-port-card border border-port-border rounded-xl p-6">
          <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-4">Vitals</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <div>
              <span className="text-xs text-gray-500">Current Age</span>
              <p className="text-xl font-bold text-white">{deathClock.ageYears}y</p>
            </div>
            <div>
              <span className="text-xs text-gray-500">Years Remaining</span>
              <p className="text-xl font-bold text-port-warning">{deathClock.yearsRemaining}y</p>
            </div>
            <div>
              <span className="text-xs text-gray-500">Healthy Years</span>
              <p className="text-xl font-bold text-port-success">{deathClock.healthyYearsRemaining}y</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
