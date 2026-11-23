import useFieldDraft from '../../../../hooks/useFieldDraft';
import { ISSUE_AUTHOR_FILTER_OPTIONS, ISSUE_AUTHOR_FILTER_TASK_TYPES, ISSUE_MIN_AGE_DEFAULT, ISSUE_MIN_AGE_OPTIONS, MAX_SELF_MANAGED_PR_AUTHORS, normalizeSelfManagedPrAuthors, PR_AUTHOR_FILTER_OPTIONS, SELF_MANAGED_PR_STALE_MINUTES_DEFAULT, SELF_MANAGED_PR_STALE_MINUTES_MAX } from '../../constants';
import TaskOverrides from './TaskOverrides';

const splitList = (text) => text.split(',').map((s) => s.trim()).filter(Boolean);

// `onMetadataChange(field, value)` writes one taskMetadata key through the
// parent's in-flight-save lock, so every control here gates Run Now and Esc.
export default function PrAndIssueFilterSection({ taskType, config, updating, activeCount, onMetadataChange }) {
  // Comma-separated free text, committed as an array on blur.
  const excludeLabelsDraft = useFieldDraft(
    (config.taskMetadata?.issueExcludeLabels || []).join(', '),
    (next) => onMetadataChange('issueExcludeLabels', splitList(next))
  );
  const selfManagedAuthorsDraft = useFieldDraft(
    (config.taskMetadata?.selfManagedPrAuthors || []).join(', '),
    (next) => {
      const entered = splitList(next);
      const authors = normalizeSelfManagedPrAuthors(entered);
      // An entry that is not a GitHub login reverts the edit rather than saving a
      // shorter list; a list only over the cap saves its first logins.
      const distinct = new Set(entered.map((login) => login.replace(/^@+/, '').toLowerCase()));
      if (authors.length !== Math.min(distinct.size, MAX_SELF_MANAGED_PR_AUTHORS)) return undefined;
      return onMetadataChange('selfManagedPrAuthors', authors);
    }
  );
  const selfManagedStaleDraft = useFieldDraft(
    String(config.taskMetadata?.selfManagedPrStaleMinutes || SELF_MANAGED_PR_STALE_MINUTES_DEFAULT),
    (next) => {
      // Whole numbers only; anything else reverts to the saved window.
      const minutes = /^\d+$/.test(next.trim()) ? Number(next.trim()) : Number.NaN;
      if (!Number.isInteger(minutes) || minutes < 1) return undefined;
      return onMetadataChange('selfManagedPrStaleMinutes', Math.min(minutes, SELF_MANAGED_PR_STALE_MINUTES_MAX));
    }
  );

  return (
    <TaskOverrides label="PR & issue filters" activeCount={activeCount}>
      {taskType === 'pr-watcher' && (
        <div>
          <label htmlFor={`pr-author-filter-${taskType}`} className="text-sm text-gray-400 block mb-2">PR Remediation Scope</label>
          <select
            id={`pr-author-filter-${taskType}`}
            value="trusted"
            disabled
            className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-white text-sm"
          >
            {PR_AUTHOR_FILTER_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <p className="text-xs text-gray-500 mt-1">
            {PR_AUTHOR_FILTER_OPTIONS.find(o => o.value === 'trusted')?.description}
            {' '}Edit the prompt below to control what the agent does for each opened PR (it can use <code>{'{prData}'}</code>, <code>{'{repoFullName}'}</code>, <code>{'{defaultBranch}'}</code>).
          </p>
          <div className="grid gap-3 mt-3 grid-cols-1 sm:grid-cols-[minmax(0,1fr)_10rem]">
            <div>
              <label htmlFor={`pr-self-managed-authors-${taskType}`} className="text-sm text-gray-400 block mb-2">Self-managed PR authors</label>
              <input
                id={`pr-self-managed-authors-${taskType}`}
                type="text"
                value={selfManagedAuthorsDraft.value}
                onChange={selfManagedAuthorsDraft.onChange}
                onBlur={selfManagedAuthorsDraft.onBlur}
                disabled={updating}
                placeholder="octocat, renovate[bot]"
                className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-white text-sm"
              />
            </div>
            <div>
              <label htmlFor={`pr-self-managed-stale-${taskType}`} className="text-sm text-gray-400 block mb-2">Stale after (minutes)</label>
              <input
                id={`pr-self-managed-stale-${taskType}`}
                type="number"
                min={1}
                max={SELF_MANAGED_PR_STALE_MINUTES_MAX}
                value={selfManagedStaleDraft.value}
                onChange={selfManagedStaleDraft.onChange}
                onBlur={selfManagedStaleDraft.onBlur}
                disabled={updating}
                className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-white text-sm"
              />
            </div>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            These authors run their own merge process. PR Watcher leaves their PRs alone until a PR has had no activity for the stale window, then treats it like any other trusted PR.
          </p>
        </div>
      )}

      {ISSUE_AUTHOR_FILTER_TASK_TYPES.has(taskType) && (
        <div>
          <label htmlFor={`issue-author-filter-${taskType}`} className="text-sm text-gray-400 block mb-2">Issue Author Filter</label>
          <select
            id={`issue-author-filter-${taskType}`}
            value={config.taskMetadata?.issueAuthorFilter || 'self'}
            onChange={(e) => onMetadataChange('issueAuthorFilter', e.target.value)}
            disabled={updating}
            className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-white text-sm"
          >
            {ISSUE_AUTHOR_FILTER_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <p className="text-xs text-gray-500 mt-1">
            {ISSUE_AUTHOR_FILTER_OPTIONS.find(o => o.value === (config.taskMetadata?.issueAuthorFilter || 'self'))?.description}.
            {' '}This is the global default — individual apps can override it below.
          </p>
        </div>
      )}

      {ISSUE_AUTHOR_FILTER_TASK_TYPES.has(taskType) && (
        <div>
          <label htmlFor={`issue-exclude-labels-${taskType}`} className="text-sm text-gray-400 block mb-2">Leave issues with these labels for humans</label>
          <input
            id={`issue-exclude-labels-${taskType}`}
            type="text"
            value={excludeLabelsDraft.value}
            onChange={excludeLabelsDraft.onChange}
            onBlur={excludeLabelsDraft.onBlur}
            disabled={updating}
            placeholder="good first issue, help wanted"
            className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-white text-sm"
          />
          <p className="text-xs text-gray-500 mt-1">
            Comma-separated labels. An issue carrying any of these is skipped by autonomous claiming, on top of the fixed <code>in-progress</code>/<code>blocked</code>/<code>needs-input</code>/<code>future</code>/<code>wontfix</code>/<code>question</code>/<code>discussion</code> set.
            {' '}This is the global default — individual apps can override it below.
          </p>
        </div>
      )}

      {ISSUE_AUTHOR_FILTER_TASK_TYPES.has(taskType) && (
        <div>
          <label htmlFor={`issue-min-age-${taskType}`} className="text-sm text-gray-400 block mb-2">New-issue grace</label>
          <select
            id={`issue-min-age-${taskType}`}
            value={config.taskMetadata?.issueMinAgeMinutes ?? ISSUE_MIN_AGE_DEFAULT}
            onChange={(e) => onMetadataChange('issueMinAgeMinutes', Number(e.target.value))}
            disabled={updating}
            className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-white text-sm"
          >
            {ISSUE_MIN_AGE_OPTIONS.map(minutes => (
              <option key={minutes} value={minutes}>{minutes === 0 ? 'Off' : `${minutes} minutes`}</option>
            ))}
          </select>
          <p className="text-xs text-gray-500 mt-1">
            Autonomous claiming skips issues newer than this, so it never takes an issue the agent that just filed it is about to claim. A picked issue is claimed right away.
          </p>
        </div>
      )}
    </TaskOverrides>
  );
}
