import { useState, useEffect, useCallback } from 'react';
import {
  Target, Plus, Trash2, Check, ChevronDown, ChevronUp,
  Calendar, Heart, DollarSign, Lightbulb, Users, Flame,
  Clock, AlertTriangle, Activity, RefreshCw, Milestone
} from 'lucide-react';
import * as api from '../../../services/api';

const CATEGORY_CONFIG = {
  creative: { label: 'Creative', icon: Lightbulb, color: 'text-purple-400', bg: 'bg-purple-500/20' },
  family: { label: 'Family', icon: Users, color: 'text-pink-400', bg: 'bg-pink-500/20' },
  health: { label: 'Health', icon: Heart, color: 'text-green-400', bg: 'bg-green-500/20' },
  financial: { label: 'Financial', icon: DollarSign, color: 'text-yellow-400', bg: 'bg-yellow-500/20' },
  legacy: { label: 'Legacy', icon: Flame, color: 'text-orange-400', bg: 'bg-orange-500/20' },
  mastery: { label: 'Mastery', icon: Target, color: 'text-blue-400', bg: 'bg-blue-500/20' }
};

const HORIZON_OPTIONS = [
  { value: '1-year', label: '1 Year' },
  { value: '3-year', label: '3 Years' },
  { value: '5-year', label: '5 Years' },
  { value: '10-year', label: '10 Years' },
  { value: '20-year', label: '20 Years' },
  { value: 'lifetime', label: 'Lifetime' }
];

function urgencyColor(urgency) {
  if (urgency == null) return 'text-gray-500';
  if (urgency >= 0.7) return 'text-red-400';
  if (urgency >= 0.4) return 'text-yellow-400';
  return 'text-green-400';
}

function urgencyLabel(urgency) {
  if (urgency == null) return 'Unknown';
  if (urgency >= 0.7) return 'Urgent';
  if (urgency >= 0.4) return 'Moderate';
  return 'Low';
}

export default function GoalsTab({ onRefresh }) {
  const [goalsData, setGoalsData] = useState(null);
  const [longevity, setLongevity] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expandedGoal, setExpandedGoal] = useState(null);
  const [showNewGoal, setShowNewGoal] = useState(false);
  const [showBirthDate, setShowBirthDate] = useState(false);
  const [newGoal, setNewGoal] = useState({ title: '', description: '', horizon: '5-year', category: 'mastery' });
  const [birthDateInput, setBirthDateInput] = useState('');
  const [newMilestone, setNewMilestone] = useState({ title: '', targetDate: '' });
  const [derivingLongevity, setDerivingLongevity] = useState(false);

  const loadData = useCallback(async () => {
    const [goals, longevityData] = await Promise.all([
      api.getGoals().catch(() => null),
      api.getLongevity().catch(() => null)
    ]);
    setGoalsData(goals);
    setLongevity(longevityData);
    if (goals?.birthDate) setBirthDateInput(goals.birthDate);
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleSetBirthDate = async () => {
    if (!birthDateInput) return;
    await api.setBirthDate(birthDateInput);
    setShowBirthDate(false);
    await loadData();
    onRefresh?.();
  };

  const handleDeriveLongevity = async () => {
    setDerivingLongevity(true);
    await api.deriveLongevity();
    setDerivingLongevity(false);
    await loadData();
  };

  const handleCreateGoal = async () => {
    if (!newGoal.title.trim()) return;
    await api.createGoal(newGoal);
    setNewGoal({ title: '', description: '', horizon: '5-year', category: 'mastery' });
    setShowNewGoal(false);
    await loadData();
    onRefresh?.();
  };

  const handleUpdateGoalStatus = async (goalId, status) => {
    await api.updateGoal(goalId, { status });
    await loadData();
  };

  const handleDeleteGoal = async (goalId) => {
    await api.deleteGoal(goalId);
    setExpandedGoal(null);
    await loadData();
    onRefresh?.();
  };

  const handleAddMilestone = async (goalId) => {
    if (!newMilestone.title.trim()) return;
    await api.addGoalMilestone(goalId, {
      title: newMilestone.title,
      ...(newMilestone.targetDate ? { targetDate: newMilestone.targetDate } : {})
    });
    setNewMilestone({ title: '', targetDate: '' });
    await loadData();
  };

  const handleCompleteMilestone = async (goalId, milestoneId) => {
    await api.completeGoalMilestone(goalId, milestoneId);
    await loadData();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <RefreshCw className="w-6 h-6 text-port-accent animate-spin" />
      </div>
    );
  }

  const activeGoals = goalsData?.goals?.filter(g => g.status === 'active') || [];
  const completedGoals = goalsData?.goals?.filter(g => g.status === 'completed') || [];
  const hasBirthDate = !!goalsData?.birthDate;
  const hasLongevity = !!longevity?.derivedAt;
  const timeHorizons = longevity?.timeHorizons;

  return (
    <div className="space-y-6">
      {/* Life Expectancy Card */}
      <div className="bg-port-card border border-port-border rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Activity className="w-5 h-5 text-port-accent" />
            <h3 className="font-medium text-white">Life Expectancy</h3>
          </div>
          <div className="flex gap-2">
            {hasBirthDate && (
              <button
                onClick={handleDeriveLongevity}
                disabled={derivingLongevity}
                className="text-xs px-2 py-1 rounded bg-port-accent/20 text-port-accent hover:bg-port-accent/30 disabled:opacity-50"
              >
                {derivingLongevity ? 'Deriving...' : 'Re-derive'}
              </button>
            )}
            <button
              onClick={() => setShowBirthDate(!showBirthDate)}
              className="text-xs px-2 py-1 rounded bg-port-border text-gray-300 hover:bg-gray-600"
            >
              {hasBirthDate ? 'Update Birth Date' : 'Set Birth Date'}
            </button>
          </div>
        </div>

        {showBirthDate && (
          <div className="flex gap-2 mb-3">
            <input
              type="date"
              value={birthDateInput}
              onChange={e => setBirthDateInput(e.target.value)}
              className="bg-port-bg border border-port-border rounded px-3 py-1.5 text-sm text-white"
            />
            <button
              onClick={handleSetBirthDate}
              className="px-3 py-1.5 text-sm rounded bg-port-accent text-white hover:bg-blue-600"
            >
              Save
            </button>
          </div>
        )}

        {!hasBirthDate ? (
          <p className="text-sm text-gray-500">
            Set your birth date to enable mortality-aware goal urgency scoring. Your genome longevity and cardiovascular markers will adjust your estimated life expectancy.
          </p>
        ) : hasLongevity ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-port-bg rounded-lg p-3 text-center">
              <div className="text-2xl font-bold text-white">
                {longevity.lifeExpectancy.adjusted}
              </div>
              <div className="text-xs text-gray-500">Adjusted Life Expectancy</div>
              <div className="text-xs text-gray-600 mt-1">
                Baseline: {longevity.lifeExpectancy.baseline}
                {longevity.lifeExpectancy.longevityAdjustment !== 0 && (
                  <span className={longevity.lifeExpectancy.longevityAdjustment > 0 ? 'text-green-500' : 'text-red-500'}>
                    {' '}{longevity.lifeExpectancy.longevityAdjustment > 0 ? '+' : ''}{longevity.lifeExpectancy.longevityAdjustment} longevity
                  </span>
                )}
                {longevity.lifeExpectancy.cardiovascularAdjustment !== 0 && (
                  <span className={longevity.lifeExpectancy.cardiovascularAdjustment > 0 ? 'text-green-500' : 'text-red-500'}>
                    {' '}{longevity.lifeExpectancy.cardiovascularAdjustment > 0 ? '+' : ''}{longevity.lifeExpectancy.cardiovascularAdjustment} cardio
                  </span>
                )}
              </div>
            </div>

            {timeHorizons && (
              <>
                <div className="bg-port-bg rounded-lg p-3 text-center">
                  <div className="text-2xl font-bold text-white">{timeHorizons.ageYears}</div>
                  <div className="text-xs text-gray-500">Current Age</div>
                </div>
                <div className="bg-port-bg rounded-lg p-3 text-center">
                  <div className="text-2xl font-bold text-green-400">{timeHorizons.yearsRemaining}</div>
                  <div className="text-xs text-gray-500">Years Remaining</div>
                  <div className="text-xs text-gray-600 mt-1">{timeHorizons.healthyYearsRemaining} healthy</div>
                </div>
                <div className="bg-port-bg rounded-lg p-3 text-center">
                  <div className="text-2xl font-bold text-amber-400">{timeHorizons.percentLifeComplete}%</div>
                  <div className="text-xs text-gray-500">Life Complete</div>
                  <div className="w-full bg-gray-700 rounded-full h-1.5 mt-2">
                    <div
                      className="bg-amber-400 h-1.5 rounded-full transition-all"
                      style={{ width: `${Math.min(100, timeHorizons.percentLifeComplete)}%` }}
                    />
                  </div>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Clock className="w-4 h-4" />
            Birth date set. Click "Re-derive" to calculate life expectancy from genome markers.
          </div>
        )}

        {hasLongevity && (
          <div className="mt-3 flex gap-4 text-xs text-gray-500">
            <span>
              Longevity markers: {Object.keys(longevity.longevityMarkers || {}).length}/{5}
            </span>
            <span>
              Cardiovascular markers: {Object.keys(longevity.cardiovascularMarkers || {}).length}/{6}
            </span>
            <span>
              Confidence: {Math.round((longevity.confidence || 0) * 100)}%
            </span>
          </div>
        )}
      </div>

      {/* Goals Section */}
      <div className="bg-port-card border border-port-border rounded-lg p-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Target className="w-5 h-5 text-port-accent" />
            <h3 className="font-medium text-white">
              Goals ({activeGoals.length} active)
            </h3>
          </div>
          <button
            onClick={() => setShowNewGoal(!showNewGoal)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-port-accent text-white hover:bg-blue-600"
          >
            <Plus className="w-4 h-4" />
            Add Goal
          </button>
        </div>

        {/* New Goal Form */}
        {showNewGoal && (
          <div className="bg-port-bg border border-port-border rounded-lg p-4 mb-4 space-y-3">
            <input
              type="text"
              value={newGoal.title}
              onChange={e => setNewGoal({ ...newGoal, title: e.target.value })}
              placeholder="Goal title..."
              className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-sm text-white placeholder-gray-500"
            />
            <textarea
              value={newGoal.description}
              onChange={e => setNewGoal({ ...newGoal, description: e.target.value })}
              placeholder="Description (optional)..."
              rows={2}
              className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-sm text-white placeholder-gray-500 resize-none"
            />
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="block text-xs text-gray-500 mb-1">Horizon</label>
                <select
                  value={newGoal.horizon}
                  onChange={e => setNewGoal({ ...newGoal, horizon: e.target.value })}
                  className="w-full bg-port-card border border-port-border rounded px-3 py-1.5 text-sm text-white"
                >
                  {HORIZON_OPTIONS.map(h => (
                    <option key={h.value} value={h.value}>{h.label}</option>
                  ))}
                </select>
              </div>
              <div className="flex-1">
                <label className="block text-xs text-gray-500 mb-1">Category</label>
                <select
                  value={newGoal.category}
                  onChange={e => setNewGoal({ ...newGoal, category: e.target.value })}
                  className="w-full bg-port-card border border-port-border rounded px-3 py-1.5 text-sm text-white"
                >
                  {Object.entries(CATEGORY_CONFIG).map(([key, cfg]) => (
                    <option key={key} value={key}>{cfg.label}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleCreateGoal}
                disabled={!newGoal.title.trim()}
                className="px-4 py-1.5 text-sm rounded bg-port-accent text-white hover:bg-blue-600 disabled:opacity-50"
              >
                Create
              </button>
              <button
                onClick={() => setShowNewGoal(false)}
                className="px-4 py-1.5 text-sm rounded bg-port-border text-gray-300 hover:bg-gray-600"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Active Goals */}
        {activeGoals.length === 0 ? (
          <p className="text-sm text-gray-500 py-4 text-center">
            No goals yet. Add your first goal to start tracking with mortality-aware urgency scoring.
          </p>
        ) : (
          <div className="space-y-2">
            {activeGoals.map(goal => {
              const cat = CATEGORY_CONFIG[goal.category] || CATEGORY_CONFIG.mastery;
              const CatIcon = cat.icon;
              const isExpanded = expandedGoal === goal.id;
              const completedMs = goal.milestones?.filter(m => m.completedAt) || [];
              const totalMs = goal.milestones?.length || 0;

              return (
                <div key={goal.id} className="bg-port-bg border border-port-border rounded-lg">
                  <button
                    onClick={() => setExpandedGoal(isExpanded ? null : goal.id)}
                    className="w-full flex items-center gap-3 p-3 text-left"
                  >
                    <div className={`p-1.5 rounded ${cat.bg}`}>
                      <CatIcon className={`w-4 h-4 ${cat.color}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-white truncate">{goal.title}</span>
                        <span className="text-xs text-gray-500 flex-shrink-0">
                          {HORIZON_OPTIONS.find(h => h.value === goal.horizon)?.label}
                        </span>
                      </div>
                      {totalMs > 0 && (
                        <div className="flex items-center gap-1 mt-0.5">
                          <div className="w-16 bg-gray-700 rounded-full h-1">
                            <div
                              className="bg-port-accent h-1 rounded-full"
                              style={{ width: `${totalMs > 0 ? (completedMs.length / totalMs) * 100 : 0}%` }}
                            />
                          </div>
                          <span className="text-xs text-gray-500">{completedMs.length}/{totalMs}</span>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {goal.urgency != null && (
                        <div className={`flex items-center gap-1 ${urgencyColor(goal.urgency)}`}>
                          {goal.urgency >= 0.7 && <AlertTriangle className="w-3.5 h-3.5" />}
                          <span className="text-xs font-medium">{urgencyLabel(goal.urgency)}</span>
                        </div>
                      )}
                      {isExpanded ? <ChevronUp className="w-4 h-4 text-gray-500" /> : <ChevronDown className="w-4 h-4 text-gray-500" />}
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="px-3 pb-3 space-y-3 border-t border-port-border pt-3">
                      {goal.description && (
                        <p className="text-sm text-gray-400">{goal.description}</p>
                      )}

                      <div className="flex flex-wrap gap-2 text-xs text-gray-500">
                        <span className={`px-2 py-0.5 rounded ${cat.bg} ${cat.color}`}>{cat.label}</span>
                        {goal.urgency != null && (
                          <span className={`px-2 py-0.5 rounded bg-gray-700 ${urgencyColor(goal.urgency)}`}>
                            Urgency: {Math.round(goal.urgency * 100)}%
                          </span>
                        )}
                        <span className="px-2 py-0.5 rounded bg-gray-700 text-gray-400">
                          Created {new Date(goal.createdAt).toLocaleDateString()}
                        </span>
                      </div>

                      {/* Milestones */}
                      <div>
                        <div className="flex items-center gap-1 mb-2">
                          <Milestone className="w-3.5 h-3.5 text-gray-500" />
                          <span className="text-xs font-medium text-gray-400">Milestones</span>
                        </div>
                        {goal.milestones?.length > 0 ? (
                          <div className="space-y-1">
                            {goal.milestones.map(ms => (
                              <div key={ms.id} className="flex items-center gap-2 text-sm">
                                <button
                                  onClick={() => !ms.completedAt && handleCompleteMilestone(goal.id, ms.id)}
                                  className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                                    ms.completedAt
                                      ? 'bg-green-500/20 border-green-500 text-green-400'
                                      : 'border-gray-600 hover:border-port-accent'
                                  }`}
                                >
                                  {ms.completedAt && <Check className="w-3 h-3" />}
                                </button>
                                <span className={ms.completedAt ? 'text-gray-500 line-through' : 'text-gray-300'}>
                                  {ms.title}
                                </span>
                                {ms.targetDate && (
                                  <span className="text-xs text-gray-600 ml-auto">
                                    {new Date(ms.targetDate).toLocaleDateString()}
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-xs text-gray-600">No milestones yet</p>
                        )}

                        {/* Add milestone */}
                        <div className="flex gap-2 mt-2">
                          <input
                            type="text"
                            value={newMilestone.title}
                            onChange={e => setNewMilestone({ ...newMilestone, title: e.target.value })}
                            placeholder="Add milestone..."
                            className="flex-1 bg-port-card border border-port-border rounded px-2 py-1 text-xs text-white placeholder-gray-600"
                            onKeyDown={e => e.key === 'Enter' && handleAddMilestone(goal.id)}
                          />
                          <input
                            type="date"
                            value={newMilestone.targetDate}
                            onChange={e => setNewMilestone({ ...newMilestone, targetDate: e.target.value })}
                            className="bg-port-card border border-port-border rounded px-2 py-1 text-xs text-white w-32"
                          />
                          <button
                            onClick={() => handleAddMilestone(goal.id)}
                            disabled={!newMilestone.title.trim()}
                            className="px-2 py-1 text-xs rounded bg-port-accent/20 text-port-accent hover:bg-port-accent/30 disabled:opacity-50"
                          >
                            Add
                          </button>
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex gap-2 pt-1">
                        <button
                          onClick={() => handleUpdateGoalStatus(goal.id, 'completed')}
                          className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-green-500/20 text-green-400 hover:bg-green-500/30"
                        >
                          <Check className="w-3 h-3" />
                          Complete
                        </button>
                        <button
                          onClick={() => handleDeleteGoal(goal.id)}
                          className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-red-500/20 text-red-400 hover:bg-red-500/30"
                        >
                          <Trash2 className="w-3 h-3" />
                          Delete
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Completed Goals */}
      {completedGoals.length > 0 && (
        <div className="bg-port-card border border-port-border rounded-lg p-4">
          <h3 className="font-medium text-gray-400 mb-3 flex items-center gap-2">
            <Check className="w-4 h-4 text-green-400" />
            Completed ({completedGoals.length})
          </h3>
          <div className="space-y-1">
            {completedGoals.map(goal => {
              const cat = CATEGORY_CONFIG[goal.category] || CATEGORY_CONFIG.mastery;
              const CatIcon = cat.icon;
              return (
                <div key={goal.id} className="flex items-center gap-2 py-1.5 text-sm">
                  <CatIcon className={`w-4 h-4 ${cat.color} opacity-50`} />
                  <span className="text-gray-500 line-through">{goal.title}</span>
                  <span className="text-xs text-gray-600 ml-auto">
                    {HORIZON_OPTIONS.find(h => h.value === goal.horizon)?.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Longevity Markers Detail (collapsed) */}
      {hasLongevity && (
        <details className="bg-port-card border border-port-border rounded-lg">
          <summary className="p-4 cursor-pointer text-sm font-medium text-gray-400 hover:text-white">
            Genome Marker Details
          </summary>
          <div className="px-4 pb-4 space-y-3">
            {Object.keys(longevity.longevityMarkers || {}).length > 0 && (
              <div>
                <h4 className="text-xs font-medium text-gray-500 mb-2">Longevity Markers</h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {Object.entries(longevity.longevityMarkers).map(([name, marker]) => (
                    <div key={name} className="flex items-center justify-between bg-port-bg rounded px-3 py-2 text-xs">
                      <div>
                        <span className="text-white font-medium">{marker.gene}</span>
                        <span className="text-gray-500 ml-1">({marker.rsid})</span>
                      </div>
                      <span className={
                        marker.status === 'beneficial' ? 'text-green-400' :
                        marker.status === 'concern' ? 'text-red-400' : 'text-gray-400'
                      }>
                        {marker.genotype} — {marker.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {Object.keys(longevity.cardiovascularMarkers || {}).length > 0 && (
              <div>
                <h4 className="text-xs font-medium text-gray-500 mb-2">Cardiovascular Markers</h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {Object.entries(longevity.cardiovascularMarkers).map(([name, marker]) => (
                    <div key={name} className="flex items-center justify-between bg-port-bg rounded px-3 py-2 text-xs">
                      <div>
                        <span className="text-white font-medium">{marker.gene}</span>
                        <span className="text-gray-500 ml-1">({marker.rsid})</span>
                      </div>
                      <span className={
                        marker.status === 'beneficial' ? 'text-green-400' :
                        marker.status === 'concern' || marker.status === 'major_concern' ? 'text-red-400' : 'text-gray-400'
                      }>
                        {marker.genotype} — {marker.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </details>
      )}
    </div>
  );
}
