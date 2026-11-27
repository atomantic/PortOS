import { ArrowLeft, Minus, RotateCcw, Sparkles, ThumbsDown, ThumbsUp } from 'lucide-react';
import BrailleSpinner from '../../BrailleSpinner';
import MarkdownOutput from '../../cos/MarkdownOutput';
import InlineConfirmRow from '../../ui/InlineConfirmRow';
import ListLoadError from '../../ui/ListLoadError';
import { iconBadgeClasses } from '../constants';
import TasteProviderNotice, { NO_API_PROVIDER_TITLE } from './TasteProviderNotice';
import { tasteSectionAppearance } from './tasteSectionAppearance';

export default function TasteReviewView({
  section, reviewResponses, loadingReview, reviewError, onBack, onRetry,
  summaryFeedback, onSummaryFeedback, providersResource, selectedProvider,
  generatingSummary, onGenerateSummary, resetting, confirmingReset,
  onRequestReset, onConfirmReset, onCancelReset,
}) {
  const { Icon, color } = tasteSectionAppearance(section?.id);
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
          <div>
            <h2 className="text-xl font-semibold text-white">{section?.label} — Responses</h2>
            {!loadingReview && !reviewError && (
              <p className="text-sm text-gray-400">{reviewResponses.length} responses recorded</p>
            )}
          </div>
        </div>
      </div>

      {loadingReview ? (
        <div className="flex items-center justify-center h-48">
          <BrailleSpinner text="Loading" />
        </div>
      ) : reviewError ? (
        // A failed read must not look like "0 responses recorded", and the
        // summary / reset actions below act on responses the user never saw.
        <ListLoadError what="your responses" error={reviewError} onRetry={onRetry} />
      ) : (
        <div className="space-y-4">
          {reviewResponses.map((r, i) => (
            <div key={i} className={`bg-port-card rounded-lg border ${r.isPersonalized ? 'border-port-accent-2/30' : 'border-port-border'} p-4`}>
              <div className="flex items-start gap-2 mb-2">
                {r.isPersonalized ? (
                  <span className="text-xs px-2 py-0.5 bg-port-accent-2/20 text-port-accent-2 rounded">personalized</span>
                ) : r.isFollowUp ? (
                  <span className="text-xs px-2 py-0.5 bg-port-accent/20 text-port-accent rounded">follow-up</span>
                ) : null}
                <p className="text-sm text-gray-400">{r.questionText}</p>
              </div>
              <p className="text-white whitespace-pre-wrap">{r.answer}</p>
            </div>
          ))}

          {section?.summary && (
            <div className="bg-port-card rounded-lg border border-port-accent-2/30 p-4">
              <h3 className="text-sm font-medium text-port-accent-2 mb-2 flex items-center gap-2">
                <Sparkles size={14} />
                AI Summary
              </h3>
              <div className="text-sm mb-3"><MarkdownOutput content={section.summary} /></div>

              {/* Behavioral Feedback */}
              <div className="pt-3 border-t border-port-border">
                <p className="text-xs text-gray-500 mb-2">Does this summary capture your taste accurately?</p>
                <div className="flex flex-wrap items-center gap-2">
                  {[
                    { key: 'sounds_like_me', label: 'Sounds like me', icon: ThumbsUp, active: 'bg-port-success/20 text-port-success border border-port-success/30', inactive: 'text-gray-400 border border-port-border hover:text-port-success hover:border-port-success/30 disabled:opacity-30' },
                    { key: 'not_quite', label: 'Not quite', icon: Minus, active: 'bg-port-warning/20 text-port-warning border border-port-warning/30', inactive: 'text-gray-400 border border-port-border hover:text-port-warning hover:border-port-warning/30 disabled:opacity-30' },
                    { key: 'doesnt_sound_like_me', label: 'Not me', icon: ThumbsDown, active: 'bg-port-error/20 text-port-error border border-port-error/30', inactive: 'text-gray-400 border border-port-border hover:text-port-error hover:border-port-error/30 disabled:opacity-30' }
                  ].map(({ key, label, icon: FbIcon, active, inactive }) => (
                    <button
                      key={key}
                      onClick={() => onSummaryFeedback(key)}
                      disabled={!!summaryFeedback}
                      className={`flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] pointer-coarse:min-h-11 rounded-lg text-xs transition-colors ${
                        summaryFeedback === key ? active : inactive
                      }`}
                    >
                      <FbIcon size={14} />
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          <TasteProviderNotice
            providersResource={providersResource}
            selectedProvider={selectedProvider}
            actionLabel="Generate Summary needs one"
          />
          <div className="flex flex-col sm:flex-row gap-3 pt-2">
            <button
              onClick={onGenerateSummary}
              disabled={generatingSummary || !selectedProvider || reviewResponses.length === 0}
              title={!selectedProvider ? NO_API_PROVIDER_TITLE : ''}
              className="flex items-center justify-center gap-2 px-4 py-3 min-h-[44px] bg-port-accent-2 text-port-on-accent-2 rounded-lg text-sm hover:bg-port-accent-2/80 disabled:opacity-50"
            >
              {generatingSummary ? <BrailleSpinner /> : <Sparkles size={16} />}
              {section?.summary ? 'Regenerate Summary' : 'Generate Summary'}
            </button>
            <button
              onClick={onRequestReset}
              disabled={resetting}
              className="flex items-center justify-center gap-2 px-4 py-3 min-h-[44px] text-port-error border border-port-error/30 rounded-lg text-sm hover:bg-port-error/10 disabled:opacity-50"
            >
              <RotateCcw size={16} />
              Reset Section
            </button>
          </div>
          {confirmingReset && (
            <InlineConfirmRow
              question="Reset all responses and summary for this section? This cannot be undone."
              confirmText="Reset Section"
              onConfirm={onConfirmReset}
              onCancel={onCancelReset}
              autoFocus
              aria-label="Confirm section reset"
            />
          )}
        </div>
      )}
    </div>
  );
}
