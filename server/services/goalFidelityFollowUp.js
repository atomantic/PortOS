/**
 * Goal-fidelity follow-up — file the finding, and/or queue the fix.
 *
 * The goal-fidelity gate (`lib/goalFidelity.js`, run from `agentFinalization`)
 * answers "did this run ship what was asked?". Until now a `rethink` verdict
 * held the run and raised a Review Hub alert, and that was the end of it: the
 * finding lived in one install's run record, where it could only be acted on by
 * the person who happened to open the agent card.
 *
 * This module is the durable half. On a verdict the user configured as
 * actionable it can:
 *
 *  - FILE the finding on whichever tracker the project actually uses — GitHub,
 *    GitLab, or JIRA, resolved from the app's own `workTracker` so the issue
 *    lands where a claim would read it; and/or
 *  - QUEUE a CoS follow-up task so an agent reconciles it without a human
 *    relaying the finding by hand.
 *
 * The two are independent switches. Filing first means the queued task can name
 * the issue and run the project's normal claim flow instead of re-deriving the
 * work from prose.
 *
 * The queued task is told to CHECK THE FINDING before acting on it. A verdict is
 * one local model's reading of a diff it saw without the repository, and an
 * agent told only to reconcile will reconcile — inventing a change to satisfy a
 * finding that had nothing behind it. When the objective turns out to have been
 * delivered, the investigator reports the blind spot instead
 * (`services/goalFidelityCalibration.js`), which queues the fix for the detector
 * rather than for the run. The instructions come from
 * `lib/goalFidelityCalibration.js`; this module supplies the loopback API base,
 * which is the one half of it a pure builder cannot resolve.
 *
 * DUPLICATE SUPPRESSION is the load-bearing part, because the producer is a
 * scheduled unattended loop: a perpetual task that keeps drifting the same way
 * would otherwise file the same issue every cadence, forever. Two guards, both
 * keyed on the one fingerprint `lib/goalFidelityFollowUp.js` derives:
 *
 *  1. the issue side lists this feature's own marker LABEL across every issue
 *     STATE and reads the fingerprint back out of the rows. A label is a direct
 *     field filter — no index lag (a full-text search has minutes of it on both
 *     GitHub and JIRA, which is exactly when a schedule re-runs), every state
 *     (so an issue a human CLOSED is not re-filed), and a page bounded by our
 *     own issues rather than by the repo's whole backlog;
 *  2. the queued task goes through `fileInvestigationTask`, inheriting the
 *     shared fingerprint dedup, circuit breaker, and loop policy.
 *
 * FAIL-CLOSED on the issue side, on purpose and against the usual convention: a
 * tracker we could not read is NOT "nothing is filed". That is exactly how a
 * transient `gh` blip files a duplicate. Refusing to file costs one missed
 * issue on a finding that will recur; filing blind costs a tracker.
 *
 * Nothing here can fail a run. `agentFinalization` calls this after the verdict
 * is decided, records what happened, and proceeds either way.
 */

import { execGh } from './github.js';
import { execGlabJson } from './gitlab.js';
import { resolveForgeExecOptions } from './forgeExecOptions.js';
import { PORTOS_APP_ID, getAppById } from './apps.js';
import { getSettings } from './settings.js';
import { fileInvestigationTask } from './investigationTaskProducer.js';
import { fileForgeIssue, probeForgeReachability, scrubForgeIssueText } from './appIssues.js';
import { investigationOutcome } from '../lib/investigationTasks.js';
import { forgeCliForTracker, resolveAppForgeTarget } from '../lib/workTracker.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import { boundedErrorMessage } from '../lib/errorHandler.js';
import { localApiBaseUrl } from '../lib/networkExposure.js';
import { buildGoalFidelityFalsePositiveReportBlock } from '../lib/goalFidelityCalibration.js';
import {
  GOAL_FIDELITY_ISSUE_LABEL,
  GOAL_FIDELITY_ISSUE_LABEL_SPEC,
  buildGoalFidelityFollowUpTask,
  buildGoalFidelityIssue,
  goalFidelityFingerprint,
  goalFidelityFollowUpApplies,
  goalFidelityIssueMarker,
  issueMatchesGoalFidelityMarker,
  resolveGoalFidelityFollowUp,
} from '../lib/goalFidelityFollowUp.js';

/** Rows per request for the label-filtered duplicate listing. */
const PAGE_LIMIT = 100;
/**
 * Hard ceiling on how many of our own filed issues the duplicate scan will read.
 *
 * `gh issue list --limit` paginates internally, so GitHub reaches this in one
 * call; GitLab and JIRA page up to it. A tracker that has this many
 * goal-fidelity issues on one repo is not a backlog, it is a runaway — and the
 * scan says so (below) rather than reading a truncated page as "nothing filed".
 */
const SCAN_LIMIT = 1_000;

/**
 * The managed-app record whose tracker this finding belongs on.
 *
 * A task with no `metadata.app` is PortOS's own work — and that resolves to the
 * REAL `PORTOS_APP_ID` record (always seeded by `loadApps`), not to a
 * `{ repoPath: ROOT_DIR }` literal. The three fields a literal would drop are
 * the three that decide where the issue lands: `workTracker` (an install that
 * pinned PortOS to JIRA would otherwise get a GitHub issue nothing will ever
 * claim), `forgeAccount` (the wrong credentials on a multi-account install),
 * and `jira` (without it the JIRA arm is structurally unreachable for PortOS's
 * own tasks).
 */
async function resolveFollowUpRepo(task) {
  const app = await getAppById(task?.metadata?.app || PORTOS_APP_ID).catch(() => null);
  return app?.repoPath ? app : null;
}

/**
 * Everything a forge call for this app needs, resolved ONCE.
 *
 * `resolveForgeExecOptions` is neither cached nor cheap — it shells out for the
 * origin remote, then `gh auth status` / `gh auth token`, plus `gh api user`
 * when the app pins a forge account. Resolving it per call made the list and
 * the create each pay for it; worse, the create ran with no options at all, so
 * an app pinned to a non-ambient account filed (or 404'd) under the wrong
 * login — the exact failure `resolveForgeExecOptions` exists to prevent.
 *
 * `glab` resolves its project from the working directory rather than a token
 * overlay, so only GitHub passes a repo path here.
 */
const resolveForgeContext = (app, tracker) => resolveForgeExecOptions(
  tracker === 'github' ? app.repoPath : null,
  { forgeAccount: app.forgeAccount },
);

/**
 * Every issue this feature has ever filed on this tracker, in one normalized
 * `{ number, title, body, url }` shape — or `null` when the tracker could not
 * be read.
 *
 * Filtered by LABEL across every STATE, which is what makes the dedup sound:
 *
 * - a label is a direct field filter, so unlike a full-text search it has no
 *   index lag — and the lag window (minutes, on both GitHub and JIRA) is
 *   exactly when a scheduled task re-runs and would re-file;
 * - every state, so an issue a human already CLOSED is still found and not
 *   re-filed;
 * - and it bounds the page by the thing we care about rather than by the
 *   tracker's whole backlog, so a busy repo cannot push our own issues off the
 *   end of the page and silently read as "nothing filed".
 *
 * The three trackers disagree about field names (`iid` / `key`, `description`
 * for the body, `summary` for a JIRA title). They are reconciled here, so the
 * matcher and the result have one shape to read.
 */
async function listFiledIssues({ app, target, tracker, exec }) {
  if (tracker === 'github') {
    // `gh issue list --limit N` pages internally up to N, so one call suffices.
    const raw = await execGh([
      'issue', 'list', '--repo', target.repoSpec,
      '--label', GOAL_FIDELITY_ISSUE_LABEL, '--state', 'all',
      '--limit', String(SCAN_LIMIT), '--json', 'number,title,body,url',
    ], undefined, { cwd: exec.cwd, env: exec.env }).catch((err) => {
      console.error(`❌ goal-fidelity follow-up: gh issue list failed for ${target.repoSpec}: ${err.message}`);
      return null;
    });
    const rows = safeJSONParse(raw, null);
    return Array.isArray(rows) ? rows : null;
  }

  if (tracker === 'gitlab') {
    // `--all` is every STATE, not every page — glab caps a page at 100, so the
    // pages are walked until one comes back short. Without the walk, the 101st
    // goal-fidelity issue pushes an older fingerprint off the only page read and
    // the scheduled task re-files it every cadence.
    const all = [];
    for (let page = 1; all.length < SCAN_LIMIT; page += 1) {
      const { rows } = await execGlabJson(
        ['issue', 'list', '--label', GOAL_FIDELITY_ISSUE_LABEL, '--all',
          '--per-page', String(PAGE_LIMIT), '--page', String(page)],
        app.repoPath,
      );
      if (!Array.isArray(rows)) return null;
      all.push(...rows.map((row) => ({
        number: row?.iid ?? null,
        title: row?.title || '',
        body: row?.description || '',
        url: row?.web_url || '',
      })));
      if (rows.length < PAGE_LIMIT) break;
    }
    return all;
  }

  // JIRA. The project is scoped explicitly — a label match across every project
  // the token can see would dedupe one app's finding against another's.
  // `jira.js` is imported lazily here and in the creator: only a JIRA-tracked
  // app reaches it, and a static edge would put the whole JIRA client graph on
  // the closure of every suite reaching agent finalization (server/AGENTS.md
  // "Import scoping").
  const { searchIssues, escapeJql } = await import('./jira.js');
  const jql = `project = "${escapeJql(app.jira.projectKey)}" AND labels = "${escapeJql(GOAL_FIDELITY_ISSUE_LABEL)}"`;
  const rows = await searchIssues(app.jira.instanceId, jql, {
    fields: 'summary,description,status',
    maxResults: SCAN_LIMIT,
  }).catch((err) => {
    console.error(`❌ goal-fidelity follow-up: JIRA issue search failed for ${app.jira.projectKey}: ${err.message}`);
    return null;
  });
  if (!Array.isArray(rows)) return null;
  return rows.map((row) => ({
    number: row?.key ?? null,
    title: row?.summary || '',
    body: row?.description || '',
    url: row?.url || '',
  }));
}

/** Create the marker label, then the issue — the exec half shared by every forge filer (#7687). */
function createForgeIssue({ app, target, tracker, exec, title, body }) {
  const cli = forgeCliForTracker(tracker);
  return fileForgeIssue({
    cli, cwd: exec.cwd, env: exec.env, repoPath: app.repoPath,
    repo: cli === 'glab' ? null : target.repoSpec,
    title, body,
    labels: [{ name: GOAL_FIDELITY_ISSUE_LABEL, ...GOAL_FIDELITY_ISSUE_LABEL_SPEC }],
  });
}

/**
 * Create the JIRA ticket for one finding, in the same `{ ok, number, url }`
 * shape. It carries the same marker label as its forge siblings — that label is
 * what the next run's duplicate check filters on, so a ticket filed without it
 * would be invisible to the dedup and re-filed every cadence.
 */
async function createJiraIssue({ app, title, body }) {
  const { createTicket } = await import('./jira.js');
  const created = await createTicket(app.jira.instanceId, {
    projectKey: app.jira.projectKey,
    summary: title,
    description: body,
    issueType: app.jira.defaultIssueType || 'Task',
    labels: [GOAL_FIDELITY_ISSUE_LABEL],
  }).catch((err) => ({ success: false, error: boundedErrorMessage(err, 'JIRA ticket creation failed') }));
  return created?.success
    ? { ok: true, number: created.ticketId, url: created.url }
    : { ok: false, error: created?.error || 'JIRA ticket creation failed' };
}

/**
 * Is this app's tracker one we can file to, and does it have what it needs?
 * Returns the refusal sentence, or `null` when the file may proceed.
 */
function trackerRefusal({ app, target, tracker }) {
  if (tracker === 'jira') {
    const jira = app?.jira;
    return jira?.enabled && jira.instanceId && jira.projectKey
      ? null
      : 'this project tracks work in JIRA, but its JIRA instance and project are not configured';
  }
  if (tracker !== 'github' && tracker !== 'gitlab') {
    return `this project's work tracker is ${tracker || 'unresolved'}, which has no issue to file`;
  }
  if (!target || target.forge !== tracker) {
    return `the ${tracker} tracker does not match this repository's remote`;
  }
  return null;
}

/**
 * File one goal-fidelity finding on the app's tracker.
 *
 * One flow for all three trackers, because the sequence is the same everywhere
 * and the fail-closed rule is this feature's load-bearing invariant — stating
 * it once means a later guard cannot land on two of the three.
 *
 * @returns {Promise<{issue: object|null, error: string|null}>} `issue` carries
 *   `duplicate: true` when an existing item already tracks this fingerprint —
 *   the queued task still wants that item's URL, so a duplicate is a usable
 *   result, not a failure.
 */
async function fileFollowUpIssue({ task, review, fingerprint }) {
  const app = await resolveFollowUpRepo(task);
  // Named, not interpolated blind: a task with no `metadata.app` is PortOS's
  // own work, and `app 'undefined' has no configured repository` is not a
  // sentence anyone can act on.
  if (!app) return { issue: null, error: `app '${task?.metadata?.app || PORTOS_APP_ID}' has no configured repository` };

  const { tracker, target } = await resolveAppForgeTarget(app).catch(() => ({ tracker: null, target: null }));
  const refusal = trackerRefusal({ app, target, tracker });
  if (refusal) return { issue: null, error: refusal };

  const exec = tracker === 'jira' ? null : await resolveForgeContext(app, tracker);
  // The reachability probe runs before anything is read or created: on an
  // unreachable forge this is one failing call instead of a list and a label
  // create that each have to time out first. Kept ahead of the duplicate read
  // below rather than folded into `fileForgeIssue`'s own probe, for the same
  // reason `persistentMindIssueCapability.js` keeps its own early probe.
  const probe = await probeForgeReachability({
    cli: forgeCliForTracker(tracker), hostname: target?.apiHost, env: exec?.customEnv,
    label: 'goal-fidelity-followup',
  });
  if (!probe.ok) return { issue: null, error: probe.error };

  // Read before writing. A failed read must NOT read as "nothing is tracked" —
  // that is exactly how a transient CLI blip files the same issue twice — so an
  // unreadable tracker refuses the file rather than proceeding blind.
  const existing = await listFiledIssues({ app, target, tracker, exec });
  if (!existing) return { issue: null, error: `could not read the ${tracker} issue list to check for duplicates; nothing was filed` };
  const duplicate = existing.find((issue) => issueMatchesGoalFidelityMarker(issue, fingerprint));
  if (duplicate) return { issue: { ...duplicate, duplicate: true }, error: null };
  // A scan that came back at the ceiling did not prove ABSENCE — it proved we
  // stopped looking. Filing here is how the 1001st issue re-files the 1st, so
  // this fails closed like every other unreadable-tracker path. Reaching this
  // at all means something upstream is filing without bound; say so.
  if (existing.length >= SCAN_LIMIT) {
    return { issue: null, error: `this repository already carries ${SCAN_LIMIT}+ '${GOAL_FIDELITY_ISSUE_LABEL}' issues, so a duplicate cannot be ruled out; nothing was filed` };
  }

  const { title, body } = buildGoalFidelityIssue({ task, review, fingerprint });
  // The forge path is scrubbed by `fileForgeIssue` itself, by construction —
  // JIRA doesn't go through it, so it scrubs explicitly here. A filed issue is
  // world-readable the moment it lands, and this text is model-authored prose
  // derived from an untrusted diff. The marker itself is a slug of the task's
  // first line and carries no path or credential shape, so the scrub leaves it
  // intact — which it must, or the issue it files could never dedupe against
  // itself.
  const created = tracker === 'jira'
    ? await createJiraIssue({ app, title: scrubForgeIssueText(title), body: scrubForgeIssueText(body) })
    : await createForgeIssue({ app, target, tracker, exec, title, body });
  if (!created.ok) return { issue: null, error: created.error };
  return { issue: { number: created.number, url: created.url, duplicate: false }, error: null };
}

/**
 * Queue the CoS follow-up run.
 *
 * Goes through the shared investigation producer rather than `addTask`
 * directly, so this participates in the machinery every other failure-driven
 * task already does: the durable fingerprint dedup (a second finding for the
 * same cause folds into the open task), the rolling circuit breaker (a drift
 * storm cannot mint one agent per failure), the loop policy (a cause we already
 * queued a fix for and that came back is held for the human), and the
 * worktree + PR delivery posture.
 *
 * The producer's approval verdict rides back out with the task: the loop policy
 * can HOLD a follow-up for a human (`repeat-fingerprint`, `failure-storm`), and
 * that is the case the user most needs named — reporting "queued" for a task
 * nothing will pick up is the one wrong thing to say about it.
 */
async function queueFollowUpTask({ task, review, fingerprint, issue }) {
  // The API base is resolved here because it is this layer's to know: the pure
  // builder cannot read the install's live network exposure to find the loopback
  // port the agent should call.
  const falsePositiveBlock = buildGoalFidelityFalsePositiveReportBlock({
    apiBase: localApiBaseUrl(),
    findingFingerprint: fingerprint,
    taskId: task?.id,
  });
  const description = buildGoalFidelityFollowUpTask({ task, review, fingerprint, issue, falsePositiveBlock });
  const filed = await fileInvestigationTask({
    fingerprint,
    description,
    affectedTasks: task?.id ? [task.id] : [],
    priority: 'MEDIUM',
    context: `Auto-generated from a goal-fidelity ${review?.verdict} verdict`,
    ...(task?.metadata?.app ? { app: task.metadata.app } : {}),
  });
  // One reading of the producer's return, shared with the calibration producer:
  // a HELD task is not a queued one, and a duplicate fold is a usable outcome
  // rather than a failure. Both are easy to re-derive slightly differently.
  return investigationOutcome(filed, { subject: 'the follow-up task' });
}

/**
 * Run whatever follow-up the user configured for this verdict.
 *
 * Returns `{ ran: false }` when nothing is configured or the verdict does not
 * fire the configured trigger — the overwhelmingly common path, and the reason
 * this costs a disabled install nothing but one settings read.
 *
 * Every arm is individually fallible and individually reported: a tracker that
 * refused the file must not also cancel the queued task, because the task is
 * the arm that actually gets the work done.
 *
 * @param {{ agentId: string, task: object, review: object }} args
 * @returns {Promise<{ran: boolean, fingerprint?: string, issue?: object|null,
 *   issueError?: string|null, task?: object|null, taskError?: string|null}>}
 */
export async function runGoalFidelityFollowUp({ agentId, task, review }) {
  const settings = await getSettings().catch(() => null);
  const config = resolveGoalFidelityFollowUp(settings?.codeReview);
  if (!config) return { ran: false };
  if (!goalFidelityFollowUpApplies(review, config.trigger)) return { ran: false };

  const fingerprint = goalFidelityFingerprint(task);
  const result = { ran: true, fingerprint, issue: null, issueError: null, task: null, taskError: null };

  if (config.fileIssue) {
    const filed = await fileFollowUpIssue({ task, review, fingerprint })
      .catch((err) => ({ issue: null, error: boundedErrorMessage(err, 'Issue filing failed') }));
    result.issue = filed.issue;
    result.issueError = filed.error;
  }

  if (config.queueTask) {
    const queued = await queueFollowUpTask({ task, review, fingerprint, issue: result.issue })
      .catch((err) => {
        console.error(`❌ goal-fidelity follow-up: could not queue a task for ${agentId}: ${err.message}`);
        return null;
      });
    result.task = queued?.queued
      ? {
        id: queued.taskId,
        approvalRequired: queued.approvalRequired,
        duplicate: queued.duplicate,
        ...(queued.loopReason ? { loopReason: queued.loopReason } : {}),
      }
      : null;
    // The producer's own refusal sentence, which names the loop policy's reason
    // when it has one — "could not be queued" is the least actionable thing we
    // could say about a deliberate suppression.
    if (!result.task) result.taskError = queued?.reason || 'the follow-up task could not be queued';
  }

  return result;
}

