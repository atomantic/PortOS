import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Fingerprint, Dna, Clock, Activity, Palette, Target,
  ChevronRight, RefreshCw, Sun, Moon, Coffee, Zap,
  Heart, DollarSign, Lightbulb, Users, Flame, Link2,
  AlertTriangle, CheckCircle, Info
} from 'lucide-react';
import * as api from '../../../services/api';

const SECTION_CONFIG = {
  genome: { label: 'Genome', icon: Dna, color: 'blue' },
  chronotype: { label: 'Chronotype', icon: Clock, color: 'purple' },
  longevity: { label: 'Longevity', icon: Activity, color: 'green' },
  aesthetics: { label: 'Aesthetics', icon: Palette, color: 'pink' },
  goals: { label: 'Goals', icon: Target, color: 'amber' }
};

const STATUS_COLORS = {
  active: { dot: 'bg-green-400', text: 'text-green-400' },
  pending: { dot: 'bg-yellow-400', text: 'text-yellow-400' },
  unavailable: { dot: 'bg-gray-500', text: 'text-gray-500' }
};

const GOAL_CATEGORY_ICONS = {
  creative: Lightbulb,
  family: Users,
  health: Heart,
  financial: DollarSign,
  legacy: Flame,
  mastery: Target
};

function urgencyColor(urgency) {
  if (urgency == null) return 'text-gray-500';
  if (urgency >= 0.7) return 'text-red-400';
  if (urgency >= 0.4) return 'text-yellow-400';
  return 'text-green-400';
}

function urgencyLabel(urgency) {
  if (urgency == null) return '';
  if (urgency >= 0.7) return 'Urgent';
  if (urgency >= 0.4) return 'Moderate';
  return 'Low';
}

const SEVERITY_CONFIG = {
  success: { icon: CheckCircle, color: 'text-green-400', border: 'border-green-500/30', bg: 'bg-green-500/10' },
  warning: { icon: AlertTriangle, color: 'text-yellow-400', border: 'border-yellow-500/30', bg: 'bg-yellow-500/10' },
  info: { icon: Info, color: 'text-blue-400', border: 'border-blue-500/30', bg: 'bg-blue-500/10' }
};

const CATEGORY_LABELS = {
  health: 'Health',
  lifestyle: 'Lifestyle',
  productivity: 'Productivity',
  goals: 'Goals'
};

export default function IdentityTab({ onRefresh }) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [identity, setIdentity] = useState(null);
  const [chronotype, setChronotype] = useState(null);
  const [longevity, setLongevity] = useState(null);
  const [taste, setTaste] = useState(null);
  const [goals, setGoals] = useState(null);
  const [crossInsights, setCrossInsights] = useState(null);
  const [derivingChronotype, setDerivingChronotype] = useState(false);
  const [derivingLongevity, setDerivingLongevity] = useState(false);

  const loadData = useCallback(async () => {
    const [identityData, chronoData, longData, tasteData, goalsData, insightsData] = await Promise.all([
      api.getIdentityStatus().catch(() => null),
      api.getChronotype().catch(() => null),
      api.getLongevity().catch(() => null),
      api.getTasteProfile().catch(() => null),
      api.getGoals().catch(() => null),
      api.getCrossInsights().catch(() => null)
    ]);
    setIdentity(identityData);
    setChronotype(chronoData);
    setLongevity(longData);
    setTaste(tasteData);
    setGoals(goalsData);
    setCrossInsights(insightsData);
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleDeriveChronotype = async () => {
    setDerivingChronotype(true);
    await api.deriveChronotype().catch(() => null);
    setDerivingChronotype(false);
    await loadData();
    onRefresh?.();
  };

  const handleDeriveLongevity = async () => {
    setDerivingLongevity(true);
    await api.deriveLongevity().catch(() => null);
    setDerivingLongevity(false);
    await loadData();
    onRefresh?.();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <RefreshCw className="w-6 h-6 text-port-accent animate-spin" />
      </div>
    );
  }

  const sections = identity?.sections || {};
  const sectionKeys = ['genome', 'chronotype', 'longevity', 'aesthetics', 'goals'];
  const activeCount = sectionKeys.filter(k => sections[k]?.status === 'active').length;
  const percentage = Math.round((activeCount / sectionKeys.length) * 100);

  return (
    <div className="space-y-6">
      {/* Completeness Header */}
      <div className="bg-port-card border border-port-border rounded-lg p-4">
        <div className="flex items-center gap-3 mb-3">
          <Fingerprint className="w-5 h-5 text-port-accent" />
          <h3 className="font-medium text-white">Identity Completeness</h3>
          <span className="ml-auto text-sm text-gray-400">
            {activeCount}/{sectionKeys.length} sections active
          </span>
        </div>

        {/* Progress bar */}
        <div className="h-2 bg-port-border rounded-full overflow-hidden mb-3">
          <div
            className={`h-full transition-all ${
              percentage >= 80 ? 'bg-green-500' :
              percentage >= 40 ? 'bg-yellow-500' : 'bg-red-500'
            }`}
            style={{ width: `${percentage}%` }}
          />
        </div>

        {/* Status chips */}
        <div className="flex flex-wrap gap-2">
          {sectionKeys.map(key => {
            const section = sections[key];
            const config = SECTION_CONFIG[key];
            const status = section?.status || 'unavailable';
            const colors = STATUS_COLORS[status];
            const Icon = config.icon;
            return (
              <div
                key={key}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-port-bg border border-port-border text-xs"
              >
                <Icon className="w-3 h-3 text-gray-400" />
                <span className="text-gray-300">{config.label}</span>
                <div className={`w-2 h-2 rounded-full ${colors.dot}`} />
              </div>
            );
          })}
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Genome Summary Card */}
        <div className="bg-port-card border border-port-border rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Dna className="w-5 h-5 text-blue-400" />
              <h3 className="font-medium text-white">Genome</h3>
            </div>
            {sections.genome?.status && (
              <span className={`text-xs px-2 py-0.5 rounded-full ${
                sections.genome.status === 'active'
                  ? 'bg-green-500/20 text-green-400'
                  : 'bg-gray-500/20 text-gray-400'
              }`}>
                {sections.genome.status === 'active' ? 'Active' : 'Pending'}
              </span>
            )}
          </div>

          {sections.genome?.status === 'active' ? (
            <div className="space-y-2">
              {sections.genome.markerCount != null && (
                <p className="text-sm text-gray-400">
                  {sections.genome.markerCount} genetic markers loaded
                </p>
              )}
              {sections.genome.variantCount != null && (
                <p className="text-xs text-gray-500">
                  {sections.genome.variantCount} variants analyzed
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-gray-500">
              Upload genome data to enable genetic analysis.
            </p>
          )}

          <button
            onClick={() => navigate('/meatspace/genome')}
            className="flex items-center gap-1 mt-3 text-sm text-port-accent hover:text-white transition-colors"
          >
            View Full Genome
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {/* Chronotype Card */}
        <div className="bg-port-card border border-port-border rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Clock className="w-5 h-5 text-purple-400" />
              <h3 className="font-medium text-white">Chronotype</h3>
            </div>
            {sections.chronotype?.status && (
              <span className={`text-xs px-2 py-0.5 rounded-full ${
                sections.chronotype.status === 'active'
                  ? 'bg-green-500/20 text-green-400'
                  : 'bg-yellow-500/20 text-yellow-400'
              }`}>
                {sections.chronotype.status === 'active' ? 'Active' : 'Pending'}
              </span>
            )}
          </div>

          {chronotype?.type ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                {chronotype.type.toLowerCase().includes('evening') || chronotype.type.toLowerCase().includes('owl')
                  ? <Moon className="w-4 h-4 text-indigo-400" />
                  : <Sun className="w-4 h-4 text-yellow-400" />
                }
                <span className="text-white font-medium">{chronotype.type}</span>
                {chronotype.confidence != null && (
                  <span className="text-xs text-gray-500">
                    {Math.round(chronotype.confidence * 100)}% confidence
                  </span>
                )}
              </div>

              {chronotype.recommendations && (
                <div className="space-y-1">
                  {(chronotype.recommendations.peakFocusStart || chronotype.recommendations.peakFocusEnd) && (
                    <div className="flex items-center gap-2 text-xs text-gray-400">
                      <Zap className="w-3 h-3 text-yellow-400" />
                      Peak focus: {chronotype.recommendations.peakFocusStart}–{chronotype.recommendations.peakFocusEnd}
                    </div>
                  )}
                  {chronotype.recommendations.caffeineCutoff && (
                    <div className="flex items-center gap-2 text-xs text-gray-400">
                      <Coffee className="w-3 h-3 text-amber-400" />
                      Caffeine cutoff: {chronotype.recommendations.caffeineCutoff}
                    </div>
                  )}
                </div>
              )}

              {chronotype.geneticMarkers && Object.keys(chronotype.geneticMarkers).length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {Object.entries(chronotype.geneticMarkers).slice(0, 5).map(([name, marker]) => (
                    <span
                      key={name}
                      className={`text-xs px-1.5 py-0.5 rounded ${
                        marker.signal < 0
                          ? 'bg-indigo-500/20 text-indigo-400'
                          : marker.signal > 0
                            ? 'bg-yellow-500/20 text-yellow-400'
                            : 'bg-gray-500/20 text-gray-400'
                      }`}
                    >
                      {name}: {marker.status}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-gray-500">
                Derive your chronotype from genome sleep and caffeine markers.
              </p>
              <button
                onClick={handleDeriveChronotype}
                disabled={derivingChronotype || sections.genome?.status !== 'active'}
                className="text-xs px-3 py-1.5 rounded bg-port-accent/20 text-port-accent hover:bg-port-accent/30 disabled:opacity-50"
              >
                {derivingChronotype ? 'Deriving...' : 'Derive Chronotype'}
              </button>
            </div>
          )}
        </div>

        {/* Longevity Card */}
        <div className="bg-port-card border border-port-border rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Activity className="w-5 h-5 text-green-400" />
              <h3 className="font-medium text-white">Longevity</h3>
            </div>
            {sections.longevity?.status && (
              <span className={`text-xs px-2 py-0.5 rounded-full ${
                sections.longevity.status === 'active'
                  ? 'bg-green-500/20 text-green-400'
                  : 'bg-yellow-500/20 text-yellow-400'
              }`}>
                {sections.longevity.status === 'active' ? 'Active' : 'Pending'}
              </span>
            )}
          </div>

          {longevity?.derivedAt ? (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <div className="bg-port-bg rounded-lg p-2 text-center">
                  <div className="text-xl font-bold text-white">
                    {longevity.lifeExpectancy?.adjusted ?? '—'}
                  </div>
                  <div className="text-xs text-gray-500">Adjusted LE</div>
                </div>
                <div className="bg-port-bg rounded-lg p-2 text-center">
                  <div className="text-xl font-bold text-green-400">
                    {longevity.timeHorizons?.yearsRemaining ?? '—'}
                  </div>
                  <div className="text-xs text-gray-500">Years Left</div>
                </div>
                <div className="bg-port-bg rounded-lg p-2 text-center">
                  <div className="text-xl font-bold text-amber-400">
                    {longevity.timeHorizons?.percentLifeComplete != null
                      ? `${longevity.timeHorizons.percentLifeComplete}%`
                      : '—'}
                  </div>
                  <div className="text-xs text-gray-500">Complete</div>
                </div>
              </div>

              <div className="flex gap-3 text-xs text-gray-500">
                <span>
                  Longevity: {Object.keys(longevity.longevityMarkers || {}).length}/5
                </span>
                <span>
                  Cardio: {Object.keys(longevity.cardiovascularMarkers || {}).length}/6
                </span>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-gray-500">
                Derive life expectancy from genome longevity and cardiovascular markers.
              </p>
              <button
                onClick={handleDeriveLongevity}
                disabled={derivingLongevity || sections.genome?.status !== 'active'}
                className="text-xs px-3 py-1.5 rounded bg-port-accent/20 text-port-accent hover:bg-port-accent/30 disabled:opacity-50"
              >
                {derivingLongevity ? 'Deriving...' : 'Derive Longevity'}
              </button>
            </div>
          )}

          <button
            onClick={() => navigate('/digital-twin/goals')}
            className="flex items-center gap-1 mt-3 text-sm text-port-accent hover:text-white transition-colors"
          >
            View Goals
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {/* Aesthetic Taste Card */}
        <div className="bg-port-card border border-port-border rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Palette className="w-5 h-5 text-pink-400" />
              <h3 className="font-medium text-white">Aesthetic Taste</h3>
            </div>
            {sections.aesthetics?.status && (
              <span className={`text-xs px-2 py-0.5 rounded-full ${
                sections.aesthetics.status === 'active'
                  ? 'bg-green-500/20 text-green-400'
                  : 'bg-yellow-500/20 text-yellow-400'
              }`}>
                {sections.aesthetics.status === 'active' ? 'Active' : 'Pending'}
              </span>
            )}
          </div>

          {taste ? (
            <div className="space-y-3">
              <p className="text-sm text-gray-400">
                {taste.completedCount ?? 0}/{taste.totalSections ?? 0} sections complete
                {taste.overallPercentage != null && ` (${Math.round(taste.overallPercentage)}%)`}
              </p>

              {taste.sections?.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {taste.sections.map(section => (
                    <div
                      key={section.id || section.name}
                      className="flex items-center gap-1 text-xs"
                      title={`${section.name || section.id}: ${section.completedQuestions ?? 0}/${section.totalQuestions ?? 0}`}
                    >
                      <div className={`w-2 h-2 rounded-full ${
                        (section.completedQuestions ?? 0) >= (section.totalQuestions ?? 1)
                          ? 'bg-green-400'
                          : (section.completedQuestions ?? 0) > 0
                            ? 'bg-yellow-400'
                            : 'bg-gray-600'
                      }`} />
                      <span className="text-gray-400">{section.name || section.id}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-gray-500">
              Complete the taste questionnaire to map your aesthetic preferences.
            </p>
          )}

          <button
            onClick={() => navigate('/digital-twin/taste')}
            className="flex items-center gap-1 mt-3 text-sm text-port-accent hover:text-white transition-colors"
          >
            {taste?.completedCount > 0 ? 'Continue Taste Questionnaire' : 'Start Taste Questionnaire'}
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {/* Life Goals Card */}
        <div className="bg-port-card border border-port-border rounded-lg p-4 lg:col-span-2">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Target className="w-5 h-5 text-amber-400" />
              <h3 className="font-medium text-white">Life Goals</h3>
            </div>
            {sections.goals?.status && (
              <span className={`text-xs px-2 py-0.5 rounded-full ${
                sections.goals.status === 'active'
                  ? 'bg-green-500/20 text-green-400'
                  : 'bg-yellow-500/20 text-yellow-400'
              }`}>
                {sections.goals.status === 'active' ? 'Active' : 'Pending'}
              </span>
            )}
          </div>

          {(() => {
            const activeGoals = goals?.goals?.filter(g => g.status === 'active') || [];
            const topGoals = [...activeGoals]
              .sort((a, b) => (b.urgency ?? 0) - (a.urgency ?? 0))
              .slice(0, 3);

            return activeGoals.length > 0 ? (
              <div className="space-y-3">
                <p className="text-sm text-gray-400">
                  {activeGoals.length} active goal{activeGoals.length !== 1 ? 's' : ''}
                </p>
                <div className="space-y-2">
                  {topGoals.map(goal => {
                    const CatIcon = GOAL_CATEGORY_ICONS[goal.category] || Target;
                    return (
                      <div key={goal.id} className="flex items-center gap-3 bg-port-bg rounded-lg px-3 py-2">
                        <CatIcon className="w-4 h-4 text-gray-400 shrink-0" />
                        <span className="text-sm text-white truncate flex-1">{goal.title}</span>
                        {goal.urgency != null && (
                          <span className={`text-xs font-medium ${urgencyColor(goal.urgency)}`}>
                            {urgencyLabel(goal.urgency)}
                          </span>
                        )}
                      </div>
                    );
                  })}
                  {activeGoals.length > 3 && (
                    <p className="text-xs text-gray-500">
                      +{activeGoals.length - 3} more goal{activeGoals.length - 3 !== 1 ? 's' : ''}
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-sm text-gray-500">
                No goals set yet. Add mortality-aware goals with urgency scoring.
              </p>
            );
          })()}

          <button
            onClick={() => navigate('/digital-twin/goals')}
            className="flex items-center gap-1 mt-3 text-sm text-port-accent hover:text-white transition-colors"
          >
            Manage Goals
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Cross-Insights Section */}
      {crossInsights?.insights?.length > 0 && (
        <div className="bg-port-card border border-port-border rounded-lg p-4">
          <div className="flex items-center gap-2 mb-4">
            <Link2 className="w-5 h-5 text-port-accent" />
            <h3 className="font-medium text-white">Cross-Domain Insights</h3>
            <span className="text-xs text-gray-500 ml-auto">
              {crossInsights.insights.length} insight{crossInsights.insights.length !== 1 ? 's' : ''}
            </span>
          </div>

          <div className="space-y-3">
            {crossInsights.insights.map(insight => {
              const config = SEVERITY_CONFIG[insight.severity] || SEVERITY_CONFIG.info;
              const SeverityIcon = config.icon;
              return (
                <div
                  key={insight.id}
                  className={`flex gap-3 p-3 rounded-lg border ${config.border} ${config.bg}`}
                >
                  <SeverityIcon className={`w-4 h-4 shrink-0 mt-0.5 ${config.color}`} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-medium text-white">{insight.title}</span>
                      <span className="text-[10px] text-gray-500 bg-port-bg px-1.5 py-0.5 rounded">
                        {CATEGORY_LABELS[insight.category] || insight.category}
                      </span>
                    </div>
                    <p className="text-xs text-gray-400 leading-relaxed">{insight.text}</p>
                    {insight.sources?.length > 0 && (
                      <div className="flex gap-1 mt-2">
                        {insight.sources.map(src => (
                          <span key={src} className="text-[10px] text-gray-600 bg-port-bg px-1.5 py-0.5 rounded">
                            {src}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <button
            onClick={() => navigate('/insights/cross-domain')}
            className="flex items-center gap-1 mt-4 text-sm text-port-accent hover:text-white transition-colors"
          >
            View Full Insights
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
