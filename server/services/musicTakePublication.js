/** Stage potentially slow audio encoding outside the backup cut, then publish
 * its final bytes and track row under one admission lease. */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withBackupAssetPublication } from '../lib/backupSnapshotBoundary.js';
import { PATHS, ensureDir } from '../lib/fileUtils.js';
import { writeWavAudioFile } from '../lib/wavAudioFile.js';
import * as tracks from './tracks/index.js';

export async function publishMusicTake({ trackId, wav, take, patch = {} }) {
  const stageDir = await mkdtemp(join(tmpdir(), 'portos-music-take-'));
  try {
    const filename = await writeWavAudioFile(wav, stageDir, `music-${randomUUID()}`);
    return await withBackupAssetPublication(async () => {
      await ensureDir(PATHS.music);
      await copyFile(join(stageDir, filename), join(PATHS.music, filename), constants.COPYFILE_EXCL);
      const track = Object.keys(patch).length
        ? await tracks.appendActiveTake(trackId, { ...take, audioFilename: filename }, patch)
        : await tracks.appendActiveTake(trackId, { ...take, audioFilename: filename });
      return { track, filename };
    });
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
}
