import { useState, useEffect, useCallback } from 'react';
import {
  Palette,
  Film,
  Music,
  Building,
  UtensilsCrossed,
  ChevronRight,
  ArrowLeft,
  Send,
  SkipForward,
  RefreshCw,
  Check,
  Sparkles,
  RotateCcw,
  Eye,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
import * as api from '../../../services/api';
import toast from 'react-hot-toast';

const SECTION_ICONS = {
  movies: Film,
  music: Music,
  visual_art: Palette,
  architecture: Building,
  food: UtensilsCrossed
};

const SECTION_COLORS = {
  movies: 'red',
  music: 'green',
  visual_art: 'violet',
  architecture: 'amber',
  food: 'orange'
};

export default function TasteTab({ onRefresh }) {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  // Active session state
  const [activeSection, setActiveSection] = useState(null);
  const [currentQuestion, setCurrentQuestion] = useState(null);
  const [answer, setAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [loadingQuestion, setLoadingQuestion] = useState(false);

  // Summary generation
  const [generatingSummary, setGeneratingSummary] = useState(false);
  const [providers, setProviders] = useState([]);
  const [selectedProvider, setSelectedProvider] = useState(null);

  // Review mode
  const [reviewSection, setReviewSection] = useState(null);
  const [reviewResponses, setReviewResponses] = useState([]);
  const [loadingReview, setLoadingReview] = useState(false);

  // Expanded summaries
  const [expandedSummary, setExpandedSummary] = useState(null);

  const loadProfile = useCallback(async () => {
    const data = await api.getTasteProfile().catch(() => null);
    if (data) setProfile(data);
    setLoading(false);
  }, []);

  const loadProviders = useCallback(async () => {
    const data = await api.getProviders().catch(() => ({ providers: [] }));
    const enabled = (data.providers || []).filter(p => p.enabled);
    setProviders(enabled);
    if (enabled.length > 0) {
      setSelectedProvider({ providerId: enabled[0].id, model: enabled[0].defaultModel });
    }
  }, []);

  useEffect(() => {
    loadProfile();
    loadProviders();
  }, [loadProfile, loadProviders]);

  const startSection = async (sectionId) => {
    setActiveSection(sectionId);
    setLoadingQuestion(true);
    const question = await api.getTasteNextQuestion(sectionId).catch(() => null);
    setCurrentQuestion(question);
    setAnswer('');
    setLoadingQuestion(false);
  };

  const submitAnswer = async () => {
    if (!answer.trim() || !currentQuestion) return;

    setSubmitting(true);
    const result = await api.submitTasteAnswer(
      activeSection,
      currentQuestion.questionId,
      answer.trim()
    ).catch(() => null);

    if (!result) {
      toast.error('Failed to save response');
      setSubmitting(false);
      return;
    }

    toast.success('Response saved');
    setAnswer('');

    // Use the next question returned inline from the submit response
    if (result.nextQuestion) {
      setCurrentQuestion(result.nextQuestion);
    } else {
      setCurrentQuestion(null);
    }

    await loadProfile();
    setSubmitting(false);
    onRefresh?.();
  };

  const exitSection = () => {
    setActiveSection(null);
    setCurrentQuestion(null);
    setAnswer('');
    setReviewSection(null);
    setReviewResponses([]);
  };

  const handleReviewSection = async (sectionId) => {
    setReviewSection(sectionId);
    setLoadingReview(true);
    const responses = await api.getTasteSectionResponses(sectionId).catch(() => []);
    setReviewResponses(responses);
    setLoadingReview(false);
  };

  const handleResetSection = async (sectionId) => {
    await api.resetTasteSection(sectionId).catch(() => null);
    toast.success('Section reset');
    await loadProfile();
    setReviewSection(null);
    setReviewResponses([]);
    onRefresh?.();
  };

  const handleGenerateSummary = async (sectionId) => {
    if (!selectedProvider) {
      toast.error('Select a provider first');
      return;
    }
    setGeneratingSummary(true);
    const result = await api.generateTasteSummary(
      selectedProvider.providerId,
      selectedProvider.model,
      sectionId
    ).catch(e => ({ error: e.message }));

    if (result.error) {
      toast.error(result.error);
    } else {
      toast.success('Summary generated');
      await loadProfile();
    }
    setGeneratingSummary(false);
  };

  const handleGenerateOverallSummary = async () => {
    if (!selectedProvider) {
      toast.error('Select a provider first');
      return;
    }
    setGeneratingSummary(true);
    const result = await api.generateTasteSummary(
      selectedProvider.providerId,
      selectedProvider.model
    ).catch(e => ({ error: e.message }));

    if (result.error) {
      toast.error(result.error);
    } else {
      toast.success('Taste profile generated');
      await loadProfile();
    }
    setGeneratingSummary(false);
    onRefresh?.();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-8 h-8 text-port-accent animate-spin" />
      </div>
    );
  }

  // Review mode — show previous responses
  if (reviewSection) {
    const section = profile?.sections?.find(s => s.id === reviewSection);
    const Icon = SECTION_ICONS[reviewSection] || Palette;
    const color = SECTION_COLORS[reviewSection] || 'blue';

    return (
      <div className="max-w-2xl mx-auto px-1">
        <div className="mb-6">
          <button
            onClick={() => { setReviewSection(null); setReviewResponses([]); }}
            className="flex items-center gap-2 text-gray-400 hover:text-white mb-4 py-2 min-h-[44px]"
          >
            <ArrowLeft size={18} />
            Back to sections
          </button>
          <div className="flex items-center gap-3">
            <div className={`p-2.5 rounded-lg bg-${color}-500/20`}>
              <Icon className={`w-5 h-5 text-${color}-400`} />
            </div>
            <div>
              <h2 className="text-xl font-semibold text-white">{section?.label} — Responses</h2>
              <p className="text-sm text-gray-400">{reviewResponses.length} responses recorded</p>
            </div>
          </div>
        </div>

        {loadingReview ? (
          <div className="flex items-center justify-center h-48">
            <RefreshCw className="w-6 h-6 text-port-accent animate-spin" />
          </div>
        ) : (
          <div className="space-y-4">
            {reviewResponses.map((r, i) => (
              <div key={i} className="bg-port-card rounded-lg border border-port-border p-4">
                <div className="flex items-start gap-2 mb-2">
                  {r.isFollowUp && (
                    <span className="text-xs px-2 py-0.5 bg-port-accent/20 text-port-accent rounded">follow-up</span>
                  )}
                  <p className="text-sm text-gray-400">{r.questionText}</p>
                </div>
                <p className="text-white whitespace-pre-wrap">{r.answer}</p>
              </div>
            ))}

            {section?.summary && (
              <div className="bg-port-card rounded-lg border border-violet-500/30 p-4">
                <h3 className="text-sm font-medium text-violet-400 mb-2 flex items-center gap-2">
                  <Sparkles size={14} />
                  AI Summary
                </h3>
                <div className="text-gray-300 text-sm whitespace-pre-wrap">{section.summary}</div>
              </div>
            )}

            <div className="flex flex-col sm:flex-row gap-3 pt-2">
              <button
                onClick={() => handleGenerateSummary(reviewSection)}
                disabled={generatingSummary || reviewResponses.length === 0}
                className="flex items-center justify-center gap-2 px-4 py-3 min-h-[44px] bg-violet-600 text-white rounded-lg text-sm hover:bg-violet-500 disabled:opacity-50"
              >
                {generatingSummary ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Sparkles size={16} />}
                {section?.summary ? 'Regenerate Summary' : 'Generate Summary'}
              </button>
              <button
                onClick={() => handleResetSection(reviewSection)}
                className="flex items-center justify-center gap-2 px-4 py-3 min-h-[44px] text-red-400 border border-red-500/30 rounded-lg text-sm hover:bg-red-500/10"
              >
                <RotateCcw size={16} />
                Reset Section
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Active Q&A session
  if (activeSection) {
    const section = profile?.sections?.find(s => s.id === activeSection);
    const Icon = SECTION_ICONS[activeSection] || Palette;
    const color = SECTION_COLORS[activeSection] || 'blue';

    // Section complete
    if (!currentQuestion && !loadingQuestion) {
      return (
        <div className="max-w-2xl mx-auto px-1">
          <div className="mb-6">
            <button
              onClick={exitSection}
              className="flex items-center gap-2 text-gray-400 hover:text-white mb-4 py-2 min-h-[44px]"
            >
              <ArrowLeft size={18} />
              Back to sections
            </button>
            <div className="flex items-center gap-3">
              <div className={`p-2.5 rounded-lg bg-${color}-500/20`}>
                <Icon className={`w-5 h-5 text-${color}-400`} />
              </div>
              <h2 className="text-xl font-semibold text-white">{section?.label}</h2>
            </div>
          </div>
          <div className="p-4 bg-green-500/10 border border-green-500/30 rounded-lg mb-4">
            <div className="flex items-center gap-3">
              <Check className="w-5 h-5 text-green-400" />
              <span className="text-green-400">All questions for this section are complete.</span>
            </div>
          </div>
          <div className="flex flex-col sm:flex-row gap-3">
            <button
              onClick={() => handleReviewSection(activeSection)}
              className="flex items-center justify-center gap-2 px-4 py-3 min-h-[44px] bg-port-card border border-port-border text-white rounded-lg text-sm hover:border-port-accent"
            >
              <Eye size={16} />
              Review Responses
            </button>
            <button
              onClick={() => handleGenerateSummary(activeSection)}
              disabled={generatingSummary}
              className="flex items-center justify-center gap-2 px-4 py-3 min-h-[44px] bg-violet-600 text-white rounded-lg text-sm hover:bg-violet-500 disabled:opacity-50"
            >
              {generatingSummary ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Sparkles size={16} />}
              Generate Summary
            </button>
          </div>
        </div>
      );
    }

    // Active question
    return (
      <div className="max-w-2xl mx-auto px-1">
        <div className="mb-6 sm:mb-8">
          <button
            onClick={exitSection}
            className="flex items-center gap-2 text-gray-400 hover:text-white mb-4 py-2 min-h-[44px]"
          >
            <ArrowLeft size={18} />
            Back to sections
          </button>

          <div className="flex items-center gap-3 sm:gap-4">
            <div className={`p-2.5 sm:p-3 rounded-lg bg-${color}-500/20 flex-shrink-0`}>
              <Icon className={`w-5 h-5 sm:w-6 sm:h-6 text-${color}-400`} />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg sm:text-xl font-bold text-white">{section?.label}</h2>
              <p className="text-sm sm:text-base text-gray-400 truncate">{section?.description}</p>
            </div>
          </div>

          {/* Progress bar */}
          <div className="mt-4">
            <div className="flex items-center justify-between text-sm mb-1">
              <span className="text-gray-400">
                {currentQuestion?.isFollowUp ? 'Follow-up question' : `Question ${currentQuestion?.progress?.current || 1} of ${currentQuestion?.progress?.coreTotal || '?'}`}
              </span>
              <span className="text-gray-400">{section?.progress?.percentage || 0}% core complete</span>
            </div>
            <div className="h-2 bg-port-border rounded-full overflow-hidden">
              <div
                className="h-full bg-port-accent transition-all"
                style={{ width: `${section?.progress?.percentage || 0}%` }}
              />
            </div>
          </div>
        </div>

        {loadingQuestion ? (
          <div className="flex items-center justify-center h-48">
            <RefreshCw className="w-6 h-6 text-port-accent animate-spin" />
          </div>
        ) : (
          <div className="bg-port-card rounded-lg border border-port-border p-6">
            <div className="mb-6">
              <span className="text-xs text-gray-500 uppercase tracking-wider">
                {currentQuestion?.isFollowUp ? 'Follow-up — based on your previous answer' : 'Core Question'}
              </span>
              <h3 className="text-xl text-white mt-2">{currentQuestion?.text}</h3>
            </div>

            <div className="mb-6">
              <textarea
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder="Share your thoughts... be as specific as possible."
                rows={6}
                className="w-full px-4 py-3 bg-port-bg border border-port-border rounded-lg text-white resize-none focus:outline-none focus:border-port-accent"
                autoFocus
              />
              <div className="text-xs text-gray-500 mt-2">
                The more specific you are, the better your taste profile will be. Reference specific examples, feelings, and reasons.
              </div>
            </div>

            <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-between gap-3">
              <button
                onClick={() => {
                  // Skip current question by submitting empty — move to next
                  setAnswer('');
                  setLoadingQuestion(true);
                  api.getTasteNextQuestion(activeSection).then(q => {
                    // If same question returned (can't skip core), just clear loading
                    if (q?.questionId === currentQuestion?.questionId) {
                      toast('Core questions cannot be skipped', { icon: '⚠️' });
                    } else {
                      setCurrentQuestion(q);
                    }
                    setLoadingQuestion(false);
                  }).catch(() => setLoadingQuestion(false));
                }}
                disabled={!currentQuestion?.isFollowUp}
                className="flex items-center justify-center gap-2 px-4 py-3 min-h-[44px] text-gray-400 hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <SkipForward size={18} />
                Skip
              </button>

              <button
                onClick={submitAnswer}
                disabled={submitting || !answer.trim()}
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
                    Submit
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Section selection view
  return (
    <div className="space-y-6">
      {/* Overall Progress */}
      <div className="bg-port-card rounded-lg border border-port-border p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <Palette className="w-6 h-6 text-violet-400" />
            <h2 className="text-lg font-semibold text-white">Aesthetic Taste Profile</h2>
          </div>
          <span className="text-gray-400">
            {profile?.completedCount || 0}/{profile?.totalSections || 5} sections complete
          </span>
        </div>

        <div className="h-3 bg-port-border rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-violet-500 to-pink-500 transition-all"
            style={{ width: `${profile?.overallPercentage || 0}%` }}
          />
        </div>

        {profile?.lastSessionAt && (
          <p className="text-sm text-gray-500 mt-3">
            Last session: {new Date(profile.lastSessionAt).toLocaleDateString()}
          </p>
        )}
      </div>

      {/* Section Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
        {(profile?.sections || []).map((section) => {
          const Icon = SECTION_ICONS[section.id] || Palette;
          const color = SECTION_COLORS[section.id] || 'blue';
          const isComplete = section.status === 'completed';
          const isStarted = section.status === 'in_progress';

          return (
            <div
              key={section.id}
              className={`bg-port-card rounded-lg border transition-all ${
                isComplete ? 'border-green-500/30' : isStarted ? 'border-port-accent/30' : 'border-port-border'
              }`}
            >
              <button
                onClick={() => startSection(section.id)}
                className="w-full p-4 min-h-[120px] text-left hover:bg-port-border/20 rounded-t-lg transition-colors"
              >
                <div className="flex items-start justify-between mb-3">
                  <div className={`p-2 rounded-lg bg-${color}-500/20`}>
                    <Icon className={`w-5 h-5 text-${color}-400`} />
                  </div>
                  {isComplete ? (
                    <Check className="w-5 h-5 text-green-400" />
                  ) : (
                    <ChevronRight className="w-5 h-5 text-gray-500" />
                  )}
                </div>

                <h3 className="font-semibold text-white mb-1">{section.label}</h3>
                <p className="text-sm text-gray-400 mb-3 line-clamp-2">{section.description}</p>

                <div className="flex items-center justify-between text-xs">
                  <span className="text-gray-500">
                    {section.progress?.coreAnswered || 0}/{section.progress?.coreTotal || 0} core
                    {section.progress?.followUpsAnswered > 0 && ` + ${section.progress.followUpsAnswered} follow-ups`}
                  </span>
                  <span className={isComplete ? 'text-green-400' : 'text-gray-500'}>
                    {section.progress?.percentage || 0}%
                  </span>
                </div>

                {/* Mini progress bar */}
                <div className="h-1 bg-port-border rounded-full mt-2 overflow-hidden">
                  <div
                    className={`h-full transition-all ${isComplete ? 'bg-green-500' : 'bg-port-accent'}`}
                    style={{ width: `${section.progress?.percentage || 0}%` }}
                  />
                </div>
              </button>

              {/* Review button for sections with responses */}
              {(section.progress?.coreAnswered > 0 || section.progress?.followUpsAnswered > 0) && (
                <div className="px-4 pb-3 flex gap-2">
                  <button
                    onClick={() => handleReviewSection(section.id)}
                    className="text-xs text-gray-400 hover:text-white flex items-center gap-1 py-1"
                  >
                    <Eye size={12} />
                    Review
                  </button>
                </div>
              )}

              {/* Expandable summary */}
              {section.summary && (
                <div className="px-4 pb-3">
                  <button
                    onClick={() => setExpandedSummary(expandedSummary === section.id ? null : section.id)}
                    className="text-xs text-violet-400 hover:text-violet-300 flex items-center gap-1 py-1"
                  >
                    <Sparkles size={12} />
                    Summary
                    {expandedSummary === section.id ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  </button>
                  {expandedSummary === section.id && (
                    <div className="mt-2 p-3 bg-port-bg rounded-lg text-xs text-gray-300 whitespace-pre-wrap max-h-48 overflow-auto">
                      {section.summary}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Overall Summary */}
      {profile?.profileSummary && (
        <div className="bg-port-card rounded-lg border border-violet-500/30 p-6">
          <h3 className="text-lg font-semibold text-white mb-3 flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-violet-400" />
            Unified Taste Profile
          </h3>
          <div className="text-gray-300 text-sm whitespace-pre-wrap">{profile.profileSummary}</div>
        </div>
      )}

      {/* Generate Summary / Provider Selection */}
      <div className="bg-port-card rounded-lg border border-port-border p-4">
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
          <div className="flex-1">
            <h3 className="font-medium text-white mb-1">Generate Taste Profile</h3>
            <p className="text-sm text-gray-400">
              Use AI to analyze your responses and build a unified aesthetic taste profile.
            </p>
          </div>
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto">
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
              onClick={handleGenerateOverallSummary}
              disabled={generatingSummary || (profile?.completedCount || 0) === 0}
              className="flex items-center justify-center gap-2 px-4 py-3 min-h-[44px] bg-violet-600 text-white rounded-lg text-sm hover:bg-violet-500 disabled:opacity-50 whitespace-nowrap"
            >
              {generatingSummary ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Sparkles size={16} />}
              {profile?.profileSummary ? 'Regenerate' : 'Generate Profile'}
            </button>
          </div>
        </div>
      </div>

      {/* Info */}
      <div className="bg-port-card rounded-lg border border-port-border p-4">
        <div className="flex items-start gap-4">
          <Palette className="w-6 h-6 text-violet-400 flex-shrink-0" />
          <div>
            <h3 className="font-medium text-white mb-1">How the Taste Questionnaire Works</h3>
            <p className="text-sm text-gray-400">
              Each section explores a different domain of aesthetic taste through a conversational Q&A flow.
              Core questions establish your baseline preferences. Based on your answers, follow-up questions
              dig deeper into specific areas — if you mention visual elements in your movie preferences,
              you'll get questions about cinematography style. After completing sections, generate an
              AI-powered taste profile that captures your aesthetic identity across all domains.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
