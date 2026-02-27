import { useState, useEffect, useCallback } from 'react';
import { Dna } from 'lucide-react';
import * as api from '../../../services/api';
import BrailleSpinner from '../../BrailleSpinner';

export default function AgeTab() {
  const [epigeneticData, setEpigeneticData] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    const epigenetic = await api.getEpigeneticTests().catch(() => ({ tests: [] }));
    setEpigeneticData(epigenetic);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <BrailleSpinner text="Loading epigenetic data" />
      </div>
    );
  }

  const epigeneticTests = epigeneticData?.tests || [];
  const latestEpigenetic = epigeneticTests[epigeneticTests.length - 1];

  if (!latestEpigenetic) {
    return (
      <div className="bg-port-card border border-port-border rounded-xl p-6">
        <p className="text-gray-500 text-sm">No epigenetic age data. Import your health data to see results.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-port-card border border-port-border rounded-xl p-6">
        <div className="flex items-center gap-2 mb-4">
          <Dna size={18} className="text-purple-400" />
          <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Epigenetic Age</h3>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <p className="text-xs text-gray-500 uppercase">Chronological</p>
            <p className="text-2xl font-mono font-bold text-gray-300">{latestEpigenetic.chronologicalAge}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 uppercase">Biological</p>
            <p className={`text-2xl font-mono font-bold ${
              latestEpigenetic.biologicalAge < latestEpigenetic.chronologicalAge
                ? 'text-port-success' : 'text-port-error'
            }`}>
              {latestEpigenetic.biologicalAge}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-500 uppercase">Pace of Aging</p>
            <p className={`text-2xl font-mono font-bold ${
              latestEpigenetic.paceOfAging < 1 ? 'text-port-success' : 'text-port-error'
            }`}>
              {latestEpigenetic.paceOfAging}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-500 uppercase">Test Date</p>
            <p className="text-lg font-mono text-gray-400">{latestEpigenetic.date}</p>
          </div>
        </div>

        {latestEpigenetic.organScores && (
          <div className="mt-4 pt-4 border-t border-port-border">
            <p className="text-xs text-gray-500 uppercase mb-2">Organ Scores (biological age)</p>
            <div className="grid grid-cols-3 md:grid-cols-5 gap-2">
              {Object.entries(latestEpigenetic.organScores).map(([organ, age]) => (
                <div key={organ} className="flex items-baseline justify-between gap-2 px-2 py-1 rounded bg-port-bg/50">
                  <span className="text-xs text-gray-400 capitalize">{organ}</span>
                  <span className={`text-sm font-mono font-medium ${
                    age < latestEpigenetic.chronologicalAge ? 'text-port-success' : 'text-port-error'
                  }`}>
                    {age}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {epigeneticTests.length > 1 && (
          <div className="mt-4 pt-4 border-t border-port-border">
            <p className="text-xs text-gray-500 uppercase mb-2">History</p>
            <div className="space-y-1">
              {epigeneticTests.map((test, i) => (
                <div key={i} className="flex items-center gap-4 text-sm">
                  <span className="text-gray-500 font-mono w-24">{test.date}</span>
                  <span className="text-gray-400">Bio: {test.biologicalAge}</span>
                  <span className="text-gray-400">Pace: {test.paceOfAging}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
