import { Check, ChevronDown, ChevronRight, ChevronUp, Eye, Palette, Sparkles } from 'lucide-react';
import { formatDateNumeric } from '../../../utils/formatters';
import BrailleSpinner from '../../BrailleSpinner';
import MarkdownOutput from '../../cos/MarkdownOutput';
import ListLoadError from '../../ui/ListLoadError';
import ObservedTasteEvidence from '../ObservedTasteEvidence';
import TwinProviderPicker from '../TwinProviderPicker.jsx';
import { iconBadgeClasses } from '../constants';
import { tasteSectionAppearance } from './tasteSectionAppearance';

export default function TasteOverview({
  profile, profileError, providersResource, providers, selectedProvider, generatingSummary,
  expandedSummary, onToggleSummary, onRetry, onStartSection, onReviewSection,
  onProviderChange, onGenerateSummary,
}) {
  return (
    <div className="space-y-6">
      {/* Overall Progress */}
      {profileError && !profile ? (
        <ListLoadError what="your taste profile" error={profileError} onRetry={onRetry} />
      ) : (
        <div className="bg-port-card rounded-lg border border-port-border p-6">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
            <div className="flex items-center gap-3">
              <Palette className="w-6 h-6 text-port-accent-2" />
              <h2 className="text-lg font-semibold text-white">Aesthetic Taste Profile</h2>
            </div>
            <span className="text-gray-400">
              {profile?.completedCount || 0}/{profile?.totalSections || 7} sections complete
            </span>
          </div>

          <div className="h-3 bg-port-border rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-port-accent-2 to-port-accent-2/40 transition-all"
              style={{ width: `${profile?.overallPercentage || 0}%` }}
            />
          </div>

          {profile?.lastSessionAt && (
            <p className="text-sm text-gray-500 mt-3">
              Last session: {formatDateNumeric(profile.lastSessionAt)}
            </p>
          )}
        </div>
      )}

      {/* Observed-behavior evidence (stated vs observed, #2156) */}
      <ObservedTasteEvidence />

      {/* Section Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
        {(profile?.sections || []).map((section) => {
          const { Icon, color } = tasteSectionAppearance(section.id);
          const isComplete = section.status === 'completed';
          const isStarted = section.status === 'in_progress';

          return (
            <div
              key={section.id}
              className={`bg-port-card rounded-lg border transition-all ${
                isComplete ? 'border-port-success/30' : isStarted ? 'border-port-accent/30' : 'border-port-border'
              }`}
            >
              <button
                onClick={() => onStartSection(section.id)}
                className="w-full p-4 min-h-[120px] text-left hover:bg-port-border/20 rounded-t-lg transition-colors"
              >
                <div className="flex items-start justify-between mb-3">
                  <div className={`p-2 rounded-lg ${iconBadgeClasses(color).bg}`}>
                    <Icon className={`w-5 h-5 ${iconBadgeClasses(color).text}`} />
                  </div>
                  {isComplete ? (
                    <Check className="w-5 h-5 text-port-success" />
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
                  <span className={isComplete ? 'text-port-success' : 'text-gray-500'}>
                    {section.progress?.percentage || 0}%
                  </span>
                </div>

                {/* Mini progress bar */}
                <div className="h-1 bg-port-border rounded-full mt-2 overflow-hidden">
                  <div
                    className={`h-full transition-all ${isComplete ? 'bg-port-success' : 'bg-port-accent'}`}
                    style={{ width: `${section.progress?.percentage || 0}%` }}
                  />
                </div>
              </button>

              {/* Review button for sections with responses */}
              {(section.progress?.coreAnswered > 0 || section.progress?.followUpsAnswered > 0) && (
                <div className="px-4 pb-3 flex gap-2">
                  <button
                    onClick={() => onReviewSection(section.id)}
                    className="text-xs text-gray-400 flex items-center gap-1 px-2 py-1 min-h-[36px] pointer-coarse:min-h-11 border border-port-border rounded-lg hover:text-white hover:border-port-accent focus-visible:border-port-accent"
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
                    onClick={() => onToggleSummary(section.id)}
                    aria-expanded={expandedSummary === section.id}
                    className="text-xs text-port-accent-2 flex items-center gap-1 px-2 py-1 min-h-[36px] pointer-coarse:min-h-11 border border-port-border rounded-lg hover:border-port-accent-2 focus-visible:border-port-accent-2"
                  >
                    <Sparkles size={12} />
                    Summary
                    {expandedSummary === section.id ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  </button>
                  {expandedSummary === section.id && (
                    <div className="mt-2 p-3 bg-port-bg rounded-lg max-h-72 overflow-auto">
                      <MarkdownOutput content={section.summary} />
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
        <div className="bg-port-card rounded-lg border border-port-accent-2/30 p-6">
          <h3 className="text-lg font-semibold text-white mb-3 flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-port-accent-2" />
            Unified Taste Profile
          </h3>
          <div className="text-sm"><MarkdownOutput content={profile.profileSummary} /></div>
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
            {providersResource.state === 'error' && (
              <ListLoadError what="AI providers" error={providersResource.error} onRetry={providersResource.retry} />
            )}
            <TwinProviderPicker
              compact
              className="flex-1 min-w-0"
              providers={providers}
              selected={selectedProvider}
              onChange={onProviderChange}
            />
            <button
              onClick={onGenerateSummary}
              disabled={generatingSummary || (profile?.completedCount || 0) === 0}
              className="flex items-center justify-center gap-2 px-4 py-3 min-h-[44px] bg-port-accent-2 text-port-on-accent-2 rounded-lg text-sm hover:bg-port-accent-2/80 disabled:opacity-50 whitespace-nowrap"
            >
              {generatingSummary ? <BrailleSpinner /> : <Sparkles size={16} />}
              {profile?.profileSummary ? 'Regenerate' : 'Generate Profile'}
            </button>
          </div>
        </div>
      </div>

      {/* Info */}
      <div className="bg-port-card rounded-lg border border-port-border p-4">
        <div className="flex items-start gap-4">
          <Palette className="w-6 h-6 text-port-accent-2 shrink-0" />
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
