import fs from 'fs/promises';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

const tempRoot = createTempDataRoot('portos-jira-');

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makePathsProxy(actual, { dataRoot: tempRoot });
});
const {
  addIssuesToSprint,
  buildColumnsFromBoardConfig,
  buildColumnsFromStatuses,
  clearCloudAssigneeCache,
  clearCurrentUserCache,
  createJiraClient,
  createTicket,
  deleteInstance,
  fetchMyCurrentSprintTickets,
  getEpicChildren,
  getIssue,
  isCloudInstance,
  jiraAuthHeader,
  resolveCustomFieldIds,
  updateTicket,
  upsertInstance
} = await import('./jira.js');

describe('isCloudInstance', () => {
  it('treats *.atlassian.net hosts as Cloud', () => {
    expect(isCloudInstance('https://example.atlassian.net')).toBe(true);
    expect(isCloudInstance('https://example.atlassian.net/jira/software/c/projects/PROJ')).toBe(true);
    expect(isCloudInstance('https://ATLASSIAN.NET')).toBe(true);
  });

  it('treats Server / Data Center hosts as not Cloud', () => {
    expect(isCloudInstance('https://jira.example.com')).toBe(false);
    expect(isCloudInstance('https://jira.example.com:8443')).toBe(false);
    // Guard against a lookalike host that merely contains the string.
    expect(isCloudInstance('https://atlassian.net.evil.com')).toBe(false);
  });

  it('does not throw on a malformed baseUrl', () => {
    expect(isCloudInstance('not a url')).toBe(false);
    expect(isCloudInstance(undefined)).toBe(false);
  });
});

describe('jiraAuthHeader', () => {
  it('uses Basic base64(email:token) for Cloud instances', () => {
    const header = jiraAuthHeader({ baseUrl: 'https://example.atlassian.net', email: 'me@x.com', apiToken: 'tok' });
    expect(header).toBe(`Basic ${Buffer.from('me@x.com:tok').toString('base64')}`);
  });

  it('uses Bearer PAT for Server / Data Center instances', () => {
    const header = jiraAuthHeader({ baseUrl: 'https://jira.example.com', email: 'me@x.com', apiToken: 'pat' });
    expect(header).toBe('Bearer pat');
  });
});

describe('createJiraClient expired-token detection', () => {
  afterEach(() => {
    // vi.stubGlobal is only reverted by unstubAllGlobals (restoreAllMocks won't
    // touch it unless unstubGlobals is set in vitest config), so the stubbed
    // fetch would otherwise leak into later suites in this file.
    vi.unstubAllGlobals();
  });

  // Helper: stub global fetch with a single response so createHttpClient's request()
  // observes exactly what the given JIRA instance type would return on an expired token.
  const stubFetch = ({ ok, status, contentType, body }) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok,
      status,
      headers: { get: name => (name.toLowerCase() === 'content-type' ? contentType : null) },
      json: async () => body,
      text: async () => body
    }));
  };

  it('maps a Server HTML login page (200 + <!DOCTYPE) to the friendly expiry error', async () => {
    stubFetch({ ok: true, status: 200, contentType: 'text/html', body: '<!DOCTYPE html><html><body>login</body></html>' });
    const client = createJiraClient({ baseUrl: 'https://jira.example.com', apiToken: 'pat' });
    await expect(client.get('/rest/api/2/myself')).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining('token expired or invalid')
    });
  });

  it('maps a Cloud JSON 401 to the same friendly expiry error', async () => {
    stubFetch({
      ok: false,
      status: 401,
      contentType: 'application/json',
      body: { errorMessages: ['Client must be authenticated to access this resource.'], errors: {} }
    });
    const client = createJiraClient({ baseUrl: 'https://example.atlassian.net', email: 'me@x.com', apiToken: 'tok' });
    await expect(client.get('/rest/api/2/myself')).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining('token expired or invalid')
    });
  });

  it('does not trip the HTML heuristic on a Cloud JSON payload that contains "<!DOCTYPE"', async () => {
    // A Cloud instance returns JSON; even if a field value contained the marker string,
    // the heuristic is gated off for Cloud so a valid response passes through untouched.
    stubFetch({ ok: true, status: 200, contentType: 'application/json', body: { note: '<!DOCTYPE lives in this field' } });
    const client = createJiraClient({ baseUrl: 'https://example.atlassian.net', email: 'me@x.com', apiToken: 'tok' });
    const res = await client.get('/rest/api/2/myself');
    expect(res.data).toEqual({ note: '<!DOCTYPE lives in this field' });
  });

  it('lets non-401 errors bubble unchanged', async () => {
    stubFetch({ ok: false, status: 500, contentType: 'application/json', body: { errorMessages: ['boom'] } });
    const client = createJiraClient({ baseUrl: 'https://jira.example.com', apiToken: 'pat' });
    await expect(client.get('/rest/api/2/myself')).rejects.toMatchObject({ status: 500 });
  });
});

describe('createJiraClient search endpoint routing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubFetchOk = (body) => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: name => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => body
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  it('routes a Cloud instance to /rest/api/2/search/jql', async () => {
    const fetchMock = stubFetchOk({ issues: [] });
    const client = createJiraClient({ baseUrl: 'https://example.atlassian.net', email: 'me@x.com', apiToken: 'tok' });
    await client.search({ jql: 'assignee = currentUser()', maxResults: 1 });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/rest/api/2/search/jql');
  });

  it('keeps a Server/DC instance on the classic /rest/api/2/search — Atlassian only sunset it on Cloud, and an older DC version may not serve /search/jql at all', async () => {
    const fetchMock = stubFetchOk({ issues: [] });
    const client = createJiraClient({ baseUrl: 'https://jira.example.com', apiToken: 'pat' });
    await client.search({ jql: 'assignee = currentUser()', maxResults: 1 });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/rest/api/2/search?');
    expect(url).not.toContain('/search/jql');
  });
});

describe('createTicket assignee resolution', () => {
  const INSTANCE_ID = 'jira-example';

  const stubInstance = (instance = {}) => {
    stubInstances({
      [INSTANCE_ID]: {
        id: INSTANCE_ID,
        name: 'Example JIRA',
        baseUrl: 'https://jira.example.com',
        apiToken: 'pat',
        ...instance
      }
    });
  };

  const stubInstances = (instances) => {
    vi.spyOn(fs, 'readFile').mockResolvedValue(JSON.stringify({
      instances
    }));
  };

  const stubFetchSequence = (responses) => {
    const fetchMock = vi.fn();
    for (const response of responses) {
      fetchMock.mockResolvedValueOnce({
        ok: response.ok !== false,
        status: response.status || 200,
        headers: { get: name => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
        json: async () => response.body,
        text: async () => JSON.stringify(response.body)
      });
    }
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearCloudAssigneeCache();
  });

  it('resolves a Cloud email to accountId and caches it for later tickets', async () => {
    stubInstance({ baseUrl: 'https://example.atlassian.net', email: 'me@example.com', apiToken: 'token' });
    const fetchMock = stubFetchSequence([
      { body: [{ accountId: 'acct-123', emailAddress: 'assignee@example.com' }] },
      { body: { key: 'PROJ-1' } },
      { body: { key: 'PROJ-2' } }
    ]);

    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'First', assignee: 'assignee@example.com' });
    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Second', assignee: 'assignee@example.com' });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const searchUrl = new URL(fetchMock.mock.calls[0][0]);
    expect(searchUrl.pathname).toBe('/rest/api/2/user/search');
    expect(searchUrl.searchParams.get('query')).toBe('assignee@example.com');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).fields.assignee).toEqual({ accountId: 'acct-123' });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).fields.assignee).toEqual({ accountId: 'acct-123' });
  });

  it('resolves a Cloud display name to accountId', async () => {
    stubInstance({ baseUrl: 'https://example.atlassian.net', email: 'me@example.com', apiToken: 'token' });
    const fetchMock = stubFetchSequence([
      { body: [{ accountId: 'acct-456', displayName: 'Example Assignee' }] },
      { body: { key: 'PROJ-3' } }
    ]);

    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Display name', assignee: 'Example Assignee' });

    expect(JSON.parse(fetchMock.mock.calls[1][1].body).fields.assignee).toEqual({ accountId: 'acct-456' });
  });

  it('resolves a privacy-redacted Cloud email result when it is unique', async () => {
    stubInstance({ baseUrl: 'https://example.atlassian.net', email: 'me@example.com', apiToken: 'token' });
    const fetchMock = stubFetchSequence([
      { body: [{ accountId: 'acct-567' }] },
      { body: { key: 'PROJ-8' } }
    ]);

    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Redacted email', assignee: 'private@example.com' });

    expect(JSON.parse(fetchMock.mock.calls[1][1].body).fields.assignee).toEqual({ accountId: 'acct-567' });
  });

  it('keeps Server/DC assignees as name without a user-search request', async () => {
    stubInstance();
    const fetchMock = stubFetchSequence([{ body: { key: 'PROJ-4' } }]);

    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Server ticket', assignee: 'jdoe' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).fields.assignee).toEqual({ name: 'jdoe' });
  });

  it('creates unassigned Cloud tickets and retries an unresolvable assignee', async () => {
    stubInstance({ baseUrl: 'https://example.atlassian.net', email: 'me@example.com', apiToken: 'token' });
    const fetchMock = stubFetchSequence([
      { body: [] },
      { body: { key: 'PROJ-5' } },
      { body: [] },
      { body: { key: 'PROJ-6' } }
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Unassigned', assignee: 'missing@example.com' });
    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Still unassigned', assignee: 'missing@example.com' });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).fields).not.toHaveProperty('assignee');
    expect(JSON.parse(fetchMock.mock.calls[3][1].body).fields).not.toHaveProperty('assignee');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be resolved'));
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('does not assign a Cloud ticket when the search result is ambiguous', async () => {
    stubInstance({ baseUrl: 'https://example.atlassian.net', email: 'me@example.com', apiToken: 'token' });
    const fetchMock = stubFetchSequence([
      { body: [
        { accountId: 'acct-789', displayName: 'Example User' },
        { accountId: 'acct-987', displayName: 'Example User' }
      ] },
      { body: { key: 'PROJ-7' } }
    ]);

    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Ambiguous', assignee: 'Example User' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).fields).not.toHaveProperty('assignee');
  });

  it('does not use the privacy fallback across multiple returned candidates', async () => {
    stubInstance({ baseUrl: 'https://example.atlassian.net', email: 'me@example.com', apiToken: 'token' });
    const fetchMock = stubFetchSequence([
      { body: [
        { accountId: 'acct-789' },
        { accountId: 'acct-987', displayName: 'Other User' }
      ] },
      { body: { key: 'PROJ-9' } }
    ]);

    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Mixed candidates', assignee: 'private@example.com' });

    expect(JSON.parse(fetchMock.mock.calls[1][1].body).fields).not.toHaveProperty('assignee');
  });

  it('creates unassigned tickets for malformed Cloud search responses and retries', async () => {
    stubInstance({ baseUrl: 'https://example.atlassian.net', email: 'me@example.com', apiToken: 'token' });
    const fetchMock = stubFetchSequence([
      { body: { users: [] } },
      { body: { key: 'PROJ-10' } },
      { body: [{ accountId: 'acct-999', emailAddress: 'retry@example.com' }] },
      { body: { key: 'PROJ-11' } }
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Malformed response', assignee: 'retry@example.com' });
    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Retry response', assignee: 'retry@example.com' });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).fields).not.toHaveProperty('assignee');
    expect(JSON.parse(fetchMock.mock.calls[3][1].body).fields.assignee).toEqual({ accountId: 'acct-999' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('lookup failed'));
  });

  it('creates unassigned tickets when Cloud user search fails and retries', async () => {
    stubInstance({ baseUrl: 'https://example.atlassian.net', email: 'me@example.com', apiToken: 'token' });
    const fetchMock = stubFetchSequence([
      { ok: false, status: 503, body: { errorMessages: ['temporary failure'] } },
      { body: { key: 'PROJ-12' } },
      { body: [{ accountId: 'acct-1000', emailAddress: 'retry@example.com' }] },
      { body: { key: 'PROJ-13' } }
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Failed lookup', assignee: 'retry@example.com' });
    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Retry failed lookup', assignee: 'retry@example.com' });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).fields).not.toHaveProperty('assignee');
    expect(JSON.parse(fetchMock.mock.calls[3][1].body).fields.assignee).toEqual({ accountId: 'acct-1000' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('lookup failed'));
  });

  it('normalizes the Cloud cache key for case-only assignee changes', async () => {
    stubInstance({ baseUrl: 'https://example.atlassian.net', email: 'me@example.com', apiToken: 'token' });
    const fetchMock = stubFetchSequence([
      { body: [{ accountId: 'acct-case', emailAddress: 'assignee@example.com' }] },
      { body: { key: 'PROJ-14' } },
      { body: { key: 'PROJ-15' } }
    ]);

    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Lowercase', assignee: 'assignee@example.com' });
    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Uppercase', assignee: 'ASSIGNEE@EXAMPLE.COM' });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).fields.assignee).toEqual({ accountId: 'acct-case' });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).fields.assignee).toEqual({ accountId: 'acct-case' });
  });

  it('ignores inactive and app accounts when resolving a Cloud assignee', async () => {
    stubInstance({ baseUrl: 'https://example.atlassian.net', email: 'me@example.com', apiToken: 'token' });
    const fetchMock = stubFetchSequence([
      { body: [
        { accountId: 'acct-inactive', emailAddress: 'assignee@example.com', active: false },
        { accountId: 'acct-app', emailAddress: 'assignee@example.com', accountType: 'app' }
      ] },
      { body: { key: 'PROJ-16' } }
    ]);

    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Inactive', assignee: 'assignee@example.com' });

    expect(JSON.parse(fetchMock.mock.calls[1][1].body).fields).not.toHaveProperty('assignee');
  });

  it('does not use a filtered candidate as the privacy fallback', async () => {
    stubInstance({ baseUrl: 'https://example.atlassian.net', email: 'me@example.com', apiToken: 'token' });
    const fetchMock = stubFetchSequence([
      { body: [
        { accountId: 'acct-inactive', displayName: 'Jane', active: false },
        { accountId: 'acct-janet', displayName: 'Janet Roe' }
      ] },
      { body: { key: 'PROJ-18' } }
    ]);

    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Filtered candidate', assignee: 'Jane' });

    expect(JSON.parse(fetchMock.mock.calls[1][1].body).fields).not.toHaveProperty('assignee');
  });

  it('omits whitespace-only assignees without a Cloud lookup', async () => {
    stubInstance({ baseUrl: 'https://example.atlassian.net', email: 'me@example.com', apiToken: 'token' });
    const fetchMock = stubFetchSequence([{ body: { key: 'PROJ-17' } }]);

    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Blank assignee', assignee: '   ' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).fields).not.toHaveProperty('assignee');
  });

  it('isolates assignee caches per Jira instance', async () => {
    stubInstances({
      'jira-one': { id: 'jira-one', baseUrl: 'https://one.atlassian.net', email: 'one@example.com', apiToken: 'token' },
      'jira-two': { id: 'jira-two', baseUrl: 'https://two.atlassian.net', email: 'two@example.com', apiToken: 'token' }
    });
    const fetchMock = stubFetchSequence([
      { body: [{ accountId: 'acct-one', emailAddress: 'assignee@example.com' }] },
      { body: { key: 'ONE-1' } },
      { body: [{ accountId: 'acct-two', emailAddress: 'assignee@example.com' }] },
      { body: { key: 'TWO-1' } }
    ]);

    await createTicket('jira-one', { projectKey: 'ONE', summary: 'One', assignee: 'assignee@example.com' });
    await createTicket('jira-two', { projectKey: 'TWO', summary: 'Two', assignee: 'assignee@example.com' });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).fields.assignee).toEqual({ accountId: 'acct-one' });
    expect(JSON.parse(fetchMock.mock.calls[3][1].body).fields.assignee).toEqual({ accountId: 'acct-two' });
  });

  it('coalesces concurrent lookups and invalidates them on instance changes', async () => {
    stubInstance({ baseUrl: 'https://example.atlassian.net', email: 'me@example.com', apiToken: 'token' });
    const fetchMock = stubFetchSequence([
      { body: [{ accountId: 'acct-first', emailAddress: 'concurrent@example.com' }] },
      { body: { key: 'PROJ-11' } },
      { body: { key: 'PROJ-12' } },
      { body: [{ accountId: 'acct-updated', emailAddress: 'concurrent@example.com' }] },
      { body: { key: 'PROJ-13' } },
      { body: [{ accountId: 'acct-deleted', emailAddress: 'concurrent@example.com' }] },
      { body: { key: 'PROJ-14' } }
    ]);
    vi.spyOn(fs, 'writeFile').mockResolvedValue();

    await Promise.all([
      createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Concurrent one', assignee: 'concurrent@example.com' }),
      createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Concurrent two', assignee: 'concurrent@example.com' })
    ]);
    await upsertInstance(INSTANCE_ID, {
      name: 'Example JIRA',
      baseUrl: 'https://example.atlassian.net',
      email: 'me@example.com',
      apiToken: 'new-token'
    });
    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Updated', assignee: 'concurrent@example.com' });
    await deleteInstance(INSTANCE_ID);
    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Deleted', assignee: 'concurrent@example.com' });

    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).fields.assignee).toEqual({ accountId: 'acct-first' });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).fields.assignee).toEqual({ accountId: 'acct-first' });
    expect(JSON.parse(fetchMock.mock.calls[4][1].body).fields.assignee).toEqual({ accountId: 'acct-updated' });
    expect(JSON.parse(fetchMock.mock.calls[6][1].body).fields.assignee).toEqual({ accountId: 'acct-deleted' });
  });
});

describe('buildColumnsFromBoardConfig', () => {
  const statusById = new Map([
    ['1', { name: 'To Do', category: 'To Do' }],
    ['2', { name: 'In Progress', category: 'In Progress' }],
    ['3', { name: 'Blocked', category: 'In Progress' }],
    ['4', { name: 'In Review', category: 'In Progress' }],
    ['5', { name: 'Done', category: 'Done' }]
  ]);

  it('maps board status ids to names and preserves board column order', () => {
    const boardColumns = [
      { name: 'To Do', statuses: [{ id: '1' }] },
      { name: 'In Progress', statuses: [{ id: 2 }] },
      { name: 'Blocked', statuses: [{ id: '3' }] },
      { name: 'In Review', statuses: [{ id: '4' }] },
      { name: 'Done', statuses: [{ id: '5' }] }
    ];
    const result = buildColumnsFromBoardConfig(boardColumns, statusById);
    expect(result.map(c => c.name)).toEqual(['To Do', 'In Progress', 'Blocked', 'In Review', 'Done']);
    expect(result.find(c => c.name === 'Blocked')).toEqual({
      name: 'Blocked',
      category: 'In Progress',
      statuses: ['Blocked']
    });
  });

  it('tolerates numeric and string status ids', () => {
    const result = buildColumnsFromBoardConfig([{ name: 'Go', statuses: [{ id: 2 }, { id: '4' }] }], statusById);
    expect(result[0].statuses).toEqual(['In Progress', 'In Review']);
  });

  it('drops columns that map to no known status (e.g. empty backlog column)', () => {
    const boardColumns = [
      { name: 'Backlog', statuses: [] },
      { name: 'Unknown', statuses: [{ id: '999' }] },
      { name: 'Done', statuses: [{ id: '5' }] }
    ];
    const result = buildColumnsFromBoardConfig(boardColumns, statusById);
    expect(result.map(c => c.name)).toEqual(['Done']);
  });

  it('derives the column category from its first mapped status', () => {
    const result = buildColumnsFromBoardConfig([{ name: 'WIP', statuses: [{ id: '3' }, { id: '5' }] }], statusById);
    expect(result[0].category).toBe('In Progress');
  });

  it('returns [] for empty/missing input', () => {
    expect(buildColumnsFromBoardConfig([], statusById)).toEqual([]);
    expect(buildColumnsFromBoardConfig(undefined, statusById)).toEqual([]);
  });
});

describe('buildColumnsFromStatuses', () => {
  it('produces one single-status column per status, ordered by category', () => {
    const statusOrder = [
      { name: 'In Review', category: 'In Progress' },
      { name: 'Done', category: 'Done' },
      { name: 'To Do', category: 'To Do' },
      { name: 'Blocked', category: 'In Progress' }
    ];
    const result = buildColumnsFromStatuses(statusOrder);
    expect(result.map(c => c.name)).toEqual(['To Do', 'In Review', 'Blocked', 'Done']);
    expect(result[1]).toEqual({ name: 'In Review', category: 'In Progress', statuses: ['In Review'] });
  });

  it('keeps discovery order stable within a category', () => {
    const statusOrder = [
      { name: 'Blocked', category: 'In Progress' },
      { name: 'In Progress', category: 'In Progress' },
      { name: 'In Review', category: 'In Progress' }
    ];
    expect(buildColumnsFromStatuses(statusOrder).map(c => c.name)).toEqual(['Blocked', 'In Progress', 'In Review']);
  });

  it('treats unknown categories as In Progress for ordering', () => {
    const statusOrder = [
      { name: 'Mystery', category: 'Weird' },
      { name: 'To Do', category: 'To Do' },
      { name: 'Done', category: 'Done' }
    ];
    expect(buildColumnsFromStatuses(statusOrder).map(c => c.name)).toEqual(['To Do', 'Mystery', 'Done']);
  });

  it('returns [] for empty/missing input', () => {
    expect(buildColumnsFromStatuses([])).toEqual([]);
    expect(buildColumnsFromStatuses(undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// #5042 — the reads the JIRA claim flow needs to decompose an epic. Before this,
// `getIssue` projected only summary/status/issuetype and `fetchMyCurrentSprintTickets`
// omitted labels entirely, so an agent could see no `decomposed` marker, could not
// read a parent's description back, and could not find an epic's children.
// ---------------------------------------------------------------------------

describe('resolveCustomFieldIds', () => {
  it('falls back to the stock JIRA field ids when the instance configures none', () => {
    expect(resolveCustomFieldIds({})).toEqual({
      storyPoints: 'customfield_10106',
      epic: 'customfield_10101'
    });
    expect(resolveCustomFieldIds(undefined).epic).toBe('customfield_10101');
  });

  it('honors per-instance overrides', () => {
    const ids = resolveCustomFieldIds({ customFields: { epic: 'customfield_20001', storyPoints: 'customfield_20002' } });
    expect(ids.epic).toBe('customfield_20001');
    expect(ids.storyPoints).toBe('customfield_20002');
    // Sprint membership goes through the Agile API, so there is no sprint field id
    // to configure — a stray `customFields.sprint` must not reappear as dead config.
    expect(ids).not.toHaveProperty('sprint');
  });
});

describe('epic-decomposition reads (#5042)', () => {
  const INSTANCE_ID = 'inst-1';
  const BASE_URL = 'https://jira.example.com';

  // The service reads its instance config off disk; stub that one read rather
  // than the whole fs module so every other helper keeps its real behavior.
  const stubInstance = (instance = {}) => {
    vi.spyOn(fs, 'readFile').mockResolvedValue(JSON.stringify({
      instances: { [INSTANCE_ID]: { id: INSTANCE_ID, name: 'Example', baseUrl: BASE_URL, apiToken: 'pat', ...instance } }
    }));
  };

  // Queue one response per fetch call, in order, so a multi-request helper
  // (create → sprint, or the epic-children fallback chain) can be driven exactly.
  const stubFetchSequence = (responses) => {
    const fetchMock = vi.fn();
    for (const r of responses) {
      fetchMock.mockResolvedValueOnce({
        ok: r.ok !== false,
        status: r.status || 200,
        headers: { get: name => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
        json: async () => r.body,
        text: async () => JSON.stringify(r.body)
      });
    }
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    // The resolved-account memo is module state — a leak here would make a later
    // test's `/myself` assertion pass or fail on test ORDER, not on behavior.
    clearCurrentUserCache();
  });

  describe('getIssue', () => {
    it('requests labels, description, and the configured epic-link field', async () => {
      stubInstance({ customFields: { epic: 'customfield_20001' } });
      const fetchMock = stubFetchSequence([{ body: { key: 'PROJ-1', fields: {} } }]);

      await getIssue(INSTANCE_ID, 'PROJ-1');

      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain('fields=');
      const fields = decodeURIComponent(new URL(url).searchParams.get('fields'));
      expect(fields.split(',')).toEqual(
        expect.arrayContaining(['summary', 'status', 'issuetype', 'labels', 'description', 'parent', 'customfield_20001'])
      );
    });

    it('returns the labels and description a decomposition marker/checklist lives in', async () => {
      stubInstance();
      stubFetchSequence([{
        body: {
          key: 'PROJ-1',
          fields: {
            summary: 'Example epic',
            status: { name: 'To Do' },
            issuetype: { name: 'Epic' },
            labels: ['decomposed', 'plan'],
            description: 'body\n\n## Decomposed into\n\n- [ ] PROJ-2'
          }
        }
      }]);

      const issue = await getIssue(INSTANCE_ID, 'PROJ-1');
      expect(issue.labels).toEqual(['decomposed', 'plan']);
      expect(issue.description).toContain('## Decomposed into');
      expect(issue.issueType).toBe('Epic');
    });

    it('keeps an absent description null and an empty one empty — the two are different answers', async () => {
      stubInstance();
      stubFetchSequence([
        { body: { key: 'PROJ-1', fields: { summary: 'a' } } },
        { body: { key: 'PROJ-2', fields: { summary: 'b', description: '' } } }
      ]);

      expect((await getIssue(INSTANCE_ID, 'PROJ-1')).description).toBeNull();
      expect((await getIssue(INSTANCE_ID, 'PROJ-2')).description).toBe('');
    });

    it('resolves the epic link from the custom field (company-managed projects)', async () => {
      stubInstance();
      stubFetchSequence([{ body: { key: 'PROJ-2', fields: { summary: 'child', customfield_10101: 'PROJ-1' } } }]);
      expect((await getIssue(INSTANCE_ID, 'PROJ-2')).epicKey).toBe('PROJ-1');
    });

    it('falls back to `parent` when the custom field is empty (team-managed projects)', async () => {
      stubInstance();
      stubFetchSequence([{ body: { key: 'PROJ-2', fields: { summary: 'child', parent: { key: 'PROJ-1' } } } }]);
      expect((await getIssue(INSTANCE_ID, 'PROJ-2')).epicKey).toBe('PROJ-1');
    });

    it('reports no epic link as null rather than undefined', async () => {
      stubInstance();
      stubFetchSequence([{ body: { key: 'PROJ-3', fields: { summary: 'orphan' } } }]);
      expect((await getIssue(INSTANCE_ID, 'PROJ-3')).epicKey).toBeNull();
    });
  });

  describe('fetchMyCurrentSprintTickets', () => {
    it('asks for labels and returns them per ticket', async () => {
      stubInstance();
      const fetchMock = stubFetchSequence([{
        body: {
          issues: [{
            key: 'PROJ-9',
            fields: {
              summary: 'Slice one',
              status: { name: 'To Do', statusCategory: { name: 'To Do' } },
              labels: ['plan'],
              customfield_10106: 3
            }
          }]
        }
      }]);

      const tickets = await fetchMyCurrentSprintTickets(INSTANCE_ID, 'PROJ');

      const [url] = fetchMock.mock.calls[0];
      expect(decodeURIComponent(url)).toContain('labels');
      expect(tickets[0].labels).toEqual(['plan']);
      expect(tickets[0].storyPoints).toBe(3);
    });

    it('reads story points from the instance-configured field, not a hardcoded id', async () => {
      stubInstance({ customFields: { storyPoints: 'customfield_20002' } });
      stubFetchSequence([{
        body: {
          issues: [{
            key: 'PROJ-9',
            fields: {
              summary: 'Slice one',
              status: { name: 'To Do', statusCategory: { name: 'To Do' } },
              customfield_20002: 5
            }
          }]
        }
      }]);

      const tickets = await fetchMyCurrentSprintTickets(INSTANCE_ID, 'PROJ');
      expect(tickets[0].storyPoints).toBe(5);
      // A ticket with no labels reads as an empty list, never undefined.
      expect(tickets[0].labels).toEqual([]);
    });
  });

  describe('getEpicChildren', () => {
    it('unions BOTH epic-link spellings — `parent` is valid-but-empty on a company-managed project, not a 400', async () => {
      // The regression this pins: on Jira Server/DC, `parent` is the long-standing
      // SUB-TASK clause, so a company-managed project whose children hang off the
      // Epic Link field answers it 200-with-zero-rows. Returning that would report
      // an already-split epic as childless and the claim flow would re-split it.
      stubInstance({ customFields: { epic: 'customfield_20001' } });
      const fetchMock = stubFetchSequence([
        { body: { issues: [] } },
        { body: { issues: [{ key: 'PROJ-2', fields: { summary: 'slice', status: { name: 'To Do' } } }] } }
      ]);

      const children = await getEpicChildren(INSTANCE_ID, 'PROJ-1');
      expect(children.map(c => c.key)).toEqual(['PROJ-2']);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('jql')).toContain('parent = "PROJ-1"');
      expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get('jql')).toContain('cf[20001] = "PROJ-1"');
    });

    it('de-duplicates a child that both spellings return', async () => {
      stubInstance();
      const child = { key: 'PROJ-2', fields: { summary: 'slice', status: { name: 'To Do' } } };
      stubFetchSequence([
        { body: { issues: [child] } },
        { body: { issues: [child, { key: 'PROJ-3', fields: { summary: 'other', status: { name: 'To Do' } } }] } }
      ]);

      const children = await getEpicChildren(INSTANCE_ID, 'PROJ-1');
      expect(children.map(c => c.key)).toEqual(['PROJ-2', 'PROJ-3']);
    });

    it('still answers when one spelling is rejected as bad JQL (HTTP 400)', async () => {
      stubInstance({ customFields: { epic: 'customfield_20001' } });
      const fetchMock = stubFetchSequence([
        { ok: false, status: 400, body: { errorMessages: ["Field 'parent' does not exist"] } },
        { body: { issues: [{ key: 'PROJ-2', fields: { summary: 'slice', status: { name: 'To Do' } } }] } }
      ]);

      const children = await getEpicChildren(INSTANCE_ID, 'PROJ-1');
      expect(children.map(c => c.key)).toEqual(['PROJ-2']);
      expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get('jql')).toContain('cf[20001] = "PROJ-1"');
    });

    it('throws when every spelling is rejected — a failed lookup must never read as "no children"', async () => {
      stubInstance();
      stubFetchSequence([
        { ok: false, status: 400, body: { errorMessages: ['bad'] } },
        { ok: false, status: 400, body: { errorMessages: ['bad'] } }
      ]);

      await expect(getEpicChildren(INSTANCE_ID, 'PROJ-1')).rejects.toThrow();
    });

    it('reports a genuinely childless epic as an empty list — but only after BOTH spellings answered', async () => {
      stubInstance();
      const fetchMock = stubFetchSequence([{ body: { issues: [] } }, { body: { issues: [] } }]);
      await expect(getEpicChildren(INSTANCE_ID, 'PROJ-1')).resolves.toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('createTicket', () => {
    it('sprints a new ticket through the Agile API and reports success', async () => {
      stubInstance();
      const fetchMock = stubFetchSequence([
        { body: { key: 'PROJ-5' } },
        { body: {} }
      ]);

      const result = await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Slice', sprintId: 42 });

      expect(result.ticketId).toBe('PROJ-5');
      expect(result.sprint).toEqual({ id: 42, assigned: true, error: null });
      const [sprintUrl, sprintInit] = fetchMock.mock.calls[1];
      expect(sprintUrl).toContain('/rest/agile/1.0/sprint/42/issue');
      expect(JSON.parse(sprintInit.body)).toEqual({ issues: ['PROJ-5'] });
    });

    it('reports a failed sprint move instead of throwing — the ticket exists and its key must survive', async () => {
      stubInstance();
      stubFetchSequence([
        { body: { key: 'PROJ-5' } },
        { ok: false, status: 400, body: { errorMessages: ['Sprint field cannot be set'] } }
      ]);

      const result = await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Slice', sprintId: 42 });
      expect(result.ticketId).toBe('PROJ-5');
      expect(result.sprint.assigned).toBe(false);
      expect(result.sprint.error).toBeTruthy();
    });

    it('leaves `sprint` null when no sprint was requested', async () => {
      stubInstance();
      const fetchMock = stubFetchSequence([{ body: { key: 'PROJ-5' } }]);
      const result = await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Slice' });
      expect(result.sprint).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('resolves the `currentUser` assignee sentinel to accountId on Cloud', async () => {
      stubInstance({ baseUrl: 'https://example.atlassian.net', email: 'me@example.com', apiToken: 'tok' });
      const fetchMock = stubFetchSequence([
        { body: { accountId: 'acct-123', name: 'legacy-name' } },
        { body: { key: 'PROJ-5' } }
      ]);

      await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Slice', assignee: 'currentUser' });

      expect(fetchMock.mock.calls[0][0]).toContain('/rest/api/2/myself');
      expect(JSON.parse(fetchMock.mock.calls[1][1].body).fields.assignee).toEqual({ accountId: 'acct-123' });
    });

    it('resolves the `currentUser` assignee sentinel to name on Server/DC', async () => {
      stubInstance();
      const fetchMock = stubFetchSequence([
        { body: { accountId: null, name: 'jdoe' } },
        { body: { key: 'PROJ-5' } }
      ]);

      await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Slice', assignee: 'currentuser' });
      expect(JSON.parse(fetchMock.mock.calls[1][1].body).fields.assignee).toEqual({ name: 'jdoe' });
    });

    // A literal is passed through as `{ name }` on BOTH instance types — the shape
    // every pre-existing caller sends. Only the `currentUser` sentinel resolves.
    it('passes a literal assignee through without a myself lookup', async () => {
      stubInstance();
      const fetchMock = stubFetchSequence([{ body: { key: 'PROJ-5' } }]);
      await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Slice', assignee: 'jdoe' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).fields.assignee).toEqual({ name: 'jdoe' });
    });

    it('writes the epic link to the instance-configured field', async () => {
      stubInstance({ customFields: { epic: 'customfield_20001' } });
      const fetchMock = stubFetchSequence([{ body: { key: 'PROJ-5' } }]);
      await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Slice', epicKey: 'PROJ-1' });
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).fields.customfield_20001).toBe('PROJ-1');
    });
  });

  describe('addIssuesToSprint', () => {
    it('is a no-op that issues no request for an empty key list', async () => {
      stubInstance();
      const fetchMock = stubFetchSequence([]);
      await expect(addIssuesToSprint(INSTANCE_ID, 42, [])).resolves.toEqual({ success: true, sprintId: 42, issueKeys: [] });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('posts the keys it was given to the Agile sprint endpoint', async () => {
      stubInstance();
      const fetchMock = stubFetchSequence([{ body: {} }]);
      await addIssuesToSprint(INSTANCE_ID, 42, ['PROJ-5', 'PROJ-6']);
      expect(fetchMock.mock.calls[0][0]).toContain('/rest/agile/1.0/sprint/42/issue');
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ issues: ['PROJ-5', 'PROJ-6'] });
    });
  });
});

// The reviews that shaped the #5042 diff surfaced three failure modes the
// implementation now guards; each of these pins one so it cannot regress.
describe('epic-decomposition hardening (#5042)', () => {
  const INSTANCE_ID = 'inst-1';
  const BASE_URL = 'https://jira.example.com';

  const stubInstance = (instance = {}) => {
    vi.spyOn(fs, 'readFile').mockResolvedValue(JSON.stringify({
      instances: { [INSTANCE_ID]: { id: INSTANCE_ID, name: 'Example', baseUrl: BASE_URL, apiToken: 'pat', ...instance } }
    }));
  };

  const stubFetchSequence = (responses) => {
    const fetchMock = vi.fn();
    for (const r of responses) {
      fetchMock.mockResolvedValueOnce({
        ok: r.ok !== false,
        status: r.status || 200,
        headers: { get: name => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
        json: async () => r.body,
        text: async () => JSON.stringify(r.body)
      });
    }
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearCurrentUserCache();
  });

  it('resolves the current user ONCE per instance — decomposition files slices in a loop', async () => {
    stubInstance();
    const fetchMock = stubFetchSequence([
      { body: { name: 'jdoe' } },
      { body: { key: 'PROJ-2' } },
      { body: { key: 'PROJ-3' } },
      { body: { key: 'PROJ-4' } }
    ]);

    for (const summary of ['Slice one', 'Slice two', 'Slice three']) {
      await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary, assignee: 'currentUser' });
    }

    const myselfCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/myself'));
    expect(myselfCalls).toHaveLength(1);
    // Every create still carries the resolved assignee, not just the first.
    for (const [, init] of fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/rest/api/2/issue'))) {
      expect(JSON.parse(init.body).fields.assignee).toEqual({ name: 'jdoe' });
    }
  });

  it('re-resolves the current user after a credential change — a new token can be a new account', async () => {
    stubInstance();
    const fetchMock = stubFetchSequence([
      { body: { name: 'jdoe' } },
      { body: { key: 'PROJ-2' } },
      { body: { name: 'other' } },
      { body: { key: 'PROJ-3' } }
    ]);

    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'a', assignee: 'currentUser' });
    clearCurrentUserCache(INSTANCE_ID);
    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'b', assignee: 'currentUser' });

    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/myself'))).toHaveLength(2);
    const creates = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/rest/api/2/issue'));
    expect(JSON.parse(creates[1][1].body).fields.assignee).toEqual({ name: 'other' });
  });

  it('getEpicChildren does NOT retry a non-400 failure — an auth error would fail identically for every clause', async () => {
    stubInstance();
    const fetchMock = stubFetchSequence([
      { ok: false, status: 500, body: { errorMessages: ['upstream is down'] } }
    ]);

    await expect(getEpicChildren(INSTANCE_ID, 'PROJ-1')).rejects.toMatchObject({ status: 500 });
    // Exactly one attempt: retrying the other spelling would report ITS error, not this one.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('updateTicket translates the domain keys instead of writing them verbatim', async () => {
    stubInstance({ customFields: { epic: 'customfield_20001', storyPoints: 'customfield_20002' } });
    const fetchMock = stubFetchSequence([{ body: {} }]);

    await updateTicket(INSTANCE_ID, 'PROJ-1', {
      summary: 'New summary',
      epicKey: 'PROJ-9',
      storyPoints: 5,
      assignee: 'jdoe',
      description: 'raw JIRA field, passed through'
    });

    const { fields } = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(fields.customfield_20001).toBe('PROJ-9');
    expect(fields.customfield_20002).toBe(5);
    expect(fields.assignee).toEqual({ name: 'jdoe' });
    expect(fields.summary).toBe('New summary');
    expect(fields.description).toBe('raw JIRA field, passed through');
    // The domain spellings are NOT sent — JIRA has no such fields, and a PUT
    // carrying them wrote nothing while reporting success.
    expect(fields).not.toHaveProperty('epicKey');
    expect(fields).not.toHaveProperty('storyPoints');
  });

  it('updateTicket writes issueType — a type change IS valid on an existing issue', async () => {
    stubInstance();
    const fetchMock = stubFetchSequence([{ body: {} }]);

    await updateTicket(INSTANCE_ID, 'PROJ-1', { issueType: 'Epic' });

    const { fields } = JSON.parse(fetchMock.mock.calls[0][1].body);
    // Phase 3 promotes an oversized ticket by PUTting this — dropping it would
    // answer 200 while the ticket stayed a Task, and the split would never converge.
    expect(fields.issuetype).toEqual({ name: 'Epic' });
  });

  it('updateTicket clears labels on an explicit empty array, and leaves them alone when absent', async () => {
    stubInstance();
    const fetchMock = stubFetchSequence([{ body: {} }, { body: {} }]);

    await updateTicket(INSTANCE_ID, 'PROJ-1', { labels: [] });
    await updateTicket(INSTANCE_ID, 'PROJ-1', { summary: 'only a rename' });

    //  is an intentional clear; an absent key must not touch them.
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).fields.labels).toEqual([]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).fields).not.toHaveProperty('labels');
  });
});

// The epic link has two mutually exclusive spellings and a project rejects the
// one it does not use. `getEpicChildren` reads both; these pin that a CREATE
// writes both, because a child filed without a working link is invisible to the
// next run's child lookup and its slice of the decomposition is stranded.
describe('epic-link write compatibility (#5042)', () => {
  const INSTANCE_ID = 'inst-1';
  const BASE_URL = 'https://jira.example.com';

  const stubInstance = (instance = {}) => {
    vi.spyOn(fs, 'readFile').mockResolvedValue(JSON.stringify({
      instances: { [INSTANCE_ID]: { id: INSTANCE_ID, name: 'Example', baseUrl: BASE_URL, apiToken: 'pat', ...instance } }
    }));
  };

  const stubFetchSequence = (responses) => {
    const fetchMock = vi.fn();
    for (const r of responses) {
      fetchMock.mockResolvedValueOnce({
        ok: r.ok !== false,
        status: r.status || 200,
        headers: { get: name => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
        json: async () => r.body,
        text: async () => JSON.stringify(r.body)
      });
    }
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearCurrentUserCache();
  });

  it('retries with the native `parent` field when a project rejects the epic-link custom field', async () => {
    stubInstance({ customFields: { epic: 'customfield_20001' } });
    const fetchMock = stubFetchSequence([
      { ok: false, status: 400, body: { errorMessages: ["Field 'customfield_20001' cannot be set"] } },
      { body: { key: 'PROJ-5' } }
    ]);

    const result = await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Slice', epicKey: 'PROJ-1' });

    expect(result.ticketId).toBe('PROJ-5');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).fields.customfield_20001).toBe('PROJ-1');
    const retried = JSON.parse(fetchMock.mock.calls[1][1].body).fields;
    expect(retried.parent).toEqual({ key: 'PROJ-1' });
    expect(retried).not.toHaveProperty('customfield_20001');
  });

  it('does NOT retry a 400 on a create that carries no epic link — the retry could not change anything', async () => {
    stubInstance();
    const fetchMock = stubFetchSequence([
      { ok: false, status: 400, body: { errorMessages: ['summary is required'] } }
    ]);

    await expect(createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Slice' })).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a non-400 failure', async () => {
    stubInstance();
    const fetchMock = stubFetchSequence([
      { ok: false, status: 500, body: { errorMessages: ['upstream is down'] } }
    ]);

    await expect(createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Slice', epicKey: 'PROJ-1' })).rejects.toMatchObject({ status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('writes storyPoints: 0 — a zero estimate is a real value, not an absent one', async () => {
    stubInstance();
    const fetchMock = stubFetchSequence([{ body: { key: 'PROJ-5' } }]);
    await createTicket(INSTANCE_ID, { projectKey: 'PROJ', summary: 'Slice', storyPoints: 0 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).fields.customfield_10106).toBe(0);
  });
});
