import { expect, it, vi } from 'vitest';
import { maintenance } from '../../lib/maintenanceAdmission.js';

vi.mock('./projectStore.js', () => ({
  getProjectRecord: vi.fn(async () => ({ budgets: {}, localSettings: {}, candidateRevisionId: 'revision-example' })),
  getRevisionRecord: vi.fn(async () => ({ id: 'revision-example', manifest: { renderer: { kind: 'html' }, audio: { kind: 'silence' } } })),
  startStageRun: vi.fn(async () => {}),
  saveStageRun: vi.fn(),
}));
vi.mock('./projectFiles.js', async original => ({ ...await original(), readProjectFiles: vi.fn(async () => { throw new Error('Synthetic source read failure'); }) }));
vi.mock('../socket.js', () => ({ emitCodeAnimationChanged: vi.fn() }));
const { startProductionStageRun, activeStageRunIds } = await import('./stages.js');
const { emitCodeAnimationChanged } = await import('../socket.js');
const { saveStageRun } = await import('./projectStore.js');

it('holds update admission through terminal persistence and then announces the idle run', async () => {
  let save;
  let persistedStatus = null;
  const notifications = [];
  emitCodeAnimationChanged.mockImplementation(projectId => {
    notifications.push({ projectId, persistedStatus, active: activeStageRunIds() });
  });
  saveStageRun.mockImplementation((_runId, status) => new Promise(resolve => {
    save = () => { persistedStatus = status; resolve(); };
  }));
  const { done } = await startProductionStageRun('project-example', {});
  await vi.waitFor(() => expect(save).toBeTypeOf('function'));
  const update = maintenance.deferredUpdate.request();
  expect(maintenance.deferredUpdate.acquire(update.id)).toBe(false);
  save();
  expect(await done).toBe('failed');
  expect(maintenance.deferredUpdate.acquire(update.id)).toBe(true);
  await expect(startProductionStageRun('project-example', {})).rejects.toMatchObject({ code: 'MAINTENANCE_HELD' });
  maintenance.deferredUpdate.finish(update.id, false);
  expect(notifications.at(-1)).toEqual({ projectId: 'project-example', persistedStatus: 'failed', active: [] });
});
