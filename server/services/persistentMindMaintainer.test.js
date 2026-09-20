import { beforeEach, expect, it, vi } from 'vitest';
import { describePersistentMindMaintainerSetup } from './persistentMindMaintainer.js';
import { composeMaintainerInstructions, mergePersistentMindMaintainer } from '../lib/persistentMindMaintainer.js';
const mocks = vi.hoisted(() => ({ root: {}, apps: [] }));
vi.mock('./persistentMindProfile.js', () => ({ resolvePersistentMindProfile: async () => ({ ok: mocks.root.routeAvailable !== false }) }));
vi.mock('./persistentMindMaintainerInference.js', () => ({ inspectMaintainerInferenceRoute: async () => ({ ok: true }), readMaintainerInferenceBudget: async () => ({}) }));
vi.mock('./cosState.js', () => ({ loadState: async () => mocks.root }));
vi.mock('./persistentMindManagedApps.js', () => ({ readPersistentMindManagedApps: async () => mocks.apps }));
beforeEach(() => {
  mocks.root = { config: { persistentMindProfile: { enabled: true, providerId: 'local', model: 'example' },
    persistentMindCapabilities: { readPortos: true, createTasks: true, fileIssues: true },
    domainAutonomy: { cos: 'execute' } } };
  mocks.apps = [{ id: 'example-app', name: 'Example app', forge: 'github', fullName: 'example/project', granted: true }];
});
it('keeps legacy installs off and preserves custom instructions during role composition', async () => {
  const preview = await describePersistentMindMaintainerSetup();
  expect(preview.role).toMatchObject({ schemaVersion: 1, enabled: false, appIds: [], intervalMinutes: 60 });
  expect(preview.ready).toBe(false);
  expect(composeMaintainerInstructions('Custom voice', undefined)).toBe('Custom voice');
  const role = mergePersistentMindMaintainer({ appIds: ['example-app'] }, { enabled: true });
  expect(composeMaintainerInstructions('Custom voice', role)).toContain('Custom voice\n\n# Development maintainer role');
  expect(mocks.root.config.persistentMindMaintainer).toBeUndefined();
});
it('shows readiness only for explicit scoped, granted repositories and current controls', async () => {
  mocks.root.config.persistentMindMaintainer = { enabled: true, appIds: ['example-app'] };
  expect((await describePersistentMindMaintainerSetup()).ready).toBe(true);
  mocks.apps[0].granted = false;
  expect((await describePersistentMindMaintainerSetup()).ready).toBe(false);
  mocks.apps[0].granted = true;
  mocks.root.config.persistentMindCapabilities.createTasks = false;
  expect((await describePersistentMindMaintainerSetup()).prerequisites).toContain('Grant createTasks separately in Persistent Mind Tools.');
  mocks.root.config.persistentMindCapabilities.createTasks = true;
  mocks.root.routeAvailable = false;
  expect((await describePersistentMindMaintainerSetup()).ready).toBe(false);
  mocks.root.routeAvailable = true;
  mocks.root.paused = true;
  expect((await describePersistentMindMaintainerSetup()).ready).toBe(false);
  mocks.root.paused = false;
  mocks.root.config.persistentMindMaintainer.enabled = false;
  expect((await describePersistentMindMaintainerSetup()).ready).toBe(false);
  expect(composeMaintainerInstructions('Custom voice', mocks.root.config.persistentMindMaintainer)).toBe('Custom voice');
});
