/**
 * Layered Intelligence — Jira filer (#2842 split of layeredIntelligence.js).
 *
 * Jira has no forge CLI — it goes through the PortOS Jira REST service
 * (server/services/jira.js). Dedup + pause are label-based (same as the forges)
 * via JQL, with the slug marker embedded in the ticket description. The Jira deps
 * (search/create/addLabel) are injectable so tests drive the dispatch without a
 * live Jira instance.
 */

import { createTicket, searchIssues, addLabels, escapeJql } from '../jira.js';
import { LI_LABEL, PLANNED_WORK_LABEL, LI_JIRA_BLOCKING_LABEL } from './constants.js';
import { slugMarker, extractSlugFromBody } from './dedup.js';
import { normalizeIssueLabels } from './forgeFiler.js';

// ---------------------------------------------------------------------------
// Jira filer. Jira has no forge CLI — it goes through the PortOS Jira REST
// service (server/services/jira.js). Dedup + pause are label-based (same as the
// forges) via JQL, with the slug marker embedded in the ticket description.
// The Jira deps (search/create/addLabel) are injectable so tests drive the
// dispatch without a live Jira instance.
// ---------------------------------------------------------------------------

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
      // Jira DOES have a real priority field (unlike the forges) — but only when
      // the caller asked searchIssues for it. Absent → null → the renderer omits
      // it, rather than a fabricated default.
      priority: typeof i.priority === 'string' && i.priority.trim() ? i.priority.trim() : null,
      slug: extractSlugFromBody(i.description || '') || extractSlugFromBody(i.summary || '')
    }))
  };
}

/**
 * The JQL for a Jira project's committed backlog (#2698): `plan`-labeled tickets
 * that aren't Done, highest priority first.
 *
 * The label filter is NOT optional — it is what makes this source mean the same
 * thing on Jira as on a forge. Without it the query returns every open ticket,
 * i.e. the untriaged backlog nobody has committed to (plus LI's own past
 * proposals), which would then render under a header asserting the user
 * "already committed to" them and instruct the reasoner to suppress against
 * essentially the whole tracker — and duplicate the `openIssues` source besides.
 * A project that doesn't use the label reports a truthful "nothing planned"
 * rather than a backlog-shaped lie.
 *
 * Deliberately NOT `sprint in openSprints()` — the Sprint field only exists on
 * Scrum-board-backed projects, and JQL referencing an absent field is a hard 400
 * rather than an empty result, which would make gatherPlannedWork report
 * "unavailable" forever on every Kanban/basic project. `labels` exists on every
 * project shape. Priority is an ORDER BY rather than a filter for the same
 * reason: priority NAMES are scheme-specific (a project can rename or drop
 * "Highest"), so filtering on them risks the same permanent-400.
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
 * File ONE proposal ticket in a Jira project. Embeds the slug marker in the
 * description (searchable for dedup) and tags it with the layered-intelligence
 * label. Returns `{ success, key, url }` — Jira issues are keyed strings
 * (`PROJ-123`), not integers, so the handler resolves pause targets by key.
 */
export async function fileProposalToJira({ instanceId, projectKey, issueType = 'Task', title, body, slug, create = createTicket } = {}) {
  if (!instanceId || !projectKey) return { success: false, error: 'jira instance/project not configured' };
  const description = `${body}\n\n${slugMarker(slug)}`;
  const res = await create(instanceId, {
    projectKey,
    summary: title,
    description,
    issueType,
    labels: [LI_LABEL]
  }).then(r => r, (err) => ({ success: false, error: err?.message || 'jira create failed' }));
  if (!res?.success) return { success: false, error: res?.error || 'jira create failed' };
  return { success: true, key: res.ticketId || null, url: res.url || null };
}

/**
 * Resolve a Jira pause target to a concrete issue KEY. `"this"` → the just-filed
 * ticket's key; an integer → `<projectKey>-<n>` (a pre-existing ticket in the
 * same project). Returns null when it can't resolve (e.g. `"this"` but nothing
 * was filed, or no project key for an integer target).
 */
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
