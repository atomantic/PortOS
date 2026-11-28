import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

const mocks = vi.hoisted(() => ({ getHistoryItem: vi.fn(), unlinkGuarded: vi.fn(), admission: null }));
vi.mock('./history.js', () => ({ getHistoryItem: mocks.getHistoryItem, mutateVideoHistory: vi.fn() }));
vi.mock('../../lib/fileUtils.js', async original => makePathsProxy(await original(), {
  dataRoot: () => lazyTempDataRoot('upscale-job-helpers-'),
  overrides: { unlinkGuarded: mocks.unlinkGuarded },
}));
vi.mock('../../lib/maintenanceAdmission.js', async original => ({
  ...await original(),
  maintenance: new Proxy({}, { get: (_target, property) => mocks.admission[property] }),
}));

const { PATHS } = await import('../../lib/fileUtils.js');
const { unlinkGuarded } = await vi.importActual('../../lib/fileUtils.js');
const { createMaintenanceAdmission } = await import('../../lib/maintenanceAdmission.js');
const { resolveQueuedUpscaleSource, removeOwnedUpscaleFile, resolveUpscaleMusicVideo } = await import('./upscaleJobHelpers.js');

const item = { id: 'source', filename: 'source.mp4', musicVideo: { projectId: 'mv-source', sceneId: 'shot-source' } };

beforeEach(async () => {
  mocks.getHistoryItem.mockReset().mockResolvedValue(item);
  mocks.unlinkGuarded.mockReset().mockImplementation(unlinkGuarded);
  mocks.admission = createMaintenanceAdmission(PATHS.data);
  await mkdir(PATHS.videos, { recursive: true });
  await writeFile(join(PATHS.videos, item.filename), 'source');
});
afterAll(cleanupTempDataRoots);

describe('queued upscale helpers', () => {
  it('keeps explicit shot controls and does not inherit a scene for another project', () => {
    const musicVideo = { projectId: 'mv-shot', sceneId: 'shot-selected', tier: 'final', selectOnComplete: true };
    expect(resolveUpscaleMusicVideo(item, { musicVideo, musicVideoProjectId: 'mv-ignored' })).toEqual({
      musicVideo, musicVideoProjectId: 'mv-shot',
    });
    expect(resolveUpscaleMusicVideo(item, { musicVideoProjectId: 'mv-new' })).toEqual({
      musicVideo: { projectId: 'mv-new', tier: 'final' }, musicVideoProjectId: 'mv-new',
    });
  });

  it('accepts legacy jobs with no pinned filename and resolves from the current row', async () => {
    await expect(resolveQueuedUpscaleSource(item.id)).resolves.toEqual({ item, sourcePath: join(PATHS.videos, item.filename) });
  });

  it.each([
    [null, item.filename, 404, 'NOT_FOUND'],
    [{ ...item, filename: '../source.mp4' }, '../source.mp4', 404, 'NOT_FOUND'],
    [{ ...item, filename: 'missing.mp4' }, 'missing.mp4', 404, 'NOT_FOUND'],
    [{ ...item, upscaledFrom: 'other' }, item.filename, 400, 'ALREADY_UPSCALED'],
    [{ ...item, filename: 'replacement.mp4' }, item.filename, 409, 'UPSCALE_SOURCE_CHANGED'],
  ])('checks queued source %j against filename %s', async (row, pinnedFilename, status, code) => {
    mocks.getHistoryItem.mockResolvedValueOnce(row);
    await expect(resolveQueuedUpscaleSource(item.id, pinnedFilename)).rejects.toMatchObject({ status, code });
  });

  it('marks the current and media operations unsettled only when cleanup fails', async () => {
    const output = join(PATHS.videos, 'owned.mp4');
    await writeFile(output, 'owned');
    const current = mocks.admission.admit('other', 'current');
    const media = mocks.admission.admit('media', 'upscale-job');
    mocks.admission.begin({ reason: 'Drain upscale', owner: 'Operator' });

    await current.run(() => removeOwnedUpscaleFile('upscale-job', join(PATHS.videos, 'absent.mp4')));
    expect(mocks.admission.status().blockers.every(op => !op.unsettled)).toBe(true);

    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mocks.unlinkGuarded.mockRejectedValueOnce(Object.assign(new Error('Cleanup denied'), { code: 'EACCES' }));
      await current.run(() => removeOwnedUpscaleFile('upscale-job', output));
      expect(existsSync(output)).toBe(true);
      await Promise.all([current.finish(), media.finish()]);
      expect(mocks.admission.status().blockers).toEqual(expect.arrayContaining([
        expect.objectContaining({ resource: 'current', unsettled: true }),
        expect.objectContaining({ resource: 'upscale-job', unsettled: true }),
      ]));
    } finally {
      errorLog.mockRestore();
    }
  });
});
