/** Replace Grok Build's shipped placeholder with its verified grok-4.6 model.
 * Preserve custom models and argv; old sentinel handling remains supported.
 */
import { writeFile } from 'fs/promises';
import { readProvidersDoc } from './_lib.js';

const LEGACY = new Set(['grok-configured-default', 'grok-build']);
const MODEL = 'grok-4.6';
const FIELDS = ['defaultModel', 'lightModel', 'mediumModel', 'heavyModel', 'fallbackModel'];

export default {
  async up({ rootDir }) {
    const doc = await readProvidersDoc({ rootDir });
    if (!doc.ok) return;
    let changed = false;
    for (const id of ['grok-cli', 'grok-tui']) {
      const provider = doc.providers[id];
      if (!provider || typeof provider !== 'object') continue;
      if (Array.isArray(provider.models) && provider.models.some(model => LEGACY.has(model))) {
        provider.models = [...new Set(provider.models.map(model => LEGACY.has(model) ? MODEL : model))];
        changed = true;
      }
      for (const field of FIELDS) {
        if (!LEGACY.has(provider[field])) continue;
        provider[field] = MODEL;
        changed = true;
      }
    }
    if (changed) await writeFile(doc.path, `${JSON.stringify(doc.config, null, 2)}\n`);
  }
};
