import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ClipboardPaste,
  RefreshCw,
  BarChart3,
  ArrowRight,
  AlertCircle,
  Target,
  Sparkles
} from 'lucide-react';
import * as api from '../../../services/api';
import toast from 'react-hot-toast';
import useProviderModels from '../../../hooks/useProviderModels';
import ProviderModelSelector from '../../ProviderModelSelector';
import InterviewAnalysisCard from '../InterviewAnalysisCard';
import { ENRICHMENT_CATEGORIES } from '../constants';

export default function InterviewTab({ onRefresh }) {
  const navigate = useNavigate();
  const {
    providers, selectedProviderId, selectedModel, availableModels,
    setSelectedProviderId, setSelectedModel, loading: providersLoading
  } = useProviderModels();

  const [content, setContent] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState(null);
  const [gaps, setGaps] = useState([]);
  const [enrichProgress, setEnrichProgress] = useState(null);

  const loadEnrichmentData = useCallback(async () => {
    const [gapsData, progressData] = await Promise.all([
      api.getDigitalTwinGaps().catch(() => ({ gaps: [] })),
      api.getDigitalTwinEnrichProgress().catch(() => null)
    ]);
    setGaps(gapsData.gaps || []);
    setEnrichProgress(progressData);
  }, []);

  useEffect(() => {
    loadEnrichmentData();
  }, [loadEnrichmentData]);

  const handleAnalyze = async () => {
    if (!content.trim() || content.trim().length < 50) {
      toast.error('Assessment must be at least 50 characters');
      return;
    }
    if (!selectedProviderId || !selectedModel) {
      toast.error('Select a provider and model');
      return;
    }

    setAnalyzing(true);
    setAnalysisResult(null);

    const result = await api.analyzeAssessment(content.trim(), selectedProviderId, selectedModel)
      .catch((err) => ({ error: err.message }));

    if (result.error) {
      toast.error(result.error);
    } else {
      setAnalysisResult(result.analysisResult);
      if (result.gaps) setGaps(result.gaps);
      toast.success('Assessment analyzed successfully');
      onRefresh?.();
      loadEnrichmentData();
    }
    setAnalyzing(false);
  };

  const navigateToEnrich = (categoryId) => {
    navigate(`/digital-twin/enrich?category=${categoryId}`);
  };

  // Sort gaps by lowest confidence first
  const sortedGaps = [...gaps].sort((a, b) => a.confidence - b.confidence);

  // Build category progress map
  const categoryProgress = enrichProgress?.categories || {};
  const categoryEntries = Object.entries(ENRICHMENT_CATEGORIES);

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Section 1: Paste & Analyze */}
      <div className="bg-port-card rounded-lg border border-port-border p-6">
        <div className="flex items-center gap-3 mb-4">
          <ClipboardPaste className="w-6 h-6 text-port-accent" />
          <div>
            <h2 className="text-lg font-semibold text-white">Analyze Personality Assessment</h2>
            <p className="text-sm text-gray-400">
              Paste an AI personality assessment to automatically enrich your digital twin
            </p>
          </div>
        </div>

        <div className="space-y-4">
          {/* Provider/Model Selector */}
          {!providersLoading && providers.length > 0 && (
            <ProviderModelSelector
              providers={providers}
              selectedProviderId={selectedProviderId}
              selectedModel={selectedModel}
              availableModels={availableModels}
              onProviderChange={setSelectedProviderId}
              onModelChange={setSelectedModel}
              disabled={analyzing}
            />
          )}

          {/* Textarea */}
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Paste your personality assessment here (from ChatGPT, Claude, etc.)..."
            rows={8}
            className="w-full px-4 py-3 bg-port-bg border border-port-border rounded-lg text-white resize-y focus:outline-none focus:border-port-accent placeholder-gray-600"
            disabled={analyzing}
          />

          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-500">
              {content.length} characters {content.length > 0 && content.length < 50 && '(need 50+)'}
            </span>
            <button
              onClick={handleAnalyze}
              disabled={analyzing || content.trim().length < 50 || !selectedProviderId}
              className="flex items-center gap-2 px-6 py-3 min-h-[48px] bg-port-accent text-white rounded-lg font-medium hover:bg-port-accent/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {analyzing ? (
                <>
                  <RefreshCw size={18} className="animate-spin" />
                  Analyzing...
                </>
              ) : (
                <>
                  <BarChart3 size={18} />
                  Analyze
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Section 2: Analysis Results */}
      {analysisResult && (
        <div className="bg-port-card rounded-lg border border-green-500/30 p-6">
          <div className="flex items-center gap-3 mb-4">
            <BarChart3 className="w-6 h-6 text-green-400" />
            <h2 className="text-lg font-semibold text-white">Analysis Results</h2>
          </div>

          {analysisResult.summary && (
            <p className="text-sm text-gray-300 mb-4">{analysisResult.summary}</p>
          )}

          <InterviewAnalysisCard analysisResult={analysisResult} />
        </div>
      )}

      {/* Section 3: Enrichment Guide */}
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Target className="w-6 h-6 text-yellow-400" />
          <h2 className="text-lg font-semibold text-white">Areas to Enrich</h2>
        </div>

        {/* Gap Cards */}
        {sortedGaps.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {sortedGaps.map((gap) => (
              <button
                key={gap.dimension}
                onClick={() => gap.suggestedCategory && navigateToEnrich(gap.suggestedCategory)}
                className="bg-port-card rounded-lg border border-port-border p-4 text-left hover:border-port-accent transition-colors"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-white capitalize">
                    {gap.dimension.replace(/_/g, ' ')}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-400">
                      {Math.round(gap.confidence * 100)}%
                    </span>
                    {gap.suggestedCategory && (
                      <ArrowRight size={14} className="text-gray-500" />
                    )}
                  </div>
                </div>
                <div className="h-1.5 bg-port-border rounded-full overflow-hidden mb-2">
                  <div
                    className={`h-full rounded-full transition-all ${
                      gap.confidence < 0.3 ? 'bg-red-500' :
                      gap.confidence < 0.6 ? 'bg-yellow-500' : 'bg-green-500'
                    }`}
                    style={{ width: `${Math.round(gap.confidence * 100)}%` }}
                  />
                </div>
                {gap.suggestedCategory && (
                  <span className="text-xs text-gray-500">
                    Enrich via: {ENRICHMENT_CATEGORIES[gap.suggestedCategory]?.label || gap.suggestedCategory}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {sortedGaps.length === 0 && (
          <div className="bg-port-card rounded-lg border border-port-border p-4 flex items-center gap-3">
            <AlertCircle size={18} className="text-gray-500" />
            <span className="text-sm text-gray-400">
              No gap data available yet. Analyze an assessment or run confidence calculation to see gaps.
            </span>
          </div>
        )}

        {/* Category Completion Grid */}
        <div>
          <h3 className="text-sm font-medium text-gray-400 mb-3">Enrichment Categories</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {categoryEntries.map(([key, config]) => {
              const progress = categoryProgress[key];
              const isComplete = progress?.completed;
              const percentage = progress?.percentage || 0;
              const Icon = config.icon || Sparkles;

              return (
                <button
                  key={key}
                  onClick={() => navigateToEnrich(key)}
                  className={`flex items-center gap-3 p-3 rounded-lg border transition-colors text-left hover:border-port-accent ${
                    isComplete ? 'border-green-500/30 bg-green-500/5' : 'border-port-border bg-port-card'
                  }`}
                >
                  <Icon size={16} className={isComplete ? 'text-green-400' : 'text-gray-500'} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-white truncate">{config.label}</span>
                      <span className={`text-xs ml-2 ${isComplete ? 'text-green-400' : 'text-gray-500'}`}>
                        {percentage}%
                      </span>
                    </div>
                    <div className="h-1 bg-port-border rounded-full mt-1 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${isComplete ? 'bg-green-500' : 'bg-port-accent'}`}
                        style={{ width: `${percentage}%` }}
                      />
                    </div>
                  </div>
                  <ArrowRight size={14} className="text-gray-600 flex-shrink-0" />
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
