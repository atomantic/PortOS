import { describe, it, expect, vi, beforeEach } from 'vitest';

// For a VALID new-apex suggestion, applyOrganizationSuggestion resolves the
// `__new_apex__` sentinel CLIENT-SIDE: it creates the new apex first, rewrites every
// `__new_apex__` parent ref to the real id, creates sub-apex goals under it, THEN
// calls the server — so no raw sentinel reaches applyGoalOrganization. The rewrite
// only runs once an apex id is resolved, so a malformed/drift suggestion that carries
// `__new_apex__` with no resolvable apex still passes the sentinel through; the
// server's goalMap.has() skip is the defensive net for that case (correct behavior,
// not a bug). These tests pin both paths so a future refactor of this file can't
// silently regress the round-trip (see issue #895).
vi.mock('../../services/api', () => ({
  createGoal: vi.fn(),
  applyGoalOrganization: vi.fn(() => Promise.resolve(true)),
}));

import * as api from '../../services/api';
import { applyOrganizationSuggestion } from './applyOrganization';

beforeEach(() => {
  vi.clearAllMocks();
  api.applyGoalOrganization.mockResolvedValue(true);
});

describe('applyOrganizationSuggestion — __new_apex__ round-trip', () => {
  it('creates a new apex and rewrites __new_apex__ parent refs to its real id before the server call', async () => {
    api.createGoal.mockResolvedValue({ id: 'apex-real-1' });

    const suggestion = {
      apexGoal: { existingId: null, suggestedTitle: 'Live fully', suggestedDescription: 'North star' },
      organization: [
        { id: 'g-1', goalType: 'sub-apex', suggestedParentId: '__new_apex__' },
        { id: 'g-2', goalType: 'standard', suggestedParentId: 'g-1' },
      ],
      suggestedSubApex: [],
    };

    const ok = await applyOrganizationSuggestion(suggestion);
    expect(ok).toBe(true);

    // Apex created from the suggestion
    expect(api.createGoal).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Live fully', goalType: 'apex' })
    );

    // The server received the rewritten organization — no raw sentinel survives
    const sentOrg = api.applyGoalOrganization.mock.calls[0][0];
    expect(sentOrg.find(i => i.id === 'g-1').suggestedParentId).toBe('apex-real-1');
    expect(sentOrg.some(i => i.suggestedParentId === '__new_apex__')).toBe(false);
    // Unrelated parent refs are untouched
    expect(sentOrg.find(i => i.id === 'g-2').suggestedParentId).toBe('g-1');
  });

  it('rewrites unparented sub-apex items (no parent + sub-apex type) to the apex too', async () => {
    api.createGoal.mockResolvedValue({ id: 'apex-real-2' });

    const suggestion = {
      apexGoal: { existingId: null, suggestedTitle: 'Purpose', suggestedDescription: '' },
      organization: [
        { id: 'g-1', goalType: 'sub-apex', suggestedParentId: null },
      ],
      suggestedSubApex: [],
    };

    await applyOrganizationSuggestion(suggestion);
    const sentOrg = api.applyGoalOrganization.mock.calls[0][0];
    expect(sentOrg[0].suggestedParentId).toBe('apex-real-2');
  });

  it('uses an existing apex id (no apex creation) and still strips the sentinel', async () => {
    const suggestion = {
      apexGoal: { existingId: 'existing-apex', suggestedTitle: null, suggestedDescription: null },
      organization: [
        { id: 'g-1', goalType: 'sub-apex', suggestedParentId: '__new_apex__' },
      ],
      suggestedSubApex: [],
    };

    const ok = await applyOrganizationSuggestion(suggestion);
    expect(ok).toBe(true);
    expect(api.createGoal).not.toHaveBeenCalled();

    const sentOrg = api.applyGoalOrganization.mock.calls[0][0];
    expect(sentOrg[0].suggestedParentId).toBe('existing-apex');
  });

  it('creates suggestedSubApex goals parented under the resolved apex', async () => {
    api.createGoal.mockResolvedValue({ id: 'apex-real-3' });

    const suggestion = {
      apexGoal: { existingId: null, suggestedTitle: 'Apex', suggestedDescription: '' },
      organization: [],
      suggestedSubApex: [
        { title: 'Health', description: 'Stay alive', category: 'health', suggestedParentId: '__new_apex__' },
      ],
    };

    await applyOrganizationSuggestion(suggestion);

    // The apex is created first (so its id is available to parent the sub-apex)...
    expect(api.createGoal.mock.calls[0][0]).toMatchObject({ title: 'Apex', goalType: 'apex' });
    // ...then the sub-apex create is parented under the real apex id
    expect(api.createGoal).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Health', goalType: 'sub-apex', parentId: 'apex-real-3' })
    );
  });

  it('passes the raw sentinel through (server-side skip is the safety net) when no apex resolves', async () => {
    // Drift case: organization carries __new_apex__ but the suggestion gives no
    // resolvable apex (no existingId, no suggestedTitle), so the client rewrite is
    // skipped. The sentinel reaches the server, where goalMap.has('__new_apex__') is
    // false and the item is silently skipped — the defensive behavior issue #895 noted.
    const suggestion = {
      apexGoal: { existingId: null, suggestedTitle: null, suggestedDescription: null },
      organization: [{ id: 'g-1', goalType: 'sub-apex', suggestedParentId: '__new_apex__' }],
      suggestedSubApex: [],
    };

    const ok = await applyOrganizationSuggestion(suggestion);
    expect(ok).toBe(true);
    expect(api.createGoal).not.toHaveBeenCalled();

    // No apex resolved → no client-side rewrite → the raw sentinel is still in the payload
    const sentOrg = api.applyGoalOrganization.mock.calls[0][0];
    expect(sentOrg[0].suggestedParentId).toBe('__new_apex__');
  });

  it('does not mutate the caller-provided organization array', async () => {
    api.createGoal.mockResolvedValue({ id: 'apex-real-4' });

    const original = [{ id: 'g-1', goalType: 'sub-apex', suggestedParentId: '__new_apex__' }];
    const suggestion = {
      apexGoal: { existingId: null, suggestedTitle: 'Apex', suggestedDescription: '' },
      organization: original,
      suggestedSubApex: [],
    };

    await applyOrganizationSuggestion(suggestion);
    // Caller's array is untouched (the function clones before rewriting)
    expect(original[0].suggestedParentId).toBe('__new_apex__');
  });

  it('aborts (returns false) when apex creation fails', async () => {
    api.createGoal.mockResolvedValue(null);

    const suggestion = {
      apexGoal: { existingId: null, suggestedTitle: 'Apex', suggestedDescription: '' },
      organization: [{ id: 'g-1', goalType: 'sub-apex', suggestedParentId: '__new_apex__' }],
      suggestedSubApex: [],
    };

    const ok = await applyOrganizationSuggestion(suggestion);
    expect(ok).toBe(false);
    expect(api.applyGoalOrganization).not.toHaveBeenCalled();
  });
});
