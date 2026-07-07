import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildColumnsFromBoardConfig, buildColumnsFromStatuses, createJiraClient, isCloudInstance, jiraAuthHeader } from './jira.js';

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
