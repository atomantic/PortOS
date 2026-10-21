import { describe, expect, it } from 'vitest';
import { __makeMemoryCosAgentBackend, __resetCosAgentRepository, applyAgentSave, getStoredAgent, listStoredAgentStatuses, loadAgentRows } from './cosAgentRepository.js';
import { __runCosAgentRepositoryContract } from './_cosAgentRepositoryContract.js';

__runCosAgentRepositoryContract({ name: 'in-memory', makeBackend: () => __makeMemoryCosAgentBackend() });

describe('cosAgentRepository facade (test runner)', () => {
  it('selects the in-memory backend and does not touch disk', async () => {
    __resetCosAgentRepository();
    const agent = { id: 'agent-example-0001', status: 'running' };
    await applyAgentSave({ upserts: [{ id: agent.id, body: JSON.stringify(agent), agent }], deletes: [] }, 0);
    expect(await getStoredAgent(agent.id)).toEqual(agent);
    expect(await listStoredAgentStatuses()).toEqual([{ id: agent.id, status: 'running' }]);
    expect((await loadAgentRows()).version).toBe(1);
    __resetCosAgentRepository();
    expect(await loadAgentRows()).toEqual({ version: 0, rows: [] });
  });
});
