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
 * DUPLICATE SUPPRESSION is the load-bearing part, because the producer is a
 * scheduled unattended loop: a perpetual task that keeps drifting the same way
 * would otherwise file the same issue every cadence, forever. Three guards, all
 * keyed on the one fingerprint `lib/goalFidelityFollowUp.js` derives:
 *
 *  1. an all-states marker search on the tracker, so a CLOSED issue for the
 *     same finding is not re-filed;
 *  2. an open-issue rescan, because forge full-text indexes lag by minutes and
 *     two runs of the same schedule inside that window are ordinary;
 *  3. the shared investigation-task fingerprint dedup + circuit breaker on the
 *     queued task, via `fileInvestigationTask`.
 *
 * FAIL-CLOSED on the issue side, on purpose and against the usual convention: a
 * tracker we could not read is NOT "nothing is filed". That is exactly how a
 * transient `gh` blip files a duplicate. Refusing to file costs one missed
 * issue on a finding that will recur; filing blind costs a tracker.
 *
 * Nothing here can fail a run. `agentFinalization` calls this after the verdict
 * is decided, records what happened, and proceeds either way.
 */

import { execGh, ensureForgeReachable } from './github.js';
import { execGlab, execGlabJson } from './gitlab.js';
import { resolveForgeExecOptions } from './forgeExecOptions.js';
import { listAppIssues } from './appIssues.js';
import { getAppById } from './apps.js';
import { ROOT_DIR } from './cosState.js';
import { getSettings } from './settings.js';
import { fileInvestigationTask } from './investigationTaskProducer.js';
import { resolveAppForgeTarget } from '../lib/workTracker.js';
import { forgeIssueCreateArgs, forgeLabelCreateArgs, parseCreatedForgeIssue } from '../lib/forgeIssueCli.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import { boundedErrorMessage } from '../lib/errorHandler.js';
import { scrubHomePath } from '../lib/homePath.js';
import { scrubSecretTokens } from '../lib/secretText.js';
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

/** Candidates a marker search may return before we substring-confirm them. */
const SEARCH_LIMIT = 30;
/** Page size for the open-issue rescan on GitLab and the JIRA marker search. */
const PAGE_LIMIT = 100;

/**
 * The last thing that happens to a title/body before a tracker sees it.
 *
 * Same enforcement as the persistent mind's filer, for the same reason: a filed
 * issue is world-readable the moment it lands, and the free text here is
 * model-authored prose derived from an untrusted diff. `scrubHomePath` collapses
 * the running user's home prefix (which embeds the OS username in
 * `/Users/<name>/…`); `scrubSecretTokens` replaces credential-shaped substrings.
 * Applied to the TITLE too — it is as public as the body.
 *
 * Deliberately NOT applied to the fingerprint marker's own text: it is derived
 * from a slug of the task's first line and carries no path or credential shape,
 * and a scrub that rewrote it would break the dedup it exists to serve.
 */
const scrubForgeText = (value) => scrubSecretTokens(scrubHomePath(value));

/**
 * The repository this task's work lives in, as an app-record shape the forge
 * resolvers accept.
 *
 * A task with no `metadata.app` is PortOS's own work, which runs against the
 * install root — the same fallback `agentWorkspacePrep` uses to pick a
 * workspace, so the tracker this files to is the tracker the run touched.
 */
async function resolveFollowUpRepo(task) {
  const appId = task?.metadata?.app;
  if (!appId) return { id: null, name: 'PortOS', repoPath: ROOT_DIR, workTracker: 'auto' };
  const app = await getAppById(appId).catch(() => null);
  if (!app?.repoPath) return null;
  return app;
}

/**
 * GitHub: candidates carrying the marker, across OPEN and CLOSED.
 *
 * `--search` is a narrowing step whose ranking we do not trust — the caller
 * substring-confirms every row. Returns `null` for "could not read", which the
 * caller treats as a refusal to file rather than an absence of duplicates.
 */
async function searchGithubMarker({ target, repoPath, forgeAccount, marker }) {
  const { cwd, env, customEnv } = await resolveForgeExecOptions(repoPath, { forgeAccount });
  const forge = await ensureForgeReachable('goal-fidelity-followup', {
    hostname: target.apiHost,
    ...(customEnv ? { env: customEnv } : {}),
  });
  if (!forge.ok) return null;
  const raw = await execGh([
    'issue', 'list', '--repo', target.repoSpec, '--state', 'all',
    '--search', marker, '--limit', String(SEARCH_LIMIT),
    '--json', 'number,title,body,url,state',
  ], undefined, { cwd, env }).catch((err) => {
    console.error(`❌ goal-fidelity follow-up: gh marker search failed for ${target.repoSpec}: ${err.message}`);
    return null;
  });
  const rows = safeJSONParse(raw, null);
  return Array.isArray(rows) ? rows : null;
}

/**
 * GitLab: `glab issue list --all` is every STATE, not every page — the page cap
 * rides separately. glab has no reliable cross-version full-text issue search
 * flag, so this reads a bounded page and the caller substring-confirms; the
 * marker sits in the second paragraph of the body precisely so a capped read
 * still finds it.
 */
async function searchGitlabMarker({ repoPath }) {
  const { rows } = await execGlabJson(['issue', 'list', '--all', '--per-page', String(PAGE_LIMIT)], repoPath);
  if (!Array.isArray(rows)) return null;
  return rows.map((row) => ({
    number: row?.iid ?? null,
    title: row?.title || '',
    body: row?.description || '',
    url: row?.web_url || '',
    state: row?.state || '',
  }));
}

/**
 * JIRA: a `text ~` marker match inside the app's own project. The project is
 * scoped explicitly — a marker search across every project the token can see
 * would dedupe one app's finding against another's.
 *
 * `jira.js` is imported lazily here and in the filer below: only a JIRA-tracked
 * app ever reaches it, and a static edge would put the whole JIRA client (and
 * its axios/client graph) on the closure of every suite that transitively
 * reaches agent finalization. See server/AGENTS.md "Import scoping".
 */
async function searchJiraMarker({ jira, marker }) {
  const { searchIssues, escapeJql } = await import('./jira.js');
  const jql = `project = "${escapeJql(jira.projectKey)}" AND text ~ "${escapeJql(marker)}"`;
  const rows = await searchIssues(jira.instanceId, jql, {
    fields: 'summary,description,status',
    maxResults: SEARCH_LIMIT,
  }).catch((err) => {
    console.error(`❌ goal-fidelity follow-up: JIRA marker search failed for ${jira.projectKey}: ${err.message}`);
    return null;
  });
  if (!Array.isArray(rows)) return null;
  return rows.map((row) => ({
    number: row?.key ?? null,
    title: row?.summary || '',
    body: row?.description || '',
    url: row?.url || '',
    state: row?.status || '',
  }));
}

/**
 * Every place a duplicate could already be, for one forge tracker: the marker
 * search (all states) and the open-issue list (index-lag backstop).
 *
 * Returns `{ issue }` on a confirmed duplicate, `{ issue: null }` when both
 * reads answered and neither matched, and `{ error }` when a read we needed
 * could not be made. The three are distinct on purpose — collapsing the last
 * into the middle is how a blip files a duplicate.
 */
async function findExistingForgeIssue({ app, target, tracker, fingerprint }) {
  const marker = goalFidelityIssueMarker(fingerprint);
  const candidates = tracker === 'github'
    ? await searchGithubMarker({
      target, repoPath: app.repoPath, forgeAccount: app.forgeAccount, marker,
    })
    : await searchGitlabMarker({ repoPath: app.repoPath });
  if (!candidates) return { error: `could not read the ${tracker} issue list` };
  const searchHit = candidates.find((issue) => issueMatchesGoalFidelityMarker(issue, fingerprint));
  if (searchHit) return { issue: searchHit };

  // Index-lag backstop. GitHub's search index trails a creation by minutes, and
  // two runs of one schedule inside that window is ordinary traffic — without
  // this the second run files a duplicate the search genuinely could not see.
  // GitLab's page read above is already a direct listing, so it needs no rescan.
  if (tracker !== 'github') return { issue: null };
  const open = await listAppIssues(app);
  if (open.transient) return { error: `could not read the open ${tracker} issues (${open.reason})` };
  const openHit = open.issues.find((issue) => issueMatchesGoalFidelityMarker(issue, fingerprint));
  return { issue: openHit || null };
}

/**
 * Create the marker label, then the issue. The label create is idempotent and
 * its failure is swallowed — both CLIs fail the whole `issue create` with a 422
 * on an undefined label, so a label we could not create resurfaces as the
 * create's own error if it actually mattered.
 */
async function createForgeIssue({ app, target, tracker, title, body }) {
  const cli = tracker === 'gitlab' ? 'glab' : 'gh';
  const spec = { name: GOAL_FIDELITY_ISSUE_LABEL, ...GOAL_FIDELITY_ISSUE_LABEL_SPEC };
  await (cli === 'glab'
    ? execGlab(forgeLabelCreateArgs(cli, spec), app.repoPath)
    : execGh(forgeLabelCreateArgs(cli, spec, { repo: target.repoSpec }))).catch(() => null);

  const args = forgeIssueCreateArgs(cli, {
    title, body, labels: [GOAL_FIDELITY_ISSUE_LABEL], repo: cli === 'glab' ? null : target.repoSpec,
  });
  return (cli === 'glab'
    ? execGlab(args, app.repoPath, undefined, { rejectOnError: true })
    : execGh(args)
  ).then(
    (stdout) => ({ ok: true, ...parseCreatedForgeIssue(stdout) }),
    (error) => ({ ok: false, error: boundedErrorMessage(error, 'Issue creation failed') }),
  );
}

/**
 * File one goal-fidelity finding on the app's tracker.
 *
 * @returns {Promise<{issue: object|null, error: string|null}>} `issue` carries
 *   `duplicate: true` when an existing item already tracks this fingerprint —
 *   the queued task still wants that item's URL, so a duplicate is a usable
 *   result, not a failure.
 */
async function fileFollowUpIssue({ task, review, fingerprint }) {
  const app = await resolveFollowUpRepo(task);
  if (!app) return { issue: null, error: `app '${task?.metadata?.app}' has no configured repository` };

  const { tracker, target } = await resolveAppForgeTarget(app).catch(() => ({ tracker: null, target: null }));
  const { title, body } = buildGoalFidelityIssue({ task, review, fingerprint });
  // Scrubbed BEFORE the duplicate check, not just before the create: the text
  // that dedupes has to be the text that gets filed.
  const safeTitle = scrubForgeText(title);
  const safeBody = scrubForgeText(body);

  if (tracker === 'jira') return fileJiraFollowUpIssue({ app, fingerprint, title: safeTitle, body: safeBody });
  if (tracker !== 'github' && tracker !== 'gitlab') {
    return { issue: null, error: `this project's work tracker is ${tracker || 'unresolved'}, which has no issue to file` };
  }
  if (!target || target.forge !== tracker) {
    return { issue: null, error: `the ${tracker} tracker does not match this repository's remote` };
  }

  const existing = await findExistingForgeIssue({ app, target, tracker, fingerprint });
  if (existing.error) return { issue: null, error: `${existing.error}; nothing was filed` };
  if (existing.issue) {
    return { issue: { ...existing.issue, duplicate: true }, error: null };
  }

  const created = await createForgeIssue({ app, target, tracker, title: safeTitle, body: safeBody });
  if (!created.ok) return { issue: null, error: created.error };
  return { issue: { number: created.number, url: created.url, duplicate: false }, error: null };
}

/** The JIRA arm of the same contract: same marker dedup, a ticket instead of an issue. */
async function fileJiraFollowUpIssue({ app, fingerprint, title, body }) {
  const jira = app?.jira;
  if (!jira?.enabled || !jira.instanceId || !jira.projectKey) {
    return { issue: null, error: 'this project tracks work in JIRA, but its JIRA instance and project are not configured' };
  }
  const marker = goalFidelityIssueMarker(fingerprint);
  const candidates = await searchJiraMarker({ jira, marker });
  if (!candidates) return { issue: null, error: 'could not read the JIRA project to check for duplicates; nothing was filed' };
  const hit = candidates.find((issue) => issueMatchesGoalFidelityMarker(issue, fingerprint));
  if (hit) return { issue: { ...hit, duplicate: true }, error: null };

  const { createTicket } = await import('./jira.js');
  const created = await createTicket(jira.instanceId, {
    projectKey: jira.projectKey,
    summary: title,
    description: body,
    issueType: jira.defaultIssueType || 'Task',
  }).catch((err) => ({ success: false, error: boundedErrorMessage(err, 'JIRA ticket creation failed') }));
  if (!created?.success) return { issue: null, error: created?.error || 'JIRA ticket creation failed' };
  return { issue: { number: created.ticketId, url: created.url, duplicate: false }, error: null };
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
 */
async function queueFollowUpTask({ task, review, fingerprint, issue }) {
  const description = buildGoalFidelityFollowUpTask({ task, review, fingerprint, issue });
  const filed = await fileInvestigationTask({
    fingerprint,
    description,
    affectedTasks: task?.id ? [task.id] : [],
    priority: 'MEDIUM',
    context: `Auto-generated from a goal-fidelity ${review?.verdict} verdict`,
    ...(task?.metadata?.app ? { app: task.metadata.app } : {}),
  });
  return filed?.task || null;
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
    result.task = queued;
    if (!queued) result.taskError = 'the follow-up task could not be queued';
  }

  return result;
}

export const __testing = { resolveFollowUpRepo, findExistingForgeIssue };
