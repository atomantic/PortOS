import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FAL_FEATURED_IMAGE_MODEL_IDS } from '../lib/falImageModels.js';
import { _createFalImageModelCatalog } from './falImageModelCatalog.js';

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

function page(models, { hasMore = false, cursor = null } = {}) {
  return { ok: true, status: 200, json: async () => ({ models, has_more: hasMore, next_cursor: cursor }) };
}

function model(id, { category = 'text-to-image', name = id, kind = 'inference', status = 'active' } = {}) {
  return { endpoint_id: id, metadata: { display_name: name, category, kind, status } };
}

async function setup(fetchPage = vi.fn()) {
  const root = await mkdtemp(join(tmpdir(), 'fal-image-catalog-'));
  directories.push(root);
  const cachePath = join(root, 'catalog.json');
  let time = 1_000_000;
  const fetchSchema = vi.fn();
  const catalog = _createFalImageModelCatalog({ cachePath, fetchPage, fetchSchema, now: () => time });
  return { catalog, cachePath, fetchPage, fetchSchema, advance: (ms) => { time += ms; } };
}

describe('fal.ai image model catalog', () => {
  it('merges both categories, keeps priced curated labels, and always offers the featured endpoints', async () => {
    const fetchPage = vi.fn(async (url) => {
      const category = new URL(url).searchParams.get('category');
      if (category === 'text-to-image') {
        return page([
          model('fal-ai/flux/schnell', { name: 'FLUX Schnell' }),
          model('fal-ai/nano-banana-pro', { name: 'LIVE NAME' }),
          model('not a model'),
          model('fal-ai/trainer/x', { kind: 'training' }),
          model('fal-ai/retired/x', { status: 'deprecated' }),
        ], { hasMore: true, cursor: 'next' });
      }
      return page([
        model('fal-ai/nano-banana-pro/edit', { category: 'image-to-image', name: 'LIVE EDIT' }),
        model('fal-ai/flux/schnell/image-to-image', { category: 'image-to-image', name: 'Schnell Edit' }),
      ]);
    });
    // The second text-to-image page is the cursor follow-up. Answer it by call order after the first text page.
    const first = fetchPage.getMockImplementation();
    let textPages = 0;
    fetchPage.mockImplementation(async (url) => {
      const category = new URL(url).searchParams.get('category');
      if (category === 'text-to-image') {
        textPages += 1;
        if (textPages > 1) return page([model('fal-ai/flux/dev', { name: 'FLUX Dev' })]);
      }
      return first(url);
    });
    const { catalog, fetchPage: fetcher, cachePath } = await setup(fetchPage);
    const [loaded, concurrent] = await Promise.all([catalog.get(), catalog.get()]);
    expect(loaded).toEqual(concurrent);
    expect(fetcher).toHaveBeenCalledTimes(3);
    const ids = loaded.models.map((row) => row.id);
    expect(ids.slice(0, 4)).toEqual([...FAL_FEATURED_IMAGE_MODEL_IDS]);
    expect(ids).toContain('fal-ai/flux/schnell');
    expect(ids).toContain('fal-ai/flux/dev');
    expect(ids).toContain('fal-ai/flux/schnell/image-to-image');
    expect(ids).not.toContain('not a model');
    expect(ids).not.toContain('fal-ai/trainer/x');
    expect(ids).not.toContain('fal-ai/retired/x');
    expect(loaded.models.find((row) => row.id === 'fal-ai/nano-banana-pro').label).toContain('$0.15/image');
    expect(loaded.models.find((row) => row.id === 'fal-ai/nano-banana-pro').label).not.toContain('LIVE NAME');
    expect(loaded.bundled).toBe(false);
    expect(loaded.truncated).toBe(false);
    const disk = JSON.parse(await readFile(cachePath, 'utf8'));
    expect(disk.live.map((row) => row.id)).toContain('fal-ai/flux/schnell');
    expect(disk.live.every((row) => !('thumbnail' in row))).toBe(true);
    const restarted = _createFalImageModelCatalog({
      cachePath, fetchPage: vi.fn(), fetchSchema: vi.fn(), now: () => 1_000_000,
    });
    const again = await restarted.get();
    expect(again.models.map((row) => row.id)).toContain('fal-ai/flux/schnell');
    expect(restarted.current().bundled).toBe(false);
  });

  it('keeps the last good list when a refresh is rate-limited or malformed, and stores an empty live list', async () => {
    const fetchPage = vi.fn(async (url) => page(
      new URL(url).searchParams.get('category') === 'text-to-image'
        ? [model('fal-ai/flux/schnell', { name: 'FLUX Schnell' })]
        : [],
    ));
    const { catalog, fetchPage: fetcher, advance } = await setup(fetchPage);
    const first = await catalog.get();
    expect(first.models.some((row) => row.id === 'fal-ai/flux/schnell')).toBe(true);
    fetcher.mockImplementation(async () => ({ ok: false, status: 429, json: async () => ({}) }));
    advance(24 * 60 * 60 * 1000);
    const limited = await catalog.get();
    expect(limited.stale).toBe(true);
    expect(limited.error).toContain('HTTP 429');
    expect(limited.models.some((row) => row.id === 'fal-ai/flux/schnell')).toBe(true);
    const duringBackoff = await catalog.get();
    expect(duringBackoff.models).toEqual(limited.models);
    fetcher.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ nope: true }) }));
    advance(5 * 60 * 1000);
    const malformed = await catalog.get();
    expect(malformed.error).toContain('malformed');
    expect(malformed.models.some((row) => row.id === 'fal-ai/flux/schnell')).toBe(true);
    fetcher.mockImplementation(async () => page([]));
    const emptied = await catalog.get({ refresh: true });
    expect(emptied.models.map((row) => row.id).slice(0, 4)).toEqual([...FAL_FEATURED_IMAGE_MODEL_IDS]);
    expect(emptied.models.some((row) => row.id === 'fal-ai/flux/schnell')).toBe(false);
    expect(emptied.bundled).toBe(false);
  });

  it('marks a list truncated when fal.ai still has another page and ignores a corrupt disk cache', async () => {
    const fetchPage = vi.fn(async (url) => page(
      [model('fal-ai/flux/schnell', { name: 'FLUX Schnell' })],
      { hasMore: new URL(url).searchParams.get('category') === 'text-to-image' },
    ));
    const { catalog, cachePath } = await setup(fetchPage);
    const loaded = await catalog.get();
    expect(loaded.truncated).toBe(true);
    expect(loaded.models.some((row) => row.id === 'fal-ai/flux/schnell')).toBe(true);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(cachePath, '{');
    const fresh = _createFalImageModelCatalog({
      cachePath, fetchPage: vi.fn(async () => { throw new Error('offline'); }), fetchSchema: vi.fn(), now: () => 2_000_000,
    });
    const fallback = await fresh.get();
    expect(fallback.bundled).toBe(true);
    expect(fallback.models.map((row) => row.id).slice(0, 4)).toEqual([...FAL_FEATURED_IMAGE_MODEL_IDS]);
    expect(fallback.models.some((row) => row.id === 'fal-ai/flux/schnell')).toBe(false);
  });

  it('caches a usable input schema and refuses a schema fal.ai will not describe', async () => {
    const spec = {
      paths: { '/': { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Input' } } } } } } },
      components: { schemas: { Input: {
        required: ['prompt'],
        properties: {
          prompt: { type: 'string' },
          image_size: { anyOf: [{ $ref: '#/components/schemas/ImageSize' }, { type: 'string', enum: ['square_hd'] }] },
        },
      }, ImageSize: { type: 'object', properties: { width: { type: 'integer' }, height: { type: 'integer' } } } } },
    };
    const { catalog, fetchSchema } = await setup();
    fetchSchema.mockResolvedValue({ ok: true, status: 200, json: async () => spec });
    const schema = await catalog.inputSchema('fal-ai/flux/schnell');
    expect(schema).toMatchObject({ prompt: true, imageSize: { kind: 'pixels' }, seed: false });
    await catalog.inputSchema('fal-ai/flux/schnell');
    expect(fetchSchema).toHaveBeenCalledTimes(1);
    fetchSchema.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    await expect(catalog.inputSchema('fal-ai/other/model')).rejects.toThrow('HTTP 404');
  });
});
