import { useState, useEffect } from 'react';
import {
  ArrowLeft,
  Plus,
  X,
  Sparkles,
  RefreshCw,
  Save,
  Edit3,
  Eye,
  ChevronDown,
  ChevronRight,
  Check
} from 'lucide-react';
import * as api from '../../services/api';
import toast from 'react-hot-toast';

import { ENRICHMENT_CATEGORIES } from './constants';

/**
 * List-based enrichment component for books, movies, music
 * Allows users to add items, analyze them with LLM, review/edit results
 */
export default function ListEnrichment({
  categoryId,
  onBack,
  onRefresh,
  providers,
  selectedProvider,
  setSelectedProvider
}) {
  const config = ENRICHMENT_CATEGORIES[categoryId];

  // List items state
  const [items, setItems] = useState([{ title: '', note: '' }]);
  const [loadingItems, setLoadingItems] = useState(true);

  // Analysis state
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState(null);

  // Document editing state
  const [editingDocument, setEditingDocument] = useState(false);
  const [documentContent, setDocumentContent] = useState('');
  const [saving, setSaving] = useState(false);

  // Expanded sections
  const [showItemAnalysis, setShowItemAnalysis] = useState(false);
  const [showPatterns, setShowPatterns] = useState(true);
  const [showInsights, setShowInsights] = useState(true);

  // Load existing items on mount
  useEffect(() => {
    loadExistingItems();
  }, [categoryId]);

  const loadExistingItems = async () => {
    setLoadingItems(true);
    const existingItems = await api.getEnrichmentListItems(categoryId).catch(() => []);
    if (existingItems && existingItems.length > 0) {
      setItems(existingItems);
    } else {
      setItems([{ title: '', note: '' }]);
    }
    setLoadingItems(false);
  };

  const addItem = () => {
    setItems([...items, { title: '', note: '' }]);
  };

  const updateItem = (index, field, value) => {
    const updated = [...items];
    updated[index] = { ...updated[index], [field]: value };
    setItems(updated);
  };

  const removeItem = (index) => {
    if (items.length > 1) {
      setItems(items.filter((_, i) => i !== index));
    }
  };

  const getValidItems = () => items.filter(item => item.title.trim().length > 0);

  const analyzeList = async () => {
    const validItems = getValidItems();
    if (validItems.length === 0) {
      toast.error(`Add at least one ${config.itemLabel.toLowerCase()}`);
      return;
    }
    if (!selectedProvider) {
      toast.error('Select a provider first');
      return;
    }

    setAnalyzing(true);
    setAnalysis(null);

    const result = await api.analyzeEnrichmentList(
      categoryId,
      validItems,
      selectedProvider.providerId,
      selectedProvider.model
    ).catch(e => ({ error: e.message }));

    if (result.error) {
      toast.error(result.error);
    } else {
      setAnalysis(result);
      setDocumentContent(result.suggestedDocument || '');
      toast.success('Analysis complete');
    }
    setAnalyzing(false);
  };

  const saveDocument = async () => {
    if (!documentContent.trim()) {
      toast.error('No document content to save');
      return;
    }

    setSaving(true);
    const result = await api.saveEnrichmentList(
      categoryId,
      documentContent,
      getValidItems()
    ).catch(e => ({ error: e.message }));

    if (result.error) {
      toast.error(result.error);
    } else {
      toast.success(`Saved to ${result.targetDoc}`);
      onRefresh?.();
    }
    setSaving(false);
  };

  const Icon = config?.icon || Sparkles;

  if (loadingItems) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-8 h-8 text-port-accent animate-spin" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-1">
      {/* Header */}
      <div className="mb-6 sm:mb-8">
        <button
          onClick={onBack}
          className="flex items-center gap-2 text-gray-400 hover:text-white mb-4 py-2 min-h-[44px]"
        >
          <ArrowLeft size={18} />
          Back to categories
        </button>

        <div className="flex items-center gap-3 sm:gap-4">
          <div className={`p-2.5 sm:p-3 rounded-lg bg-${config?.color || 'blue'}-500/20 flex-shrink-0`}>
            <Icon className={`w-5 h-5 sm:w-6 sm:h-6 text-${config?.color || 'blue'}-400`} />
          </div>
          <div className="min-w-0">
            <h2 className="text-lg sm:text-xl font-bold text-white">{config?.label}</h2>
            <p className="text-sm sm:text-base text-gray-400">{config?.description}</p>
          </div>
        </div>
      </div>

      {/* Items List */}
      <div className="bg-port-card rounded-lg border border-port-border p-4 sm:p-6 mb-6">
        <h3 className="font-medium text-white mb-4 flex items-center gap-2">
          <Icon size={18} />
          Your {config?.label}
        </h3>

        <div className="space-y-4">
          {items.map((item, index) => (
            <div
              key={index}
              className="bg-port-bg rounded-lg border border-port-border p-4 relative group"
            >
              {items.length > 1 && (
                <button
                  onClick={() => removeItem(index)}
                  className="absolute top-2 right-2 p-1.5 text-gray-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Remove"
                >
                  <X size={16} />
                </button>
              )}

              <div className="space-y-3">
                <div>
                  <label className="text-xs text-gray-500 uppercase tracking-wider mb-1 block">
                    {config?.itemLabel} {index + 1}
                  </label>
                  <input
                    type="text"
                    value={item.title}
                    onChange={(e) => updateItem(index, 'title', e.target.value)}
                    placeholder={config?.itemPlaceholder}
                    className="w-full px-3 py-2.5 bg-port-card border border-port-border rounded-lg text-white focus:outline-none focus:border-port-accent"
                  />
                </div>

                <div>
                  <label className="text-xs text-gray-500 uppercase tracking-wider mb-1 block">
                    Notes (optional)
                  </label>
                  <textarea
                    value={item.note}
                    onChange={(e) => updateItem(index, 'note', e.target.value)}
                    placeholder={config?.notePlaceholder}
                    rows={2}
                    className="w-full px-3 py-2.5 bg-port-card border border-port-border rounded-lg text-white resize-none focus:outline-none focus:border-port-accent"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>

        <button
          onClick={addItem}
          className="mt-4 flex items-center gap-2 px-4 py-2.5 min-h-[44px] text-port-accent hover:text-white border border-port-accent/30 rounded-lg hover:border-port-accent transition-colors"
        >
          <Plus size={18} />
          Add {config?.itemLabel}
        </button>
      </div>

      {/* Provider Selection & Analyze Button */}
      <div className="bg-port-card rounded-lg border border-port-border p-4 sm:p-6 mb-6">
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-4">
          <div className="flex-1">
            <label className="text-xs text-gray-500 uppercase tracking-wider mb-2 block">
              Analyze with
            </label>
            <select
              value={selectedProvider ? `${selectedProvider.providerId}:${selectedProvider.model}` : ''}
              onChange={(e) => {
                const [providerId, model] = e.target.value.split(':');
                setSelectedProvider({ providerId, model });
              }}
              className="w-full px-3 py-3 min-h-[44px] bg-port-bg border border-port-border rounded-lg text-white text-sm"
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

          <button
            onClick={analyzeList}
            disabled={analyzing || getValidItems().length === 0}
            className="px-6 py-3 min-h-[48px] bg-port-accent text-white rounded-lg font-medium hover:bg-port-accent/80 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 sm:self-end"
          >
            {analyzing ? (
              <>
                <RefreshCw className="w-5 h-5 animate-spin" />
                Analyzing...
              </>
            ) : (
              <>
                <Sparkles size={18} />
                Analyze & Generate
              </>
            )}
          </button>
        </div>

        <p className="text-xs text-gray-500 mt-3">
          The AI will analyze your selections to identify patterns, themes, and personality insights.
        </p>
      </div>

      {/* Analysis Results */}
      {analysis && (
        <div className="space-y-6">
          {/* Item Analysis (collapsible) */}
          {analysis.itemAnalysis?.length > 0 && (
            <div className="bg-port-card rounded-lg border border-port-border overflow-hidden">
              <button
                onClick={() => setShowItemAnalysis(!showItemAnalysis)}
                className="w-full p-4 flex items-center justify-between hover:bg-port-border/30 transition-colors"
              >
                <h3 className="font-medium text-white flex items-center gap-2">
                  <Eye size={18} />
                  Item-by-Item Analysis
                </h3>
                {showItemAnalysis ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
              </button>

              {showItemAnalysis && (
                <div className="p-4 pt-0 space-y-3">
                  {analysis.itemAnalysis.map((item, i) => (
                    <div key={i} className="p-3 bg-port-bg rounded-lg">
                      <div className="font-medium text-white mb-1">{item.title}</div>
                      <div className="text-sm text-gray-400">{item.insights}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Patterns */}
          {analysis.patterns?.length > 0 && (
            <div className="bg-port-card rounded-lg border border-port-border overflow-hidden">
              <button
                onClick={() => setShowPatterns(!showPatterns)}
                className="w-full p-4 flex items-center justify-between hover:bg-port-border/30 transition-colors"
              >
                <h3 className="font-medium text-white flex items-center gap-2">
                  <Sparkles size={18} />
                  Patterns Detected
                </h3>
                {showPatterns ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
              </button>

              {showPatterns && (
                <div className="p-4 pt-0">
                  <ul className="space-y-2">
                    {analysis.patterns.map((pattern, i) => (
                      <li key={i} className="flex items-start gap-2 text-gray-300">
                        <Check size={16} className="text-green-400 mt-0.5 flex-shrink-0" />
                        {pattern}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Personality Insights */}
          {analysis.personalityInsights && (
            <div className="bg-port-card rounded-lg border border-port-border overflow-hidden">
              <button
                onClick={() => setShowInsights(!showInsights)}
                className="w-full p-4 flex items-center justify-between hover:bg-port-border/30 transition-colors"
              >
                <h3 className="font-medium text-white flex items-center gap-2">
                  <Sparkles size={18} />
                  Personality Insights
                </h3>
                {showInsights ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
              </button>

              {showInsights && (
                <div className="p-4 pt-0 space-y-3">
                  {Object.entries(analysis.personalityInsights).map(([key, value]) => (
                    <div key={key} className="p-3 bg-port-bg rounded-lg">
                      <div className="text-xs text-gray-500 uppercase tracking-wider mb-1">
                        {key.replace(/([A-Z])/g, ' $1').trim()}
                      </div>
                      <div className="text-sm text-gray-300">{value}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Generated Document */}
          <div className="bg-port-card rounded-lg border border-port-border p-4 sm:p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-medium text-white flex items-center gap-2">
                Generated Document: {analysis.targetDoc}
              </h3>
              <button
                onClick={() => setEditingDocument(!editingDocument)}
                className="flex items-center gap-1 text-sm text-port-accent hover:text-white"
              >
                <Edit3 size={14} />
                {editingDocument ? 'Preview' : 'Edit'}
              </button>
            </div>

            {editingDocument ? (
              <textarea
                value={documentContent}
                onChange={(e) => setDocumentContent(e.target.value)}
                rows={15}
                className="w-full px-4 py-3 bg-port-bg border border-port-border rounded-lg text-white font-mono text-sm resize-y focus:outline-none focus:border-port-accent"
              />
            ) : (
              <pre className="p-4 bg-port-bg rounded-lg text-sm text-gray-300 whitespace-pre-wrap overflow-auto max-h-96">
                {documentContent}
              </pre>
            )}

            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 mt-4 pt-4 border-t border-port-border">
              <p className="text-xs text-gray-500">
                Review and edit the generated content before saving.
              </p>
              <button
                onClick={saveDocument}
                disabled={saving || !documentContent.trim()}
                className="px-6 py-3 min-h-[44px] bg-green-600 text-white rounded-lg font-medium hover:bg-green-500 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {saving ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Save size={18} />
                    Save to Digital Twin
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
