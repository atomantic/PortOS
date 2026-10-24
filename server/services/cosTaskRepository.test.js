import { describe, expect, it } from 'vitest';
import { __makeMemoryCosTaskBackend, __resetCosTaskRepository, applyTaskListSave, loadTaskWorkingSet, readTaskListVersion } from './cosTaskRepository.js';
import { __runCosTaskRepositoryContract } from './_cosTaskRepositoryContract.js';

__runCosTaskRepositoryContract({ name: 'in-memory', makeBackend: () => __makeMemoryCosTaskBackend() });

describe('cosTaskRepository facade (test runner)', () => {
  it('selects the in-memory backend and does not touch disk', async () => {
    __resetCosTaskRepository();
    const task = { id: 'task-example-0001', status: 'pending', priority: 'MEDIUM', priorityValue: 2, description: 'Example', approvalRequired: false, autoApproved: true, metadata: {} };
    await applyTaskListSave('user', { upserts: [{ task, position: 0 }], deletes: [], expectedVersions: { user: 0 } });
    expect((await loadTaskWorkingSet('user')).rows).toHaveLength(1);
    expect(await readTaskListVersion('user')).toBe(1);
    __resetCosTaskRepository();
    expect((await loadTaskWorkingSet('user')).rows).toHaveLength(0);
  });
});
