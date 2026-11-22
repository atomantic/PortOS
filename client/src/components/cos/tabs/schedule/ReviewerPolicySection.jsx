import { useMemo } from 'react';
import { RotateCcw } from 'lucide-react';
import ReviewerPicker from '../../ReviewerPicker';
import { FormField } from '../../../ui/FormField';
import { DEFAULT_REVIEW_STOP_MODE, IMPLICIT_PR_COMPLETION, ISSUE_AUTHOR_FILTER_TASK_TYPES, PR_COMPLETION_OPTIONS, pinnedPrCompletion, prCompletionOption, REVIEWER_OVERRIDE_KEYS as REVIEW_CONFIG_KEYS } from '../../constants';
import { useCodeReviewDefaults } from '../../../../hooks/useCodeReviewDefaults';
import useReviewerModelOptions from '../../../../hooks/useReviewerModelOptions';
import { reviewerModelsFromDefaults, reviewerEffortsFromDefaults } from '../../../../lib/reviewerModels';
import { resolveTaskOptionalReviewers } from '../../../../lib/reviewerPins';
import { isTruthyMeta } from '../../../../../../server/lib/metadataFlags.js';
import TaskOverrides from './TaskOverrides';

// Shown for the unpinned ('' → inherit) choice: the task type is global, so the
// policy is whatever each target app configured, and PortOS's own self-improvement
// runs (no app) land on the server-side fallback.
const PR_COMPLETION_INHERIT_HINT = `Uses the target app's "After opening PR" default (Apps → Edit App), or "${prCompletionOption(IMPLICIT_PR_COMPLETION)?.label}" when it has none.`;

// The task-local reviewer-loop override is REVIEWER_OVERRIDE_KEYS (imported as
// REVIEW_CONFIG_KEYS above). Removing those keys lets the picker and the server
// resolver fall back to the install-wide Code Review Defaults without changing
// the task's PR policy or other agent options.
//
// Deliberately the WIDE roster, not `hasReviewerOverride`'s list-bearing subset:
// the reset clears the two run flags too, so gating its visibility on the subset
// would leave a stop-mode-only override on screen with no control that removes it.

// `runUpdate(patch)` saves under the parent's in-flight-save lock, so Run Now
// and Esc-to-close stay gated while a reviewer or PR-policy change is saving.
// Renders nothing when neither the PR policy nor the reviewers apply to the task.
export default function ReviewerPolicySection({ taskType, config, updating, runUpdate }) {
  const reviewDefaults = useCodeReviewDefaults();
  // Resolved model lists for the reviewer table's Model column (the picker itself
  // never fetches — see its `modelOptions` prop).
  const reviewerModelOptions = useReviewerModelOptions();
  // The install defaults persist per-reviewer models and efforts as `<reviewer>Model`
  // / `<reviewer>Effort` scalars; the picker takes token-keyed maps. Memoized so a
  // re-render (every `updating` flip) doesn't re-walk the roster and hand the picker
  // fresh object identities. Mirrors SlashDoRunDrawer's `seededReview`.
  const seededPins = useMemo(() => ({
    models: reviewerModelsFromDefaults(reviewDefaults),
    efforts: reviewerEffortsFromDefaults(reviewDefaults),
  }), [reviewDefaults]);

  const claimFlow = !!config.taskMetadata?.claimFlow || ISSUE_AUTHOR_FILTER_TASK_TYPES.has(taskType);
  const prCompletion = pinnedPrCompletion(config.taskMetadata);
  // Reviewers only run under review-then-merge, so the picker hides for the two
  // policies that never reach them — but an unpinned ('') task may still inherit
  // review-then-merge from its app, so that keeps it.
  //
  // A claimFlow task is unconditional: its PROMPT opens and merges its own PR and
  // runs the reviewers itself, so the resolved list is operative no matter what
  // `openPR` / `reviewLoop` say (both are false in the shipped claim metadata).
  // Without this the picker — and the "Use system Code Review Defaults" reset
  // beside it — never render for claim-work, leaving a reviewer override that
  // every claim obeys with no control anywhere that can clear it.
  const reviewersApply = claimFlow
    ? prCompletion !== 'merge-on-green'
    : config.taskMetadata?.openPR
      ? prCompletion === '' || prCompletion === 'review-then-merge'
      : !!config.taskMetadata?.reviewLoop;
  const hasTaskReviewerListOverride = (Array.isArray(config.taskMetadata?.reviewers) && config.taskMetadata.reviewers.length > 0)
    || (typeof config.taskMetadata?.reviewer === 'string' && !!config.taskMetadata.reviewer);

  // '' drops the key so the task inherits its app's `defaultPrCompletion` —
  // which works because no DEFAULT_TASK_INTERVALS entry ships a `prCompletion`
  // for loadSchedule to merge back underneath. The legacy `reviewLoop` bit is
  // the pre-`prCompletion` spelling of the same decision, so it goes too rather
  // than outvoting whatever the user just picked.
  const handlePrCompletionChange = (value) => {
    const { prCompletion: _pinned, reviewLoop: _legacy, ...rest } = config.taskMetadata || {};
    return runUpdate({ taskMetadata: value ? { ...rest, prCompletion: value } : rest });
  };

  const handleResetReviewConfig = () => {
    const taskMetadata = Object.fromEntries(
      Object.entries(config.taskMetadata || {}).filter(([key]) => !REVIEW_CONFIG_KEYS.includes(key))
    );
    return runUpdate({ taskMetadata });
  };

  if (!(config.taskMetadata?.openPR || claimFlow || reviewersApply)) return null;

  return (
    <TaskOverrides label="PR policy & reviewer overrides"
      activeCount={Number(Boolean(prCompletion)) + (reviewersApply ? REVIEW_CONFIG_KEYS.filter((key) => key in (config.taskMetadata || {})).length : 0)}>
      {(config.taskMetadata?.openPR || claimFlow) && (
        <FormField label="After opening PR" className="mt-3" labelClassName="text-sm text-gray-400 block mb-2">
          <select
            value={prCompletion}
            onChange={(e) => handlePrCompletionChange(e.target.value)}
            disabled={updating}
            className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-white text-sm"
          >
            <option value="">{claimFlow ? 'Automatic merge after reviews and CI (default)' : 'App default'}</option>
            {PR_COMPLETION_OPTIONS.map(option => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <p className="text-xs text-gray-500 mt-1">
            {claimFlow
              ? (prCompletion === 'merge-on-green'
                  ? prCompletionOption(prCompletion)?.description
                  : (prCompletion === 'leave-open'
                      ? 'Configured reviews and CI still run. Leave open hands the PR to you for further review without merging or closing the issue.'
                      : 'Configured reviews and CI still run. Automatic merge after reviews and CI pass.'))
              : prCompletionOption(prCompletion)?.description || PR_COMPLETION_INHERIT_HINT}
          </p>
        </FormField>
      )}
      {reviewersApply && (
        <div className="mt-3 pl-2">
          {REVIEW_CONFIG_KEYS.some((key) => key in (config.taskMetadata || {})) && (
            <button
              type="button"
              onClick={handleResetReviewConfig}
              disabled={updating}
              className="mb-2 flex items-center gap-1 text-xs text-gray-400 hover:text-white disabled:opacity-50"
              title="Remove this task's code review override and use the system Code Review Defaults"
            >
              <RotateCcw size={13} />
              Use system Code Review Defaults
            </button>
          )}
          <ReviewerPicker
            reviewers={config.taskMetadata?.reviewers ?? (config.taskMetadata?.reviewer ? [config.taskMetadata.reviewer] : reviewDefaults.reviewers)}
            usernames={config.taskMetadata?.usernames ?? reviewDefaults.usernames}
            optionalReviewers={resolveTaskOptionalReviewers(config.taskMetadata, reviewDefaults.optionalReviewers)}
            reviewerMaxRounds={config.taskMetadata?.reviewerMaxRounds ?? reviewDefaults.reviewerMaxRounds}
            // The task type's own pins when it has them, else the install's Code
            // Review Defaults (persisted as `<reviewer>Model` scalars).
            reviewerModels={config.taskMetadata?.reviewerModels ?? seededPins.models}
            reviewerEfforts={config.taskMetadata?.reviewerEfforts ?? seededPins.efforts}
            modelOptions={reviewerModelOptions}
            installed={reviewDefaults.installed}
            providerReviewUnsupported={reviewDefaults.providerReviewUnsupported}
            stopMode={config.taskMetadata?.reviewStopMode || reviewDefaults.stopMode || DEFAULT_REVIEW_STOP_MODE}
            reviewerApplies={config.taskMetadata?.reviewerApplies !== undefined
              ? isTruthyMeta(config.taskMetadata?.reviewerApplies)
              : reviewDefaults.reviewerApplies}
            // The same fallback the props above were seeded from. The picker
            // omits whatever still equals it, so touching one control no
            // longer freezes the rest into a permanent task override (#6208).
            defaults={{
              reviewers: reviewDefaults.reviewers,
              usernames: reviewDefaults.usernames,
              optionalReviewers: reviewDefaults.optionalReviewers,
              reviewerMaxRounds: reviewDefaults.reviewerMaxRounds,
              reviewerModels: seededPins.models,
              reviewerEfforts: seededPins.efforts,
              stopMode: reviewDefaults.stopMode,
              reviewerApplies: reviewDefaults.reviewerApplies,
            }}
            disabled={updating}
            onChange={(patch) => {
              // The picker emits only what differs from `defaults` above, so
              // rebuild the reviewer slice from scratch: strip every override
              // key (a key that reverted to the default must be DELETED, not
              // left pinning its old value), then re-apply what arrived.
              // Drop the legacy single `reviewer` key so storage converges on `reviewers`.
              const { reviewer: _reviewer, ...rest } = config.taskMetadata || {};
              for (const key of REVIEW_CONFIG_KEYS) delete rest[key];
              const taskMetadata = { ...rest };
              if (patch.reviewers !== undefined) taskMetadata.reviewers = patch.reviewers;
              if (patch.usernames !== undefined) taskMetadata.usernames = patch.usernames;
              if (patch.optionalReviewers !== undefined) taskMetadata.optionalReviewers = patch.optionalReviewers;
              if (patch.reviewerMaxRounds !== undefined) taskMetadata.reviewerMaxRounds = patch.reviewerMaxRounds;
              if (patch.reviewerModels !== undefined) taskMetadata.reviewerModels = patch.reviewerModels;
              if (patch.reviewerEfforts !== undefined) taskMetadata.reviewerEfforts = patch.reviewerEfforts;
              if (patch.stopMode !== undefined) taskMetadata.reviewStopMode = patch.stopMode;
              if (patch.reviewerApplies !== undefined) taskMetadata.reviewerApplies = patch.reviewerApplies;
              runUpdate({ taskMetadata });
            }}
          />
          {hasTaskReviewerListOverride && (
            <p className="mt-2 text-xs text-gray-500">
              This task’s reviewer list is its preferred tier. If any reviewer is paused, scheduled runs use the first healthy system Code Review Defaults tier, or the first configured system tier if all are paused.
            </p>
          )}
        </div>
      )}
    </TaskOverrides>
  );
}
