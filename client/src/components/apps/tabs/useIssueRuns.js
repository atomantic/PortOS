import { useCallback, useEffect, useRef, useState } from 'react';
import { ClipboardCheck, Rocket } from 'lucide-react';
import toast from '../../ui/Toast';
import { useCosTaskUpdates } from '../../../hooks/useCosTaskUpdates';
import { createSlashdoTask } from '../../../services/apiAgents.js';
import { ISSUE_BODY_PREVIEW_MAX_CHARS, isCompleteIssueContext } from '../../../../../lib/issueContext.js';

const RUN_STATUS_RANK = { queuing: 0, queued: 1, active: 2, completed: 3, blocked: 3 };

export const RUN_STATUS_LABEL = {
  queued: 'Queued — view',
  active: 'Active — view',
  completed: 'Completed — view',
  blocked: 'Blocked — view'
};

const runStatusForTask = (status) => ({
  pending: 'queued',
  in_progress: 'active',
  completed: 'completed',
  blocked: 'blocked'
}[status] || null);

// The two per-issue agent runs this tab can launch. Both POST the same
// `/tasks/slashdo` shape — a slashdo command pinned to one issue via `target` —
// and differ only in which command, which task-metadata key carries the pinned
// issue back over the socket, and how the row reads.
//
// They are tracked as SEPARATE runs (the state map is keyed `<action>:<number>`,
// and the server persists `claimTarget` / `replanTarget` under distinct keys) so
// replanning an issue never disables its Claim button, and neither run's
// lifecycle events can light up the other's.
// Every message this tab prints about a run is "<verb> #42 <happened>", so the
// per-action table carries only the two words that vary — the imperative the
// button promises and the noun the notice names it by — and one formatter
// renders all four sentences from them. A third action supplies two strings.
const runMessages = ({ verb, noun }) => ({
  queued: (number) => `Queued a CoS agent to ${verb} #${number}`,
  failed: (number) => `Failed to queue a ${verb} for #${number}`,
  transition: (number, to) => ({
    active: `${noun} #${number} is now active`,
    completed: `${noun} #${number} completed`,
    blocked: `${noun} #${number} was blocked`
  }[to])
});

export const ISSUE_ACTIONS = {
  replan: {
    command: 'replan',
    targetKey: 'replanTarget',
    label: 'Replan',
    icon: ClipboardCheck,
    tone: 'bg-port-border/60 text-gray-300 enabled:hover:bg-port-border',
    title: (number) => `Queue a CoS agent to review the plan on issue #${number} and comment its refinements — it writes no code`,
    ...runMessages({ verb: 'replan', noun: 'Replan of' })
  },
  claim: {
    command: 'next',
    targetKey: 'claimTarget',
    label: 'Claim',
    icon: Rocket,
    tone: 'bg-port-accent/20 text-port-accent enabled:hover:bg-port-accent/30',
    title: (number, appName) => `Queue a CoS agent to claim issue #${number} for ${appName}`,
    ...runMessages({ verb: 'claim', noun: 'Claim' })
  }
};

// Buttons render in table order — no second list to keep in sync.
export const ACTION_ORDER = Object.keys(ISSUE_ACTIONS);

/** Run-map key. One issue can carry an independent run per action. */
export const runKey = (action, issueNumber) => `${action}:${issueNumber}`;

/** Split a run key back into its action + issue number (as a string). */
function parseRunKey(key) {
  const at = key.indexOf(':');
  return { action: key.slice(0, at), issueNumber: key.slice(at + 1) };
}

export default function useIssueRuns(appId, { pin, overrideContext, prCompletion, prCompletionTouched, reviewOverrides, invalidReviewOverride }) {
  const { provider, model, effort } = pin;
  // Per-issue run lifecycle: 'queuing' while the POST is in flight, then the
  // task's live CoS state. Keyed `<action>:<issue number>` so neither one row's
  // run nor its sibling action can disable the others' buttons.
  const [runs, setRuns] = useState({});
  const runsRef = useRef({});

  // Keep the event-driven path based on the latest runs without putting a
  // mutable state snapshot in its effect dependencies. Socket callbacks can
  // arrive between the POST response and the next React render.
  const replaceRuns = useCallback((updater) => {
    const next = updater(runsRef.current);
    runsRef.current = next;
    setRuns(next);
  }, []);

  useEffect(() => {
    runsRef.current = {};
    setRuns({});
  }, [appId]);

  const applyTaskUpdate = useCallback((task) => {
    if (!task?.id) return;
    const nextStatus = runStatusForTask(task.status);
    if (!nextStatus) return;

    const currentRuns = runsRef.current;
    const nextRuns = { ...currentRuns };
    const transitions = [];

    for (const [key, rawRun] of Object.entries(currentRuns)) {
      const { action, issueNumber } = parseRunKey(key);
      const spec = ISSUE_ACTIONS[action];
      if (!spec) continue;
      const run = typeof rawRun === 'string' ? { status: rawRun } : rawRun;
      // Before the POST resolves there is no task id to match on, so fall back
      // to the durable per-action target the server stamped. Reading THIS
      // action's key is what keeps a claim's events off a replan's row.
      const matchesTask = run.taskId === task.id || (
        !run.taskId && task.metadata?.app === appId &&
        String(task.metadata?.[spec.targetKey]) === issueNumber
      );
      if (!matchesTask) continue;

      const currentStatus = run.status || 'queuing';
      if ((RUN_STATUS_RANK[nextStatus] ?? 0) < (RUN_STATUS_RANK[currentStatus] ?? 0)) continue;
      if (run.taskId === task.id && currentStatus === nextStatus) continue;

      nextRuns[key] = { ...run, taskId: run.taskId || task.id, status: nextStatus };
      transitions.push({ action, issueNumber, from: currentStatus, to: nextStatus });
    }

    if (transitions.length === 0) return;
    replaceRuns(() => nextRuns);

    for (const { action, issueNumber, from, to } of transitions) {
      if (to === from) continue;
      const message = ISSUE_ACTIONS[action].transition(issueNumber, to);
      if (!message) continue;
      if (to === 'active') toast(message, { icon: '▶️' });
      else if (to === 'completed') toast.success(message);
      else if (to === 'blocked') toast.error(message);
    }
  }, [appId, replaceRuns]);

  useCosTaskUpdates(applyTaskUpdate);

  // One launcher for both per-issue actions: they POST the same body to the same
  // endpoint and differ only in the slashdo command. Keeping them on one path is
  // what guarantees the provider pin, override context, and prefetched issue
  // content reach a replan exactly as they reach a claim.
  const handleRun = useCallback(async (issue, action) => {
    const spec = ISSUE_ACTIONS[action];
    if (action === 'claim' && invalidReviewOverride) return;
    const key = runKey(action, issue.number);
    replaceRuns(prev => ({ ...prev, [key]: { status: 'queuing', taskId: null } }));
    const trimmedOverrideContext = overrideContext.trim();
    const issueContext = {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      ...(issue.url ? { url: issue.url } : {})
    };
    // Older servers lack the completeness flag but their clipped previews are
    // longer than the preview limit because they append a truncation notice.
    const completePreview = issue.bodyTruncated === false
      || (issue.bodyTruncated == null && typeof issue.body === 'string' && issue.body.length <= ISSUE_BODY_PREVIEW_MAX_CHARS);
    const result = await createSlashdoTask(spec.command, appId, {
      target: String(issue.number),
      ...(completePreview && isCompleteIssueContext(issueContext) ? { issueContext } : {}),
      provider, model, effort,
      ...(action === 'claim' ? {
        ...(prCompletionTouched ? { prCompletion } : {}),
        ...(prCompletion === 'review-then-merge' ? reviewOverrides : {}),
      } : {}),
      ...(trimmedOverrideContext ? { overrideContext: trimmedOverrideContext } : {}),
    }, { silent: true })
      .catch(err => {
        toast.error(err?.message || spec.failed(issue.number));
        return null;
      });
    if (!result) {
      replaceRuns(prev => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      return;
    }
    replaceRuns(prev => {
      const current = prev[key];
      const currentStatus = typeof current === 'string' ? current : current?.status;
      const resultStatus = runStatusForTask(result.status) || 'queued';
      const status = (RUN_STATUS_RANK[resultStatus] ?? 0) >= (RUN_STATUS_RANK[currentStatus] ?? 0)
        ? resultStatus
        : currentStatus;
      return {
        ...prev,
        [key]: {
          ...(typeof current === 'object' ? current : {}),
          status,
          taskId: current?.taskId || result.id || null
        }
      };
    });
    toast.success(spec.queued(issue.number));
  }, [appId, replaceRuns, provider, model, effort, overrideContext, prCompletion, prCompletionTouched, reviewOverrides, invalidReviewOverride]);

  return { runs, handleRun };
}
