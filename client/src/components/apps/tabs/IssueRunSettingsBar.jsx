import { useEffect, useId, useState } from 'react';
import { Bot } from 'lucide-react';
import { DEFAULT_PR_COMPLETION, PR_COMPLETION_OPTIONS, prCompletionOption } from '../../cos/constants';
import ProviderModelSelector from '../../ProviderModelSelector';
import useRunWithPicker from '../../../hooks/useRunWithPicker';
import useClaimReviewers from '../../../hooks/useClaimReviewers';
import ClaimReviewerSource from '../ClaimReviewerSource';
import ReviewerPicker from '../../cos/ReviewerPicker';
import useReviewerModelOptions from '../../../hooks/useReviewerModelOptions';
import { buildReviewersCsv } from '../../../../../server/lib/reviewerConfig.js';

function ClaimReviewOverride({ defaults, overrides, onChange, modelOptions }) {
  return (
    <ReviewerPicker
      {...defaults}
      {...overrides}
      defaults={defaults}
      modelOptions={modelOptions}
      showRunFlags={false}
      onChange={({ reviewers, usernames, optionalReviewers, reviewerMaxRounds, reviewerModels, reviewerEfforts }) =>
        onChange(Object.fromEntries(Object.entries({ reviewers, usernames, optionalReviewers, reviewerMaxRounds, reviewerModels, reviewerEfforts })
          .filter(([, value]) => value !== undefined)))}
    />
  );
}

const RUN_FIELD_LABEL = 'block text-[10px] uppercase tracking-wide text-gray-500';

export function useIssueRunSettings(appId) {
  // Page-level provider/model/effort pin for every Claim AND Replan button on this tab —
  // left untouched (blank), a claim resolves the install's active provider,
  // same as the bare button always did (POST /tasks/slashdo -> resolveAgentProviderAndModel;
  // this manual path does NOT consult the app's scheduled claim-work override for
  // the PROVIDER — that pin is read only by the automated claim-work task).
  // Scoped to the provider deliberately: the REVIEWERS below do come from that
  // override, which is precisely the mismatch `claimReviewers` exists to surface.
  // This picker never persists across a reload; it's a session convenience for
  // "claim the next several issues with model X" without reopening the Agent
  // Operations drawer each time.
  const picker = useRunWithPicker();
  const [overrideContext, setOverrideContext] = useState('');
  // The reviewers a Claim launched from this tab will actually run — NOT the
  // Models → Code Reviewers list, whenever a claim-work override is in play (see
  // `GET /apps/:id/claim-reviewers`). Untouched fields remain inherited.
  const claimReviewers = useClaimReviewers(appId);
  const [prCompletion, setPrCompletion] = useState(DEFAULT_PR_COMPLETION);
  const [prCompletionTouched, setPrCompletionTouched] = useState(false);
  useEffect(() => {
    if (!prCompletionTouched && claimReviewers?.prCompletion) {
      setPrCompletion(claimReviewers.prCompletion);
    }
  }, [claimReviewers?.prCompletion, prCompletionTouched]);
  const [reviewOverrides, setReviewOverrides] = useState({});
  const reviewerModelOptions = useReviewerModelOptions();
  // A claim needs someone it can wait on: a non-Copilot AI reviewer or a
  // GitHub/GitLab user. Copilot alone has no CLI for the claim agent to run.
  const invalidReviewOverride = prCompletion === 'review-then-merge'
    && Array.isArray(reviewOverrides.reviewers)
    && !reviewOverrides.reviewers.some(reviewer => reviewer !== 'copilot')
    && !(reviewOverrides.usernames ?? claimReviewers?.usernames ?? []).length;
  const [showReviewOverride, setShowReviewOverride] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // An invalid or active review override must never hide behind the collapsed summary.
  // Overrides only render (and apply) under review-then-merge, so only they can lock the panel open.
  const settingsForcedOpen = prCompletion === 'review-then-merge'
    && (invalidReviewOverride || Object.keys(reviewOverrides).length > 0);
  const settingsOpen = showSettings || settingsForcedOpen;
  useEffect(() => {
    setOverrideContext('');
    setReviewOverrides({});
    setShowReviewOverride(false);
    setPrCompletion(DEFAULT_PR_COMPLETION);
    setPrCompletionTouched(false);
  }, [appId]);

  return {
    picker, pin: picker.pin, overrideContext, setOverrideContext, claimReviewers,
    prCompletion, setPrCompletion, prCompletionTouched, setPrCompletionTouched,
    reviewOverrides, setReviewOverrides, reviewerModelOptions, invalidReviewOverride,
    showReviewOverride, setShowReviewOverride, setShowSettings, settingsForcedOpen, settingsOpen
  };
}

export default function IssueRunSettingsBar({ settings }) {
  const {
    picker, overrideContext, setOverrideContext, claimReviewers,
    prCompletion, setPrCompletion, setPrCompletionTouched, reviewOverrides,
    setReviewOverrides, reviewerModelOptions, invalidReviewOverride, showReviewOverride,
    setShowReviewOverride, setShowSettings, settingsForcedOpen, settingsOpen
  } = settings;
  const runSettingsId = useId();
  const prCompletionId = useId();
  const overrideContextId = useId();
  const providersList = reviewerModelOptions?.providers?.length
    ? reviewerModelOptions.providers
    : (picker.providers || []);
  const hasOverrides = Object.keys(reviewOverrides).length > 0;
  const reviewsEnabled = claimReviewers && prCompletion === 'review-then-merge';
  let reviewerCsv = null;
  if (reviewsEnabled && !invalidReviewOverride) {
    const resolveProviderNames = claimReviewers.csv?.includes('provider:') && providersList.length > 0;
    reviewerCsv = hasOverrides || resolveProviderNames
      ? buildReviewersCsv(
          reviewOverrides.reviewers ?? claimReviewers.reviewers,
          reviewOverrides.usernames ?? claimReviewers.usernames,
          reviewOverrides.optionalReviewers ?? claimReviewers.optionalReviewers,
          reviewOverrides.reviewerMaxRounds ?? claimReviewers.reviewerMaxRounds,
          reviewOverrides.reviewerModels ?? claimReviewers.reviewerModels,
          reviewOverrides.reviewerEfforts ?? claimReviewers.reviewerEfforts,
          providersList
        )
      : claimReviewers.csv;
  }
  const pickedProvider = picker.providers?.find(p => p.id === picker.selectedProviderId);
  const runSettingsSummary = [
    pickedProvider?.name || picker.selectedProviderId || 'Auto',
    picker.selectedModel || pickedProvider?.defaultModel || null,
    picker.effort || pickedProvider?.effort || null,
    prCompletionOption(prCompletion)?.label ?? prCompletion,
    reviewerCsv,
    overrideContext.trim() ? '+ context' : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="px-3 py-2 bg-port-card border border-port-border rounded-lg space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Bot size={14} className="text-gray-500 shrink-0" />
        <span data-testid="run-settings-summary" className="flex-1 min-w-0 text-xs text-gray-300 break-words">{runSettingsSummary}</span>
        {!settingsForcedOpen && (
          <button
            type="button"
            aria-expanded={settingsOpen}
            aria-controls={runSettingsId}
            onClick={() => setShowSettings(value => !value)}
            className="text-xs text-port-accent hover:underline shrink-0"
          >
            {settingsOpen ? 'Hide' : 'Change'}
          </button>
        )}
      </div>
      {settingsOpen && (
        <div id={runSettingsId} className="space-y-3">
          <div className="space-y-1">
            <span className={RUN_FIELD_LABEL}>Agent</span>
            <ProviderModelSelector
              {...picker.selectorProps}
              compact
            />
          </div>
          <div className="space-y-1">
            <label htmlFor={prCompletionId} className={RUN_FIELD_LABEL}>After PR</label>
            <select
              id={prCompletionId}
              value={prCompletion}
              title={prCompletionOption(prCompletion)?.description}
              onChange={e => { setPrCompletion(e.target.value); setPrCompletionTouched(true); }}
              className="w-full sm:w-auto min-h-9 px-2.5 bg-port-bg border border-port-border rounded-lg text-xs text-white focus:border-port-accent focus:outline-hidden"
            >
              {PR_COMPLETION_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          {reviewsEnabled && (
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className={RUN_FIELD_LABEL}>Reviewers</span>
                <span className="flex-1" />
                {hasOverrides && (
                  <button type="button" aria-label="Use configured reviewers" onClick={() => setReviewOverrides({})} className="text-xs text-port-accent hover:underline min-h-7">
                    Reset
                  </button>
                )}
                <button
                  type="button"
                  aria-expanded={showReviewOverride}
                  aria-label={showReviewOverride ? 'Done editing reviewers' : 'Edit reviewers'}
                  onClick={() => setShowReviewOverride(value => !value)}
                  className="text-xs text-port-accent hover:underline min-h-7"
                >
                  {showReviewOverride ? 'Done' : 'Edit'}
                </button>
              </div>
              {!showReviewOverride && (
                <p className="text-xs text-gray-300 break-words">
                  {reviewerCsv ? <span>{reviewerCsv}</span> : <span className="text-gray-500">None</span>}
                  {!hasOverrides && <ClaimReviewerSource source={claimReviewers.source} />}
                </p>
              )}
              {invalidReviewOverride && (
                <p className="text-xs text-port-warning" role="alert">Add an AI reviewer or a GitHub/GitLab user.</p>
              )}
              {showReviewOverride && (
                <ClaimReviewOverride defaults={claimReviewers} overrides={reviewOverrides} onChange={setReviewOverrides} modelOptions={reviewerModelOptions} />
              )}
            </div>
          )}
          <div className="space-y-1">
            <label htmlFor={overrideContextId} className={RUN_FIELD_LABEL}>Extra context</label>
            <textarea
              id={overrideContextId}
              value={overrideContext}
              onChange={e => setOverrideContext(e.target.value)}
              maxLength={4000}
              rows={2}
              placeholder="Optional guidance for Claim and Replan"
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm placeholder:text-gray-600 focus:border-port-accent focus:outline-hidden resize-y"
            />
          </div>
        </div>
      )}
    </div>
  );
}
