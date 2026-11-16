/**
 * Layered Intelligence: Jira filer (#2842 split of layeredIntelligence.js).
 * Goes through the PortOS Jira REST service (server/services/jira.js); dedup and pause are
 * label-based via JQL with the slug marker in the description. Jira deps are injectable.
 */

import { jiraIssueLabels, normalizeIssueHardwareRequirements } from '../../lib/dispatchLabels.js';
import { createTicket, searchIssues, addLabels, escapeJql } from '../jira.js';
import { LI_LABEL, PLANNED_WORK_LABEL, LI_JIRA_BLOCKING_LABEL } from './constants.js';
import { slugMarker, extractSlugFromBody } from './dedup.js';
import { normalizeIssueLabels } from './forgeFiler.js';
import { scrubForgeIssueText } from '../appIssues.js';

/**
 * Normalize a Jira status CATEGORY to `open` / `closed`. Jira's three canonical
 * categories are "To Do" / "In Progress" / "Done"; only "Done" counts as closed
 * for dedup + park. Anything unrecognized is treated as open so a custom
 * in-flight status can't slip past dedup.
 */
export function normalizeJiraState(statusCategory) {
  return (statusCategory || '').toLowerCase() === 'done' ? 'closed' : 'open';
}

/**
 * List existing layered-intelligence tickets in a Jira project (open + recently
 * closed) for the reasoner + dedup guard. Mirrors listForgeIssues' `{ ok, issues }`
 * failed-vs-empty contract: a thrown search is `ok:false` (do NOT file — a blind
 * dedup would duplicate); an empty result is `ok:true, issues:[]`.
 */
export async function listJiraIssues({ instanceId, projectKey, jql, searchOptions, search = searchIssues } = {}) {
  if (!instanceId || !projectKey) return { ok: false, issues: [] };
  // `jql` lets the plannedWork source (#2698) reuse this parse path for the
  // prioritized backlog; absent, it's the layered-intelligence label set.
  const query = jql || `project = "${escapeJql(projectKey)}" AND labels = "${LI_LABEL}" ORDER BY updated DESC`;
  const rows = searchOptions
    ? await search(instanceId, query, searchOptions).then(r => r, () => null)
    : await search(instanceId, query).then(r => r, () => null);
  if (!Array.isArray(rows)) return { ok: false, issues: [] };
  return {
    ok: true,
    issues: rows.map(i => ({
      number: i.key || null,
      title: i.summary || '',
      body: i.description || '',
      state: normalizeJiraState(i.statusCategory),
      closedAt: i.resolutiondate || null,
      labels: normalizeIssueLabels(i.labels),
      // Real priority field, only when the caller asked searchIssues for it; absent is null, not a default.
      priority: typeof i.priority === 'string' && i.priority.trim() ? i.priority.trim() : null,
      slug: extractSlugFromBody(i.description || '') || extractSlugFromBody(i.summary || '')
    }))
  };
}

/**
 * The JQL for a Jira project's committed backlog (#2698): `plan`-labeled tickets that
 * aren't Done, highest priority first. The label filter is required: without it the query
 * returns the whole untriaged backlog under a header claiming the user committed to it.
 * Deliberately NOT `sprint in openSprints()` (absent on non-Scrum projects, where JQL on a
 * missing field is a hard 400), and priority is an ORDER BY, not a filter, because
 * priority names are scheme-specific.
 */
export function plannedWorkJql(projectKey) {
  return `project = "${escapeJql(projectKey)}" AND labels = "${PLANNED_WORK_LABEL}" AND statusCategory != Done ORDER BY priority DESC, updated DESC`;
}

/**
 * List OPEN blocking-labeled Jira tickets for the app (park check). `{ ok, issues }`
 * with the same failed-vs-empty distinction. JQL filters out Done so a resolved
 * blocking ticket un-parks the app automatically (matching the forge pause model).
 */
export async function listJiraBlockingIssues({ instanceId, projectKey, search = searchIssues } = {}) {
  if (!instanceId || !projectKey) return { ok: false, issues: [] };
  const jql = `project = "${escapeJql(projectKey)}" AND labels = "${LI_JIRA_BLOCKING_LABEL}" AND statusCategory != Done ORDER BY updated DESC`;
  const rows = await search(instanceId, jql).then(r => r, () => null);
  if (!Array.isArray(rows)) return { ok: false, issues: [] };
  return {
    ok: true,
    issues: rows.map(i => ({ number: i.key || null, title: i.summary || '', state: normalizeJiraState(i.statusCategory) }))
  };
}

/**
 * File ONE proposal ticket. The slug marker (dedup identity) is appended after the shared
 * `scrubForgeIssueText` pass (#8460) so redaction cannot rewrite it. Returns
 * `{ success, key, url }`: Jira keys are strings (`PROJ-123`), not integers.
 */
export async function fileProposalToJira({
  instanceId, projectKey, issueType = 'Task', title, body, slug,
  model, effort, goodFirstIssue, helpWanted, helpWantedReason, hardwareRequirements, planner, create = createTicket
} = {}) {
  if (!instanceId || !projectKey) return { success: false, error: 'jira instance/project not configured' };
  if (!normalizeIssueHardwareRequirements(hardwareRequirements, { helpWanted, helpWantedReason })) {
    return { success: false, error: 'Invalid hardwareRequirements; use canonical prerequisites and split independent platform targets' };
  }
  const description = `${scrubForgeIssueText(body)}\n\n${slugMarker(slug)}`;
  const res = await create(instanceId, {
    projectKey,
    summary: scrubForgeIssueText(title),
    description,
    issueType,
    labels: [LI_LABEL, ...jiraIssueLabels({ model, effort, goodFirstIssue, helpWanted, helpWantedReason, hardwareRequirements, planner })]
  }).then(r => r, (err) => ({ success: false, error: err?.message || 'jira create failed' }));
  if (!res?.success) return { success: false, error: res?.error || 'jira create failed' };
  return { success: true, key: res.ticketId || null, url: res.url || null };
}

/** Resolve a Jira pause target to an issue KEY: `"this"` is the just-filed ticket, an integer is `<projectKey>-<n>`; null when unresolvable. */
export function resolveJiraBlockKey(pause, filedKey, projectKey) {
  if (!pause) return null;
  if (pause.blockOnIssue === 'this') return filedKey || null;
  if (Number.isInteger(pause.blockOnIssue) && projectKey) return `${projectKey}-${pause.blockOnIssue}`;
  return null;
}

/** Apply the Jira blocking label to an existing ticket (pause). Returns `{ success }`. */
export async function applyJiraBlockingLabel({ instanceId, key, addLabel = addLabels } = {}) {
  if (!instanceId || !key) return { success: false, error: 'no jira ticket key' };
  const res = await addLabel(instanceId, key, [LI_JIRA_BLOCKING_LABEL]).then(r => r, (err) => ({ success: false, error: err?.message }));
  return res?.success ? { success: true } : { success: false, error: res?.error || 'jira label failed' };
}
