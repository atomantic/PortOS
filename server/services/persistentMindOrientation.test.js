import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ world: vi.fn(), readFile: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile }));
vi.mock('./eidoverseWorld.js', () => ({ getEidoverseWorldStatus: mocks.world }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.readFile.mockImplementation(async (url) => String(url).endsWith('package.json')
    ? JSON.stringify({ version: '1.2.3' })
    : Array.from({ length: 20 }, (_, i) => `- Release improvement ${i}`).join('\n'));
  mocks.world.mockResolvedValue({
    setup: { installed: true, runtimeStatus: 'online' },
    cos: { enabled: true, connected: false },
    instance: { name: 'private-machine' },
    recipe: { privateValue: 'private-record' },
  });
});

describe('Persistent Mind orientation', () => {
  it('refreshes world readiness, preserves model continuity and bounds cached release context', async () => {
    const { readPersistentMindOrientation } = await import('./persistentMindOrientation.js');
    const root = { config: {
      persistentMindCapabilities: { readPortos: true, manageEidoverse: true },
      persistentMindProfile: { providerId: 'example-provider', model: 'example-model' },
    } };
    const first = await readPersistentMindOrientation(root);
    expect(first.eidoverse).toMatchObject({ status: 'available', canBuild: true, canProject: true, connected: false });
    expect(first.modelPolicy).toMatchObject({ providerId: 'example-provider', selfModification: false });
    expect(first.release).toMatchObject({ version: '1.2.3', truncated: true });
    expect(first.release.highlights).toHaveLength(8);
    expect(JSON.stringify(first)).not.toMatch(/private-machine|private-record/);
    mocks.world.mockResolvedValue({ setup: { installed: true, runtimeStatus: 'stopped' } });
    expect((await readPersistentMindOrientation(root)).eidoverse.status).toBe('offline');
    expect(mocks.readFile).toHaveBeenCalledTimes(2);
    expect(mocks.world).toHaveBeenCalledWith({ compact: true });
    mocks.world.mockResolvedValue({ setup: { installed: true, runtimeStatus: 'unknown' } });
    expect((await readPersistentMindOrientation(root)).eidoverse.status).toBe('unknown');
  });

  it('reports unavailable release notes without inventing release history', async () => {
    mocks.readFile.mockRejectedValue(new Error('private file detail'));
    const { readPersistentMindOrientation } = await import('./persistentMindOrientation.js');
    expect((await readPersistentMindOrientation()).release).toEqual({ status: 'unknown' });
  });

  it('does not probe ungranted world state or infer success from a missing runtime', async () => {
    const { readPersistentMindOrientation } = await import('./persistentMindOrientation.js');
    expect((await readPersistentMindOrientation()).eidoverse).toMatchObject({ status: 'unknown', canBuild: false });
    expect(mocks.world).not.toHaveBeenCalled();
    mocks.world.mockRejectedValue(new Error('private network detail'));
    const result = await readPersistentMindOrientation({ config: { persistentMindCapabilities: { readPortos: true } } });
    expect(result.eidoverse).toMatchObject({ status: 'unknown', canBuild: false });
    expect(JSON.stringify(result)).not.toMatch(/private network detail|private file detail/);
  });
});
