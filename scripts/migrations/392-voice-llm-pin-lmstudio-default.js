/**
 * Pin `voice.llm.provider: 'lmstudio'` for installs that were relying on it
 * being the default.
 *
 * `VOICE_DEFAULTS.llm.provider` changes from 'lmstudio' to 'ollama' in this
 * release. Voice config is stored as a sparse patch merged over the defaults
 * (`getVoiceConfig` → `deepMerge(VOICE_DEFAULTS, settings.voice)`), so an
 * install that configured voice without ever touching the provider field would
 * silently switch backends on upgrade — pointing at an Ollama daemon that may
 * not be running, and re-provisioning models it already has in LM Studio.
 *
 * Only an install that has ALREADY configured voice is pinned. A `settings.json`
 * with no `voice` key has expressed no preference and is exactly who the new
 * default is for, so it is deliberately left alone rather than pinned to the
 * outgoing backend.
 *
 * Gates on the presence of its INPUT (a stored `voice` object without an
 * explicit `llm.provider`), never on the absence of its output — per the
 * migration rule in AGENTS.md. Re-running is a no-op because the first run
 * writes the very field the gate checks for.
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
