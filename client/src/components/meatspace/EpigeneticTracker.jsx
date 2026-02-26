import { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import {
  Plus, RefreshCw, Trash2, ChevronDown, ChevronRight,
  Activity, Pill, Heart, CheckCircle, Calendar, FlameKindling
} from 'lucide-react';
import * as api from '../../services/api';

const CATEGORY_ICONS = {
  supplement: Pill,
  lifestyle: Heart,
  custom: Activity
};

const EVIDENCE_COLORS = {
  strong: 'bg-green-500/20 text-green-400 border-green-500/30',
  moderate: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  emerging: 'bg-blue-500/20 text-blue-400 border-blue-500/30'
};

export default function EpigeneticTracker({ markerCategories = [] }) {
  const [interventions, setInterventions] = useState({});
  const [recommendations, setRecommendations] = useState([]);
  const [compliance, setCompliance] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [expandedRecs, setExpandedRecs] = useState({});
  const [expandedTracked, setExpandedTracked] = useState({});
  const [logAmounts, setLogAmounts] = useState({});
  const [loggingId, setLoggingId] = useState(null);

  // Custom intervention form
  const [customForm, setCustomForm] = useState({
    name: '', category: 'supplement', dosage: '', frequency: 'daily', trackingUnit: 'mg', notes: ''
  });

  const fetchData = useCallback(async () => {
    const [intData, recData, compData] = await Promise.all([
      api.getEpigeneticInterventions().catch(() => ({ interventions: {} })),
      api.getEpigeneticRecommendations(markerCategories).catch(() => ({ recommendations: [] })),
      api.getEpigeneticCompliance(30).catch(() => null)
    ]);
    setInterventions(intData.interventions || {});
    setRecommendations(recData.recommendations || []);
    setCompliance(compData);
    setLoading(false);
  }, [markerCategories]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleAddCurated = useCallback(async (rec) => {
    const result = await api.addEpigeneticIntervention({
      id: rec.id,
      name: rec.name,
      category: rec.category,
      dosage: rec.dosageRange?.optimal || '',
      frequency: 'daily',
      trackingUnit: rec.trackingUnit,
      notes: ''
    }).catch(() => null);
    if (result) {
      toast.success(`Tracking ${rec.name}`);
      await fetchData();
    }
  }, [fetchData]);

  const handleAddCustom = useCallback(async () => {
    if (!customForm.name.trim()) {
      toast.error('Name is required');
      return;
    }
    const result = await api.addEpigeneticIntervention(customForm).catch(() => null);
    if (result) {
      toast.success(`Tracking ${customForm.name}`);
      setCustomForm({ name: '', category: 'supplement', dosage: '', frequency: 'daily', trackingUnit: 'mg', notes: '' });
      setShowAdd(false);
      await fetchData();
    }
  }, [customForm, fetchData]);

  const handleLog = useCallback(async (id) => {
    const amount = parseFloat(logAmounts[id]);
    if (isNaN(amount) || amount < 0) {
      toast.error('Enter a valid amount');
      return;
    }
    setLoggingId(id);
    const result = await api.logEpigeneticEntry(id, { amount }).catch(() => null);
    if (result) {
      toast.success('Logged');
      setLogAmounts(prev => ({ ...prev, [id]: '' }));
      await fetchData();
    }
    setLoggingId(null);
  }, [logAmounts, fetchData]);

  const handleToggleActive = useCallback(async (id, active) => {
    await api.updateEpigeneticIntervention(id, { active: !active }).catch(() => null);
    await fetchData();
  }, [fetchData]);

  const handleDelete = useCallback(async (id, name) => {
    await api.deleteEpigeneticIntervention(id).catch(() => null);
    toast.success(`Removed ${name}`);
    await fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <RefreshCw className="w-5 h-5 text-port-accent animate-spin" />
      </div>
    );
  }

  const trackedList = Object.entries(interventions);
  const trackedIds = new Set(trackedList.map(([, i]) => i.id));
  const untrackedRecs = recommendations.filter(r => !trackedIds.has(r.id));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="text-lg font-semibold text-white flex items-center gap-2">
            <FlameKindling size={20} className="text-orange-400" />
            Epigenetic Lifestyle Interventions
          </h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Track neuroprotective supplements and lifestyle practices that modify genetic risk through epigenetic mechanisms.
          </p>
        </div>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="flex items-center gap-1.5 px-3 py-2 bg-port-accent/20 text-port-accent border border-port-accent/30 rounded text-sm hover:bg-port-accent/30 transition-colors"
        >
          <Plus size={14} />
          Custom Intervention
        </button>
      </div>

      {/* Custom Intervention Form */}
      {showAdd && (
        <div className="p-4 rounded bg-port-card border border-port-border space-y-3">
          <h4 className="text-sm font-medium text-white">Add Custom Intervention</h4>
          <div className="grid grid-cols-2 gap-3">
            <input
              type="text"
              value={customForm.name}
              onChange={(e) => setCustomForm(prev => ({ ...prev, name: e.target.value }))}
              placeholder="Intervention name"
              className="col-span-2 px-3 py-2 bg-port-bg border border-port-border rounded text-sm text-white placeholder-gray-600 focus:outline-none focus:border-port-accent"
            />
            <select
              value={customForm.category}
              onChange={(e) => setCustomForm(prev => ({ ...prev, category: e.target.value }))}
              className="px-3 py-2 bg-port-bg border border-port-border rounded text-sm text-white focus:outline-none"
            >
              <option value="supplement">Supplement</option>
              <option value="lifestyle">Lifestyle</option>
              <option value="custom">Custom</option>
            </select>
            <select
              value={customForm.frequency}
              onChange={(e) => setCustomForm(prev => ({ ...prev, frequency: e.target.value }))}
              className="px-3 py-2 bg-port-bg border border-port-border rounded text-sm text-white focus:outline-none"
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="as_needed">As Needed</option>
            </select>
            <input
              type="text"
              value={customForm.dosage}
              onChange={(e) => setCustomForm(prev => ({ ...prev, dosage: e.target.value }))}
              placeholder="Target dosage (e.g. 5g/day)"
              className="px-3 py-2 bg-port-bg border border-port-border rounded text-sm text-white placeholder-gray-600 focus:outline-none"
            />
            <input
              type="text"
              value={customForm.trackingUnit}
              onChange={(e) => setCustomForm(prev => ({ ...prev, trackingUnit: e.target.value }))}
              placeholder="Unit (g, mg, min, etc.)"
              className="px-3 py-2 bg-port-bg border border-port-border rounded text-sm text-white placeholder-gray-600 focus:outline-none"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleAddCustom}
              className="px-3 py-1.5 bg-port-accent/20 text-port-accent border border-port-accent/30 rounded text-sm hover:bg-port-accent/30"
            >
              Add
            </button>
            <button
              onClick={() => setShowAdd(false)}
              className="px-3 py-1.5 bg-port-card border border-port-border rounded text-sm text-gray-400 hover:text-white"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Compliance Summary */}
      {compliance && Object.keys(compliance.summary).length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {Object.entries(compliance.summary).map(([id, s]) => (
            <div key={id} className="p-3 rounded bg-port-card border border-port-border">
              <div className="text-xs text-gray-500 truncate">{s.name}</div>
              <div className="flex items-center gap-2 mt-1">
                <div className="flex-1 h-1.5 bg-port-bg rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      s.compliance >= 0.8 ? 'bg-green-500' :
                      s.compliance >= 0.5 ? 'bg-yellow-500' : 'bg-red-500'
                    }`}
                    style={{ width: `${Math.round(s.compliance * 100)}%` }}
                  />
                </div>
                <span className="text-xs font-mono text-white">{Math.round(s.compliance * 100)}%</span>
              </div>
              {s.streak > 0 && (
                <div className="text-xs text-orange-400 mt-1 flex items-center gap-1">
                  <FlameKindling size={10} />
                  {s.streak}d streak
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Currently Tracked */}
      {trackedList.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Tracking ({trackedList.length})</h4>
          {trackedList.map(([key, intervention]) => {
            const Icon = CATEGORY_ICONS[intervention.category] || Activity;
            const isExpanded = expandedTracked[key];
            const recentLogs = intervention.logs?.slice(-7) || [];

            return (
              <div key={key} className="rounded bg-port-card border border-port-border overflow-hidden">
                <button
                  onClick={() => setExpandedTracked(prev => ({ ...prev, [key]: !prev[key] }))}
                  className="w-full flex items-center gap-3 p-3 text-left hover:bg-white/5 transition-colors"
                >
                  <Icon size={16} className={intervention.active ? 'text-green-400' : 'text-gray-600'} />
                  <span className={`text-sm font-medium flex-1 ${intervention.active ? 'text-white' : 'text-gray-500'}`}>
                    {intervention.name}
                  </span>
                  {intervention.dosage && (
                    <span className="text-xs text-gray-500">{intervention.dosage}</span>
                  )}
                  <span className="text-xs text-gray-600">{intervention.frequency}</span>
                  {isExpanded ? <ChevronDown size={14} className="text-gray-500" /> : <ChevronRight size={14} className="text-gray-500" />}
                </button>

                {isExpanded && (
                  <div className="px-3 pb-3 space-y-3 border-t border-port-border/50">
                    {/* Quick log */}
                    <div className="flex items-center gap-2 mt-3">
                      <input
                        type="number"
                        value={logAmounts[key] || ''}
                        onChange={(e) => setLogAmounts(prev => ({ ...prev, [key]: e.target.value }))}
                        onKeyDown={(e) => e.key === 'Enter' && handleLog(key)}
                        placeholder={`Amount (${intervention.trackingUnit})`}
                        className="flex-1 max-w-[160px] px-3 py-1.5 bg-port-bg border border-port-border rounded text-sm text-white placeholder-gray-600 focus:outline-none focus:border-port-accent font-mono"
                        min="0"
                        step="any"
                      />
                      <span className="text-xs text-gray-500">{intervention.trackingUnit}</span>
                      <button
                        onClick={() => handleLog(key)}
                        disabled={loggingId === key}
                        className="flex items-center gap-1 px-3 py-1.5 bg-green-500/20 text-green-400 border border-green-500/30 rounded text-sm hover:bg-green-500/30 disabled:opacity-50"
                      >
                        {loggingId === key ? <RefreshCw size={12} className="animate-spin" /> : <CheckCircle size={12} />}
                        Log Today
                      </button>
                    </div>

                    {/* Recent log history */}
                    {recentLogs.length > 0 && (
                      <div className="flex gap-1 items-end">
                        <Calendar size={12} className="text-gray-600 mb-0.5" />
                        <div className="flex gap-1">
                          {recentLogs.map(log => (
                            <div
                              key={log.id}
                              title={`${log.date}: ${log.amount} ${log.unit}`}
                              className="w-6 h-6 rounded bg-green-500/20 border border-green-500/30 flex items-center justify-center text-[10px] text-green-400 font-mono"
                            >
                              {log.amount}
                            </div>
                          ))}
                        </div>
                        <span className="text-[10px] text-gray-600 ml-1">last 7 entries</span>
                      </div>
                    )}

                    {/* Actions */}
                    <div className="flex gap-2 text-xs">
                      <button
                        onClick={() => handleToggleActive(key, intervention.active)}
                        className="px-2 py-1 bg-port-bg border border-port-border rounded text-gray-400 hover:text-white"
                      >
                        {intervention.active ? 'Pause' : 'Resume'}
                      </button>
                      <button
                        onClick={() => handleDelete(key, intervention.name)}
                        className="px-2 py-1 bg-red-500/10 border border-red-500/20 rounded text-red-400 hover:bg-red-500/20"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Recommended Interventions (not yet tracked) */}
      {untrackedRecs.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-gray-400 uppercase tracking-wider">
            Recommended Interventions ({untrackedRecs.length})
          </h4>
          <p className="text-xs text-gray-600">
            Evidence-based interventions targeting your genetic risk markers. Click to learn more and start tracking.
          </p>
          {untrackedRecs.map(rec => {
            const Icon = CATEGORY_ICONS[rec.category] || Activity;
            const isExpanded = expandedRecs[rec.id];

            return (
              <div key={rec.id} className="rounded bg-port-card border border-port-border overflow-hidden">
                <button
                  onClick={() => setExpandedRecs(prev => ({ ...prev, [rec.id]: !prev[rec.id] }))}
                  className="w-full flex items-center gap-3 p-3 text-left hover:bg-white/5 transition-colors"
                >
                  <Icon size={16} className="text-purple-400" />
                  <span className="text-sm font-medium text-white flex-1">{rec.name}</span>
                  <span className={`px-1.5 py-0.5 rounded text-xs border ${EVIDENCE_COLORS[rec.evidenceLevel] || EVIDENCE_COLORS.emerging}`}>
                    {rec.evidenceLevel}
                  </span>
                  {isExpanded ? <ChevronDown size={14} className="text-gray-500" /> : <ChevronRight size={14} className="text-gray-500" />}
                </button>

                {isExpanded && (
                  <div className="px-3 pb-3 space-y-3 border-t border-port-border/50">
                    <p className="text-sm text-gray-400 mt-2">{rec.mechanism}</p>

                    <div className="flex flex-wrap gap-3 text-xs">
                      <div>
                        <span className="text-gray-500">Optimal: </span>
                        <span className="text-white">{rec.dosageRange?.optimal}</span>
                      </div>
                      <div>
                        <span className="text-gray-500">Range: </span>
                        <span className="text-white">{rec.dosageRange?.min}–{rec.dosageRange?.max} {rec.dosageRange?.unit}</span>
                      </div>
                      <div>
                        <span className="text-gray-500">Targets: </span>
                        <span className="text-purple-400">{rec.targetMarkers.join(', ')}</span>
                      </div>
                    </div>

                    {rec.references?.length > 0 && (
                      <div className="text-xs text-gray-600 space-y-0.5">
                        {rec.references.map((ref, i) => (
                          <div key={i}>{ref}</div>
                        ))}
                      </div>
                    )}

                    <button
                      onClick={() => handleAddCurated(rec)}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-500/20 text-purple-400 border border-purple-500/30 rounded text-sm hover:bg-purple-500/30"
                    >
                      <Plus size={14} />
                      Start Tracking
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {trackedList.length === 0 && untrackedRecs.length === 0 && (
        <div className="text-center py-6 text-gray-500 text-sm">
          <FlameKindling className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p>Upload genome data and scan markers to get personalized neuroprotective recommendations.</p>
        </div>
      )}

      <p className="text-xs text-gray-600">
        These recommendations are informational — consult a healthcare provider before starting any supplementation program.
      </p>
    </div>
  );
}
