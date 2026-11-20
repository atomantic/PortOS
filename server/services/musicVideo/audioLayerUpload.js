/**
 * Music Video: add an uploaded audio file to the editor timeline as a new
 * audio layer (audioLayers.js holds the record shape and the mix rules).
 */

import { unlink } from 'fs/promises';
import { ServerError } from '../../lib/errorHandler.js';
import { probeVideoDuration } from '../../lib/ffmpeg.js';
import { assertFileNotMediaManifest } from '../../lib/uploads.js';
import { importUploadedTrack } from '../pipeline/musicLibrary.js';
import { AUDIO_LAYER_LIMIT, appendAudioLayer, projectAudioLayers } from './audioLayers.js';
import { mutateProjectRecord } from './projects.js';
import { requireProject } from './requireProject.js';

const layerLimit = () => new ServerError(`A video holds at most ${AUDIO_LAYER_LIMIT} audio layers. Remove one first.`, { status: 422, code: 'AUDIO_LAYER_LIMIT' });

/**
 * Probe the upload for its length (refused when it has none), copy it under
 * data/music/ and append it as a layer at `startSec` in one serialized write.
 * The temp upload is always removed.
 */
export async function addAudioLayer(projectId, { tempPath, originalName, startSec = 0 }) {
  try {
    const project = await requireProject(projectId);
    if (projectAudioLayers(project).length >= AUDIO_LAYER_LIMIT) throw layerLimit();
    // Before the probe: ffmpeg would follow a playlist posing as audio.
    await assertFileNotMediaManifest(tempPath);
    const durationSec = await probeVideoDuration(tempPath).catch(() => null);
    if (!(durationSec > 0)) {
      throw new ServerError('Could not read that audio file. Is it MP3, WAV, M4A, OGG or FLAC?', { status: 400, code: 'AUDIO_LAYER_UNREADABLE' });
    }
    const { filename } = await importUploadedTrack(tempPath, originalName);
    const { project: saved, layer } = await mutateProjectRecord(projectId, (current) => {
      // Re-checked under the write lock: another upload may have landed meanwhile.
      if (projectAudioLayers(current).length >= AUDIO_LAYER_LIMIT) throw layerLimit();
      const next = appendAudioLayer(current.audioLayers, { filename, originalName, durationSec, startSec });
      return { project: { ...current, audioLayers: next.layers }, layer: next.layer };
    });
    console.log(`🎚️ Audio layer added to ${projectId.slice(0, 8)} at ${layer.startSec}s (${layer.durationSec}s)`);
    return { project: saved, layer };
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}
