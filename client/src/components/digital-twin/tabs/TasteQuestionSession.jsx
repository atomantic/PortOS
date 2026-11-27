import { ArrowLeft, Check, Eye, Send, SkipForward, Sparkles, Telescope } from 'lucide-react';
import BrailleSpinner from '../../BrailleSpinner';
import MarkdownOutput from '../../cos/MarkdownOutput';
import ListLoadError from '../../ui/ListLoadError';
import { iconBadgeClasses } from '../constants';
import TasteProviderNotice, { NO_API_PROVIDER_TITLE } from './TasteProviderNotice';
import { tasteSectionAppearance } from './tasteSectionAppearance';

export default function TasteQuestionSession({
  section, currentQuestion, answer, submitting, loadingQuestion, questionError,
  loadingPersonalized, providersResource, selectedProvider, generatingSummary,
  onBack, onRetry, onReview, onGoDeeper, onGenerateSummary, onAnswerChange,
  onDoneExploring, onSkip, onSubmit,
}) {
  const { Icon, color } = tasteSectionAppearance(section?.id);

  // Section complete
  if (!currentQuestion && !loadingQuestion && !loadingPersonalized) {
    return (
      <div className="max-w-2xl mx-auto px-1">
        <div className="mb-6">
          <button
            onClick={onBack}
            className="flex items-center gap-2 text-gray-400 hover:text-white mb-4 py-2 min-h-[44px]"
          >
            <ArrowLeft size={18} />
            Back to sections
          </button>
          <div className="flex items-center gap-3">
            <div className={`p-2.5 rounded-lg ${iconBadgeClasses(color).bg}`}>
              <Icon className={`w-5 h-5 ${iconBadgeClasses(color).text}`} />
            </div>
            <h2 className="text-xl font-semibold text-white">{section?.label}</h2>
          </div>
        </div>
        {questionError ? (
          <ListLoadError className="mb-4" what="the next question" error={questionError} onRetry={onRetry} />
        ) : (
          <div className="p-4 bg-port-success/10 border border-port-success/30 rounded-lg mb-4">
            <div className="flex items-center gap-3">
              <Check className="w-5 h-5 text-port-success" />
              <span className="text-port-success">All questions for this section are complete.</span>
            </div>
          </div>
        )}
        {section?.summary && (
          <div className="bg-port-card rounded-lg border border-port-accent-2/30 p-4 mb-4">
            <h3 className="text-sm font-medium text-port-accent-2 mb-2 flex items-center gap-2">
              <Sparkles size={14} />
              AI Summary
            </h3>
            <div className="text-sm"><MarkdownOutput content={section.summary} /></div>
          </div>
        )}
        <TasteProviderNotice
          providersResource={providersResource}
          selectedProvider={selectedProvider}
          actionLabel="Go Deeper and Generate Summary need one"
        />
        <div className="flex flex-col sm:flex-row gap-3">
          <button
            onClick={onGoDeeper}
            disabled={submitting || !selectedProvider}
            className="flex items-center justify-center gap-2 px-4 py-3 min-h-[44px] bg-port-accent-2 text-port-on-accent-2 rounded-lg text-sm hover:bg-port-accent-2/80 disabled:opacity-50"
            title={!selectedProvider ? NO_API_PROVIDER_TITLE : ''}
          >
            {loadingPersonalized ? <BrailleSpinner /> : <Telescope size={16} />}
            Go Deeper
          </button>
          <button
            onClick={onReview}
            className="flex items-center justify-center gap-2 px-4 py-3 min-h-[44px] bg-port-card border border-port-border text-white rounded-lg text-sm hover:border-port-accent"
          >
            <Eye size={16} />
            Review Responses
          </button>
          <button
            onClick={onGenerateSummary}
            disabled={generatingSummary || !selectedProvider}
            className="flex items-center justify-center gap-2 px-4 py-3 min-h-[44px] bg-port-accent-2 text-port-on-accent-2 rounded-lg text-sm hover:bg-port-accent-2/80 disabled:opacity-50"
            title={!selectedProvider ? NO_API_PROVIDER_TITLE : ''}
          >
            {generatingSummary ? <BrailleSpinner /> : <Sparkles size={16} />}
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
          onClick={onBack}
          className="flex items-center gap-2 text-gray-400 hover:text-white mb-4 py-2 min-h-[44px]"
        >
          <ArrowLeft size={18} />
          Back to sections
        </button>

        <div className="flex items-center gap-3 sm:gap-4">
          <div className={`p-2.5 sm:p-3 rounded-lg ${iconBadgeClasses(color).bg} shrink-0`}>
            <Icon className={`w-5 h-5 sm:w-6 sm:h-6 ${iconBadgeClasses(color).text}`} />
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
              {currentQuestion?.isPersonalized ? 'Personalized deep-dive' : currentQuestion?.isFollowUp ? 'Follow-up question' : `Question ${currentQuestion?.progress?.current || 1} of ${currentQuestion?.progress?.coreTotal || '?'}`}
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

      {loadingQuestion || loadingPersonalized ? (
        <div className="flex flex-col items-center justify-center h-48 gap-3">
          <BrailleSpinner text="Loading" />
          {loadingPersonalized && (
            <span className="text-sm text-gray-400">Generating personalized question...</span>
          )}
        </div>
      ) : (
        <div className={`bg-port-card rounded-lg border ${currentQuestion?.isPersonalized ? 'border-port-accent-2/30' : 'border-port-border'} p-6`}>
          <div className="mb-6">
            {currentQuestion?.isPersonalized ? (
              <span className="text-xs px-2 py-0.5 bg-port-accent-2/20 text-port-accent-2 rounded uppercase tracking-wider">
                Personalized — referencing your identity
              </span>
            ) : (
              <span className="text-xs text-gray-500 uppercase tracking-wider">
                {currentQuestion?.isFollowUp ? 'Follow-up — based on your previous answer' : 'Core Question'}
              </span>
            )}
            <h3 className="text-xl text-white mt-2">{currentQuestion?.text}</h3>
          </div>

          <div className="mb-6">
            <textarea
              aria-label="Your answer"
              value={answer}
              onChange={(e) => onAnswerChange(e.target.value)}
              placeholder="Share your thoughts... be as specific as possible."
              rows={6}
              className="w-full px-4 py-3 bg-port-bg border border-port-border rounded-lg text-white resize-none focus:outline-hidden focus:border-port-accent"
              autoFocus
            />
            <div className="text-xs text-gray-500 mt-2">
              The more specific you are, the better your taste profile will be. Reference specific examples, feelings, and reasons.
            </div>
          </div>

          <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-between gap-3">
            {currentQuestion?.isPersonalized ? (
              <button
                onClick={onDoneExploring}
                disabled={submitting}
                className="flex items-center justify-center gap-2 px-4 py-3 min-h-[44px] text-gray-400 hover:text-white transition-colors"
              >
                <ArrowLeft size={18} />
                Done exploring
              </button>
            ) : (
              <button
                onClick={onSkip}
                disabled={submitting || !currentQuestion?.isFollowUp}
                className="flex items-center justify-center gap-2 px-4 py-3 min-h-[44px] text-gray-400 hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <SkipForward size={18} />
                Skip
              </button>
            )}

            <button
              onClick={onSubmit}
              disabled={submitting || !answer.trim()}
              className="flex items-center justify-center gap-2 px-6 py-3 min-h-[48px] bg-port-accent text-white rounded-lg font-medium hover:bg-port-accent/80 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? (
                <>
                  <BrailleSpinner />
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
