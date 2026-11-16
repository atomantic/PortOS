/**
 * Pin `voice.llm.provider: 'lmstudio'` for installs that were relying on it being the default.
 *
 * `VOICE_DEFAULTS.llm.provider` changes from 'lmstudio' to 'ollama' in this release, and voice config is a sparse patch merged over the defaults (`getVoiceConfig` → `deepMerge(VOICE_DEFAULTS, settings.voice)`), so an install that configured voice without touching the provider would silently switch to an Ollama daemon that may not be running and re-provision models it already has in LM Studio.
 * Only an install that has ALREADY configured voice is pinned; a `settings.json` with no `voice` key expressed no preference and is who the new default is for. Gates on the presence of its INPUT (a stored `voice` object without an explicit `llm.provider`), never the absence of its output (AGENTS.md); re-running is a no-op because the first run writes the field the gate checks.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from './_lib.js';

export default {
  async up({ rootDir }) {
    const path = join(rootDir, 'data', 'settings.json');
    const raw = await readFile(path, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (raw === null) return;

    const settings = JSON.parse(raw);
    // No stored voice config at all — never configured, so the new default applies.
    if (!settings.voice || typeof settings.voice !== 'object') return;
    // Already explicit (either backend, or a remote provider) — respect it.
    if (typeof settings.voice.llm?.provider === 'string' && settings.voice.llm.provider) return;

    settings.voice.llm = { ...(settings.voice.llm || {}), provider: 'lmstudio' };
    await writeJsonAtomic(path, settings);
    console.log('🎙️ Voice: pinned llm.provider=lmstudio (the default is now ollama; change it in Settings → Voice)');
  },
};
