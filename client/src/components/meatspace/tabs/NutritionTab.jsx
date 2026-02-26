import { useState, useEffect, useCallback } from 'react';
import { Apple } from 'lucide-react';
import * as api from '../../../services/api';
import BrailleSpinner from '../../BrailleSpinner';

const MACRO_LABELS = {
  calories: { label: 'Calories', unit: 'kcal', color: 'text-port-accent' },
  fatG: { label: 'Fat', unit: 'g', color: 'text-yellow-400' },
  satFatG: { label: 'Sat Fat', unit: 'g', color: 'text-yellow-500' },
  transFatG: { label: 'Trans Fat', unit: 'g', color: 'text-red-400' },
  polyFatG: { label: 'Poly Fat', unit: 'g', color: 'text-yellow-300' },
  monoFatG: { label: 'Mono Fat', unit: 'g', color: 'text-yellow-300' },
  carbG: { label: 'Carbs', unit: 'g', color: 'text-blue-400' },
  fiberG: { label: 'Fiber', unit: 'g', color: 'text-green-400' },
  sugarG: { label: 'Sugar', unit: 'g', color: 'text-pink-400' }
};

export default function NutritionTab() {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    const data = await api.getNutritionSummary().catch(() => ({
      totalEntries: 0, averages: null, recentEntries: []
    }));
    setSummary(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <BrailleSpinner text="Loading nutrition data" />
      </div>
    );
  }

  if (!summary || summary.totalEntries === 0) {
    return (
      <div className="bg-port-card border border-port-border rounded-xl p-6">
        <div className="flex items-center gap-2 mb-4">
          <Apple size={18} className="text-port-accent" />
          <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Nutrition</h3>
        </div>
        <p className="text-gray-500 text-sm">No nutrition data. Import your health spreadsheet to see macro trends.</p>
      </div>
    );
  }

  const { averages, recentEntries, totalEntries } = summary;

  return (
    <div className="space-y-6">
      {/* Averages Summary */}
      {averages && (
        <div className="bg-port-card border border-port-border rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Apple size={18} className="text-port-accent" />
              <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Daily Averages</h3>
            </div>
            <span className="text-xs text-gray-600">{totalEntries} days tracked</span>
          </div>
          <div className="grid grid-cols-3 md:grid-cols-5 gap-3">
            {Object.entries(MACRO_LABELS).map(([key, meta]) => {
              const val = averages[key];
              if (val == null) return null;
              return (
                <div key={key} className="bg-port-bg/50 rounded-lg px-3 py-2">
                  <p className="text-xs text-gray-500">{meta.label}</p>
                  <p className={`text-lg font-mono font-bold ${meta.color}`}>
                    {Math.round(val)}
                    <span className="text-xs text-gray-600 ml-1">{meta.unit}</span>
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Recent Entries */}
      {recentEntries?.length > 0 && (
        <div className="bg-port-card border border-port-border rounded-xl p-6">
          <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-4">Recent Days</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 uppercase border-b border-port-border">
                  <th className="text-left py-2 pr-3">Date</th>
                  <th className="text-right py-2 px-2">Cal</th>
                  <th className="text-right py-2 px-2">Fat</th>
                  <th className="text-right py-2 px-2">Carbs</th>
                  <th className="text-right py-2 px-2">Fiber</th>
                  <th className="text-right py-2 px-2">Sugar</th>
                </tr>
              </thead>
              <tbody>
                {recentEntries.map(entry => (
                  <tr key={entry.date} className="border-b border-port-border/50">
                    <td className="py-1.5 pr-3 font-mono text-gray-400">{entry.date}</td>
                    <td className="py-1.5 px-2 text-right font-mono text-gray-300">
                      {entry.nutrition?.calories ?? '—'}
                    </td>
                    <td className="py-1.5 px-2 text-right font-mono text-gray-300">
                      {entry.nutrition?.fatG ?? '—'}
                    </td>
                    <td className="py-1.5 px-2 text-right font-mono text-gray-300">
                      {entry.nutrition?.carbG ?? '—'}
                    </td>
                    <td className="py-1.5 px-2 text-right font-mono text-gray-300">
                      {entry.nutrition?.fiberG ?? '—'}
                    </td>
                    <td className="py-1.5 px-2 text-right font-mono text-gray-300">
                      {entry.nutrition?.sugarG ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
