import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Heart,
  FileText,
  CheckCircle,
  Sparkles,
  Download,
  Play,
  Settings,
  AlertCircle,
  AlertTriangle,
  Target,
  RefreshCw,
  ChevronRight
} from 'lucide-react';
import * as api from '../../../services/api';
import toast from 'react-hot-toast';

import {
  DOCUMENT_CATEGORIES,
  getHealthColor,
  getHealthLabel,
  formatRelativeTime
} from '../constants';
import SoulWizard from '../SoulWizard';
import PersonalityMap from '../PersonalityMap';
import ConfidenceGauge from '../ConfidenceGauge';
import GapRecommendations from '../GapRecommendations';

export default function OverviewTab({ status, settings, onRefresh }) {
  const navigate = useNavigate();
  const [showSettings, setShowSettings] = useState(false);
  const [settingsForm, setSettingsForm] = useState(settings || {});
  const [saving, setSaving] = useState(false);
  const [completeness, setCompleteness] = useState(null);
  const [loadingCompleteness, setLoadingCompleteness] = useState(false);
  const [showValidation, setShowValidation] = useState(false);
  const [contradictions, setContradictions] = useState(null);
  const [checkingContradictions, setCheckingContradictions] = useState(false);
  const [providers, setProviders] = useState([]);
  const [selectedProvider, setSelectedProvider] = useState(null);
  const [showWizard, setShowWizard] = useState(false);
  const [traits, setTraits] = useState(null);
  const [confidence, setConfidence] = useState(null);
  const [gaps, setGaps] = useState([]);

  useEffect(() => {
    loadCompleteness();
    loadProviders();
    loadTraitsAndConfidence();
  }, []);

  const loadTraitsAndConfidence = async () => {
    const [traitsData, confidenceData, gapsData] = await Promise.all([
      api.getDigitalTwinTraits().catch(() => ({ traits: null })),
      api.getDigitalTwinConfidence().catch(() => ({ confidence: null })),
      api.getDigitalTwinGaps().catch(() => ({ gaps: [] }))
    ]);
    setTraits(traitsData.traits);
    setConfidence(confidenceData.confidence);
    setGaps(gapsData.gaps || []);
  };

  const loadCompleteness = async () => {
    setLoadingCompleteness(true);
    const data = await api.getSoulCompleteness().catch(() => null);
    setCompleteness(data);
    setLoadingCompleteness(false);
  };

  const loadProviders = async () => {
    const data = await api.getProviders().catch(() => ({ providers: [] }));
    const enabled = (data.providers || []).filter(p => p.enabled);
    setProviders(enabled);
    if (enabled.length > 0) {
      setSelectedProvider({ providerId: enabled[0].id, model: enabled[0].defaultModel });
    }
  };

  const checkContradictions = async () => {
    if (!selectedProvider) {
      toast.error('Select a provider first');
      return;
    }
    setCheckingContradictions(true);
    const result = await api.detectSoulContradictions(
      selectedProvider.providerId,
      selectedProvider.model
    ).catch(e => ({ error: e.message }));
    setContradictions(result);
    setCheckingContradictions(false);
  };

  const isEmpty = !status || status.documentCount === 0;

  const handleSaveSettings = async () => {
    setSaving(true);
    await api.updateSoulSettings(settingsForm);
    toast.success('Settings updated');
    setSaving(false);
    setShowSettings(false);
    onRefresh();
  };

  if (isEmpty) {
    if (showWizard) {
      return (
        <div className="max-w-2xl mx-auto p-8">
          <SoulWizard
            onComplete={() => {
              setShowWizard(false);
              onRefresh();
            }}
            onCancel={() => setShowWizard(false)}
          />
        </div>
      );
    }

    return (
      <div className="flex flex-col items-center justify-center h-full max-w-2xl mx-auto text-center p-8">
        <Heart className="w-16 h-16 text-pink-500 mb-6" />
        <h2 className="text-2xl font-bold text-white mb-4">Create Your Digital Twin</h2>
        <p className="text-gray-400 mb-8">
          A soul document is a comprehensive identity scaffold that defines who you are -
          your values, preferences, communication style, and cognitive patterns.
          When loaded into an LLM, it creates a digital twin that thinks and responds like you.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 w-full mb-8">
          <div className="p-4 bg-port-card rounded-lg border border-port-border">
            <FileText className="w-8 h-8 text-purple-400 mb-3" />
            <h3 className="font-semibold text-white mb-2">Core Identity</h3>
            <p className="text-sm text-gray-400">Define your values, philosophy, and worldview</p>
          </div>
          <div className="p-4 bg-port-card rounded-lg border border-port-border">
            <Sparkles className="w-8 h-8 text-yellow-400 mb-3" />
            <h3 className="font-semibold text-white mb-2">Enrichment</h3>
            <p className="text-sm text-gray-400">Answer questions to expand your profile</p>
          </div>
          <div className="p-4 bg-port-card rounded-lg border border-port-border">
            <CheckCircle className="w-8 h-8 text-green-400 mb-3" />
            <h3 className="font-semibold text-white mb-2">Testing</h3>
            <p className="text-sm text-gray-400">Verify alignment across different models</p>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-3 sm:gap-4">
          <button
            onClick={() => setShowWizard(true)}
            className="px-6 py-3 min-h-[44px] bg-port-accent text-white rounded-lg font-medium hover:bg-port-accent/80 transition-colors"
          >
            Start Wizard
          </button>
          <button
            onClick={() => navigate('/digital-twin/enrich')}
            className="px-6 py-3 min-h-[44px] bg-port-card text-white rounded-lg font-medium border border-port-border hover:bg-port-border transition-colors"
          >
            Start Enrichment
          </button>
          <button
            onClick={() => navigate('/digital-twin/documents')}
            className="px-6 py-3 min-h-[44px] bg-port-card text-white rounded-lg font-medium border border-port-border hover:bg-port-border transition-colors"
          >
            Create Document
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Health Score Card */}
      <div className="bg-port-card rounded-lg border border-port-border p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white">Soul Health</h2>
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="p-2 min-h-[40px] min-w-[40px] flex items-center justify-center text-gray-400 hover:text-white transition-colors"
            title="Settings"
          >
            <Settings size={20} />
          </button>
        </div>

        <div className="flex flex-col sm:flex-row items-center gap-6">
          <div className="relative w-28 h-28 sm:w-32 sm:h-32 flex-shrink-0">
            <svg className="w-full h-full transform -rotate-90" viewBox="0 0 128 128">
              <circle
                cx="64"
                cy="64"
                r="56"
                stroke="currentColor"
                strokeWidth="8"
                fill="none"
                className="text-port-border"
              />
              <circle
                cx="64"
                cy="64"
                r="56"
                stroke="currentColor"
                strokeWidth="8"
                fill="none"
                strokeDasharray={`${status.healthScore * 3.52} 352`}
                strokeLinecap="round"
                className={getHealthColor(status.healthScore)}
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className={`text-2xl sm:text-3xl font-bold ${getHealthColor(status.healthScore)}`}>
                {status.healthScore}%
              </span>
              <span className="text-xs text-gray-500">
                {getHealthLabel(status.healthScore)}
              </span>
            </div>
          </div>

          <div className="flex-1 grid grid-cols-3 gap-2 sm:gap-4 w-full">
            <div className="text-center sm:text-left">
              <div className="text-xl sm:text-2xl font-bold text-white">{status.enabledDocuments}</div>
              <div className="text-xs sm:text-sm text-gray-500">Active Docs</div>
            </div>
            <div className="text-center sm:text-left">
              <div className="text-xl sm:text-2xl font-bold text-white">
                {status.enrichmentProgress?.completedCategories || 0}/{status.enrichmentProgress?.totalCategories || 10}
              </div>
              <div className="text-xs sm:text-sm text-gray-500">Enriched</div>
            </div>
            <div className="text-center sm:text-left">
              <div className="text-xl sm:text-2xl font-bold text-white">
                {status.lastTestRun ? `${Math.round(status.lastTestRun.score * 100)}%` : '—'}
              </div>
              <div className="text-xs sm:text-sm text-gray-500">Test Score</div>
            </div>
          </div>
        </div>

        {/* Settings Panel */}
        {showSettings && (
          <div className="mt-6 pt-6 border-t border-port-border">
            <h3 className="text-sm font-medium text-gray-400 mb-4">Settings</h3>
            <div className="space-y-4">
              <label className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={settingsForm.autoInjectToCoS || false}
                  onChange={(e) => setSettingsForm({ ...settingsForm, autoInjectToCoS: e.target.checked })}
                  className="w-4 h-4 rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent"
                />
                <span className="text-white">Auto-inject soul context into CoS agents</span>
              </label>
              <div>
                <label className="block text-sm text-gray-400 mb-2">Max context tokens</label>
                <input
                  type="number"
                  value={settingsForm.maxContextTokens || 4000}
                  onChange={(e) => setSettingsForm({ ...settingsForm, maxContextTokens: parseInt(e.target.value) })}
                  className="w-32 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white"
                />
              </div>
              <button
                onClick={handleSaveSettings}
                disabled={saving}
                className="px-4 py-2 bg-port-accent text-white rounded-lg text-sm hover:bg-port-accent/80 disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save Settings'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Personality Traits & Confidence - New Phase 1 & 2 Components */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <PersonalityMap
          traits={traits}
          confidence={confidence}
          providers={providers}
          onAnalyze={loadTraitsAndConfidence}
        />
        <ConfidenceGauge
          confidence={confidence}
          onRecalculate={loadTraitsAndConfidence}
        />
      </div>

      {/* Gap Recommendations */}
      {gaps.length > 0 && (
        <GapRecommendations gaps={gaps} maxDisplay={3} />
      )}

      {/* Completeness Score */}
      <div className="bg-port-card rounded-lg border border-port-border p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <Target size={20} />
            Completeness
          </h2>
          <button
            onClick={() => setShowValidation(!showValidation)}
            className="text-sm text-port-accent hover:text-white transition-colors"
          >
            {showValidation ? 'Hide Details' : 'Show Details'}
          </button>
        </div>

        {loadingCompleteness ? (
          <div className="flex items-center gap-2 text-gray-400">
            <RefreshCw className="w-4 h-4 animate-spin" />
            Analyzing...
          </div>
        ) : completeness ? (
          <div>
            <div className="flex items-center gap-4 mb-4">
              <div className={`text-3xl font-bold ${
                completeness.score >= 80 ? 'text-green-400' :
                completeness.score >= 50 ? 'text-yellow-400' : 'text-red-400'
              }`}>
                {completeness.score}%
              </div>
              <div>
                <div className="text-white">{completeness.found}/{completeness.total} sections covered</div>
                <div className="text-sm text-gray-500">
                  {completeness.missing.length === 0 ? 'All core sections present' : `${completeness.missing.length} sections missing`}
                </div>
              </div>
            </div>

            {/* Progress bar */}
            <div className="h-2 bg-port-border rounded-full overflow-hidden mb-4">
              <div
                className={`h-full transition-all ${
                  completeness.score >= 80 ? 'bg-green-500' :
                  completeness.score >= 50 ? 'bg-yellow-500' : 'bg-red-500'
                }`}
                style={{ width: `${completeness.score}%` }}
              />
            </div>

            {showValidation && completeness.missing.length > 0 && (
              <div className="space-y-3 mt-4 pt-4 border-t border-port-border">
                <h3 className="text-sm font-medium text-gray-400">Missing Sections</h3>
                {completeness.missing.map(section => (
                  <div
                    key={section.id}
                    className="p-3 bg-port-bg rounded-lg border border-port-border"
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-medium text-white">{section.label}</div>
                        <div className="text-sm text-gray-400">{section.description}</div>
                      </div>
                      {section.enrichmentCategory && (
                        <button
                          onClick={() => navigate('/digital-twin/enrich')}
                          className="flex items-center gap-1 text-sm text-port-accent hover:text-white"
                        >
                          Add via Enrich
                          <ChevronRight size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="text-gray-500">Unable to analyze completeness</div>
        )}
      </div>

      {/* Contradiction Detection */}
      <div className="bg-port-card rounded-lg border border-port-border p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <AlertTriangle size={20} />
            Consistency Check
          </h2>
        </div>

        <p className="text-sm text-gray-400 mb-4">
          Use AI to detect contradictions or inconsistencies between your soul documents.
        </p>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 sm:gap-4 mb-4">
          <select
            value={selectedProvider ? `${selectedProvider.providerId}:${selectedProvider.model}` : ''}
            onChange={(e) => {
              const [providerId, model] = e.target.value.split(':');
              setSelectedProvider({ providerId, model });
            }}
            className="px-3 py-3 min-h-[44px] bg-port-bg border border-port-border rounded-lg text-white text-sm"
          >
            {providers.map(p => (
              (p.models || [p.defaultModel]).filter(Boolean).map(model => (
                <option key={`${p.id}:${model}`} value={`${p.id}:${model}`}>
                  {p.name} - {model}
                </option>
              ))
            ))}
          </select>

          <button
            onClick={checkContradictions}
            disabled={checkingContradictions}
            className="px-4 py-3 min-h-[44px] bg-port-accent text-white rounded-lg text-sm hover:bg-port-accent/80 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {checkingContradictions ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                Analyzing...
              </>
            ) : (
              'Check for Contradictions'
            )}
          </button>
        </div>

        {contradictions && (
          <div className="mt-4 pt-4 border-t border-port-border">
            {contradictions.error ? (
              <div className="text-red-400 text-sm">{contradictions.error}</div>
            ) : contradictions.issues?.length === 0 ? (
              <div className="flex items-center gap-2 text-green-400">
                <CheckCircle size={18} />
                No contradictions detected
              </div>
            ) : (
              <div className="space-y-3">
                <div className="text-sm text-gray-400">{contradictions.summary}</div>
                {contradictions.issues?.map((issue, i) => (
                  <div
                    key={i}
                    className={`p-3 rounded-lg border ${
                      issue.severity === 'high' ? 'bg-red-500/10 border-red-500/30' :
                      issue.severity === 'medium' ? 'bg-yellow-500/10 border-yellow-500/30' :
                      'bg-blue-500/10 border-blue-500/30'
                    }`}
                  >
                    <div className="font-medium text-white mb-1">
                      {issue.docs?.join(' & ')}
                    </div>
                    <div className="text-sm text-gray-300 mb-2">{issue.explanation}</div>
                    {issue.suggestion && (
                      <div className="text-sm text-gray-400">
                        Suggestion: {issue.suggestion}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Document Categories */}
      <div className="bg-port-card rounded-lg border border-port-border p-4 sm:p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Documents by Category</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
          {Object.entries(DOCUMENT_CATEGORIES).map(([key, config]) => {
            const count = status.documentsByCategory?.[key] || 0;
            const Icon = config.icon;
            return (
              <div
                key={key}
                className={`p-4 rounded-lg border ${config.color} cursor-pointer hover:opacity-80 transition-opacity`}
                onClick={() => navigate('/digital-twin/documents')}
              >
                <div className="flex items-center gap-2 mb-2">
                  <Icon size={16} />
                  <span className="font-medium">{config.label}</span>
                </div>
                <div className="text-2xl font-bold">{count}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Quick Actions */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
        <button
          onClick={() => navigate('/digital-twin/test')}
          className="flex items-center gap-3 sm:gap-4 p-4 min-h-[72px] bg-port-card rounded-lg border border-port-border hover:border-port-accent transition-colors"
        >
          <div className="p-2.5 sm:p-3 rounded-lg bg-green-500/20 flex-shrink-0">
            <Play className="w-5 h-5 sm:w-6 sm:h-6 text-green-400" />
          </div>
          <div className="text-left min-w-0">
            <div className="font-medium text-white">Run Tests</div>
            <div className="text-sm text-gray-500 truncate">
              {status.lastTestRun
                ? `Last: ${formatRelativeTime(status.lastTestRun.timestamp)}`
                : 'Test behavioral alignment'}
            </div>
          </div>
        </button>

        <button
          onClick={() => navigate('/digital-twin/enrich')}
          className="flex items-center gap-3 sm:gap-4 p-4 min-h-[72px] bg-port-card rounded-lg border border-port-border hover:border-port-accent transition-colors"
        >
          <div className="p-2.5 sm:p-3 rounded-lg bg-yellow-500/20 flex-shrink-0">
            <Sparkles className="w-5 h-5 sm:w-6 sm:h-6 text-yellow-400" />
          </div>
          <div className="text-left min-w-0">
            <div className="font-medium text-white">Enrich Soul</div>
            <div className="text-sm text-gray-500 truncate">
              {status.enrichmentProgress?.completedCategories || 0} categories complete
            </div>
          </div>
        </button>

        <button
          onClick={() => navigate('/digital-twin/export')}
          className="flex items-center gap-3 sm:gap-4 p-4 min-h-[72px] bg-port-card rounded-lg border border-port-border hover:border-port-accent transition-colors"
        >
          <div className="p-2.5 sm:p-3 rounded-lg bg-blue-500/20 flex-shrink-0">
            <Download className="w-5 h-5 sm:w-6 sm:h-6 text-blue-400" />
          </div>
          <div className="text-left min-w-0">
            <div className="font-medium text-white">Export Soul</div>
            <div className="text-sm text-gray-500 truncate">Download for external LLMs</div>
          </div>
        </button>
      </div>

      {/* Last Test Result */}
      {status.lastTestRun && (
        <div className="bg-port-card rounded-lg border border-port-border p-4 sm:p-6">
          <h2 className="text-lg font-semibold text-white mb-4">Latest Test Run</h2>
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className={`text-2xl sm:text-3xl font-bold ${
                status.lastTestRun.score >= 0.8 ? 'text-green-400' :
                status.lastTestRun.score >= 0.5 ? 'text-yellow-400' : 'text-red-400'
              }`}>
                {Math.round(status.lastTestRun.score * 100)}%
              </div>
              <div>
                <div className="text-white font-medium">
                  {status.lastTestRun.passed}/{status.lastTestRun.total} tests passed
                </div>
                <div className="text-xs sm:text-sm text-gray-500">
                  Model: {status.lastTestRun.model} • {formatRelativeTime(status.lastTestRun.timestamp)}
                </div>
              </div>
            </div>
            <button
              onClick={() => navigate('/digital-twin/test')}
              className="px-4 py-2 min-h-[40px] text-sm text-port-accent hover:text-white transition-colors"
            >
              View Details
            </button>
          </div>
        </div>
      )}

      {/* CoS Integration Status */}
      <div className="bg-port-card rounded-lg border border-port-border p-4">
        <div className="flex items-center gap-3">
          {settings?.autoInjectToCoS ? (
            <>
              <CheckCircle className="w-5 h-5 text-green-400" />
              <span className="text-white">Soul context is being injected into CoS agents</span>
            </>
          ) : (
            <>
              <AlertCircle className="w-5 h-5 text-yellow-400" />
              <span className="text-white">Soul context injection is disabled</span>
              <button
                onClick={() => setShowSettings(true)}
                className="ml-auto text-sm text-port-accent hover:text-white"
              >
                Enable
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
