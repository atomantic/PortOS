import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listUserActions: vi.fn(),
  detectIdleLeftoverBranches: vi.fn(async () => []),
}));
vi.mock('./userActions.js', () => ({
  listUserActions: (...args) => mocks.listUserActions(...args),
}));
vi.mock('./userActionDetectors.js', async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    detectIdleLeftoverBranches: (...args) => mocks.detectIdleLeftoverBranches(...args),
  };
});

import {
  USER_ACTIONS_SNIPPET_MAX_CHARS,
  USER_ACTIONS_SNIPPET_MAX_SUMMARIES,
  USER_ACTIONS_SNIPPET_WINDOW_MS,
  buildPersistentMindUserActionsPrompt,
  readPersistentMindUserActionsPrompt,
} from './persistentMindUserActions.js';

const event = (overrides = {}) => ({
  id: 'evt-1',
  type: 'cos.schedule.trigger',
  actor: 'user',
  target: 'branch-reconcile',
  summary: "Ran scheduled task 'branch-reconcile' on demand",
  happenedAt: '2026-09-01T10:00:00.000Z',
  payload: {},
  ...overrides,
});

describe('buildPersistentMindUserActionsPrompt', () => {
  it('renders counts by type+target first, then the newest summaries', () => {
    const prompt = buildPersistentMindUserActionsPrompt([
      event({ id: 'a' }),
      event({ id: 'b' }),
      event({ id: 'c', type: 'cos.task.create', target: 'task-1', summary: 'Queued CoS task "Fix flaky test"' }),
      event({ id: 'd', type: 'cos.task.create', target: 'task-2', summary: 'Queued CoS task "Bump deps"' }),
    ]);
    expect(prompt).toMatch(/^# Recent user actions \(last 24h\)\n/);
    // Schedule triggers count per task TYPE (the target is a class)…
    expect(prompt).toContain('- 2× cos.schedule.trigger (branch-reconcile) actor=user');
    // …while record-id targets fold into one line per event type, so a busy
    // day of distinct task ids cannot flood the budget with 1× lines.
    expect(prompt).toContain('- 2× cos.task.create actor=user');
    expect(prompt).not.toContain('(task-1)');
    expect(prompt).toContain('Last 4, newest first:');
    expect(prompt).toContain("- Ran scheduled task 'branch-reconcile' on demand");
    expect(prompt).toContain('- Queued CoS task "Fix flaky test"');
  });

  it('omits the section entirely when there are no events', () => {
    expect(buildPersistentMindUserActionsPrompt([])).toBe('');
    expect(buildPersistentMindUserActionsPrompt(null)).toBe('');
    expect(buildPersistentMindUserActionsPrompt([null, 'garbage', {}])).toBe('');
  });

  it('never emits payload values — even a secret that slipped past redaction', () => {
    const prompt = buildPersistentMindUserActionsPrompt([
      event({ payload: { apiToken: 'sk-live-EXAMPLE-SECRET-VALUE', note: 'private-note-body' } }),
    ]);
    expect(prompt).not.toContain('sk-live-EXAMPLE-SECRET-VALUE');
    expect(prompt).not.toContain('private-note-body');
  });

  it('scrubs a credential pasted into a summary by VALUE — key-based redaction cannot catch it', () => {
    const prompt = buildPersistentMindUserActionsPrompt([
      event({ summary: 'Queued CoS task: deploy with sk-abcdefghijklmnopqrstuvwx as the key' }),
    ]);
    expect(prompt).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(prompt).toContain('[REDACTED]');
  });

  it('caps the section size and the summary count without evicting every summary', () => {
    // Worst realistic shape: many events with DISTINCT record-id targets. The
    // counts must fold per type so summaries — the lines carrying the actual
    // pattern — survive the char budget.
    const many = Array.from({ length: 80 }, (_, index) => event({
      id: `evt-${index}`,
      type: 'cos.task.create',
      target: `task-${index}`,
      summary: `Summary line ${index} ${'x'.repeat(60)}`,
    }));
    const prompt = buildPersistentMindUserActionsPrompt(many);
    expect(prompt.length).toBeLessThanOrEqual(USER_ACTIONS_SNIPPET_MAX_CHARS);
    expect(prompt).toContain('- 80× cos.task.create actor=user');
    const summaryLines = prompt.split('\n').filter((line) => line.startsWith('- Summary line'));
    expect(summaryLines.length).toBeLessThanOrEqual(USER_ACTIONS_SNIPPET_MAX_SUMMARIES);
    // Non-vacuous: the cap trims summaries, it must not zero them.
    expect(summaryLines.length).toBeGreaterThan(0);
  });
});

describe('readPersistentMindUserActionsPrompt', () => {
  it('queries the last 24 hours and renders the section', async () => {
    const now = Date.parse('2026-09-01T12:00:00.000Z');
    mocks.listUserActions.mockResolvedValueOnce([event()]);
    const prompt = await readPersistentMindUserActionsPrompt({ now });
    expect(mocks.listUserActions).toHaveBeenCalledWith({
      from: new Date(now - USER_ACTIONS_SNIPPET_WINDOW_MS).toISOString(),
      limit: 200,
    });
    expect(prompt).toContain('# Recent user actions (last 24h)');
  });

  it('renders nothing instead of sinking the mind turn when the ledger read fails', async () => {
    mocks.listUserActions.mockRejectedValueOnce(new Error('database offline'));
    await expect(readPersistentMindUserActionsPrompt()).resolves.toBe('');
  });

  it('appends leftover-branch detector lines even when the 24h ledger is empty', async () => {
    mocks.listUserActions.mockResolvedValueOnce([]);
    mocks.detectIdleLeftoverBranches.mockResolvedValueOnce([{
      appId: 'app-acme', leftoverCount: 2, lastUserReconcileAt: null, agentsIdle: true,
    }]);
    const prompt = await readPersistentMindUserActionsPrompt();
    expect(prompt).toContain('# Recent user actions (last 24h)');
    expect(prompt).toContain('leftover-branches: app app-acme has 2 local branches, agents idle, last manual reconcile never');
  });
});
