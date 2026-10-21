// The dev file escape hatch persists both CoS repositories to data/; a restart
// must reload what was written, and an unreadable file must stop the backend
// rather than start empty and overwrite it.
import { afterAll, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'cos-repo-dev-' });
vi.mock('../lib/fileUtils.js', async (importOriginal) => makeProxy(await importOriginal()));
afterAll(cleanup);

const { __makeMemoryCosAgentBackend } = await import('./cosAgentRepository.js');
const { __makeMemoryCosTaskBackend } = await import('./cosTaskRepository.js');

describe('CoS repositories on the dev file backend', () => {
  it('reload agent rows written before a restart', async () => {
    const first = await __makeMemoryCosAgentBackend({ persist: true });
    const agent = { id: 'agent-example-1', status: 'running' };
    await first.apply({ upserts: [{ id: agent.id, body: JSON.stringify(agent), agent }], deletes: [] }, 0);
    const restarted = await __makeMemoryCosAgentBackend({ persist: true });
    expect(await restarted.loadAgents()).toEqual({ version: 1, rows: [{ id: agent.id, body: JSON.stringify(agent) }] });
  });

  it('reload task rows written before a restart', async () => {
    const first = await __makeMemoryCosTaskBackend({ persist: true });
    const task = { id: 'task-example-1', status: 'pending', priority: 'MEDIUM', priorityValue: 2, description: 'Example', metadata: {} };
    await first.apply('user', { upserts: [{ task, position: 0 }], deletes: [] });
    const restarted = await __makeMemoryCosTaskBackend({ persist: true });
    expect((await restarted.loadWorkingSet('user')).rows.map((row) => row.task.id)).toEqual([task.id]);
    expect(await restarted.readVersion('user')).toBe(1);
  });

  it('refuses to start over an unreadable file', async () => {
    writeFileSync(join(tempRoot, 'cos-agents.json'), '{broken');
    writeFileSync(join(tempRoot, 'cos-tasks.json'), '{broken');
    await expect(__makeMemoryCosAgentBackend({ persist: true })).rejects.toThrow('Unreadable');
    await expect(__makeMemoryCosTaskBackend({ persist: true })).rejects.toThrow('Unreadable');
  });
});
