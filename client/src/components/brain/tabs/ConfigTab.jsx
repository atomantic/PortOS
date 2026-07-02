import { useState, useEffect } from 'react';
import * as api from '../../../services/api';
import { filterSelectableModels } from '../../../utils/providers';
import { formatDateTime } from '../../../utils/formatters';
import {Settings,
  Save,
  Zap,
  Clock,
  Calendar,
  TrendingUp,
  CheckCircle,
  Database,
  AlertTriangle,
  RefreshCw} from 'lucide-react';
import BrailleSpinner from '../../BrailleSpinner';
import toast from '../../ui/Toast';

const DAYS_OF_WEEK = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday'
];

export default function ConfigTab({ onRefresh }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState(null);
  const [providers, setProviders] = useState([]);
  const [selectedProvider, setSelectedProvider] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [confidenceThreshold, setConfidenceThreshold] = useState(0.6);
  const [dailyDigestTime, setDailyDigestTime] = useState('09:00');
  const [weeklyReviewDay, setWeeklyReviewDay] = useState('sunday');
  const [weeklyReviewTime, setWeeklyReviewTime] = useState('16:00');
  // Embedding config lives in CoS config (embeddingProviderId/embeddingModel),
  // separate from the brain settings above — it drives semantic search /
  // pgvector, not classification.
  const [embeddingProvider, setEmbeddingProvider] = useState('');
  const [embeddingModel, setEmbeddingModel] = useState('');
  const [savedEmbeddingProvider, setSavedEmbeddingProvider] = useState('');
  const [savedEmbeddingModel, setSavedEmbeddingModel] = useState('');
  const [embeddingStatus, setEmbeddingStatus] = useState(null);
  const [savingEmbedding, setSavingEmbedding] = useState(false);
  const [reprocessing, setReprocessing] = useState(false);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    const [settingsData, providersData, cosConfig, embStatus] = await Promise.all([
      api.getBrainSettings().catch(() => null),
      api.getProviders().catch(() => ({ providers: [] })),
      api.getCosConfig().catch(() => null),
      api.getEmbeddingStatus().catch(() => null)
    ]);

    if (settingsData) {
      setSettings(settingsData);
      setSelectedProvider(settingsData.defaultProvider || '');
      setSelectedModel(settingsData.defaultModel || '');
      setConfidenceThreshold(settingsData.confidenceThreshold ?? 0.6);
      setDailyDigestTime(settingsData.dailyDigestTime || '09:00');
      setWeeklyReviewDay(settingsData.weeklyReviewDay || 'sunday');
      setWeeklyReviewTime(settingsData.weeklyReviewTime || '16:00');
    }

    if (providersData) {
      setProviders(providersData.providers || []);
    }

    if (cosConfig) {
      setEmbeddingProvider(cosConfig.embeddingProviderId || '');
      setEmbeddingModel(cosConfig.embeddingModel || '');
      setSavedEmbeddingProvider(cosConfig.embeddingProviderId || '');
      setSavedEmbeddingModel(cosConfig.embeddingModel || '');
    }
    if (embStatus) setEmbeddingStatus(embStatus);

    setLoading(false);
  };

  const refreshEmbeddingStatus = async () => {
    const embStatus = await api.getEmbeddingStatus().catch(() => null);
    if (embStatus) setEmbeddingStatus(embStatus);
  };

  // Models offered for the EMBEDDING provider. We don't filter to "embed"-named
  // models — provider model lists vary — but surface the whole selectable list
  // so the user can pick e.g. nomic-embed-text on Ollama.
  const getEmbeddingModels = () => {
    if (!embeddingProvider) return [];
    const provider = providers.find(p => p.id === embeddingProvider);
    return filterSelectableModels(provider?.models);
  };

  const embeddingDirty = () =>
    embeddingProvider !== savedEmbeddingProvider || embeddingModel !== savedEmbeddingModel;

  const handleSaveEmbedding = async () => {
    setSavingEmbedding(true);
    const result = await api
      .updateCosConfig({ embeddingProviderId: embeddingProvider, embeddingModel })
      .catch(err => { toast.error(err.message || 'Failed to save embedding config'); return null; });
    setSavingEmbedding(false);
    if (result) {
      setSavedEmbeddingProvider(embeddingProvider);
      setSavedEmbeddingModel(embeddingModel);
      toast.success('Embedding config saved');
      // The server reinitializes embeddings on this PUT — re-probe availability.
      await refreshEmbeddingStatus();
    }
  };

  const handleReprocess = async () => {
    setReprocessing(true);
    const result = await api
      .syncBrainData({ refresh: true }, { silent: true })
      .catch(err => { toast.error(err.message || 'Reprocess failed'); return null; });
    setReprocessing(false);
    if (result) {
      toast.success(`Reprocessed embeddings: ${result.synced} synced, ${result.skipped} skipped, ${result.errors} errors`);
    }
  };

  const handleSave = async () => {
    setSaving(true);

    const updatedSettings = {
      defaultProvider: selectedProvider,
      defaultModel: selectedModel,
      confidenceThreshold: parseFloat(confidenceThreshold),
      dailyDigestTime,
      weeklyReviewDay,
      weeklyReviewTime
    };

    const result = await api.updateBrainSettings(updatedSettings).catch(err => {
      toast.error(err.message || 'Failed to save settings');
      return null;
    });

    setSaving(false);

    if (result) {
      toast.success('Settings saved successfully');
      setSettings(result);
      onRefresh?.();
    }
  };

  const getAvailableModels = () => {
    if (!selectedProvider) return [];
    const provider = providers.find(p => p.id === selectedProvider);
    return filterSelectableModels(provider?.models);
  };

  const hasChanges = () => {
    if (!settings) return false;
    return (
      selectedProvider !== settings.defaultProvider ||
      selectedModel !== settings.defaultModel ||
      parseFloat(confidenceThreshold) !== settings.confidenceThreshold ||
      dailyDigestTime !== settings.dailyDigestTime ||
      weeklyReviewDay !== settings.weeklyReviewDay ||
      weeklyReviewTime !== settings.weeklyReviewTime
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <BrailleSpinner text="Loading" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Settings className="w-5 h-5 text-port-accent" />
          <h2 className="text-lg font-semibold text-white">Configuration</h2>
        </div>
        {hasChanges() && (
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2 bg-port-accent text-white rounded-lg text-sm hover:bg-port-accent/80 disabled:opacity-50"
          >
            {saving ? (
              <>
                <BrailleSpinner />
                Saving...
              </>
            ) : (
              <>
                <Save size={14} />
                Save Changes
              </>
            )}
          </button>
        )}
      </div>

      {/* Settings cards flow into columns on lg/xl, stack on mobile */}
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4 items-start">
      {/* AI Provider & Model Section */}
      <section className="p-4 bg-port-card border border-port-border rounded-lg space-y-4">
        <div className="flex items-center gap-2 mb-4">
          <Zap className="w-5 h-5 text-port-accent" />
          <h3 className="text-md font-semibold text-white">AI Provider & Model</h3>
        </div>

        <div className="space-y-4">
          {/* Provider Selection */}
          <div>
            <label htmlFor="provider" className="block text-sm font-medium text-gray-300 mb-2">
              Default Provider
            </label>
            <select
              id="provider"
              value={selectedProvider}
              onChange={(e) => {
                setSelectedProvider(e.target.value);
                // Reset model when provider changes
                const newProvider = providers.find(p => p.id === e.target.value);
                if (newProvider?.defaultModel) {
                  setSelectedModel(newProvider.defaultModel);
                } else if (filterSelectableModels(newProvider?.models).length > 0) {
                  setSelectedModel(filterSelectableModels(newProvider.models)[0]);
                } else {
                  setSelectedModel('');
                }
              }}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:outline-hidden focus:ring-2 focus:ring-port-accent"
            >
              <option value="">Select a provider...</option>
              {providers.map(provider => (
                <option key={provider.id} value={provider.id}>
                  {provider.name} ({provider.type})
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-500">
              Used for thought classification, digests, and reviews
            </p>
          </div>

          {/* Model Selection */}
          <div>
            <label htmlFor="model" className="block text-sm font-medium text-gray-300 mb-2">
              Default Model
            </label>
            <select
              id="model"
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              disabled={!selectedProvider || getAvailableModels().length === 0}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:outline-hidden focus:ring-2 focus:ring-port-accent disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {getAvailableModels().length === 0 ? (
                <option value="">No models available</option>
              ) : (
                <>
                  <option value="">Select a model...</option>
                  {getAvailableModels().map(model => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </>
              )}
            </select>
            <p className="mt-1 text-xs text-gray-500">
              Select the model for AI operations
            </p>
          </div>
        </div>
      </section>

      {/* Embedding Provider & Model — drives semantic search (pgvector). This
          is a SEPARATE provider/model from the classification one above; many
          installs run classification on a chat model and embeddings on a small
          dedicated embedding model (e.g. Ollama nomic-embed-text). */}
      <section className="p-4 bg-port-card border border-port-border rounded-lg space-y-4">
        <div className="flex items-center gap-2 mb-1">
          <Database className="w-5 h-5 text-port-accent" />
          <h3 className="text-md font-semibold text-white">Embeddings (semantic search)</h3>
        </div>

        {/* Live backend status. Green requires a positive model-present signal
            (the backend always returns modelPresent now) — a reachable backend
            with no usable embedding model is a warning, not success, because
            embedding calls would silently return null. */}
        {embeddingStatus && (
          embeddingStatus.available && embeddingStatus.modelPresent === true ? (
            <div className="flex items-center gap-2 text-xs text-port-success">
              <CheckCircle size={14} />
              <span>Reachable — model <span className="font-mono">{embeddingStatus.embeddingModel || '—'}</span></span>
            </div>
          ) : (
            <div className="flex items-start gap-2 text-xs text-port-warning">
              <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
              <span>
                {embeddingStatus.available
                  ? `Backend reachable but no usable embedding model ("${embeddingStatus.embeddingModel || embeddingModel}") — pick/install one (e.g. nomic-embed-text on Ollama) before reprocessing.`
                  : `Embedding backend unreachable: ${embeddingStatus.error || 'unknown error'}`}
              </span>
            </div>
          )
        )}

        <div className="space-y-4">
          {/* Embedding Provider */}
          <div>
            <label htmlFor="embeddingProvider" className="block text-sm font-medium text-gray-300 mb-2">
              Embedding Provider
            </label>
            <select
              id="embeddingProvider"
              value={embeddingProvider}
              onChange={(e) => {
                setEmbeddingProvider(e.target.value);
                const np = providers.find(p => p.id === e.target.value);
                const models = filterSelectableModels(np?.models);
                // Prefer an embedding-named model if the provider lists one.
                const embed = models.find(m => /embed|nomic|bge|minilm|mxbai/i.test(m));
                setEmbeddingModel(embed || np?.defaultModel || models[0] || '');
              }}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:outline-hidden focus:ring-2 focus:ring-port-accent"
            >
              <option value="">Select a provider...</option>
              {providers.map(provider => (
                <option key={provider.id} value={provider.id}>
                  {provider.name} ({provider.type})
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-500">
              Backend that generates vector embeddings (must serve an OpenAI-compatible <span className="font-mono">/v1/embeddings</span>)
            </p>
          </div>

          {/* Embedding Model */}
          <div>
            <label htmlFor="embeddingModel" className="block text-sm font-medium text-gray-300 mb-2">
              Embedding Model
            </label>
            <select
              id="embeddingModel"
              value={embeddingModel}
              onChange={(e) => setEmbeddingModel(e.target.value)}
              disabled={!embeddingProvider || getEmbeddingModels().length === 0}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:outline-hidden focus:ring-2 focus:ring-port-accent disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {getEmbeddingModels().length === 0 ? (
                <option value="">No models available</option>
              ) : (
                <>
                  <option value="">Select a model...</option>
                  {getEmbeddingModels().map(model => (
                    <option key={model} value={model}>{model}</option>
                  ))}
                </>
              )}
            </select>
            <p className="mt-1 text-xs text-gray-500">
              Changing the model can change vector dimensions — reprocess after switching so all entries share one space.
            </p>
          </div>

          {/* Save + Reprocess */}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              onClick={handleSaveEmbedding}
              disabled={!embeddingDirty() || savingEmbedding}
              className="flex items-center gap-2 px-3 py-2 bg-port-accent text-white rounded-lg text-sm hover:bg-port-accent/80 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {savingEmbedding ? <BrailleSpinner /> : <Save size={14} />}
              Save embedding config
            </button>
            <button
              onClick={handleReprocess}
              disabled={reprocessing || embeddingDirty()}
              title={embeddingDirty() ? 'Save the embedding config first' : 'Re-embed every brain record'}
              className="flex items-center gap-2 px-3 py-2 bg-port-bg border border-port-border text-white rounded-lg text-sm hover:bg-port-card disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {reprocessing ? <BrailleSpinner /> : <RefreshCw size={14} />}
              Reprocess all embeddings
            </button>
          </div>
          <p className="text-xs text-gray-500">
            Reprocess re-embeds every brain record (memories, people, projects, ideas, daily log) — run it after importing or switching models. It drains sequentially in the background.
          </p>
        </div>
      </section>

      {/* Classification Settings */}
      <section className="p-4 bg-port-card border border-port-border rounded-lg space-y-4">
        <div className="flex items-center gap-2 mb-4">
          <TrendingUp className="w-5 h-5 text-port-accent" />
          <h3 className="text-md font-semibold text-white">Classification Settings</h3>
        </div>

        <div>
          <label htmlFor="confidence" className="block text-sm font-medium text-gray-300 mb-2">
            Confidence Threshold: {(confidenceThreshold * 100).toFixed(0)}%
          </label>
          <div className="flex items-center gap-4">
            <input
              id="confidence"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={confidenceThreshold}
              onChange={(e) => setConfidenceThreshold(parseFloat(e.target.value))}
              className="flex-1 h-2 bg-port-bg rounded-lg appearance-none cursor-pointer accent-port-accent"
            />
            <span className="text-sm text-gray-400 w-12 text-right">
              {(confidenceThreshold * 100).toFixed(0)}%
            </span>
          </div>
          <p className="mt-2 text-xs text-gray-500">
            Thoughts classified below this confidence level will require manual review
          </p>
        </div>
      </section>

      {/* Schedule Settings */}
      <section className="p-4 bg-port-card border border-port-border rounded-lg space-y-4">
        <div className="flex items-center gap-2 mb-4">
          <Clock className="w-5 h-5 text-port-accent" />
          <h3 className="text-md font-semibold text-white">Schedule Settings</h3>
        </div>

        <div className="space-y-4">
          {/* Daily Digest Time */}
          <div>
            <label htmlFor="digestTime" className="block text-sm font-medium text-gray-300 mb-2">
              Daily Digest Time
            </label>
            <input
              id="digestTime"
              type="time"
              value={dailyDigestTime}
              onChange={(e) => setDailyDigestTime(e.target.value)}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:outline-hidden focus:ring-2 focus:ring-port-accent"
            />
            <p className="mt-1 text-xs text-gray-500">
              Time when daily digest will be generated automatically
            </p>
          </div>

          {/* Weekly Review Day */}
          <div>
            <label htmlFor="reviewDay" className="block text-sm font-medium text-gray-300 mb-2">
              Weekly Review Day
            </label>
            <select
              id="reviewDay"
              value={weeklyReviewDay}
              onChange={(e) => setWeeklyReviewDay(e.target.value)}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:outline-hidden focus:ring-2 focus:ring-port-accent"
            >
              {DAYS_OF_WEEK.map(day => (
                <option key={day} value={day}>
                  {day.charAt(0).toUpperCase() + day.slice(1)}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-500">
              Day of the week for weekly review generation
            </p>
          </div>

          {/* Weekly Review Time */}
          <div>
            <label htmlFor="reviewTime" className="block text-sm font-medium text-gray-300 mb-2">
              Weekly Review Time
            </label>
            <input
              id="reviewTime"
              type="time"
              value={weeklyReviewTime}
              onChange={(e) => setWeeklyReviewTime(e.target.value)}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:outline-hidden focus:ring-2 focus:ring-port-accent"
            />
            <p className="mt-1 text-xs text-gray-500">
              Time when weekly review will be generated automatically
            </p>
          </div>
        </div>
      </section>

      {/* Current Schedule Summary */}
      {settings && (
        <section className="p-4 bg-port-bg border border-port-border rounded-lg">
          <div className="flex items-center gap-2 mb-3">
            <Calendar className="w-4 h-4 text-gray-400" />
            <h4 className="text-sm font-medium text-gray-400">Schedule Summary</h4>
          </div>
          <div className="space-y-2 text-sm text-gray-300">
            <div className="flex items-center gap-2">
              <CheckCircle size={14} className="text-port-accent" />
              <span>Daily digest at {dailyDigestTime}</span>
            </div>
            <div className="flex items-center gap-2">
              <CheckCircle size={14} className="text-port-accent-2" />
              <span>Weekly review on {weeklyReviewDay.charAt(0).toUpperCase() + weeklyReviewDay.slice(1)}s at {weeklyReviewTime}</span>
            </div>
            {settings.lastDailyDigest && (
              <div className="flex items-center gap-2 text-gray-500">
                <Clock size={14} />
                <span>Last digest: {formatDateTime(settings.lastDailyDigest)}</span>
              </div>
            )}
            {settings.lastWeeklyReview && (
              <div className="flex items-center gap-2 text-gray-500">
                <Clock size={14} />
                <span>Last review: {formatDateTime(settings.lastWeeklyReview)}</span>
              </div>
            )}
          </div>
        </section>
      )}
      </div>

      {/* Save button at bottom for mobile */}
      {hasChanges() && (
        <div className="flex justify-end">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2 bg-port-accent text-white rounded-lg text-sm hover:bg-port-accent/80 disabled:opacity-50"
          >
            {saving ? (
              <>
                <BrailleSpinner />
                Saving...
              </>
            ) : (
              <>
                <Save size={14} />
                Save Changes
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
