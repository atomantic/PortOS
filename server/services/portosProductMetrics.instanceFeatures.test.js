import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  getPostSessions: vi.fn(),
  getAllTrainingEntries: vi.fn(),
  listCommissions: vi.fn(),
  getProjectsByIds: vi.fn(),
  isInstanceFeatureEnabled: vi.fn(),
  getUserTimezone: vi.fn(),
  todayInTimezone: vi.fn(),
}));

vi.mock('./meatspacePost.js', () => ({ getPostSessions: mock.getPostSessions }));
vi.mock('./postTrainingLogStore.js', () => ({ getAllTrainingEntries: mock.getAllTrainingEntries }));
vi.mock('./creativeCommissions/store.js', () => ({ listCommissions: mock.listCommissions }));
vi.mock('./creativeDirector/local.js', () => ({ getProjectsByIds: mock.getProjectsByIds }));
vi.mock('./instanceFeatures.js', () => ({ isInstanceFeatureEnabled: mock.isInstanceFeatureEnabled }));
vi.mock('../lib/timezone.js', () => ({
  todayInTimezone: mock.todayInTimezone,
}));
vi.mock('./userTimezone.js', () => ({
  getUserTimezone: mock.getUserTimezone,
}));

import { getProductEngagement } from './portosProductMetrics.js';

describe('getProductEngagement — instance feature participation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.isInstanceFeatureEnabled.mockResolvedValue(false);
    mock.getUserTimezone.mockResolvedValue('UTC');
    mock.todayInTimezone.mockReturnValue('2026-08-24');
    mock.listCommissions.mockResolvedValue([]);
    mock.getProjectsByIds.mockResolvedValue([]);
    mock.getPostSessions.mockResolvedValue([]);
    mock.getAllTrainingEntries.mockResolvedValue([]);
  });

  it('skips POST reads and actions when POST is disabled on this instance', async () => {
    const result = await getProductEngagement({ now: new Date('2026-08-24T12:00:00.000Z') });

    expect(result.post).toEqual({ status: 'disabled', reason: 'instance-feature-disabled' });
    expect(result.actions).toEqual([]);
    expect(mock.getPostSessions).not.toHaveBeenCalled();
    expect(mock.getAllTrainingEntries).not.toHaveBeenCalled();
  });
});
