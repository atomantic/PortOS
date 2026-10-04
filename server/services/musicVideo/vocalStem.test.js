import { afterAll, expect, it, vi } from 'vitest';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

vi.mock('../../lib/paths.js', async original => makePathsProxy(await original(), {
  dataRoot: () => lazyTempDataRoot('mv-vocal-backup-'),
}));
vi.mock('./render.js', () => ({ resolveMasterAudioPath: async () => '/synthetic/master.wav' }));
vi.mock('../../lib/ffmpeg.js', async original => ({ ...await original(), probeVideoDuration: vi.fn(async () => 10) }));

const { PATHS } = await import('../../lib/paths.js');
const { createProject, getProject } = await import('./projects.js');
const { attachVocalStem } = await import('./vocalStem.js');
const { probeVideoDuration } = await import('../../lib/ffmpeg.js');
const { acquireBackupSnapshotCut } = await import('../../lib/backupSnapshotBoundary.js');

afterAll(() => cleanupTempDataRoots());

it('keeps a stem file and its project reference behind an active backup cut', async () => {
  const project = await createProject({ name: 'Vocal example', mediaMode: 'code-images' });
  await mkdir(PATHS.data, { recursive: true });
  const tempPath = join(PATHS.data, 'synthetic-upload.wav');
  const bytes = Buffer.from('synthetic audio');
  await writeFile(tempPath, bytes);

  const release = await acquireBackupSnapshotCut();
  try {
    const attaching = attachVocalStem(project.id, { tempPath, originalName: 'vocals.wav' });
    await vi.waitFor(() => expect(probeVideoDuration).toHaveBeenCalledTimes(2));
    await new Promise(resolve => setImmediate(resolve));
    expect((await getProject(project.id)).vocalStemFilename).toBeFalsy();
    expect(await readdir(PATHS.music).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))).toEqual([]);
    release();
    const attached = await attaching;
    expect((await getProject(project.id)).vocalStemFilename).toBe(attached.vocalStemFilename);
    expect(await readFile(join(PATHS.music, attached.vocalStemFilename))).toEqual(bytes);
  } finally {
    release();
  }
});
