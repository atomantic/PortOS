import { useState, useEffect, useCallback } from 'react';
import { Dna, Calendar, Pencil, Check, X } from 'lucide-react';
import * as api from '../../../services/api';
import BrailleSpinner from '../../BrailleSpinner';

function BirthDateSection({ birthDate, onUpdate }) {
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState(birthDate || '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing) setInput(birthDate || '');
  }, [birthDate, editing]);

  const handleSave = async () => {
    if (!input) return;
    setSaving(true);
    const result = await api.setMeatspaceBirthDate(input).catch(() => null);
    setSaving(false);
    if (result) {
      onUpdate(input);
      setEditing(false);
    }
  };

  const handleCancel = () => {
    setInput(birthDate || '');
    setEditing(false);
  };

  const age = birthDate ? (() => {
    const birth = new Date(birthDate);
    const now = new Date();
    const years = (now - birth) / (365.25 * 24 * 60 * 60 * 1000);
    return Math.floor(years);
  })() : null;

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-6">
      <div className="flex items-center gap-2 mb-4">
        <Calendar size={18} className="text-port-accent" />
        <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Birth Date</h3>
      </div>
      {editing ? (
        <div className="flex items-center gap-3">
          <input
            type="date"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="bg-port-bg border border-port-border rounded px-3 py-2 text-white font-mono text-lg focus:border-port-accent focus:outline-none"
          />
          <button
            onClick={handleSave}
            disabled={saving || !input}
            className="p-2 rounded bg-port-success/20 text-port-success hover:bg-port-success/30 disabled:opacity-50"
          >
            <Check size={16} />
          </button>
          <button
            onClick={handleCancel}
            className="p-2 rounded bg-port-error/20 text-port-error hover:bg-port-error/30"
          >
            <X size={16} />
          </button>
        </div>
      ) : birthDate ? (
        <div className="flex items-center gap-4">
          <div>
            <p className="text-2xl font-mono font-bold text-white">{birthDate}</p>
            {age != null && (
              <p className="text-sm text-gray-500 mt-1">Chronological age: {age} years</p>
            )}
          </div>
          <button
            onClick={() => setEditing(true)}
            className="p-2 rounded text-gray-500 hover:text-gray-300 hover:bg-port-border/50"
          >
            <Pencil size={14} />
          </button>
        </div>
      ) : (
        <div>
          <p className="text-gray-500 text-sm mb-3">No birth date set. Required for life calendar and death clock calculations.</p>
          <button
            onClick={() => setEditing(true)}
            className="px-4 py-2 rounded bg-port-accent/20 text-port-accent hover:bg-port-accent/30 text-sm"
          >
            Set Birth Date
          </button>
        </div>
      )}
    </div>
  );
}

export default function AgeTab() {
  const [birthDate, setBirthDate] = useState(null);
  const [epigeneticData, setEpigeneticData] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    const [birthResult, epigenetic] = await Promise.all([
      api.getMeatspaceBirthDate().catch(() => ({ birthDate: null })),
      api.getEpigeneticTests().catch(() => ({ tests: [] }))
    ]);
    setBirthDate(birthResult?.birthDate || null);
    setEpigeneticData(epigenetic);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <BrailleSpinner text="Loading age data" />
      </div>
    );
  }

  const epigeneticTests = epigeneticData?.tests || [];
  const latestEpigenetic = epigeneticTests[epigeneticTests.length - 1];

  return (
    <div className="space-y-6">
      <BirthDateSection
        birthDate={birthDate}
        onUpdate={(newDate) => setBirthDate(newDate)}
      />

      {latestEpigenetic ? (
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
      ) : (
        <div className="bg-port-card border border-port-border rounded-xl p-6">
          <p className="text-gray-500 text-sm">No epigenetic age data. Import your health data to see results.</p>
        </div>
      )}
    </div>
  );
}
