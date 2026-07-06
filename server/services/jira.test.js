import { describe, it, expect } from 'vitest';
import { buildColumnsFromBoardConfig, buildColumnsFromStatuses, isCloudInstance, jiraAuthHeader } from './jira.js';

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
