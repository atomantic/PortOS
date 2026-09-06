import { describe, it, expect, beforeEach } from 'vitest';
import {
  getOrchestrationProfiles,
  getOrchestrationProfileById,
  saveOrchestrationProfile,
  updateOrchestrationProfile,
  deleteOrchestrationProfile,
} from './orchestrationProfiles.js';
import { BUILT_IN_ORCHESTRATION_PROFILES } from '../lib/orchestrationProfile.js';

let mockSettings = {};

vi.mock('./settings.js', () => ({
  getSettings: vi.fn(async () => ({ ...mockSettings })),
  updateSettingsWith: vi.fn(async (mutate) => {
    mockSettings = await mutate({ ...mockSettings });
    return { ...mockSettings };
  }),
}));

describe('orchestrationProfiles service', () => {
  beforeEach(() => {
    mockSettings = {};
  });

  it('returns built-in profiles when no user profiles are configured', async () => {
    const profiles = await getOrchestrationProfiles();
    expect(profiles.length).toBe(BUILT_IN_ORCHESTRATION_PROFILES.length);
    expect(profiles[0].id).toBe('heavy-planner');
  });

  it('saves a new named profile and persists it in settings', async () => {
    const custom = {
      id: 'custom-team',
      name: 'Custom Team',
      description: 'Opus architect and sonnet implementer',
      profile: {
        architect: { provider: 'anthropic', model: 'claude-3-opus', effort: 'max' },
        implementer: { provider: 'anthropic', model: 'claude-3-5-sonnet', effort: 'low' },
        reviewer: { effort: 'medium' },
      },
    };

    const saved = await saveOrchestrationProfile(custom);
    expect(saved.id).toBe('custom-team');
    expect(saved.isBuiltin).toBe(false);

    const all = await getOrchestrationProfiles();
    expect(all.some((p) => p.id === 'custom-team')).toBe(true);

    const fetched = await getOrchestrationProfileById('custom-team');
    expect(fetched?.name).toBe('Custom Team');
  });

  it('updates an existing profile', async () => {
    await saveOrchestrationProfile({
      id: 'quick-loop',
      name: 'Quick Loop',
      profile: {
        architect: { effort: 'low' },
      },
    });

    const updated = await updateOrchestrationProfile('quick-loop', {
      name: 'Quick Loop v2',
      profile: {
        implementer: { effort: 'low' },
      },
    });

    expect(updated.name).toBe('Quick Loop v2');
    expect(updated.profile.architect?.effort).toBe('low');
    expect(updated.profile.implementer?.effort).toBe('low');
  });

  it('deletes a user profile', async () => {
    await saveOrchestrationProfile({
      id: 'to-delete',
      name: 'Temporary',
      profile: {
        architect: { effort: 'low' },
      },
    });

    const res = await deleteOrchestrationProfile('to-delete');
    expect(res).toEqual({ success: true, deleted: 'to-delete' });

    const remaining = await getOrchestrationProfiles();
    expect(remaining.some((p) => p.id === 'to-delete')).toBe(false);
  });

  it('refuses to delete a purely built-in profile', async () => {
    await expect(deleteOrchestrationProfile('heavy-planner')).rejects.toThrow(
      /Cannot delete built-in/
    );
  });
});
