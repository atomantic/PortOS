import { describe, expect, it, vi } from 'vitest';

const archive = vi.hoisted(() => ({ days: {} }));

vi.mock('./cosAgentLifecycle.js', () => ({ getAgents: vi.fn(async () => [{ id: 'live', taskId: 't' }]) }));
vi.mock('./cosAgentIndex.js', () => ({
  getAgentsByDate: vi.fn(async (day) => archive.days[day] || []),
  selectArchivedCompletions: vi.fn(async () => [{ day: 'd1', id: 'a' }, { day: 'd1', id: 'gone' }]),
  readArchivedAgentMetadata: vi.fn(async (_day, id) => (id === 'a' ? { id: 'a', taskId: 't' } : null)),
}));

import { getAgentsWithArchive } from './cosAgentHistory.js';

describe('getAgentsWithArchive', () => {
  it('returns resident and archived records as one flat list without task ids', async () => {
    const day = new Date().toISOString().slice(0, 10);
    archive.days[day] = [{ id: 'old', taskId: 'x' }];
    const agents = await getAgentsWithArchive({ endAt: Date.now(), lookbackDays: 1 });
    expect(agents.map(a => a.id).sort()).toEqual(['live', 'old']);
  });

  it('reads only selected archive rows with task ids and drops unreadable ones', async () => {
    const agents = await getAgentsWithArchive({ endAt: Date.now(), lookbackDays: 3, taskIds: ['t'] });
    expect(agents.map(a => a.id).sort()).toEqual(['a', 'live']);
  });
});
