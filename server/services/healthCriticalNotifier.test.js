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
