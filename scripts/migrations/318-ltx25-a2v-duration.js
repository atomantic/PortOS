/**
 * Persist the LTX-2.5 audio-duration contract for installs whose model registry
 * predates image+audio A2V exposure. The load-time twin in mediaModels.js makes
 * the fields available on this same boot; this migration keeps the user's file
 * explicit for later restarts and hand editing.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { atomicWrite } from '../../server/lib/fileUtils.js';
import { VIDEO_BUCKET_MLX, readVideoBucket } from '../../server/lib/mediaModelBuckets.js';
import { LTX25_AUDIO_PROFILE } from '../../server/lib/videoDurationProfiles.js';

const REL_PATH = 'data/media-models.json';
const PROFILE_KEYS = Object.freeze(['audioDurationDriven', 'frameStride', 'maxNumFrames']);

export default {
  async up({ rootDir }) {
    const path = join(rootDir, REL_PATH);
    const raw = await readFile(path, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw == null) return;
    let config;
    try {
      config = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Cannot migrate ${REL_PATH}: invalid JSON (${err.message})`, { cause: err });
    }
    const entries = readVideoBucket(config?.video, VIDEO_BUCKET_MLX);
    if (!Array.isArray(entries)) return;
    const model = entries.find((entry) => (
      entry?.id === LTX25_AUDIO_PROFILE.id
      && entry.repo === LTX25_AUDIO_PROFILE.repo
      && entry.revision === LTX25_AUDIO_PROFILE.revision
    ));
    if (!model) return;
    const missing = PROFILE_KEYS.filter((key) => !Object.hasOwn(model, key));
    if (missing.length === 0) return;
    for (const key of missing) model[key] = LTX25_AUDIO_PROFILE[key];
    await atomicWrite(path, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`📝 ${REL_PATH}: enabled duration-driven LTX-2.5 audio-to-video`);
  },
};
