import { LOCAL_LLM_EFFORT_LEVELS, LOCAL_LLM_REVIEWERS, reviewerLabel } from '../cos/constants';
import {
  DEFAULT_GOAL_FIDELITY_FOLLOW_UP_TRIGGER,
  GOAL_FIDELITY_FOLLOW_UP_TRIGGERS,
  sanitizeReviewerModelInput,
} from '../../lib/reviewerPins';

// Prose for each trigger, keyed by the mirrored enum rather than re-listing its
// values: the settings schema is a `z.enum` over the server's list, so an option
// the picker offered but the enum omitted would 400 the whole save — and the
// parity test guarding that mirror only covers the picker if the picker renders
// from it. `fix-first` is the reason to widen: it never downgrades a run, so an
// issue is the only thing that carries those findings past the run record.
const FOLLOW_UP_TRIGGER_LABELS = {
  rethink: 'Only “rethink” — the run built the wrong thing',
  'any-finding': 'Any finding — also the advisory “fix-first”',
};

// The goal-fidelity gate's controls (#5994) — the SECOND review, which asks
// whether a finished run's diff delivers the objective the task stated, rather
// than whether it is decent code. It runs server-side at agent completion, so
// its reviewer has to be one PortOS can call itself: the local-LLM backends. The
// CLI reviewers are invoked by the follow-up agent from a prompt and have no
// server-side entry point, which is why they are absent from this picker rather
// than shown disabled.
//
// Every field is optional. Left unset, the gate inherits whichever local-LLM
// reviewer the chain above already runs (and that reviewer's pinned model and
// effort), so the common case is configuring nothing at all.
export default function GoalFidelityControls({ value, modelOptions, disabled = false, onChange }) {
  const enabled = value?.enabled !== false;
  const backend = value?.backend || '';
  const fileIssue = value?.fileIssue === true;
  const queueTask = value?.queueTask === true;
  const followUpOn = value?.followUpOn || DEFAULT_GOAL_FIDELITY_FOLLOW_UP_TRIGGER;
  const patch = (fields) => onChange({
    enabled,
    backend: value?.backend || null,
    model: value?.model || null,
    effort: value?.effort || null,
    fileIssue,
    queueTask,
    followUpOn,
    ...fields,
  });
  // The trigger only means something once one of the two actions is on, and
  // both are meaningless with the gate itself off.
  const followUpDisabled = disabled || !enabled;

  // Only a chosen backend has a catalog to offer. With none chosen the model and
  // effort fields are inert on purpose: a pin typed against "whatever the chain
  // runs" would follow the chain to a backend that never heard of that id.
  const options = backend ? (modelOptions?.optionsByReviewer?.[backend] || []) : [];
  const freeText = backend ? modelOptions?.freeText?.[backend] !== false : true;
  const fieldsDisabled = disabled || !enabled || !backend;

  return (
    <div className="border border-port-border/60 rounded-lg p-3 space-y-2.5">
      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          id="goal-fidelity-enabled"
          checked={enabled}
          disabled={disabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
          className="mt-0.5 accent-port-accent"
        />
        <span>
          <span className="text-sm text-white">Check finished runs against the task objective</span>
          <span className="block text-xs text-gray-500">
            After a CoS agent run ships, re-read its accumulated diff against what the task actually asked for — what is missing, what was never requested, whether the work was really verified. A <span className="font-mono">rethink</span> verdict records the run as needing attention instead of complete. Runs only when a local model below (or in the chain above) is available, so leaving it on costs nothing until one is.
          </span>
        </span>
      </label>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <div>
          <label htmlFor="goal-fidelity-backend" className="block text-[11px] text-gray-500 mb-1">Local model runtime</label>
          <select
            id="goal-fidelity-backend"
            value={backend}
            disabled={disabled || !enabled}
            onChange={(e) => patch({ backend: e.target.value || null, model: null, effort: null })}
            className="w-full px-2 py-1 text-xs bg-port-bg border border-port-border rounded text-white disabled:opacity-50"
          >
            <option value="">Same as the reviewer chain</option>
            {LOCAL_LLM_REVIEWERS.map((r) => (
              <option key={r} value={r}>{reviewerLabel(r)}</option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="goal-fidelity-model" className="block text-[11px] text-gray-500 mb-1">Model</label>
          {freeText ? (
            <input
              id="goal-fidelity-model"
              type="text"
              value={value?.model || ''}
              disabled={fieldsDisabled}
              placeholder={backend ? 'That runtime’s default' : 'Pick a runtime first'}
              onChange={(e) => patch({ model: sanitizeReviewerModelInput(e.target.value) || null })}
              className="w-full px-2 py-1 text-xs bg-port-bg border border-port-border rounded text-white disabled:opacity-50 font-mono"
            />
          ) : (
            <select
              id="goal-fidelity-model"
              value={value?.model || ''}
              disabled={fieldsDisabled}
              onChange={(e) => patch({ model: e.target.value || null })}
              className="w-full px-2 py-1 text-xs bg-port-bg border border-port-border rounded text-white disabled:opacity-50"
            >
              <option value="">That runtime’s default</option>
              {options.map((id) => (
                <option key={id} value={id}>{id}</option>
              ))}
            </select>
          )}
        </div>

        <div>
          <label htmlFor="goal-fidelity-effort" className="block text-[11px] text-gray-500 mb-1">Reasoning effort</label>
          <select
            id="goal-fidelity-effort"
            value={value?.effort || ''}
            disabled={fieldsDisabled}
            onChange={(e) => patch({ effort: e.target.value || null })}
            className="w-full px-2 py-1 text-xs bg-port-bg border border-port-border rounded text-white disabled:opacity-50"
          >
            <option value="">Model’s own default</option>
            {LOCAL_LLM_EFFORT_LEVELS.map((level) => (
              <option key={level} value={level}>{level}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="border-t border-port-border/60 pt-2.5 space-y-2">
        <p className="text-[11px] uppercase tracking-wide text-gray-500">When the review finds a problem</p>

        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            id="goal-fidelity-file-issue"
            checked={fileIssue}
            disabled={followUpDisabled}
            onChange={(e) => patch({ fileIssue: e.target.checked })}
            className="mt-0.5 accent-port-accent disabled:opacity-50"
          />
          <span>
            <span className="text-sm text-white">File an issue on the project’s tracker</span>
            <span className="block text-xs text-gray-500">
              Writes the finding to whichever tracker the app actually uses — GitHub, GitLab, or JIRA — so it outlives the run record. Re-filing is suppressed by a key carried in the issue body: an existing issue for the same finding is reused even after it has been closed, and a tracker PortOS can’t read refuses the filing rather than risking a duplicate.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            id="goal-fidelity-queue-task"
            checked={queueTask}
            disabled={followUpDisabled}
            onChange={(e) => patch({ queueTask: e.target.checked })}
            className="mt-0.5 accent-port-accent disabled:opacity-50"
          />
          <span>
            <span className="text-sm text-white">Queue an agent to reconcile it</span>
            <span className="block text-xs text-gray-500">
              Adds a CoS task that claims the filed issue — or, with no issue filed, works the finding directly. Runs in a worktree behind a PR, and shares the investigation queue’s duplicate guard and hourly circuit breaker, so a repeated drift can’t spawn one agent per run.
            </span>
          </span>
        </label>

        <div>
          <label htmlFor="goal-fidelity-follow-up-on" className="block text-[11px] text-gray-500 mb-1">Act on which verdicts</label>
          <select
            id="goal-fidelity-follow-up-on"
            value={followUpOn}
            disabled={followUpDisabled || (!fileIssue && !queueTask)}
            onChange={(e) => patch({ followUpOn: e.target.value })}
            className="w-full sm:w-2/3 px-2 py-1 text-xs bg-port-bg border border-port-border rounded text-white disabled:opacity-50"
          >
            {GOAL_FIDELITY_FOLLOW_UP_TRIGGERS.map((option) => (
              <option key={option} value={option}>{FOLLOW_UP_TRIGGER_LABELS[option]}</option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
