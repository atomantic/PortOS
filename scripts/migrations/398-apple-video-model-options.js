// Older registries without _shippedDefaults otherwise classify new entries as
// already shipped during bootstrap. Insert only this release's new IDs, without
// resurrecting an entry a newer install has explicitly removed.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '../../server/lib/fileUtils.js';
import { getShippedMediaRegistry } from '../../server/lib/mediaModels.js';

const NEW_IDS = ['fasth3_v2_int8', 'fasth3_v2_int6', 'minimax_h3_6bit', 'minimax_h3_4bit'];

export default {
  async up({ rootDir }) {
    const path = join(rootDir, 'data/media-models.json');
    const raw = await readFile(path, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (raw === null) return;
    const registry = JSON.parse(raw);
    const key = Array.isArray(registry.video?.mlx) ? 'mlx'
      : Array.isArray(registry.video?.macos) ? 'macos' : null;
    if (!key) return;
    const seed = getShippedMediaRegistry();
    const defaults = seed.video.mlx;
    const entries = registry.video[key];
    const recorded = registry._shippedDefaults?.video?.mlx ?? registry._shippedDefaults?.video?.macos;
    const shipped = new Set(Array.isArray(recorded) ? recorded : defaults.filter((entry) => !NEW_IDS.includes(entry.id)).map((entry) => entry.id));
    const existing = new Set(entries.map((entry) => entry.id));
    for (const id of NEW_IDS) {
      if (existing.has(id) || shipped.has(id)) continue;
      const entry = defaults.find((candidate) => candidate.id === id);
      if (!entry) throw new Error(`Missing shipped video option: ${id}`);
      entries.push(entry);
    }
    registry._shippedDefaults ??= {};
    registry._shippedDefaults.video ??= {};
    registry._shippedDefaults.video[key] = [...new Set([...shipped, ...existing, ...NEW_IDS])];
    const next = `${JSON.stringify(registry, null, 2)}\n`;
    if (next !== raw) await atomicWrite(path, next);
  },
};
