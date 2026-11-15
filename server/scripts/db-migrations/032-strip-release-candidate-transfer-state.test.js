import { describe, expect, it, vi } from 'vitest';
import { up } from './032-strip-release-candidate-transfer-state.js';

const makeClient = (agents) => {
  const updates = new Map();
  let versionBumps = 0;
  const query = vi.fn(async (sql, params) => {
    if (sql.startsWith('SELECT')) {
      return { rows: Object.entries(agents).map(([id, agent]) => ({ agent_id: id, body: JSON.stringify(agent) }))
        .filter((row) => /releaseCandidateRecovery|releaseCandidateSuccessor/.test(row.body)) };
    }
    if (sql.startsWith('UPDATE')) updates.set(params[0], JSON.parse(params[1]));
    else versionBumps += 1;
    return { rows: [] };
  });
  return { client: { query }, updates, bumps: () => versionBumps };
};

// Uniquely catches an upgrade leaving a legacy held/transferred record that a do-release run would still trip over.
describe('db-migration 032 - strip release-candidate transfer state', () => {
  it('removes both retired fields from a legacy held record and keeps the rest of the agent', async () => {
    const held = { id: 'a1', status: 'completed', metadata: { taskAnalysisType: 'do-release', releaseCandidate: { version: 1 },
      releaseCandidateRecovery: { version: 1, status: 'held', predecessorAgentId: 'a0' }, releaseCandidateSuccessor: { version: 1 } } };
    const clean = { id: 'a2', status: 'running', metadata: { taskAnalysisType: 'do-release' } };
    const { client, updates, bumps } = makeClient({ a1: held, a2: clean });
    await up(client);
    expect([...updates.keys()]).toEqual(['a1']);
    expect(updates.get('a1')).toEqual({ id: 'a1', status: 'completed', metadata: { taskAnalysisType: 'do-release', releaseCandidate: { version: 1 } } });
    expect(bumps()).toBe(1);
  });

  it('writes nothing and leaves the store version alone when no record carries the fields', async () => {
    const { client, updates, bumps } = makeClient({ a2: { id: 'a2', status: 'running', metadata: { note: 'mentions nothing' } } });
    await up(client);
    expect(updates.size).toBe(0);
    expect(bumps()).toBe(0);
  });
});
