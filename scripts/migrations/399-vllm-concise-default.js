/**
 * Make the Qwen vLLM OpenCode wrappers concise by default.
 *
 * Qwen's chat template enables reasoning when the request omits the flag. Keep
 * an explicit operator choice intact; only fill the previously-unset default.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '../../server/lib/fileUtils.js';

const IDS = new Set(['opencode-vllm', 'opencode-vllm-tui']);

export default {
  async up({ rootDir }) {
    const path = join(rootDir, 'data/providers.json');
    const raw = await readFile(path, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (raw === null) return;
    const document = JSON.parse(raw);
    const providers = document.providers;
    if (!providers || typeof providers !== 'object') return;
    let changed = false;
    for (const [id, provider] of Object.entries(providers)) {
      if (!IDS.has(id) || !provider || typeof provider !== 'object' || Object.hasOwn(provider, 'thinking')) continue;
      provider.thinking = false;
      changed = true;
    }
    if (changed) await atomicWrite(path, document);
  },
};
