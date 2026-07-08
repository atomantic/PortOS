/**
 * JIRA API Service
 * Supports multiple JIRA instances with Personal Access Tokens
 */

import fs from 'fs/promises';
import { createHttpClient } from '../lib/httpClient.js';
import path from 'path';
import { ensureDir, PATHS } from '../lib/fileUtils.js';
import { hostFromOriginUrl } from '../lib/workTracker.js';

const JIRA_CONFIG_FILE = path.join(PATHS.data, 'jira.json');

export const escapeJql = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/**
 * Get JIRA instances configuration
 */
export async function getInstances() {
  try {
    const content = await fs.readFile(JIRA_CONFIG_FILE, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      // Initialize with empty config
      const defaultConfig = { instances: {} };
      await saveInstances(defaultConfig);
      return defaultConfig;
    }
    throw error;
  }
}

/**
 * Save JIRA instances configuration
 */
export async function saveInstances(config) {
  await ensureDir(path.dirname(JIRA_CONFIG_FILE));
  await fs.writeFile(
    JIRA_CONFIG_FILE,
    JSON.stringify(config, null, 2),
    'utf-8'
  );
}

/**
 * Add or update JIRA instance
 */
export async function upsertInstance(instanceId, instanceData) {
  const config = await getInstances();

  const existing = config.instances[instanceId];

  config.instances[instanceId] = {
    id: instanceId,
    name: instanceData.name,
    baseUrl: instanceData.baseUrl,
    email: instanceData.email,
    apiToken: instanceData.apiToken, // Server/DC PAT (sent as Bearer) or Cloud API token (sent as Basic email:token)
    tokenUpdatedAt: (instanceData.apiToken !== existing?.apiToken) ? new Date().toISOString() : (existing?.tokenUpdatedAt || new Date().toISOString()),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await saveInstances(config);
  return config.instances[instanceId];
}

/**
 * Delete JIRA instance
 */
export async function deleteInstance(instanceId) {
  const config = await getInstances();
  delete config.instances[instanceId];
  await saveInstances(config);
}

/**
 * Whether a JIRA instance is Jira Cloud (*.atlassian.net) vs Server / Data Center.
 * Uses the shared no-throw host extractor (returns null on unparseable input) so a
 * hand-edited jira.json can't throw here.
 */
export function isCloudInstance(baseUrl) {
  const host = hostFromOriginUrl(baseUrl);
  return !!host && /(^|\.)atlassian\.net$/i.test(host);
}

/**
 * Build the Authorization header for a JIRA instance.
 * - Jira Cloud authenticates a personal API token via HTTP Basic (base64 "email:token").
 * - Jira Server / Data Center authenticates a Personal Access Token (PAT) via Bearer.
 * Detected by host so Server and Cloud instances can coexist during a migration.
 */
export function jiraAuthHeader(instance) {
  if (isCloudInstance(instance.baseUrl)) {
    return `Basic ${Buffer.from(`${instance.email}:${instance.apiToken}`).toString('base64')}`;
  }
  return `Bearer ${instance.apiToken}`;
}

/**
 * Create HTTP client for JIRA instance
 */
export function createJiraClient(instance) {
  if (instance.allowSelfSigned) {
    console.warn(`⚠️ JIRA instance ${instance.name || instance.id} using allowSelfSigned — TLS verification disabled`);
  }

  const base = createHttpClient({
    baseURL: instance.baseUrl,
    headers: {
      'Authorization': jiraAuthHeader(instance),
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    timeout: 30000,
    allowSelfSigned: instance.allowSelfSigned
  });

  // Expired/invalid token surfaces differently per instance type, so detection is
  // instance-type-aware alongside jiraAuthHeader — both funnel to one friendly error:
  //   - Jira Server/DC: 200 response whose body is the HTML login page (not JSON).
  //   - Jira Cloud: JSON 401 (createHttpClient throws HTTP 401), never an HTML page.
  const isCloud = isCloudInstance(instance.baseUrl);
  const expiredTokenError = () => {
    const err = new Error('JIRA token expired or invalid — regenerate your token (Server: PAT; Cloud: API token).');
    err.status = 401;
    return err;
  };

  // Success path: only Server serves an HTML login page in place of JSON, so gate the
  // heuristic to Server — a Cloud JSON payload can't accidentally trip on "<!DOCTYPE".
  const checkToken = res => {
    if (!isCloud && typeof res.data === 'string' && res.data.includes('<!DOCTYPE')) {
      throw expiredTokenError();
    }
    return res;
  };

  // Error path: a 401 (Cloud's expired-token signal, and Server's when it 401s rather
  // than serving HTML) maps to the same friendly error. Other errors bubble unchanged.
  const mapAuthError = err => {
    if (err?.status === 401) throw expiredTokenError();
    throw err;
  };

  return {
    get: (...args) => base.get(...args).then(checkToken, mapAuthError),
    post: (...args) => base.post(...args).then(checkToken, mapAuthError),
    put: (...args) => base.put(...args).then(checkToken, mapAuthError),
    delete: (...args) => base.delete(...args).then(checkToken, mapAuthError)
  };
}

/**
 * Test JIRA instance connection
 */
export async function testConnection(instanceId) {
  const config = await getInstances();
  const instance = config.instances[instanceId];

  if (!instance) {
    throw new Error(`JIRA instance ${instanceId} not found`);
  }

  const client = createJiraClient(instance);

  try {
    // Test with /rest/api/2/myself endpoint
    const response = await client.get('/rest/api/2/myself');
    return {
      success: true,
      user: response.data.displayName,
      email: response.data.emailAddress
    };
  } catch (error) {
    return {
      success: false,
      error: error.response?.data?.message || error.message
    };
  }
}

/**
 * Get projects for JIRA instance
 */
export async function getProjects(instanceId) {
  const config = await getInstances();
  const instance = config.instances[instanceId];

  if (!instance) {
    throw new Error(`JIRA instance ${instanceId} not found`);
  }

  const client = createJiraClient(instance);
  const response = await client.get('/rest/api/2/project');

  return response.data.map(project => ({
    key: project.key,
    name: project.name,
    id: project.id
  }));
}

/**
 * Create JIRA ticket
 */
export async function createTicket(instanceId, ticketData) {
  const config = await getInstances();
  const instance = config.instances[instanceId];

  if (!instance) {
    throw new Error(`JIRA instance ${instanceId} not found`);
  }

  const client = createJiraClient(instance);

  const issue = {
    fields: {
      project: {
        key: ticketData.projectKey
      },
      summary: ticketData.summary,
      description: ticketData.description || ticketData.summary,
      issuetype: {
        name: ticketData.issueType || 'Task'
      }
    }
  };

  // Add optional fields
  if (ticketData.assignee) {
    issue.fields.assignee = { name: ticketData.assignee };
  }

  // Custom field IDs vary per JIRA instance — use instance config or defaults
  const fieldIds = {
    storyPoints: instance.customFields?.storyPoints || 'customfield_10106',
    epic: instance.customFields?.epic || 'customfield_10101',
    sprint: instance.customFields?.sprint || 'customfield_10105',
  };

  if (ticketData.storyPoints) {
    issue.fields[fieldIds.storyPoints] = ticketData.storyPoints;
  }

  if (ticketData.epicKey) {
    issue.fields[fieldIds.epic] = ticketData.epicKey;
  }

  if (ticketData.sprint) {
    issue.fields[fieldIds.sprint] = ticketData.sprint;
  }

  if (ticketData.labels && ticketData.labels.length > 0) {
    issue.fields.labels = ticketData.labels;
  }

  const response = await client.post('/rest/api/2/issue', issue);

  const ticketId = response.data.key;
  const ticketUrl = `${instance.baseUrl}/browse/${ticketId}`;

  return {
    success: true,
    ticketId,
    url: ticketUrl,
    response: response.data
  };
}

/**
 * Search JIRA issues by an arbitrary JQL string. STRICT variant — lets fetch
 * errors bubble so a caller can distinguish a transient API failure from a
 * legitimately empty result set (the CLAUDE.md sentinel rule). `fields` selects
 * the returned issue fields; `maxResults` caps the page.
 *
 * Returns `[{ key, summary, description, status, statusCategory, labels, updated, url }]`.
 */
export async function searchIssues(instanceId, jql, { fields = 'summary,status,labels,updated,description,resolutiondate', maxResults = 100 } = {}) {
  const config = await getInstances();
  const instance = config.instances[instanceId];

  if (!instance) {
    throw new Error(`JIRA instance ${instanceId} not found`);
  }

  const client = createJiraClient(instance);
  const response = await client.get('/rest/api/2/search', {
    params: { jql, fields, maxResults }
  });

  return (response.data.issues || []).map(issue => ({
    key: issue.key,
    summary: issue.fields.summary || '',
    description: issue.fields.description || '',
    status: issue.fields.status?.name || null,
    statusCategory: issue.fields.status?.statusCategory?.name || null,
    labels: issue.fields.labels || [],
    updated: issue.fields.updated || null,
    resolutiondate: issue.fields.resolutiondate || null,
    url: `${instance.baseUrl}/browse/${issue.key}`
  }));
}

/**
 * Add labels to an existing JIRA ticket without disturbing its other labels.
 * Jira's field-update API takes an `update.labels` array of `{ add: <label> }`
 * ops, so this is additive (unlike PUT-ing `fields.labels`, which replaces).
 */
export async function addLabels(instanceId, ticketId, labels = []) {
  const config = await getInstances();
  const instance = config.instances[instanceId];

  if (!instance) {
    throw new Error(`JIRA instance ${instanceId} not found`);
  }

  const toAdd = (Array.isArray(labels) ? labels : []).filter(l => typeof l === 'string' && l.trim());
  if (toAdd.length === 0) return { success: true, ticketId };

  const client = createJiraClient(instance);
  await client.put(`/rest/api/2/issue/${encodeURIComponent(ticketId)}`, {
    update: { labels: toAdd.map(name => ({ add: name })) }
  });

  return { success: true, ticketId };
}

/**
 * Update JIRA ticket
 */
export async function updateTicket(instanceId, ticketId, updates) {
  const config = await getInstances();
  const instance = config.instances[instanceId];

  if (!instance) {
    throw new Error(`JIRA instance ${instanceId} not found`);
  }

  const client = createJiraClient(instance);

  const payload = {
    fields: updates
  };

  await client.put(`/rest/api/2/issue/${ticketId}`, payload);

  return {
    success: true,
    ticketId,
    url: `${instance.baseUrl}/browse/${ticketId}`
  };
}

/**
 * Add comment to JIRA ticket
 */
export async function addComment(instanceId, ticketId, comment) {
  const config = await getInstances();
  const instance = config.instances[instanceId];

  if (!instance) {
    throw new Error(`JIRA instance ${instanceId} not found`);
  }

  const client = createJiraClient(instance);

  await client.post(`/rest/api/2/issue/${ticketId}/comment`, {
    body: comment
  });

  return { success: true };
}

/**
 * Get available transitions for a JIRA ticket
 */
export async function getTransitions(instanceId, ticketId) {
  const config = await getInstances();
  const instance = config.instances[instanceId];

  if (!instance) {
    throw new Error(`JIRA instance ${instanceId} not found`);
  }

  const client = createJiraClient(instance);
  const response = await client.get(`/rest/api/2/issue/${ticketId}/transitions`);

  return response.data.transitions.map(t => ({
    id: t.id,
    name: t.name,
    to: t.to?.name,
    toCategory: t.to?.statusCategory?.name
  }));
}

/**
 * Delete a JIRA ticket
 */
export async function deleteTicket(instanceId, ticketId) {
  const config = await getInstances();
  const instance = config.instances[instanceId];

  if (!instance) {
    throw new Error(`JIRA instance ${instanceId} not found`);
  }

  const client = createJiraClient(instance);
  await client.delete(`/rest/api/2/issue/${ticketId}`);

  return { success: true, ticketId };
}

/**
 * Transition JIRA ticket (change status)
 */
export async function transitionTicket(instanceId, ticketId, transitionId) {
  const config = await getInstances();
  const instance = config.instances[instanceId];

  if (!instance) {
    throw new Error(`JIRA instance ${instanceId} not found`);
  }

  const client = createJiraClient(instance);

  await client.post(`/rest/api/2/issue/${ticketId}/transitions`, {
    transition: { id: transitionId }
  });

  return { success: true };
}

/**
 * Fetch tickets assigned to the current user in the active sprint for a project —
 * STRICT variant that lets fetch errors bubble. Used by the issue-reconcile JIRA
 * gatherer, which must distinguish a transient API failure (skip, don't park) from
 * a legitimately empty sprint ([], a valid answer) — the sentinel rule in CLAUDE.md.
 * The UI-facing `getMyCurrentSprintTickets` wraps this and swallows to [] instead.
 */
export async function fetchMyCurrentSprintTickets(instanceId, projectKey) {
  const config = await getInstances();
  const instance = config.instances[instanceId];

  if (!instance) {
    throw new Error(`JIRA instance ${instanceId} not found`);
  }

  const client = createJiraClient(instance);

  // JQL to find tickets assigned to current user in active sprint for the project
  const jql = `project = "${escapeJql(projectKey)}" AND assignee = currentUser() AND sprint in openSprints() ORDER BY priority DESC, updated DESC`;

  const response = await client.get('/rest/api/2/search', {
    params: {
      jql,
      fields: 'summary,status,priority,issuetype,assignee,updated,customfield_10106',
      maxResults: 50
    }
  });

  return response.data.issues.map(issue => ({
    key: issue.key,
    summary: issue.fields.summary,
    status: issue.fields.status.name,
    statusCategory: issue.fields.status.statusCategory?.name,
    priority: issue.fields.priority?.name,
    issueType: issue.fields.issuetype?.name,
    storyPoints: issue.fields.customfield_10106,
    updated: issue.fields.updated,
    url: `${instance.baseUrl}/browse/${issue.key}`
  }));
}

/**
 * Get tickets assigned to user in current sprint for a project.
 * Swallows fetch errors to [] so a JIRA blip never breaks the Kanban UI.
 */
export async function getMyCurrentSprintTickets(instanceId, projectKey) {
  try {
    return await fetchMyCurrentSprintTickets(instanceId, projectKey);
  } catch (error) {
    console.warn(`⚠️ JIRA sprint fetch failed for project ${projectKey}: ${error.message}`);
    // Return empty array on error to avoid breaking the UI
    return [];
  }
}

// Canonical lifecycle ordering for the three Jira status categories. Used to
// order the fallback (no-board) column list — board-config columns keep their
// own configured order instead.
const CATEGORY_ORDER = { 'To Do': 0, 'In Progress': 1, 'Done': 2 };

/**
 * Pure: turn an agile board's column config into Kanban columns.
 * @param {Array} boardColumns - `columnConfig.columns` from the board config API
 *   (`[{ name, statuses: [{ id }] }]`).
 * @param {Map<string,{name,category}>} statusById - status id → name/category.
 * Returns ordered `[{ name, category, statuses: [statusName] }]`, dropping any
 * column that maps to no known status (e.g. an empty/backlog column).
 */
export function buildColumnsFromBoardConfig(boardColumns, statusById) {
  return (boardColumns || [])
    .map(col => {
      const statuses = (col.statuses || [])
        .map(s => statusById.get(String(s.id)))
        .filter(Boolean);
      return {
        name: col.name,
        category: statuses[0]?.category || 'In Progress',
        statuses: statuses.map(s => s.name)
      };
    })
    .filter(col => col.statuses.length > 0);
}

/**
 * Pure: turn a project's distinct workflow statuses into one column per status,
 * ordered by status category (To Do → In Progress → Done). Used when no board
 * id is available. `statusOrder` preserves discovery order so statuses within a
 * category keep a stable layout (Array.prototype.sort is stable).
 */
export function buildColumnsFromStatuses(statusOrder) {
  return (statusOrder || [])
    .map(s => ({ name: s.name, category: s.category, statuses: [s.name] }))
    .sort((a, b) => (CATEGORY_ORDER[a.category] ?? 1) - (CATEGORY_ORDER[b.category] ?? 1));
}

/**
 * Resolve the ordered workflow columns for a project's board so the Kanban UI
 * can show the full lifecycle (Blocked, In Review, any custom stage) instead of
 * collapsing every status into the three statusCategory buckets.
 *
 * With a boardId we use the agile board's actual column layout — the truest
 * representation of the user's workflow, in board order — mapping each column's
 * status ids to names via the project statuses endpoint. Without a boardId, or
 * if the board config can't be read, we fall back to the project's distinct
 * statuses ordered by category. If even the project statuses can't be read the
 * caller (client) falls back to its built-in three-category board.
 *
 * Returns `{ columns: [{ name, category, statuses: [statusName] }], source }`.
 */
export async function getBoardColumns(instanceId, projectKey, boardId) {
  const config = await getInstances();
  const instance = config.instances[instanceId];

  if (!instance) {
    throw new Error(`JIRA instance ${instanceId} not found`);
  }

  const client = createJiraClient(instance);

  // Project statuses (always) and the board config (only when we have a board)
  // are independent calls — fetch them in parallel to save a round-trip. A
  // board-config failure falls through to project-status columns (null).
  const [statusesRes, boardColumns] = await Promise.all([
    client.get(`/rest/api/2/project/${encodeURIComponent(projectKey)}/statuses`),
    boardId
      ? client
          .get(`/rest/agile/1.0/board/${encodeURIComponent(boardId)}/configuration`)
          .then(res => res.data?.columnConfig?.columns || [])
          .catch(err => {
            console.warn(`⚠️ JIRA board ${boardId} config fetch failed: ${err.message}`);
            return null;
          })
      : Promise.resolve(null)
  ]);

  // status id → { name, category }, plus discovery order for the fallback.
  const statusById = new Map();
  const statusOrder = [];
  for (const issueType of statusesRes.data || []) {
    for (const s of issueType.statuses || []) {
      const id = String(s.id);
      if (!statusById.has(id)) {
        const entry = { name: s.name, category: s.statusCategory?.name || 'To Do' };
        statusById.set(id, entry);
        statusOrder.push(entry);
      }
    }
  }

  if (boardColumns) {
    const columns = buildColumnsFromBoardConfig(boardColumns, statusById);
    if (columns.length > 0) {
      return { columns, source: 'board' };
    }
  }

  return { columns: buildColumnsFromStatuses(statusOrder), source: 'project' };
}

/**
 * Get active sprints for a JIRA board
 */
export async function getActiveSprints(instanceId, boardId) {
  const config = await getInstances();
  const instance = config.instances[instanceId];

  if (!instance) {
    throw new Error(`JIRA instance ${instanceId} not found`);
  }

  const client = createJiraClient(instance);
  const response = await client.get(`/rest/agile/1.0/board/${boardId}/sprint`, {
    params: { state: 'active' }
  });

  return response.data.values.map(sprint => ({
    id: sprint.id,
    name: sprint.name,
    state: sprint.state,
    startDate: sprint.startDate,
    endDate: sprint.endDate
  }));
}

/**
 * Search for epics in a JIRA project by name
 */
export async function searchEpics(instanceId, projectKey, query) {
  const config = await getInstances();
  const instance = config.instances[instanceId];

  if (!instance) {
    throw new Error(`JIRA instance ${instanceId} not found`);
  }

  const client = createJiraClient(instance);
  const safeProject = escapeJql(projectKey);
  const safeQuery = escapeJql(query);
  const jql = `project = "${safeProject}" AND issuetype = Epic AND summary ~ "${safeQuery}" ORDER BY updated DESC`;

  const response = await client.get('/rest/api/2/search', {
    params: {
      jql,
      fields: 'summary,status',
      maxResults: 10
    }
  });

  return response.data.issues.map(issue => ({
    key: issue.key,
    summary: issue.fields.summary,
    status: issue.fields.status.name
  }));
}

/**
 * List agile boards for a JIRA project (Scrum + Kanban).
 * Powers the app-config "detect boards" picker so a boardId is chosen from live
 * data instead of hand-typed — which is how a boardId goes stale across a
 * Server→Cloud migration (the id is reassigned). The Agile board list paginates,
 * so walk every page until isLast.
 */
export async function getBoards(instanceId, projectKey) {
  const config = await getInstances();
  const instance = config.instances[instanceId];

  if (!instance) {
    throw new Error(`JIRA instance ${instanceId} not found`);
  }

  const client = createJiraClient(instance);
  const boards = [];
  let startAt = 0;
  let guard = 0;
  for (;;) {
    const response = await client.get('/rest/agile/1.0/board', {
      params: { projectKeyOrId: projectKey, maxResults: 50, startAt }
    });
    const values = response.data.values || [];
    for (const b of values) {
      boards.push({
        id: b.id,
        name: b.name,
        type: b.type,
        projectKey: b.location?.projectKey || null
      });
    }
    // isLast is authoritative; the empty-page and guard checks are belt-and-suspenders
    // so a misbehaving API can't spin this loop forever.
    if (response.data.isLast || values.length === 0 || ++guard > 40) break;
    startAt += values.length;
  }
  return boards;
}

/**
 * Fetch a single issue by key (lightweight — summary/type/status only).
 * Used by the app-config picker to validate that a configured epicKey still
 * resolves on the instance (keys can vanish/change across a migration). Throws
 * (bubbles to a 4xx) when the key doesn't resolve — the caller treats that as
 * "no longer resolves".
 */
export async function getIssue(instanceId, issueKey) {
  const config = await getInstances();
  const instance = config.instances[instanceId];

  if (!instance) {
    throw new Error(`JIRA instance ${instanceId} not found`);
  }

  const client = createJiraClient(instance);
  const response = await client.get(`/rest/api/2/issue/${encodeURIComponent(issueKey)}`, {
    params: { fields: 'summary,status,issuetype' }
  });
  const fields = response.data.fields || {};
  return {
    key: response.data.key,
    summary: fields.summary || '',
    status: fields.status?.name || null,
    issueType: fields.issuetype?.name || null
  };
}

export default {
  getInstances,
  saveInstances,
  upsertInstance,
  deleteInstance,
  testConnection,
  getProjects,
  getBoards,
  getIssue,
  createTicket,
  searchIssues,
  addLabels,
  updateTicket,
  addComment,
  getTransitions,
  deleteTicket,
  transitionTicket,
  getMyCurrentSprintTickets,
  fetchMyCurrentSprintTickets,
  getBoardColumns,
  buildColumnsFromBoardConfig,
  buildColumnsFromStatuses,
  getActiveSprints,
  searchEpics
};
