/**
 * JIRA API Service
 * Supports multiple JIRA instances with Personal Access Tokens
 */

import fs from 'fs/promises';
import { createBoundedStateMap } from '../lib/boundedStateMap.js';
import { createHttpClient } from '../lib/httpClient.js';
import { createSingleFlight } from '../lib/singleFlight.js';
import path from 'path';
import { atomicWrite, ensureDir, PATHS, readJSONFile } from '../lib/fileUtils.js';
import { hostFromOriginUrl } from '../lib/workTracker.js';
import { countConfiguredInstances } from '../lib/instanceFeatureRegistry.js';

const JIRA_CONFIG_FILE = path.join(PATHS.data, 'jira.json');

// Resolved Cloud user-search results are stable until the instance credentials
// change, and ticket creation can happen repeatedly in one run. Keep only
// positive results in a bounded per-instance cache so a transient failure or an
// initially hidden user can recover on the next ticket.
const cloudAssigneeCache = new Map();
const cloudAssigneeLookupFlight = createSingleFlight();

function getCloudAssigneeCache(instanceId) {
  let instanceCache = cloudAssigneeCache.get(instanceId);
  if (!instanceCache) {
    instanceCache = createBoundedStateMap();
    cloudAssigneeCache.set(instanceId, instanceCache);
  }
  return instanceCache;
}

export function clearCloudAssigneeCache(instanceId) {
  if (instanceId === undefined) cloudAssigneeCache.clear();
  else cloudAssigneeCache.delete(instanceId);
}

// Whether this install has any JIRA instance configured. Read-only on purpose:
// unlike getInstances() it never seeds an empty config file, because the
// instance-feature registry calls it just to decide whether the JIRA nav
// entries should appear on a fresh install.
//
// `strict` so a PRESENT-but-corrupt config throws instead of reading as the
// empty default. The caller turns a throw into "detection failed" and falls back
// to the shipped default; without it an unparseable jira.json would report a
// confident "no instances" and silently hide the JIRA navigation. A genuinely
// absent file still returns the empty default — absent is a trustworthy empty.
export async function hasConfiguredInstances() {
  const config = await readJSONFile(JIRA_CONFIG_FILE, { instances: {} }, { logError: false, strict: true });
  return countConfiguredInstances(config, 'jira.json') > 0;
}

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
  await atomicWrite(JIRA_CONFIG_FILE, config);
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
  // A changed token can authenticate as a different account.
  clearCloudAssigneeCache(instanceId);
  clearCurrentUserCache(instanceId);
  return config.instances[instanceId];
}

/**
 * Delete JIRA instance
 */
export async function deleteInstance(instanceId) {
  const config = await getInstances();
  delete config.instances[instanceId];
  await saveInstances(config);
  clearCloudAssigneeCache(instanceId);
  clearCurrentUserCache(instanceId);
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
    delete: (...args) => base.delete(...args).then(checkToken, mapAuthError),
    // Atlassian sunset the old `GET /rest/api/2/search` on Cloud only (410 Gone) in
    // favor of `/search/jql`, which keeps the same v2 field shapes. Server/DC is on
    // its own release cycle: the classic endpoint stays supported there, and an
    // older DC version may not even serve `/search/jql` yet — so route on instance
    // type instead of hardcoding one path. Every JQL search goes through here.
    search: (params) => base.get(isCloud ? '/rest/api/2/search/jql' : '/rest/api/2/search', { params }).then(checkToken, mapAuthError)
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
 * Resolve a literal Cloud assignee to the GDPR-compatible accountId field.
 *
 * Jira's user search accepts both email addresses and display names. Keep the
 * query's original spelling for Jira, but normalize the cache key so harmless
 * casing differences do not create another request. A null result is reported
 * but deliberately not cached, so an unresolvable configured value creates an
 * unassigned ticket and can resolve on a later retry without sending the
 * rejected `{ name }` shape to Cloud.
 */
async function resolveCloudAssignee(instanceId, client, assignee) {
  const query = assignee.trim();
  if (!query) return null;
  const cacheKey = query.toLowerCase();
  const instanceCache = getCloudAssigneeCache(instanceId);

  const cachedAccountId = instanceCache.get(cacheKey);
  if (cachedAccountId !== undefined) return cachedAccountId;

  const lookup = cloudAssigneeLookupFlight.run(`${instanceId}\u0000${cacheKey}`, async () => {
    const response = await client.get('/rest/api/2/user/search', { params: { query } });
    if (!Array.isArray(response.data)) throw new Error('JIRA Cloud assignee search returned an invalid user list');

    const users = response.data.filter(user => {
      const accountType = typeof user?.accountType === 'string' ? user.accountType.toLowerCase() : null;
      return user?.active !== false && accountType !== 'app';
    });
    const exactAccountIds = [...new Set(users
      .filter(user => [user?.accountId, user?.emailAddress, user?.displayName, user?.name]
        .some(value => typeof value === 'string' && value.trim().toLowerCase() === cacheKey))
      .map(user => user?.accountId)
      .filter(accountId => typeof accountId === 'string' && accountId.trim())
      .map(accountId => accountId.trim()))];
    const soleAccountId = response.data.length === 1 && users.length === 1 && typeof users[0]?.accountId === 'string'
      ? users[0].accountId.trim()
      : '';
    const accountId = exactAccountIds.length === 1
      ? exactAccountIds[0]
      : exactAccountIds.length > 1
        ? null
        : soleAccountId
          ? soleAccountId
          : null;

    if (accountId && cloudAssigneeCache.get(instanceId) === instanceCache) {
      instanceCache.set(cacheKey, accountId);
    }
    if (!accountId) {
      console.warn(`⚠️ JIRA Cloud assignee could not be resolved for instance ${instanceId}; creating ticket unassigned`);
    }

    return accountId;
  });
  return lookup.then(
    accountId => accountId,
    () => {
      console.warn(`⚠️ JIRA Cloud assignee lookup failed for instance ${instanceId}; creating ticket unassigned`);
      return null;
    }
  );
}

/**
 * Look up one configured instance, or throw.
 *
 * The `getInstances() → lookup → throw` preamble is copy-pasted at ~20 call
 * sites in this file. New and edited code goes through here; the rest migrate as
 * they are touched, rather than in one mechanical sweep.
 */
async function resolveInstance(instanceId) {
  const config = await getInstances();
  const instance = config.instances[instanceId];

  if (!instance) {
    throw new Error(`JIRA instance ${instanceId} not found`);
  }

  return instance;
}

/**
 * Custom-field IDs vary per JIRA instance, so every read AND write of one goes
 * through here. Shared by createTicket (which writes the epic link),
 * getIssue/getEpicChildren (which read it back), and fetchMyCurrentSprintTickets
 * (story points), so a claim agent resolving an epic's parent reads the exact
 * field the creator wrote — a one-sided default would silently answer null.
 *
 * There is deliberately no `sprint` entry: sprint membership is set through the
 * Agile API (see addIssuesToSprint), never by writing a custom field, so a
 * `customFields.sprint` id would be config nothing reads.
 */
export function resolveCustomFieldIds(instance) {
  return {
    storyPoints: instance?.customFields?.storyPoints || 'customfield_10106',
    epic: instance?.customFields?.epic || 'customfield_10101',
  };
}

/**
 * Resolve the authenticated JIRA account. Cloud identifies a user by `accountId`
 * (GDPR retired `name`/`key`); Server/DC still uses `name`. Returned raw so
 * callers can pick the field their endpoint expects.
 */
export async function getMyself(instanceId) {
  const instance = await resolveInstance(instanceId);
  const client = createJiraClient(instance);
  const response = await client.get('/rest/api/2/myself');
  const me = response.data || {};
  return {
    accountId: me.accountId || null,
    name: me.name || null,
    displayName: me.displayName || null,
    emailAddress: me.emailAddress || null,
    isCloud: isCloudInstance(instance.baseUrl)
  };
}

// `assignee: 'currentUser'` is the sentinel a claim agent uses to make a filed
// child ticket claimable: the sprint query is `assignee = currentUser()`, and an
// agent has no way to know its own accountId up front.
const CURRENT_USER_ASSIGNEE = 'currentuser';

// The account behind an instance's credential does not change while the process
// runs, and the epic-decomposition flow files a whole batch of slices in a loop —
// without this, every one of them pays its own `/myself` round-trip. `undefined`
// means "not looked up"; a cached `null` means "looked up, no usable identity",
// so a resolvable-to-nothing instance is not re-probed on every create.
const currentUserFieldCache = new Map();

// Exported for tests and for a credential swap: `upsertInstance` can change which
// account a token authenticates as, which is the one thing the cache above can't see.
export function clearCurrentUserCache(instanceId) {
  if (instanceId === undefined) currentUserFieldCache.clear();
  else currentUserFieldCache.delete(instanceId);
}

/**
 * Build the `fields.assignee` value for a create. Returns null when there is
 * nothing to set.
 *
 * The `currentUser` sentinel resolves the caller's own identity and writes the
 * field its instance type actually accepts: Cloud identifies a user by
 * `accountId` (GDPR retired `name`), Server/DC by `name`. A LITERAL identifier
 * goes through `resolveCloudAssignee` on Cloud — Cloud rejects a bare `{ name }`
 * for the same GDPR reason — and is passed through as `{ name }` unchanged on
 * Server/DC, which still accepts it.
 */
async function resolveAssigneeField(instanceId, instance, client, assignee) {
  if (!assignee) return null;
  // A caller that already built the JIRA object (`{ accountId }` / `{ name }`)
  // gets it back untouched — stringifying it would write `{ name: "[object Object]" }`.
  if (typeof assignee !== 'string') return assignee;

  const trimmed = assignee.trim();
  if (!trimmed) return null;

  if (trimmed.toLowerCase() !== CURRENT_USER_ASSIGNEE) {
    if (isCloudInstance(instance.baseUrl)) {
      const accountId = await resolveCloudAssignee(instanceId, client, trimmed);
      return accountId ? { accountId } : null;
    }
    return { name: trimmed };
  }

  const cached = currentUserFieldCache.get(instanceId);
  if (cached !== undefined) return cached;

  const me = await getMyself(instanceId);
  const field = me.isCloud ? 'accountId' : 'name';
  const resolved = me[field] ? { [field]: me[field] } : null;
  currentUserFieldCache.set(instanceId, resolved);
  return resolved;
}

// The two ways a project can express "this issue belongs to that epic". Only one
// exists on any given project — writing the wrong one is a 400, not a silent
// no-op — so a create tries the classic custom field first (what every install
// has been writing until now) and retries with the native `parent` field.
const EPIC_LINK_CUSTOM_FIELD = 'customField';
const EPIC_LINK_PARENT = 'parent';

/**
 * Translate PortOS's domain ticket keys into the JIRA `fields` they actually
 * name. Shared by createTicket and updateTicket: `jiraTicketUpdateSchema` is
 * `jiraTicketCreateSchema.partial()`, so PUT accepts the same keys — and before
 * this, forwarded `epicKey` / `storyPoints` / `assignee` verbatim, none of which
 * is a JIRA field name. That wrote nothing and reported success.
 *
 * Only keys the caller actually supplied are mapped; everything else is left to
 * the caller, so an update can still pass raw JIRA fields straight through.
 */
async function buildIssueFields(instanceId, instance, client, data, epicLinkAs = EPIC_LINK_CUSTOM_FIELD) {
  const fieldIds = resolveCustomFieldIds(instance);
  const fields = {};

  if (data.summary !== undefined) fields.summary = data.summary;
  // `!= null`, not truthiness — `storyPoints: 0` is a real estimate, and dropping
  // it while answering 200 is the absent-vs-empty conflation AGENTS.md warns about.
  if (data.storyPoints != null) fields[fieldIds.storyPoints] = data.storyPoints;
  // The epic link has two incompatible spellings and only one exists per project
  // (see getEpicChildren). `epicLinkAs` picks which to write; the caller retries
  // with the other when the first is rejected.
  if (data.epicKey) {
    if (epicLinkAs === EPIC_LINK_PARENT) fields.parent = { key: data.epicKey };
    else fields[fieldIds.epic] = data.epicKey;
  }
  // `issuetype` IS writable on update — JIRA accepts a type change on an existing
  // issue — so it is mapped here rather than treated as a create-only concern.
  if (data.issueType) fields.issuetype = { name: data.issueType };
  // Array.isArray, not `.length` truthiness: `labels: []` is an intentional CLEAR
  // and must reach JIRA, while an absent key must leave the existing labels alone.
  if (Array.isArray(data.labels)) fields.labels = data.labels;

  const assignee = await resolveAssigneeField(instanceId, instance, client, data.assignee);
  if (assignee) fields.assignee = assignee;

  return fields;
}

/**
 * Move existing issues into a sprint via the Agile API.
 *
 * This is the only reliable way to sprint an issue: setting the sprint custom
 * field on create is rejected outright on most Cloud instances ("Field cannot be
 * set"), which is why `createTicket`'s old `fields[sprint]` write was both dead
 * (it read `ticketData.sprint`, a key nothing sends) and wrong. Filing a child
 * that never lands in the sprint strands it — the next claim run's candidate
 * query only sees sprinted tickets.
 */
export async function addIssuesToSprint(instanceId, sprintId, issueKeys = []) {
  const instance = await resolveInstance(instanceId);
  const keys = issueKeys.filter(key => typeof key === 'string' && key.trim());
  if (keys.length === 0) return { success: true, sprintId, issueKeys: [] };

  const client = createJiraClient(instance);
  await client.post(`/rest/agile/1.0/sprint/${encodeURIComponent(sprintId)}/issue`, { issues: keys });

  return { success: true, sprintId, issueKeys: keys };
}

/**
 * Create JIRA ticket.
 *
 * Returns `{ success, ticketId, url, sprint, response }`. `sprint` is the
 * explicit sentinel for the sprint move: `null` when none was requested, else
 * `{ id, assigned, error }` — `assigned: false` with an `error` means the ticket
 * EXISTS but is not in the sprint, which a caller must surface rather than treat
 * as a clean create (an unsprinted child is invisible to the next claim run).
 */
export async function createTicket(instanceId, ticketData) {
  const instance = await resolveInstance(instanceId);
  const client = createJiraClient(instance);

  const buildIssue = async (epicLinkAs) => ({
    fields: {
      project: {
        key: ticketData.projectKey
      },
      description: ticketData.description || ticketData.summary,
      issuetype: {
        name: ticketData.issueType || 'Task'
      },
      ...(await buildIssueFields(instanceId, instance, client, ticketData, epicLinkAs))
    }
  });

  // A project has exactly one epic-link spelling and rejects the other with a 400
  // naming the offending field, so retry once with the alternative rather than
  // filing an UNPARENTED child — a slice that isn't linked to its epic is
  // invisible to the next run's child lookup and the decomposition strands.
  const response = await client.post('/rest/api/2/issue', await buildIssue(EPIC_LINK_CUSTOM_FIELD))
    .catch(async err => {
      if (!ticketData.epicKey || err?.status !== 400) throw err;
      console.warn(`⚠️ JIRA rejected the epic-link custom field, retrying ${ticketData.projectKey} create with parent`);
      return client.post('/rest/api/2/issue', await buildIssue(EPIC_LINK_PARENT));
    });

  const ticketId = response.data.key;
  const ticketUrl = `${instance.baseUrl}/browse/${ticketId}`;

  // Sprint the ticket AFTER creation (see addIssuesToSprint). A failure here is
  // reported, never thrown: the ticket already exists, so throwing would lose the
  // key the caller needs to recover.
  const sprintId = ticketData.sprintId ?? null;
  let sprint = null;
  if (sprintId !== null && sprintId !== '') {
    sprint = await addIssuesToSprint(instanceId, sprintId, [ticketId])
      .then(() => ({ id: sprintId, assigned: true, error: null }))
      .catch(err => {
        console.warn(`⚠️ JIRA ${ticketId} created but not added to sprint ${sprintId}: ${err.message}`);
        return { id: sprintId, assigned: false, error: err.message };
      });
  }

  return {
    success: true,
    ticketId,
    url: ticketUrl,
    sprint,
    response: response.data
  };
}

/**
 * Search JIRA issues by an arbitrary JQL string. STRICT variant — lets fetch
 * errors bubble so a caller can distinguish a transient API failure from a
 * legitimately empty result set (the AGENTS.md sentinel rule). `fields` selects
 * the returned issue fields; `maxResults` caps the page.
 *
 * Returns `[{ key, summary, description, status, statusCategory, priority,
 * issueType, assignee, labels, updated, resolutiondate, url }]`.
 */
export async function searchIssues(instanceId, jql, { fields = 'summary,status,labels,updated,description,resolutiondate', maxResults = 100 } = {}) {
  const config = await getInstances();
  const instance = config.instances[instanceId];

  if (!instance) {
    throw new Error(`JIRA instance ${instanceId} not found`);
  }

  const client = createJiraClient(instance);
  const response = await client.search({ jql, fields, maxResults });

  return (response.data.issues || []).map(issue => ({
    key: issue.key,
    summary: issue.fields.summary || '',
    description: issue.fields.description || '',
    status: issue.fields.status?.name || null,
    statusCategory: issue.fields.status?.statusCategory?.name || null,
    // Only populated when the caller asked for these fields (none is in the
    // default `fields` set) — null otherwise, never a fabricated default.
    priority: issue.fields.priority?.name || null,
    issueType: issue.fields.issuetype?.name || null,
    assignee: issue.fields.assignee?.displayName || issue.fields.assignee?.name || null,
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
  const instance = await resolveInstance(instanceId);
  const client = createJiraClient(instance);

  // The domain keys go through the shared mapper so a PUT writes the same JIRA
  // fields a POST does; anything else the caller sent is a raw JIRA field and is
  // passed through untouched. `projectKey` and `sprintId` name nothing writable
  // on an update — the route schema no longer accepts them, and sprint membership
  // moves via addIssuesToSprint rather than a field write.
  const { projectKey, sprintId, summary, issueType, storyPoints, epicKey, labels, assignee, ...rest } = updates;
  const payload = {
    fields: {
      ...rest,
      ...(await buildIssueFields(instanceId, instance, client, { summary, issueType, storyPoints, epicKey, labels, assignee }))
    }
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
 * a legitimately empty sprint ([], a valid answer) — the sentinel rule in AGENTS.md.
 * The UI-facing `getMyCurrentSprintTickets` wraps this and swallows to [] instead.
 */
export async function fetchMyCurrentSprintTickets(instanceId, projectKey) {
  const instance = await resolveInstance(instanceId);
  const client = createJiraClient(instance);
  const fieldIds = resolveCustomFieldIds(instance);

  // JQL to find tickets assigned to current user in active sprint for the project
  const jql = `project = "${escapeJql(projectKey)}" AND assignee = currentUser() AND sprint in openSprints() ORDER BY priority DESC, updated DESC`;

  // `labels` is what lets the claim flow see per-ticket markers (the `decomposed`
  // epic marker, dispatch hints) without a second round-trip per candidate.
  const response = await client.search({
    jql,
    fields: `summary,status,priority,issuetype,assignee,labels,updated,${fieldIds.storyPoints}`,
    maxResults: 50
  });

  return response.data.issues.map(issue => ({
    key: issue.key,
    summary: issue.fields.summary,
    status: issue.fields.status.name,
    statusCategory: issue.fields.status.statusCategory?.name,
    priority: issue.fields.priority?.name,
    issueType: issue.fields.issuetype?.name,
    labels: issue.fields.labels || [],
    storyPoints: issue.fields[fieldIds.storyPoints],
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

  const response = await client.search({
    jql,
    fields: 'summary,status',
    maxResults: 10
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
 * Fetch a single issue by key.
 *
 * Used by the app-config picker to validate that a configured epicKey still
 * resolves on the instance (keys can vanish/change across a migration), and by
 * the claim flow's epic decomposition, which needs three things the original
 * summary/type/status projection did not carry: `labels` (to see the
 * `decomposed` marker), `description` (to append and re-read the
 * "Decomposed into" checklist), and `epicKey` (to walk a child back to its
 * parent). Throws (bubbles to a 4xx) when the key doesn't resolve — the caller
 * treats that as "no longer resolves".
 *
 * `epicKey` reads BOTH the instance's configured epic-link custom field and the
 * native `parent` field: company-managed projects use the custom field, while
 * team-managed (next-gen) projects only ever populate `parent`.
 */
export async function getIssue(instanceId, issueKey) {
  const instance = await resolveInstance(instanceId);
  const fieldIds = resolveCustomFieldIds(instance);
  const client = createJiraClient(instance);
  const response = await client.get(`/rest/api/2/issue/${encodeURIComponent(issueKey)}`, {
    params: { fields: `summary,status,issuetype,labels,description,parent,${fieldIds.epic}` }
  });
  const fields = response.data.fields || {};
  const epicLink = fields[fieldIds.epic];
  return {
    key: response.data.key,
    summary: fields.summary || '',
    status: fields.status?.name || null,
    issueType: fields.issuetype?.name || null,
    labels: fields.labels || [],
    // Absent stays null, never '' — an empty description is a legitimate value a
    // caller must be able to tell apart from a field the projection didn't carry.
    description: typeof fields.description === 'string' ? fields.description : null,
    // The custom field holds a bare key string; `parent` holds an issue object.
    epicKey: (typeof epicLink === 'string' ? epicLink : epicLink?.key) || fields.parent?.key || null
  };
}

/**
 * List the child issues of an epic.
 *
 * JIRA has two incompatible epic-link models and no way to know up front which
 * one a project uses: `parent` (team-managed, and the modern Cloud spelling) and
 * the instance's configured epic-link custom field via `cf[...]` (company-managed,
 * classic). A single `OR` query is not an option — a project that lacks either
 * field rejects the WHOLE query with a 400 — so both run separately and their
 * results are unioned by key.
 *
 * Both must run even when the first one succeeds. `parent` is valid JQL on
 * Server/DC as the long-standing sub-task clause, so a company-managed project
 * whose children hang off the Epic Link field answers it with a clean, empty 200
 * rather than a 400. Returning that empty result would report an already-split
 * epic as childless, and the claim flow would re-split it into duplicate slices.
 *
 * A 400 means only "this project does not know that clause" and is tolerated;
 * anything else (401/403/5xx/network) bubbles immediately, because "the lookup
 * failed" must never collapse into "the epic has no children". An empty union
 * after every clause succeeded IS a genuinely childless epic.
 */
export async function getEpicChildren(instanceId, epicKey, { maxResults = 100 } = {}) {
  const instance = await resolveInstance(instanceId);
  const fieldIds = resolveCustomFieldIds(instance);
  const epicFieldNumber = String(fieldIds.epic).replace(/^customfield_/, '');
  const safeKey = escapeJql(epicKey);
  const clauses = [
    `parent = "${safeKey}"`,
    `cf[${epicFieldNumber}] = "${safeKey}"`
  ];

  const byKey = new Map();
  let rejected = 0;
  let lastError = null;

  for (const clause of clauses) {
    const issues = await searchIssues(
      instanceId,
      `${clause} ORDER BY created ASC`,
      { fields: 'summary,status,labels,issuetype,assignee,updated', maxResults }
    ).catch(err => {
      if (err?.status !== 400) throw err;
      rejected += 1;
      lastError = err;
      return null;
    });
    if (issues === null) continue;
    for (const issue of issues) {
      if (!byKey.has(issue.key)) byKey.set(issue.key, issue);
    }
  }

  // Every clause was rejected as bad JQL — that is a failed lookup, not an
  // answer, so it must throw rather than report zero children.
  if (rejected === clauses.length) throw lastError;

  return [...byKey.values()];
}

export default {
  getInstances,
  saveInstances,
  upsertInstance,
  deleteInstance,
  clearCloudAssigneeCache,
  testConnection,
  getProjects,
  getBoards,
  getIssue,
  getEpicChildren,
  getMyself,
  resolveCustomFieldIds,
  clearCurrentUserCache,
  createTicket,
  addIssuesToSprint,
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
