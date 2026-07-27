import { useState, useCallback, useMemo } from 'react';
import { Loader2, Terminal, Wand2 } from 'lucide-react';
import Drawer from '../Drawer';
import ProviderModelSelector from '../ProviderModelSelector';
import ReviewerPicker from '../cos/ReviewerPicker';
import EffortSelect from '../cos/EffortSelect';
import useProviderModels from '../../hooks/useProviderModels';
import useReviewerModelOptions from '../../hooks/useReviewerModelOptions';
import { reviewerModelsFromDefaults } from '../../lib/reviewerModels';
import { CodeReviewDefaultsProvider, useCodeReviewDefaults } from '../../hooks/useCodeReviewDefaults';
import { isProcessProvider } from '../../utils/providers';
import WorkItemPicker from './WorkItemPicker';
import * as api from '../../services/api';

// Module-scoped so `useProviderModels` sees a stable predicate — an inline arrow
// would be a new identity each render, re-firing the hook's fetch effect forever.
const enabledProcessProviderFilter = (p) => Boolean(p?.enabled) && isProcessProvider(p);

const SELECT_CLASS = 'w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm min-h-[44px]';

/**
 * Pre-flight settings for an Agent Operations `/do:*` run: for `/do:next`, which
 * work item to claim (or let the agent decide); for every command, the provider /
 * model / effort pin and the task options (simplify, review-loop reviewers).
 *
 * Every control is optional — submitting untouched queues exactly the run the
 * bare button used to. Reviewer fields are sent ONLY when the user edits them, so
 * an untouched drawer still resolves the app's configured claim-work reviewers
 * server-side rather than pinning whatever this form happened to display.
 *
 * Mount only while open (the parent conditionally renders it): the provider fetch
 * runs on mount, and unmounting is what resets the form between runs.
 */
function SlashDoRunDrawerBody({ open, command, label, appId, appName, onClose, onQueued }) {
  const codeReviewDefaults = useCodeReviewDefaults();
  // Resolved model lists for the reviewer table's Model column (the picker never
  // fetches — see its `modelOptions` prop).
  const reviewerModelOptions = useReviewerModelOptions();
  const {
    providers, selectedProviderId, selectedModel, availableModels, selectedProvider,
    setSelectedProviderId, setSelectedModel
  } = useProviderModels({ filter: enabledProcessProviderFilter, allowDefault: true, silent: true });

  const [effort, setEffort] = useState('');
  const [simplify, setSimplify] = useState(true);
  // Seeded from the install's Code Review Defaults for display. `reviewDirty`
  // gates whether they're SENT — see the component doc.
  const [review, setReview] = useState(null);
  // The defaults carry per-reviewer models as `<reviewer>Model` scalars; the picker
  // takes the token-keyed map, so fold them in for the seeded (untouched) display.
  const seededReview = useMemo(
    () => ({ ...codeReviewDefaults, reviewerModels: reviewerModelsFromDefaults(codeReviewDefaults) }),
    [codeReviewDefaults]
  );
  const reviewValue = review ?? seededReview;

  const [work, setWork] = useState({ mode: 'auto', target: '', issueAuthorFilter: '' });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const handleWorkChange = useCallback((next) => setWork(next), []);

  const isNext = command === 'next';
  // In pick mode an unselected item must block, not silently fall back to the
  // agent-picked run the user just opted out of.
  const awaitingPick = isNext && work.mode === 'pick' && !work.target;

  const handleQueue = async () => {
    setSubmitting(true);
    setSubmitError('');
    // silent: this drawer owns its own inline error + the caller's toast.
    const result = await api.createSlashdoTask(command, appId, {
      target: work.target || undefined,
      // Only send the filter/reviewers the user actually chose — otherwise the
      // app's configured claim-work defaults apply server-side, unchanged.
      issueAuthorFilter: work.issueAuthorFilter || undefined,
      provider: selectedProviderId || undefined,
      model: selectedModel || undefined,
      effort: effort || undefined,
      simplify,
      // `isNext &&` states the route's contract rather than leaning on the picker
      // being unrendered: only the `next` branch of POST /tasks/slashdo reads these,
      // so sending them for another command would be a silent no-op.
      ...(isNext && review ? {
        reviewers: review.reviewers,
        usernames: review.usernames,
        optionalReviewers: review.optionalReviewers,
        reviewerMaxRounds: review.reviewerMaxRounds,
        reviewerModels: review.reviewerModels
      } : {})
    }, { silent: true }).catch((err) => {
      setSubmitError(err.message || 'Failed to queue the task');
      return null;
    });
    setSubmitting(false);
    if (result) onQueued?.(result);
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={`Run ${label}`}
      subtitle={appName}
      size="lg"
      closeOnBackdrop={false}
    >
      <div className="space-y-6">
        {isNext && <WorkItemPicker appId={appId} target={work.target} onChange={handleWorkChange} />}

        <section className="space-y-3">
          <div className="text-xs text-gray-500 uppercase tracking-wide">Agent</div>
          <ProviderModelSelector
            providers={providers}
            selectedProviderId={selectedProviderId}
            selectedModel={selectedModel}
            availableModels={availableModels}
            onProviderChange={(id) => { setSelectedProviderId(id); setEffort(''); }}
            onModelChange={setSelectedModel}
            emptyProviderOption="Auto (default)"
            emptyModelOption="Default model"
            highlightToolUse
          />
          <div className="sm:max-w-xs">
            <EffortSelect
              provider={selectedProvider}
              value={effort}
              onChange={setEffort}
              className={SELECT_CLASS}
            />
          </div>
        </section>

        <section className="space-y-3">
          <div className="text-xs text-gray-500 uppercase tracking-wide">Task settings</div>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={simplify}
              onChange={e => setSimplify(e.target.checked)}
              className="w-4 h-4 rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent focus:ring-offset-0"
            />
            <span className="flex items-center gap-1.5 text-sm text-gray-400">
              <Wand2 size={14} className="text-port-accent-2" />
              Simplify before committing
            </span>
          </label>
          {/* Reviewer choices are `/do:next`-only: they're substituted into the
              claim prompt's reviewer CSV, and `POST /tasks/slashdo` reads them only
              on that branch. Every other `/do:*` body owns its own review/PR
              sequence, so rendering the picker there would be four knobs wired to
              nothing — the user would pick a reviewer and a model and the run would
              silently discard both. */}
          {isNext && (
            <>
              <ReviewerPicker
                reviewers={reviewValue.reviewers}
                usernames={reviewValue.usernames}
                optionalReviewers={reviewValue.optionalReviewers}
                reviewerMaxRounds={reviewValue.reviewerMaxRounds}
                reviewerModels={reviewValue.reviewerModels}
                modelOptions={reviewerModelOptions}
                // The claim flows substitute a reviewer CSV into their prompt and have
                // no slashdo flag string, so stop-mode / reviewer-applies can't be honored.
                showRunFlags={false}
                onChange={({ reviewers, usernames, optionalReviewers, reviewerMaxRounds, reviewerModels }) =>
                  setReview({ reviewers, usernames, optionalReviewers, reviewerMaxRounds, reviewerModels })}
              />
              <p className="text-xs text-gray-500">
                The claim flow opens and merges its own PR, so these reviewers gate that merge (slashdo <code>--review-with</code>).
                {!review && ' Leave them untouched to use this app’s configured reviewers.'}
              </p>
            </>
          )}
        </section>

        {submitError && <p className="text-xs text-port-error">{submitError}</p>}

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-sm text-gray-400 hover:text-white transition-colors min-h-[44px]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleQueue}
            disabled={submitting || awaitingPick}
            title={awaitingPick ? 'Select a work item first' : undefined}
            className="flex items-center gap-1.5 px-3 py-2 bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 border border-blue-500/30 rounded-lg text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed min-h-[44px]"
          >
            {submitting ? <Loader2 size={14} className="animate-spin" /> : <Terminal size={14} />}
            Queue {label}
          </button>
        </div>
      </div>
    </Drawer>
  );
}

export default function SlashDoRunDrawer(props) {
  return (
    <CodeReviewDefaultsProvider>
      <SlashDoRunDrawerBody {...props} />
    </CodeReviewDefaultsProvider>
  );
}
