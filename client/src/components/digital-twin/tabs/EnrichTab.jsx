import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Sparkles,
  ChevronRight,
  Check,
  Send,
  SkipForward,
  RefreshCw,
  ArrowLeft,
  FileText,
  PenTool,
  Eye,
  Save
} from 'lucide-react';
import * as api from '../../../services/api';
import toast from 'react-hot-toast';

import { ENRICHMENT_CATEGORIES } from '../constants';
import ListEnrichment from '../ListEnrichment';
import ScaleInput from '../ScaleInput';

export default function EnrichTab({ onRefresh }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [categories, setCategories] = useState([]);
  const [progress, setProgress] = useState(null);
  const [loading, setLoading] = useState(true);

  // Active session state
  const [activeCategory, setActiveCategory] = useState(null);
  const [currentQuestion, setCurrentQuestion] = useState(null);
  const [answer, setAnswer] = useState('');
  const [scaleValue, setScaleValue] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [loadingQuestion, setLoadingQuestion] = useState(false);
  const [skippedIndices, setSkippedIndices] = useState([]);

  // Writing sample analysis
  const [showWritingAnalysis, setShowWritingAnalysis] = useState(false);
  const [writingSamples, setWritingSamples] = useState(['']);
  const [analyzingWriting, setAnalyzingWriting] = useState(false);
  const [writingAnalysis, setWritingAnalysis] = useState(null);
  const [providers, setProviders] = useState([]);
  const [selectedProvider, setSelectedProvider] = useState(null);
  const [savingWritingStyle, setSavingWritingStyle] = useState(false);

  useEffect(() => {
    loadData();
    loadProviders();
  }, []);

  // Auto-select category from query param
  useEffect(() => {
    const categoryParam = searchParams.get('category');
    if (categoryParam && ENRICHMENT_CATEGORIES[categoryParam] && !loading) {
      startCategory(categoryParam);
      // Clear the param so back navigation works cleanly
      setSearchParams({}, { replace: true });
    }
  }, [loading, searchParams]);

  const loadData = async () => {
    setLoading(true);
    const [categoriesData, progressData] = await Promise.all([
      api.getSoulEnrichCategories().catch(() => []),
      api.getSoulEnrichProgress().catch(() => null)
    ]);
    setCategories(categoriesData);
    setProgress(progressData);
    setLoading(false);
  };

  const loadProviders = async () => {
    const data = await api.getProviders().catch(() => ({ providers: [] }));
    const enabled = (data.providers || []).filter(p => p.enabled);
    setProviders(enabled);
    if (enabled.length > 0) {
      setSelectedProvider({ providerId: enabled[0].id, model: enabled[0].defaultModel });
    }
  };

  const addWritingSample = () => {
    setWritingSamples([...writingSamples, '']);
  };

  const updateWritingSample = (index, value) => {
    const updated = [...writingSamples];
    updated[index] = value;
    setWritingSamples(updated);
  };

  const removeWritingSample = (index) => {
    if (writingSamples.length > 1) {
      setWritingSamples(writingSamples.filter((_, i) => i !== index));
    }
  };

  const analyzeWriting = async () => {
    const validSamples = writingSamples.filter(s => s.trim().length >= 50);
    if (validSamples.length === 0) {
      toast.error('Add at least one writing sample (50+ characters)');
      return;
    }
    if (!selectedProvider) {
      toast.error('Select a provider first');
      return;
    }

    setAnalyzingWriting(true);
    const result = await api.analyzeWritingSamples(
      validSamples,
      selectedProvider.providerId,
      selectedProvider.model
    ).catch(e => ({ error: e.message }));

    if (result.error) {
      toast.error(result.error);
    } else {
      setWritingAnalysis(result);
      toast.success('Writing analysis complete');
    }
    setAnalyzingWriting(false);
  };

  const saveWritingStyle = async () => {
    if (!writingAnalysis?.suggestedContent) {
      toast.error('No writing style content to save');
      return;
    }

    setSavingWritingStyle(true);
    await api.createSoulDocument({
      filename: 'WRITING_STYLE.md',
      title: 'Writing Style',
      category: 'core',
      content: writingAnalysis.suggestedContent
    }).catch(async () => {
      // Document might exist, try to update by fetching ID
      const docs = await api.getSoulDocuments();
      const existing = docs.find(d => d.filename === 'WRITING_STYLE.md');
      if (existing) {
        return api.updateSoulDocument(existing.id, {
          content: writingAnalysis.suggestedContent
        });
      }
    });
    toast.success('Writing style saved');
    setSavingWritingStyle(false);
    onRefresh();
  };

  const startCategory = async (categoryId) => {
    const config = ENRICHMENT_CATEGORIES[categoryId];
    setActiveCategory(categoryId);
    // Only load question for non-list-based categories
    if (!config?.listBased) {
      await loadQuestion(categoryId);
    }
  };

  const loadQuestion = async (categoryId, skipList = []) => {
    setLoadingQuestion(true);
    const question = await api.getSoulEnrichQuestion(categoryId, undefined, undefined, skipList.length ? skipList : undefined);
    setCurrentQuestion(question);
    setAnswer('');
    setScaleValue(null);
    setLoadingQuestion(false);
  };

  const submitAnswer = async () => {
    const isScale = currentQuestion?.questionType === 'scale';

    if (isScale && scaleValue == null) {
      toast.error('Please select a rating');
      return;
    }
    if (!isScale && !answer.trim()) {
      toast.error('Please provide an answer');
      return;
    }

    setSubmitting(true);

    const payload = {
      questionId: currentQuestion.questionId,
      category: activeCategory,
      question: currentQuestion.question
    };

    if (isScale) {
      payload.questionType = 'scale';
      payload.scaleValue = scaleValue;
      payload.scaleQuestionId = currentQuestion.scaleQuestionId;
    } else {
      payload.questionType = 'text';
      payload.answer = answer.trim();
    }

    const result = await api.submitSoulEnrichAnswer(payload).catch(() => null);
    if (!result) {
      toast.error('Failed to save response. Please try again.');
      setSubmitting(false);
      return;
    }

    toast.success(isScale ? 'Rating saved' : 'Answer saved');
    setSkippedIndices([]);
    await loadData();

    // Load next question
    await loadQuestion(activeCategory);
    setSubmitting(false);
    onRefresh();
  };

  const skipQuestion = async () => {
    const idx = currentQuestion?.questionType === 'scale' ? -(currentQuestion.scaleIndex + 1) : currentQuestion?.questionIndex;
    // Fallback/generated questions have no index — treat skip as category-complete
    if (idx == null) {
      setCurrentQuestion(null);
      return;
    }
    const nextSkipped = [...skippedIndices, idx];
    setSkippedIndices(nextSkipped);
    await loadQuestion(activeCategory, nextSkipped);
  };

  const exitCategory = () => {
    setActiveCategory(null);
    setCurrentQuestion(null);
    setAnswer('');
    setScaleValue(null);
    setSkippedIndices([]);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-8 h-8 text-port-accent animate-spin" />
      </div>
    );
  }

  // List-based enrichment (books, movies, music)
  const activeCategoryConfig = activeCategory ? ENRICHMENT_CATEGORIES[activeCategory] : null;
  if (activeCategory && activeCategoryConfig?.listBased) {
    return (
      <ListEnrichment
        categoryId={activeCategory}
        onBack={exitCategory}
        onRefresh={() => {
          loadData();
          onRefresh?.();
        }}
        providers={providers}
        selectedProvider={selectedProvider}
        setSelectedProvider={setSelectedProvider}
      />
    );
  }

  // All questions exhausted for this category
  if (activeCategory && !currentQuestion && !loadingQuestion) {
    const categoryConfig = ENRICHMENT_CATEGORIES[activeCategory];
    const Icon = categoryConfig?.icon || Sparkles;
    return (
      <div className="max-w-2xl mx-auto px-1">
        <div className="mb-6">
          <button
            onClick={exitCategory}
            className="flex items-center gap-2 text-gray-400 hover:text-white mb-4 py-2 min-h-[44px]"
          >
            <ArrowLeft size={18} />
            Back to categories
          </button>
          <div className="flex items-center gap-3">
            <div className={`p-2.5 rounded-lg bg-${categoryConfig?.color || 'blue'}-500/20`}>
              <Icon className={`w-5 h-5 text-${categoryConfig?.color || 'blue'}-400`} />
            </div>
            <h2 className="text-xl font-semibold text-white">{categoryConfig?.label}</h2>
          </div>
        </div>
        <div className="p-4 bg-green-500/10 border border-green-500/30 rounded-lg">
          <div className="flex items-center gap-3">
            <Check className="w-5 h-5 text-green-400" />
            <span className="text-green-400">All questions for this category have been answered. Great job!</span>
          </div>
        </div>
      </div>
    );
  }

  // Q&A-based enrichment session
  if (activeCategory && currentQuestion) {
    const categoryConfig = ENRICHMENT_CATEGORIES[activeCategory];
    const categoryProgress = progress?.categories?.[activeCategory];
    const Icon = categoryConfig?.icon || Sparkles;

    return (
      <div className="max-w-2xl mx-auto px-1">
        {/* Header */}
        <div className="mb-6 sm:mb-8">
          <button
            onClick={exitCategory}
            className="flex items-center gap-2 text-gray-400 hover:text-white mb-4 py-2 min-h-[44px]"
          >
            <ArrowLeft size={18} />
            Back to categories
          </button>

          <div className="flex items-center gap-3 sm:gap-4">
            <div className={`p-2.5 sm:p-3 rounded-lg bg-${categoryConfig?.color || 'blue'}-500/20 flex-shrink-0`}>
              <Icon className={`w-5 h-5 sm:w-6 sm:h-6 text-${categoryConfig?.color || 'blue'}-400`} />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg sm:text-xl font-bold text-white">{categoryConfig?.label}</h2>
              <p className="text-sm sm:text-base text-gray-400 truncate">{categoryConfig?.description}</p>
            </div>
          </div>

          {/* Progress bar */}
          <div className="mt-4">
            <div className="flex items-center justify-between text-sm mb-1">
              <span className="text-gray-400">
                Question {categoryProgress?.answered + 1 || 1}
                {currentQuestion.totalQuestions && ` of ${currentQuestion.totalQuestions}`}
              </span>
              <span className="text-gray-400">{categoryProgress?.percentage || 0}% complete</span>
            </div>
            <div className="h-2 bg-port-border rounded-full overflow-hidden">
              <div
                className="h-full bg-port-accent transition-all"
                style={{ width: `${categoryProgress?.percentage || 0}%` }}
              />
            </div>
          </div>
        </div>

        {/* Question */}
        {loadingQuestion ? (
          <div className="flex items-center justify-center h-48">
            <RefreshCw className="w-6 h-6 text-port-accent animate-spin" />
          </div>
        ) : (
          <div className="bg-port-card rounded-lg border border-port-border p-6">
            <div className="mb-6">
              <span className="text-xs text-gray-500 uppercase tracking-wider">
                {currentQuestion.questionType === 'scale' ? 'Rate This Statement' : currentQuestion.isGenerated ? 'AI Generated Follow-up' : 'Core Question'}
              </span>
              <h3 className="text-xl text-white mt-2">{currentQuestion.question}</h3>
            </div>

            <div className="mb-6">
              {currentQuestion.questionType === 'scale' ? (
                <ScaleInput
                  labels={currentQuestion.labels}
                  value={scaleValue}
                  onChange={setScaleValue}
                  disabled={submitting}
                />
              ) : (
                <>
                  <textarea
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    placeholder="Type your answer here..."
                    rows={6}
                    className="w-full px-4 py-3 bg-port-bg border border-port-border rounded-lg text-white resize-none focus:outline-none focus:border-port-accent"
                    autoFocus
                  />
                  <div className="text-xs text-gray-500 mt-2">
                    Be as specific as possible. Your answers help create a more accurate digital twin.
                  </div>
                </>
              )}
            </div>

            <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-between gap-3">
              <button
                onClick={skipQuestion}
                className="flex items-center justify-center gap-2 px-4 py-3 min-h-[44px] text-gray-400 hover:text-white transition-colors"
              >
                <SkipForward size={18} />
                Skip
              </button>

              <button
                onClick={submitAnswer}
                disabled={submitting || (currentQuestion?.questionType === 'scale' ? scaleValue == null : !answer.trim())}
                className="flex items-center justify-center gap-2 px-6 py-3 min-h-[48px] bg-port-accent text-white rounded-lg font-medium hover:bg-port-accent/80 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? (
                  <>
                    <RefreshCw className="w-5 h-5 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Send size={18} />
                    Submit Answer
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* Category completion */}
        {categoryProgress?.completed && (
          <div className="mt-6 p-4 bg-green-500/10 border border-green-500/30 rounded-lg">
            <div className="flex items-center gap-3">
              <Check className="w-5 h-5 text-green-400" />
              <span className="text-green-400">
                This category is complete! Continue answering to add more depth.
              </span>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Category selection view
  return (
    <div className="space-y-6">
      {/* Overall Progress */}
      <div className="bg-port-card rounded-lg border border-port-border p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white">Enrichment Progress</h2>
          <span className="text-gray-400">
            {progress?.completedCount || 0}/{progress?.totalCategories || 10} categories complete
          </span>
        </div>

        <div className="h-3 bg-port-border rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-yellow-500 to-orange-500 transition-all"
            style={{ width: `${((progress?.completedCount || 0) / (progress?.totalCategories || 10)) * 100}%` }}
          />
        </div>

        {progress?.lastSession && (
          <p className="text-sm text-gray-500 mt-3">
            Last session: {new Date(progress.lastSession).toLocaleDateString()}
          </p>
        )}
      </div>

      {/* Category Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
        {Object.entries(ENRICHMENT_CATEGORIES).map(([key, config]) => {
          const catProgress = progress?.categories?.[key];
          const isComplete = catProgress?.completed;
          const Icon = config.icon;

          return (
            <button
              key={key}
              onClick={() => startCategory(key)}
              className={`p-4 min-h-[120px] bg-port-card rounded-lg border transition-all text-left hover:border-port-accent ${
                isComplete ? 'border-green-500/30' : 'border-port-border'
              }`}
            >
              <div className="flex items-start justify-between mb-3">
                <div className={`p-2 rounded-lg bg-${config.color}-500/20`}>
                  <Icon className={`w-5 h-5 text-${config.color}-400`} />
                </div>
                {isComplete ? (
                  <Check className="w-5 h-5 text-green-400" />
                ) : (
                  <ChevronRight className="w-5 h-5 text-gray-500" />
                )}
              </div>

              <h3 className="font-semibold text-white mb-1">{config.label}</h3>
              <p className="text-sm text-gray-400 mb-3 line-clamp-2">{config.description}</p>

              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-500">
                  {catProgress?.answered || 0} questions answered
                </span>
                <span className={isComplete ? 'text-green-400' : 'text-gray-500'}>
                  {catProgress?.percentage || 0}%
                </span>
              </div>

              {/* Mini progress bar */}
              <div className="h-1 bg-port-border rounded-full mt-2 overflow-hidden">
                <div
                  className={`h-full transition-all ${isComplete ? 'bg-green-500' : 'bg-port-accent'}`}
                  style={{ width: `${catProgress?.percentage || 0}%` }}
                />
              </div>
            </button>
          );
        })}
      </div>

      {/* Info */}
      <div className="bg-port-card rounded-lg border border-port-border p-4">
        <div className="flex items-start gap-4">
          <Sparkles className="w-6 h-6 text-yellow-400 flex-shrink-0" />
          <div>
            <h3 className="font-medium text-white mb-1">How Enrichment Works</h3>
            <p className="text-sm text-gray-400">
              Answer questions in each category to build a comprehensive profile. After answering
              the core questions (3 per category), AI-generated follow-up questions will help
              capture more nuanced details. Your answers are processed and added to your soul documents.
            </p>
          </div>
        </div>
      </div>

      {/* Writing Sample Analysis */}
      <div className="bg-port-card rounded-lg border border-port-border overflow-hidden">
        <button
          onClick={() => setShowWritingAnalysis(!showWritingAnalysis)}
          className="w-full p-4 flex items-center justify-between hover:bg-port-border/30 transition-colors"
        >
          <div className="flex items-center gap-3">
            <PenTool className="w-6 h-6 text-cyan-400" />
            <div className="text-left">
              <h3 className="font-medium text-white">Analyze Your Writing</h3>
              <p className="text-sm text-gray-400">Extract communication patterns from your actual writing</p>
            </div>
          </div>
          <ChevronRight className={`w-5 h-5 text-gray-400 transition-transform ${showWritingAnalysis ? 'rotate-90' : ''}`} />
        </button>

        {showWritingAnalysis && (
          <div className="p-4 pt-0 space-y-4">
            <p className="text-sm text-gray-400">
              Paste samples of your writing (emails, messages, documents) to extract your authentic voice patterns.
              The AI will analyze sentence structure, vocabulary, tone, and distinctive markers.
            </p>

            {/* Provider Selection */}
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
              <label className="text-sm text-gray-400">Analyze with:</label>
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
            </div>

            {/* Writing Samples */}
            <div className="space-y-3">
              {writingSamples.map((sample, index) => (
                <div key={index} className="relative">
                  <textarea
                    value={sample}
                    onChange={(e) => updateWritingSample(index, e.target.value)}
                    placeholder={`Paste writing sample ${index + 1} here (emails, messages, docs)...`}
                    rows={4}
                    className="w-full px-4 py-3 bg-port-bg border border-port-border rounded-lg text-white resize-none focus:outline-none focus:border-port-accent"
                  />
                  {writingSamples.length > 1 && (
                    <button
                      onClick={() => removeWritingSample(index)}
                      className="absolute top-2 right-2 text-gray-500 hover:text-red-400"
                    >
                      ×
                    </button>
                  )}
                  <div className="text-xs text-gray-500 mt-1">
                    {sample.length} characters {sample.length < 50 && sample.length > 0 && '(need 50+)'}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 sm:gap-4">
              <button
                onClick={addWritingSample}
                className="px-4 py-3 min-h-[44px] text-sm text-port-accent hover:text-white border border-port-accent/30 rounded-lg hover:border-port-accent"
              >
                + Add Another Sample
              </button>

              <button
                onClick={analyzeWriting}
                disabled={analyzingWriting}
                className="px-4 py-3 min-h-[44px] bg-cyan-600 text-white rounded-lg text-sm hover:bg-cyan-500 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {analyzingWriting ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    Analyzing...
                  </>
                ) : (
                  <>
                    <Eye className="w-4 h-4" />
                    Analyze Writing
                  </>
                )}
              </button>
            </div>

            {/* Analysis Results */}
            {writingAnalysis && (
              <div className="mt-4 pt-4 border-t border-port-border space-y-4">
                <h4 className="font-medium text-white flex items-center gap-2">
                  <FileText className="w-4 h-4" />
                  Analysis Results
                </h4>

                {writingAnalysis.analysis && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
                    {writingAnalysis.analysis.formality && (
                      <div className="p-3 bg-port-bg rounded-lg">
                        <div className="text-xs text-gray-500">Formality</div>
                        <div className="text-white capitalize">{writingAnalysis.analysis.formality}</div>
                      </div>
                    )}
                    {writingAnalysis.analysis.directness && (
                      <div className="p-3 bg-port-bg rounded-lg">
                        <div className="text-xs text-gray-500">Directness</div>
                        <div className="text-white">{writingAnalysis.analysis.directness}/10</div>
                      </div>
                    )}
                    {writingAnalysis.analysis.warmth && (
                      <div className="p-3 bg-port-bg rounded-lg">
                        <div className="text-xs text-gray-500">Warmth</div>
                        <div className="text-white">{writingAnalysis.analysis.warmth}/10</div>
                      </div>
                    )}
                    {writingAnalysis.analysis.humor && (
                      <div className="p-3 bg-port-bg rounded-lg">
                        <div className="text-xs text-gray-500">Humor</div>
                        <div className="text-white capitalize">{writingAnalysis.analysis.humor}</div>
                      </div>
                    )}
                  </div>
                )}

                {writingAnalysis.analysis?.overallVoice && (
                  <div className="p-3 bg-port-bg rounded-lg">
                    <div className="text-xs text-gray-500 mb-1">Overall Voice</div>
                    <div className="text-white text-sm">{writingAnalysis.analysis.overallVoice}</div>
                  </div>
                )}

                {writingAnalysis.suggestedContent && (
                  <div className="space-y-2">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <div className="text-sm text-gray-400">Suggested WRITING_STYLE.md content:</div>
                      <button
                        onClick={saveWritingStyle}
                        disabled={savingWritingStyle}
                        className="px-3 py-2 min-h-[40px] bg-green-600 text-white rounded text-sm hover:bg-green-500 disabled:opacity-50 flex items-center justify-center gap-1"
                      >
                        {savingWritingStyle ? (
                          <RefreshCw className="w-3 h-3 animate-spin" />
                        ) : (
                          <Save className="w-3 h-3" />
                        )}
                        Save to Soul
                      </button>
                    </div>
                    <pre className="p-3 bg-port-bg rounded-lg text-sm text-gray-300 whitespace-pre-wrap overflow-auto max-h-64">
                      {writingAnalysis.suggestedContent}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
