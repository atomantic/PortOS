import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/workTracker.js', async (importActual) => ({
  ...(await importActual()),
  resolveAppWorkTracker: vi.fn()
}));
vi.mock('./perpetualWork.js', () => ({
  detectActionableWork: vi.fn(),
  WORK_ITEM_LIMIT: 50
}));
vi.mock('./jira.js', () => ({
  fetchMyCurrentSprintTickets: vi.fn()
}));

import { resolveAppWorkTracker } from '../lib/workTracker.js';
import { detectActionableWork } from './perpetualWork.js';
import { fetchMyCurrentSprintTickets } from './jira.js';
import { listWorkItems } from './workItems.js';

const app = { id: 'acme', repoPath: '/repos/acme' };

describe('listWorkItems', () => {
  beforeEach(() => {
    resolveAppWorkTracker.mockReset();
    detectActionableWork.mockReset();
    fetchMyCurrentSprintTickets.mockReset();
  });

  it('delegates a forge tracker to the claim detector, honoring the author filter', async () => {
    resolveAppWorkTracker.mockResolvedValue({ resolved: 'github', source: 'origin' });
    detectActionableWork.mockResolvedValue({
      actionable: true, count: 2, reason: 'actionable-issues',
      items: [{ ref: '7', title: 'Fix the thing' }, { ref: '9', title: 'Add the other' }]
    });

    const out = await listWorkItems(app, { issueAuthorFilter: 'any' });

    expect(detectActionableWork).toHaveBeenCalledWith('claim-issue', app, { issueAuthorFilter: 'any' });
    expect(out).toMatchObject({
      tracker: 'github',
      promptTaskType: 'claim-issue',
      count: 2,
      reason: 'actionable-issues',
      transient: false
    });
    expect(out.items).toHaveLength(2);
  });

  it('routes PLAN.md apps to the plan-task detector', async () => {
    resolveAppWorkTracker.mockResolvedValue({ resolved: 'plan', source: 'fallback' });
    detectActionableWork.mockResolvedValue({ actionable: true, count: 1, reason: 'actionable-plan-items', items: [{ ref: 'do-thing', title: 'Do the thing' }] });

    const out = await listWorkItems(app);

    expect(detectActionableWork).toHaveBeenCalledWith('plan-task', app, {});
    expect(out.tracker).toBe('plan');
    expect(out.items).toEqual([{ ref: 'do-thing', title: 'Do the thing' }]);
  });

  it('surfaces a transient probe failure as transient with an empty list (not "no work")', async () => {
    resolveAppWorkTracker.mockResolvedValue({ resolved: 'gitlab', source: 'origin' });
    detectActionableWork.mockResolvedValue({ actionable: false, count: 0, reason: 'glab-list-failed', transient: true });

    const out = await listWorkItems(app);

    expect(out).toMatchObject({ tracker: 'gitlab', items: [], count: 0, reason: 'glab-list-failed', transient: true });
  });

  it('lists JIRA sprint tickets, skipping ones already started or done', async () => {
    resolveAppWorkTracker.mockResolvedValue({ resolved: 'jira', source: 'configured' });
    fetchMyCurrentSprintTickets.mockResolvedValue([
      { key: 'ACME-1', summary: 'Ready to go', statusCategory: 'To Do', url: 'https://example.com/browse/ACME-1' },
      { key: 'ACME-2', summary: 'Underway', statusCategory: 'In Progress' },
      { key: 'ACME-3', summary: 'Finished', statusCategory: 'Done' }
    ]);

    const out = await listWorkItems({ ...app, jira: { enabled: true, instanceId: 'i1', projectKey: 'ACME' } });

    expect(detectActionableWork).not.toHaveBeenCalled();
    expect(out.tracker).toBe('jira');
    expect(out.items).toEqual([{ ref: 'ACME-1', title: 'Ready to go', url: 'https://example.com/browse/ACME-1' }]);
    expect(out.reason).toBe('actionable-tickets');
  });

  it('reports jira-not-configured rather than probing when the app has no JIRA config', async () => {
    resolveAppWorkTracker.mockResolvedValue({ resolved: 'jira', source: 'configured' });

    const out = await listWorkItems(app);

    expect(fetchMyCurrentSprintTickets).not.toHaveBeenCalled();
    expect(out).toMatchObject({ items: [], reason: 'jira-not-configured', transient: false });
  });

  it('marks a failed JIRA fetch transient so the UI says "couldn\'t load", not "no tickets"', async () => {
    resolveAppWorkTracker.mockResolvedValue({ resolved: 'jira', source: 'configured' });
    fetchMyCurrentSprintTickets.mockRejectedValue(new Error('502 from JIRA'));

    const out = await listWorkItems({ ...app, jira: { enabled: true, instanceId: 'i1', projectKey: 'ACME' } });

    expect(out).toMatchObject({ items: [], reason: 'jira-fetch-failed', transient: true });
  });
});
