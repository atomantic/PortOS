/**
 * Contract: one persistent card per distinct critical-issue set, replaced when
 * the set changes, retracted on recovery — never re-raised for an unchanged set.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./notifications.js', () => ({
  addNotification: vi.fn().mockResolvedValue({}),
  exists: vi.fn().mockResolvedValue(false),
  removeByMetadata: vi.fn().mockResolvedValue({ success: true, removed: 0 }),
  NOTIFICATION_TYPES: { HEALTH_ISSUE: 'health_issue' },
  PRIORITY_LEVELS: { CRITICAL: 'critical' },
}));

import { notifyCriticalHealth, clearCriticalHealthIfRecovered } from './healthCriticalNotifier.js';
import { addNotification, exists, removeByMetadata } from './notifications.js';

const issues = [
  { type: 'error', category: 'processes', message: 'PM2 process read failed' },
  { type: 'error', category: 'processes', message: 'Restart failed: example-app' },
];

beforeEach(() => {
  vi.clearAllMocks();
  exists.mockResolvedValue(false);
  removeByMetadata.mockResolvedValue({ success: true, removed: 0 });
});

describe('notifyCriticalHealth', () => {
  it('raises a critical health card naming the issues', async () => {
    expect(await notifyCriticalHealth(issues)).toBe(true);
    const card = addNotification.mock.calls[0][0];
    expect(card).toMatchObject({ type: 'health_issue', priority: 'critical' });
    expect(card.description).toContain('Restart failed: example-app');
    expect(removeByMetadata).toHaveBeenCalledWith('source', 'cos-health-critical');
  });

  it('stays silent when the same issue set is already announced, regardless of order', async () => {
    exists.mockResolvedValue(true);
    expect(await notifyCriticalHealth(issues)).toBe(false);
    expect(await notifyCriticalHealth([...issues].reverse())).toBe(false);
    expect(exists.mock.calls[0][2]).toBe(exists.mock.calls[1][2]);
    expect(addNotification).not.toHaveBeenCalled();
    expect(removeByMetadata).not.toHaveBeenCalled();
  });

  it('ignores an empty or malformed payload', async () => {
    expect(await notifyCriticalHealth([])).toBe(false);
    expect(await notifyCriticalHealth(undefined)).toBe(false);
    expect(addNotification).not.toHaveBeenCalled();
  });
});

describe('clearCriticalHealthIfRecovered', () => {
  it('retracts the card when no error-level issue remains (warnings do not keep it)', async () => {
    removeByMetadata.mockResolvedValue({ success: true, removed: 1 });
    expect(await clearCriticalHealthIfRecovered({ issues: [{ type: 'warning', message: 'High process count' }] })).toBe(true);
    expect(removeByMetadata).toHaveBeenCalledWith('source', 'cos-health-critical');
  });

  it('keeps the card while an error-level issue persists', async () => {
    expect(await clearCriticalHealthIfRecovered({ issues })).toBe(false);
    expect(removeByMetadata).not.toHaveBeenCalled();
  });
});

// Ordering: cos.js launches both entry points from independent listeners without
// awaiting either. A synthetic store serializes each individual call (as the real
// notification store does) but lets a test hold any one call open.
describe('transition ordering', () => {
  const SOURCE = 'cos-health-critical';
  const other = [{ type: 'error', category: 'processes', message: 'Disk unreadable' }];
  let cards;
  let gate; // optional (op) => Promise to await before the op takes effect

  const deferred = () => {
    let release;
    const promise = new Promise(r => { release = r; });
    return { promise, release };
  };
  // Let queued microtasks run so a blocked transition reaches its held call.
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

  beforeEach(() => {
    cards = [];
    gate = null;
    exists.mockImplementation(async (_type, _field, key) => {
      const hit = cards.some(c => c.metadata.healthCriticalKey === key);
      await gate?.('exists');
      return hit;
    });
    removeByMetadata.mockImplementation(async (_field, value) => {
      await gate?.('remove');
      const before = cards.length;
      cards = cards.filter(c => c.metadata.source !== value);
      return { success: true, removed: before - cards.length };
    });
    addNotification.mockImplementation(async (card) => {
      await gate?.('add');
      cards.push(card);
      return card;
    });
  });

  it('raises exactly one card for concurrent identical critical events', async () => {
    const hold = deferred();
    gate = (op) => (op === 'exists' ? hold.promise : undefined);
    const first = notifyCriticalHealth(issues);
    const second = notifyCriticalHealth([...issues].reverse());
    await flush();
    hold.release();
    expect(await Promise.all([first, second])).toEqual([true, false]);
    expect(cards).toHaveLength(1);
  });

  it('does not let a delayed failure land its card after a later recovery', async () => {
    const hold = deferred();
    let held = false;
    gate = (op) => {
      if (op === 'exists' && !held) { held = true; return hold.promise; }
    };
    const failure = notifyCriticalHealth(issues);
    const recovery = clearCriticalHealthIfRecovered({ issues: [] });
    await flush();
    hold.release();
    await Promise.all([failure, recovery]);
    expect(cards).toHaveLength(0);
  });

  it('leaves one card for the latest state across changed sets and a new failure after recovery', async () => {
    const hold = deferred();
    let held = false;
    gate = (op) => {
      if (op === 'add' && !held) { held = true; return hold.promise; }
    };
    const calls = [
      notifyCriticalHealth(issues),
      notifyCriticalHealth(other),
      clearCriticalHealthIfRecovered({ issues: [] }),
      notifyCriticalHealth(issues),
    ];
    await flush();
    hold.release();
    await Promise.all(calls);
    expect(cards).toHaveLength(1);
    expect(cards[0].metadata.healthCriticalKey).toBe(issueKeyOf(issues));
  });

  it('releases the queue after a rejected transition and surfaces the error to its caller', async () => {
    exists.mockRejectedValueOnce(new Error('store unavailable'));
    const failing = notifyCriticalHealth(issues);
    const next = notifyCriticalHealth(issues);
    await expect(failing).rejects.toThrow('store unavailable');
    expect(await next).toBe(true);
    expect(cards).toHaveLength(1);
    expect(cards[0].metadata.source).toBe(SOURCE);
  });
});

const issueKeyOf = (list) => [...new Set(list.map(i => i.message))].sort().join('\n');
