import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _createRunwayModelCatalog } from './runwayModelCatalog.js';

// Real public OpenAPI excerpts (2026-10-22), descriptions removed; no generation endpoint is called.
const fixture = JSON.parse(await readFile(new URL('./fixtures/runwayOpenApi.json', import.meta.url), 'utf8'));
const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'runway-catalog-'));
  directories.push(root);
  const cachePath = join(root, 'catalog.json');
  let time = 1_000_000;
  const fetchSchema = vi.fn(async () => ({ ok: true, json: async () => structuredClone(fixture) }));
  const options = { cachePath, fetchSchema, now: () => time };
  return { cache: _createRunwayModelCatalog(options), options, fetchSchema, advance: (ms) => { time += ms; } };
}
describe('Runway public catalog cache', () => {
  it('coalesces form loads, survives restart, expires and honors explicit refresh/removals', async () => {
    const { cache, options, fetchSchema, advance } = await setup();
    const [first, concurrent] = await Promise.all([cache.get(), cache.get()]);
    expect(first).toEqual(concurrent);
    expect(first.available.text_to_image).toEqual(['gen4_image', 'gpt_image_2']);
    expect(first.available.text_to_video).not.toContain('gen4_turbo');
    expect(first.available.video_to_video).toEqual(['aleph2']);
    expect(first.available.character_performance).toEqual(['act_two']);
    expect(fetchSchema).toHaveBeenCalledTimes(1);
    await cache.get();
    await _createRunwayModelCatalog(options).get();
    expect(fetchSchema).toHaveBeenCalledTimes(1);
    advance(24 * 60 * 60 * 1000);
    await cache.get();
    expect(fetchSchema).toHaveBeenCalledTimes(2);
    const removed = structuredClone(fixture);
    removed.paths['/v1/text_to_image'].post.requestBody.content['application/json'].schema.oneOf = [];
    fetchSchema.mockResolvedValue({ ok: true, json: async () => removed });
    const refreshed = await cache.get({ refresh: true });
    expect(refreshed.available.text_to_image).toEqual([]); // valid empty is not fallback
    expect(refreshed.stale).toBe(false);
    await cache.get();
    expect(fetchSchema).toHaveBeenCalledTimes(3);
  });
  it('keeps last good data on timeout, malformed schema and HTTP failure, backing off repeated forms', async () => {
    const { cache, fetchSchema, advance } = await setup();
    const good = await cache.get();
    fetchSchema.mockRejectedValue(new Error('timeout'));
    advance(24 * 60 * 60 * 1000);
    const stale = await cache.get();
    expect(stale).toMatchObject({ available: good.available, stale: true, error: expect.stringContaining('timeout') });
    await cache.get();
    expect(fetchSchema).toHaveBeenCalledTimes(2);
    fetchSchema.mockResolvedValue({ ok: true, json: async () => ({}) });
    expect((await cache.get({ refresh: true })).available).toEqual(good.available);
    fetchSchema.mockResolvedValue({ ok: false, status: 403 });
    expect((await cache.get({ refresh: true })).available).toEqual(good.available);
  });
  it('falls back on cold failure/corrupt disk and invalidates an old snapshot version', async () => {
    const { cache, options, fetchSchema } = await setup();
    await writeFile(options.cachePath, 'broken');
    fetchSchema.mockRejectedValue(new Error('offline'));
    expect(await cache.get()).toMatchObject({ bundled: true, stale: true });
    await cache.get();
    expect(fetchSchema).toHaveBeenCalledTimes(1);
    await writeFile(options.cachePath, JSON.stringify({ version: 'old', fetchedAt: 1_000_000, catalog: { available: {} } }));
    fetchSchema.mockResolvedValue({ ok: true, json: async () => fixture });
    expect(await _createRunwayModelCatalog(options).get()).toMatchObject({ bundled: false, stale: false });
  });
  it('does not claim unknown or changed request schemas are runnable and preserves forced refresh during disk load', async () => {
    const { cache, options, fetchSchema } = await setup();
    await cache.get();
    const changed = structuredClone(fixture);
    const rows = changed.paths['/v1/text_to_image'].post.requestBody.content['application/json'].schema.oneOf;
    delete rows[0].properties.referenceImages.items.properties.tag;
    changed.paths['/v1/character_performance'].post.requestBody.content['application/json'].schema.oneOf[0].properties.expressionIntensity.maximum = 4;
    rows.push({ properties: { model: { const: 'future_image' } } });
    fetchSchema.mockResolvedValue({ ok: true, json: async () => changed });
    const restarted = _createRunwayModelCatalog(options);
    const load = restarted.get();
    const forced = restarted.get({ refresh: true });
    const forcedAgain = restarted.get({ refresh: true });
    await load;
    const updated = await forced;
    expect(await forcedAgain).toEqual(updated);
    expect(fetchSchema).toHaveBeenCalledTimes(2);
    expect(updated.available.text_to_image).toEqual(['gpt_image_2']);
    expect(updated.available.character_performance).toEqual([]);
    expect(updated.unsupported.map((r) => r.id)).toEqual(expect.arrayContaining(['gen4_image', 'future_image']));
  });
});
