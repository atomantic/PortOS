import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { inScopeModels, prunedSeed } from './prune-model-comparison-seed.js';

const root = join(import.meta.dirname, '..');
const readSeed = async () => JSON.parse(await readFile(join(root, 'data.reference/model-comparison.json'), 'utf8'));

describe('model comparison seed scope', () => {
  it('ships only models a shipped provider can dispatch', async () => {
    const [seed, scope] = await Promise.all([readSeed(), inScopeModels()]);
    const outOfScope = [...new Set(seed.observations.map(row => row.model))].filter(model => !scope.has(model));
    // Re-run `node scripts/prune-model-comparison-seed.js` after a sync writes
    // the full public index over the seed.
    expect(outOfScope).toEqual([]);
  });

  it('is already pruned — the checked-in seed equals the pruned seed', async () => {
    const [seed, pruned] = await Promise.all([readSeed(), prunedSeed()]);
    expect(seed.observations.length).toBe(pruned.observations.length);
  });

  it('keeps a full reasoning-effort curve for the frontier anchor', async () => {
    const seed = await readSeed();
    const efforts = seed.observations.filter(row => row.model === 'claude-fable-5.1').map(row => row.effort);
    expect([...efforts].sort()).toEqual(['high', 'low', 'max', 'medium', 'xhigh']);
  });

  it('carries no retired generation the chart would never plot', async () => {
    const models = new Set((await readSeed()).observations.map(row => row.model));
    for (const retired of ['claude-2.0', 'gpt-4', 'palm-2', 'llama-2-chat-70b']) {
      expect(models.has(retired)).toBe(false);
    }
  });
});
