// Upgrade only the retired engine; keep custom Piper settings and legacy provenance.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from './_lib.js';
import { migrateRetiredTtsConfig } from '../../server/lib/voiceEngines.js';

export default {
  async up({ rootDir }) {
    const path = join(rootDir, 'data', 'settings.json');
    const raw = await readFile(path, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (raw === null) return;
    const settings = JSON.parse(raw);
    const tts = settings.voice?.tts;
    const next = migrateRetiredTtsConfig(tts);
    if (next === tts) return;
    settings.voice.tts = next;
    await writeJsonAtomic(path, settings);
    console.log('🗣 Kokoro retired: open Settings → Voice and use Save & Reconcile to set up Piper.');
  },
};
