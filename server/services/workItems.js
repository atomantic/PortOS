/**
 * Claimable work-item listing for a managed app.
 *
 * `/do:next` normally lets the agent pick its own item. The app-overview
 * "Run /do:next" drawer also offers picking ONE specific item, which needs the
 * same candidate list the agent would walk. Rather than re-implementing the
 * forge queries, this dispatches on the app's resolved Work Tracker to the
 * detector that ALREADY produces that list:
 *
 *   plan   → detectPlanTask        (PLAN.md unchecked/unclaimed items)
 *   github → detectGithubIssues    (`gh issue list` minus the claim skip-list)
 *   gitlab → detectGitlabIssues    (`glab issue list`, same skip-list)
 *   jira   → the app's current-sprint tickets (no detector exists for JIRA —
 *            perpetual mode parks on 'no-detector' — so it reads the same sprint
 *            query the app's Kanban board uses, minus already-started tickets)
 *
 * Sentinel discipline (CLAUDE.md): a failed probe returns `items: []` WITH the
 * detector's `reason` + `transient: true`, so the caller can say "couldn't
 * reach the tracker" instead of the lie "no work available".
 */

import { resolveAppWorkTracker, trackerToClaimTaskType } from '../lib/workTracker.js';
import { detectActionableWork, WORK_ITEM_LIMIT } from './perpetualWork.js';
import { fetchMyCurrentSprintTickets } from './jira.js';

// JIRA statuses whose tickets are already underway or finished — the claim flow
// skips them (claim-issue-jira Phase 1), so they never belong in the picker.
const JIRA_SKIP_CATEGORIES = new Set(['In Progress', 'Done']);

/**
 * Current-sprint tickets for a JIRA-tracked app, shaped like a detector result.
 * Only the tickets the claim flow would consider (not already In Progress/Done).
 * A missing JIRA config is a definitive "nothing to pick"; a fetch failure is
 * transient so the UI says "couldn't load" rather than "no tickets".
 */
async function listJiraTickets(app) {
  const { instanceId, projectKey } = app?.jira || {};
  if (!app?.jira?.enabled || !instanceId || !projectKey) {
    return { items: [], count: 0, reason: 'jira-not-configured' };
  }
  const tickets = await fetchMyCurrentSprintTickets(instanceId, projectKey).catch((err) => {
    console.warn(`⚠️ JIRA work-item fetch failed for ${projectKey}: ${err.message}`);
    return null;
  });
  if (!tickets) return { items: [], count: 0, reason: 'jira-fetch-failed', transient: true };
  const open = tickets.filter(t => !JIRA_SKIP_CATEGORIES.has(t.statusCategory));
  return {
    items: open.slice(0, WORK_ITEM_LIMIT).map(t => ({ ref: t.key, title: t.summary || '', url: t.url })),
    count: open.length,
    reason: open.length > 0 ? 'actionable-tickets' : 'no-open-tickets'
  };
}

/**
 * List the work items `/do:next` could claim for `app`, honoring the same
 * author filter the claim flow uses on forge trackers.
 *
 * @param {object} app - managed app record (needs `id`, `repoPath`, `jira`)
 * @param {{ issueAuthorFilter?: 'self'|'owner'|'any' }} [opts]
 * @returns {Promise<{tracker, source, promptTaskType, items, count, reason, transient}>}
 */
export async function listWorkItems(app, { issueAuthorFilter } = {}) {
  const wt = await resolveAppWorkTracker(app);
  const promptTaskType = trackerToClaimTaskType(wt.resolved) || 'plan-task';
  const base = { tracker: wt.resolved, source: wt.source, promptTaskType };

  const result = promptTaskType === 'claim-issue-jira'
    ? await listJiraTickets(app)
    : await detectActionableWork(promptTaskType, app, issueAuthorFilter ? { issueAuthorFilter } : {});

  return {
    ...base,
    items: Array.isArray(result.items) ? result.items : [],
    count: Number.isFinite(result.count) ? result.count : 0,
    reason: result.reason || null,
    transient: result.transient === true
  };
}
