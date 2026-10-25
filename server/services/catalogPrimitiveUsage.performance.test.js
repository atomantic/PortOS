import { describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ count: 0, entries: [] }));
vi.mock('../lib/db.js', () => ({ query: async (sql) => {
  state.count += 1;
  if (sql.includes('FROM universes')) return { rows: [{ id: 'example-world', entries: state.entries }] };
  if (sql.includes('FROM fableloom_stories') || sql.includes('FROM voice_profiles') || sql.includes('FROM pipeline_series')) return { rows: [] };
  throw new Error('Unexpected query');
} }));
vi.mock('./catalogDB/ingredients.js', () => ({ getIngredientIdentityIds: async () => ['example-primitive'] }));
import { listPrimitiveUsages } from './catalogPrimitiveUsage.js';
describe('bounded usage query fan-out', () => {
  it.each([1, 10, 50])('measures %s aliases in the same universe', async (size) => {
    state.count = 0;
    state.entries = Array.from({ length: size }, (_, i) => ({ id: `example-${i}`, name: `Example ${i}`, ingredientId: 'example-primitive', kind: 'character' }));
    await listPrimitiveUsages('example-primitive', [{ refKind: 'universe', refId: 'example-world' }]);
    console.log(`📊 Batched usage query seam: entries=${size}, queries=${state.count}; excludes the mocked identity lookup; includes scoped prose query`);
    expect(state.count).toBe(4);
  });
});
