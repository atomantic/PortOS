import { useState, useEffect } from 'react';
import {
  Upload,
  BookOpen,
  Music,
  Film,
  Calendar,
  RefreshCw,
  Check,
  AlertCircle,
  FileText,
  ChevronRight,
  ExternalLink,
  Save,
  Trash2
} from 'lucide-react';
import * as api from '../../../services/api';
import toast from 'react-hot-toast';

const SOURCE_ICONS = {
  goodreads: BookOpen,
  spotify: Music,
  letterboxd: Film,
  ical: Calendar
};

const SOURCE_COLORS = {
  goodreads: 'text-amber-400 bg-amber-500/20',
  spotify: 'text-green-400 bg-green-500/20',
  letterboxd: 'text-orange-400 bg-orange-500/20',
  ical: 'text-blue-400 bg-blue-500/20'
};

export default function ImportTab() {
  const [sources, setSources] = useState([]);
  const [providers, setProviders] = useState([]);
  const [selectedSource, setSelectedSource] = useState(null);
  const [selectedProvider, setSelectedProvider] = useState(null);
  const [fileContent, setFileContent] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadSources();
    loadProviders();
  }, []);

  const loadSources = async () => {
    const data = await api.getDigitalTwinImportSources().catch(() => ({ sources: [] }));
    setSources(data.sources || []);
  };

  const loadProviders = async () => {
    const data = await api.getProviders().catch(() => ({ providers: [] }));
    const enabled = (data.providers || []).filter(p => p.enabled);
    setProviders(enabled);
    if (enabled.length > 0) {
      setSelectedProvider({ providerId: enabled[0].id, model: enabled[0].defaultModel });
    }
  };

  const handleFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      setFileContent(event.target.result);
      setAnalysisResult(null);
    };
    reader.readAsText(file);
  };

  const handleAnalyze = async () => {
    if (!selectedSource || !fileContent || !selectedProvider) {
      toast.error('Please select a source, upload a file, and choose a provider');
      return;
    }

    setAnalyzing(true);
    setAnalysisResult(null);

    const result = await api.analyzeDigitalTwinImport(
      selectedSource.id,
      fileContent,
      selectedProvider.providerId,
      selectedProvider.model
    ).catch(e => ({ error: e.message }));

    if (result.error) {
      toast.error(result.error);
    } else {
      setAnalysisResult(result);
      toast.success(`Analyzed ${result.itemCount} items from ${selectedSource.name}`);
    }

    setAnalyzing(false);
  };

  const handleSaveDocument = async (suggestedDoc) => {
    setSaving(true);

    const result = await api.saveDigitalTwinImport(
      selectedSource.id,
      suggestedDoc
    ).catch(e => ({ error: e.message }));

    if (result.error) {
      toast.error(result.error);
    } else {
      toast.success(`Document "${suggestedDoc.title}" saved successfully`);
      // Remove saved document from suggestions
      setAnalysisResult(prev => ({
        ...prev,
        suggestedDocuments: prev.suggestedDocuments?.filter(d => d.filename !== suggestedDoc.filename)
      }));
    }

    setSaving(false);
  };

  const handleReset = () => {
    setSelectedSource(null);
    setFileContent('');
    setAnalysisResult(null);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-port-card rounded-lg border border-port-border p-6">
        <div className="flex items-center gap-3 mb-4">
          <Upload className="w-6 h-6 text-purple-400" />
          <h2 className="text-xl font-semibold text-white">Import External Data</h2>
        </div>
        <p className="text-gray-400">
          Import data from external services to automatically extract personality insights.
          Your data is processed locally and only the personality inferences are stored.
        </p>
      </div>

      {/* Source Selection */}
      {!selectedSource && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {sources.map(source => {
            const Icon = SOURCE_ICONS[source.id] || FileText;
            const colorClass = SOURCE_COLORS[source.id] || 'text-gray-400 bg-gray-500/20';

            return (
              <button
                key={source.id}
                onClick={() => setSelectedSource(source)}
                className="p-6 bg-port-card rounded-lg border border-port-border hover:border-port-accent transition-colors text-left"
              >
                <div className="flex items-start gap-4">
                  <div className={`p-3 rounded-lg ${colorClass}`}>
                    <Icon className="w-6 h-6" />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold text-white">{source.name}</h3>
                      <span className="text-xs text-gray-500 bg-port-bg px-2 py-1 rounded">
                        {source.format}
                      </span>
                    </div>
                    <p className="text-sm text-gray-400 mt-1">{source.description}</p>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Selected Source - Upload & Analyze */}
      {selectedSource && !analysisResult && (
        <div className="bg-port-card rounded-lg border border-port-border p-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              {(() => {
                const Icon = SOURCE_ICONS[selectedSource.id] || FileText;
                const colorClass = SOURCE_COLORS[selectedSource.id] || 'text-gray-400 bg-gray-500/20';
                return (
                  <div className={`p-2 rounded-lg ${colorClass}`}>
                    <Icon className="w-5 h-5" />
                  </div>
                );
              })()}
              <div>
                <h3 className="font-semibold text-white">{selectedSource.name}</h3>
                <span className="text-xs text-gray-500">{selectedSource.format} file</span>
              </div>
            </div>
            <button
              onClick={handleReset}
              className="text-sm text-gray-400 hover:text-white transition-colors"
            >
              Change Source
            </button>
          </div>

          {/* Instructions */}
          <div className="mb-6 p-4 bg-port-bg rounded-lg border border-port-border">
            <h4 className="text-sm font-medium text-white mb-2">How to export your data</h4>
            <p className="text-sm text-gray-400">{selectedSource.instructions}</p>
          </div>

          {/* File Upload */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-400 mb-2">
              Upload {selectedSource.format} File
            </label>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
              <label className="flex-1 flex items-center justify-center px-4 py-8 border-2 border-dashed border-port-border rounded-lg cursor-pointer hover:border-port-accent transition-colors">
                <input
                  type="file"
                  accept={selectedSource.format === 'CSV' ? '.csv' : selectedSource.format === 'JSON' ? '.json' : '.ics,.ical'}
                  onChange={handleFileUpload}
                  className="hidden"
                />
                <div className="text-center">
                  <Upload className="w-8 h-8 text-gray-500 mx-auto mb-2" />
                  <span className="text-sm text-gray-400">
                    {fileContent ? 'File loaded - click to change' : `Click to upload ${selectedSource.format} file`}
                  </span>
                </div>
              </label>
            </div>
            {fileContent && (
              <div className="mt-2 flex items-center gap-2 text-sm text-green-400">
                <Check className="w-4 h-4" />
                File loaded ({Math.round(fileContent.length / 1024)} KB)
              </div>
            )}
          </div>

          {/* Provider Selection */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-400 mb-2">
              Analysis Provider
            </label>
            <select
              value={selectedProvider ? `${selectedProvider.providerId}:${selectedProvider.model}` : ''}
              onChange={(e) => {
                const [providerId, model] = e.target.value.split(':');
                setSelectedProvider({ providerId, model });
              }}
              className="w-full px-3 py-3 bg-port-bg border border-port-border rounded-lg text-white"
            >
              {providers.map(p => (
                (p.models || [p.defaultModel]).filter(Boolean).map(model => (
                  <option key={`${p.id}:${model}`} value={`${p.id}:${model}`}>
                    {p.name} - {model}
                  </option>
                ))
              ))}
            </select>
          </div>

          {/* Analyze Button */}
          <button
            onClick={handleAnalyze}
            disabled={!fileContent || analyzing}
            className="w-full px-6 py-3 bg-port-accent text-white rounded-lg font-medium hover:bg-port-accent/80 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {analyzing ? (
              <>
                <RefreshCw className="w-5 h-5 animate-spin" />
                Analyzing...
              </>
            ) : (
              <>
                <Upload className="w-5 h-5" />
                Analyze Data
              </>
            )}
          </button>
        </div>
      )}

      {/* Analysis Results */}
      {analysisResult && (
        <div className="space-y-6">
          {/* Summary */}
          <div className="bg-port-card rounded-lg border border-port-border p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                <Check className="w-5 h-5 text-green-400" />
                Analysis Complete
              </h3>
              <button
                onClick={handleReset}
                className="text-sm text-gray-400 hover:text-white flex items-center gap-1"
              >
                <Trash2 className="w-4 h-4" />
                Start Over
              </button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
              <div className="text-center p-3 bg-port-bg rounded-lg">
                <div className="text-2xl font-bold text-white">{analysisResult.itemCount}</div>
                <div className="text-xs text-gray-500">Items Analyzed</div>
              </div>
              <div className="text-center p-3 bg-port-bg rounded-lg">
                <div className="text-2xl font-bold text-white">
                  {analysisResult.insights?.patterns?.length || 0}
                </div>
                <div className="text-xs text-gray-500">Patterns Found</div>
              </div>
              <div className="text-center p-3 bg-port-bg rounded-lg">
                <div className="text-2xl font-bold text-white">
                  {analysisResult.insights?.personalityInferences?.values?.length || 0}
                </div>
                <div className="text-xs text-gray-500">Values Identified</div>
              </div>
              <div className="text-center p-3 bg-port-bg rounded-lg">
                <div className="text-2xl font-bold text-white">
                  {analysisResult.suggestedDocuments?.length || 0}
                </div>
                <div className="text-xs text-gray-500">Documents Suggested</div>
              </div>
            </div>

            {analysisResult.rawSummary && (
              <p className="text-gray-400 border-t border-port-border pt-4">
                {analysisResult.rawSummary}
              </p>
            )}
          </div>

          {/* Personality Inferences */}
          {analysisResult.insights?.personalityInferences && (
            <div className="bg-port-card rounded-lg border border-port-border p-6">
              <h3 className="text-lg font-semibold text-white mb-4">Personality Inferences</h3>

              {/* Big Five */}
              {analysisResult.insights.personalityInferences.bigFive && (
                <div className="mb-6">
                  <h4 className="text-sm font-medium text-gray-400 mb-3">Big Five Traits</h4>
                  <div className="grid grid-cols-5 gap-2">
                    {Object.entries(analysisResult.insights.personalityInferences.bigFive).map(([trait, score]) => {
                      const labels = { O: 'Open', C: 'Consc', E: 'Extra', A: 'Agree', N: 'Neuro' };
                      return (
                        <div key={trait} className="text-center">
                          <div className="text-xs text-gray-500 mb-1">{labels[trait] || trait}</div>
                          <div className="h-16 bg-port-bg rounded-lg relative overflow-hidden">
                            <div
                              className="absolute bottom-0 left-0 right-0 bg-port-accent/50"
                              style={{ height: `${score * 100}%` }}
                            />
                            <div className="absolute inset-0 flex items-center justify-center">
                              <span className="text-sm font-medium text-white">
                                {Math.round(score * 100)}%
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Values & Interests */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {analysisResult.insights.personalityInferences.values?.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium text-gray-400 mb-2">Values</h4>
                    <div className="flex flex-wrap gap-2">
                      {analysisResult.insights.personalityInferences.values.map((value, i) => (
                        <span
                          key={i}
                          className="px-2 py-1 bg-purple-500/20 text-purple-400 rounded-lg text-sm"
                        >
                          {value}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {analysisResult.insights.personalityInferences.interests?.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium text-gray-400 mb-2">Interests</h4>
                    <div className="flex flex-wrap gap-2">
                      {analysisResult.insights.personalityInferences.interests.map((interest, i) => (
                        <span
                          key={i}
                          className="px-2 py-1 bg-blue-500/20 text-blue-400 rounded-lg text-sm"
                        >
                          {interest}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Patterns & Preferences */}
          {(analysisResult.insights?.patterns?.length > 0 || analysisResult.insights?.preferences?.length > 0) && (
            <div className="bg-port-card rounded-lg border border-port-border p-6">
              <h3 className="text-lg font-semibold text-white mb-4">Patterns & Preferences</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                {analysisResult.insights.patterns?.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium text-gray-400 mb-2">Patterns</h4>
                    <ul className="space-y-2">
                      {analysisResult.insights.patterns.map((pattern, i) => (
                        <li key={i} className="text-sm text-gray-300 flex items-start gap-2">
                          <ChevronRight className="w-4 h-4 text-port-accent flex-shrink-0 mt-0.5" />
                          {pattern}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {analysisResult.insights.preferences?.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium text-gray-400 mb-2">Preferences</h4>
                    <ul className="space-y-2">
                      {analysisResult.insights.preferences.map((pref, i) => (
                        <li key={i} className="text-sm text-gray-300 flex items-start gap-2">
                          <ChevronRight className="w-4 h-4 text-green-400 flex-shrink-0 mt-0.5" />
                          {pref}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Suggested Documents */}
          {analysisResult.suggestedDocuments?.length > 0 && (
            <div className="bg-port-card rounded-lg border border-port-border p-6">
              <h3 className="text-lg font-semibold text-white mb-4">Save as Documents</h3>
              <p className="text-sm text-gray-400 mb-4">
                These documents have been generated from your {selectedSource?.name} data.
                Save them to add this information to your digital twin.
              </p>
              <div className="space-y-3">
                {analysisResult.suggestedDocuments.map((doc, i) => (
                  <div
                    key={i}
                    className="p-4 bg-port-bg rounded-lg border border-port-border"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <FileText className="w-4 h-4 text-gray-400" />
                        <span className="font-medium text-white">{doc.title}</span>
                        <span className="text-xs text-gray-500 bg-port-card px-2 py-0.5 rounded">
                          {doc.category}
                        </span>
                      </div>
                      <button
                        onClick={() => handleSaveDocument(doc)}
                        disabled={saving}
                        className="px-3 py-1.5 bg-port-accent text-white rounded-lg text-sm hover:bg-port-accent/80 disabled:opacity-50 flex items-center gap-1"
                      >
                        <Save className="w-4 h-4" />
                        Save
                      </button>
                    </div>
                    <p className="text-xs text-gray-500">{doc.filename}</p>
                    <details className="mt-2">
                      <summary className="text-sm text-port-accent cursor-pointer hover:text-white">
                        Preview content
                      </summary>
                      <pre className="mt-2 p-3 bg-port-card rounded text-xs text-gray-300 overflow-x-auto whitespace-pre-wrap max-h-48 overflow-y-auto">
                        {doc.content}
                      </pre>
                    </details>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
