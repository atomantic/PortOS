/**
 * The fal.ai image model list, read from fal's public model search and cached on disk for a day.
 *
 * A listed (non-curated) model must be on this list, and its OpenAPI must describe a prompt,
 * before a paid render is submitted to it.
 */

import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { PATHS } from '../lib/paths.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { ServerError } from '../lib/errorHandler.js';
import {
  FAL_FEATURED_IMAGE_MODEL_IDS,
  falImageFamily,
  falImageModelChoices,
  falInputSchemaFromOpenApi,
  isPlausibleFalEndpointId,
} from '../lib/falImageModels.js';

/** Public model search. No API key: favoriting is unused, and the key must not ride on this list. */
export const FAL_IMAGE_CATALOG_SOURCE = 'https://api.fal.ai/v1/models';
const SCHEMA_SOURCE = 'https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=';
const CATEGORIES = Object.freeze(['text-to-image', 'image-to-image']);
const TTL = 24 * 60 * 60 * 1000;
const RETRY = 5 * 60 * 1000;
const PAGE_LIMIT = 100;
const MAX_PAGES = 10;
// Featured ids and the categories define the cache. Price labels are rebuilt from code, so a price edit does not need a new file.
const VERSION = createHash('sha256').update(JSON.stringify({ featured: FAL_FEATURED_IMAGE_MODEL_IDS, categories: CATEGORIES })).digest('hex');

function liveRow(model, category) {
  const id = typeof model?.endpoint_id === 'string' ? model.endpoint_id.trim() : '';
  if (!isPlausibleFalEndpointId(id)) return null;
  const meta = model?.metadata || {};
  if (meta.kind && meta.kind !== 'inference') return null;
  if (meta.status && meta.status !== 'active') return null;
  const label = typeof meta.display_name === 'string' && meta.display_name.trim() ? meta.display_name.trim() : id;
  return { id, label, category };
}

async function readPage(fetchPage, category, cursor) {
  const url = new URL(FAL_IMAGE_CATALOG_SOURCE);
  url.searchParams.set('category', category);
  url.searchParams.set('status', 'active');
  url.searchParams.set('limit', String(PAGE_LIMIT));
  if (cursor) url.searchParams.set('cursor', cursor);
  const res = await fetchPage(url.toString());
  if (!res?.ok) throw new Error(`HTTP ${res?.status ?? 0}`);
  const body = await res.json();
  if (!Array.isArray(body?.models)) throw new Error('malformed fal.ai model list');
  return body;
}

/**
 * One category, fully read or not started. A failed page throws so the caller
 * keeps the last good list instead of saving a partial one.
 */
async function fetchCategory(fetchPage, category) {
  const rows = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = await readPage(fetchPage, category, cursor);
    for (const model of body.models) {
      const row = liveRow(model, category);
      if (row) rows.push(row);
    }
    if (!body.has_more) return { rows, truncated: false };
    if (typeof body.next_cursor !== 'string' || !body.next_cursor || page === MAX_PAGES - 1) {
      return { rows, truncated: true };
    }
    cursor = body.next_cursor;
  }
  return { rows, truncated: true };
}

function diskLive(disk) {
  if (!disk || disk.version !== VERSION || !Number.isFinite(disk.fetchedAt) || !Array.isArray(disk.live)) return null;
  const live = [];
  for (const row of disk.live) {
    if (!row || !isPlausibleFalEndpointId(row.id) || typeof row.label !== 'string') return null;
    if (!CATEGORIES.includes(row.category)) return null;
    live.push({ id: row.id.trim(), label: row.label, category: row.category });
  }
  return { fetchedAt: disk.fetchedAt, truncated: disk.truncated === true, live };
}

/**
 * Public fal.ai image endpoints, cached on this machine. Curated rows are
 * merged back in at read time, so the file stores only live ids and labels —
 * no credentials, thumbnails, or prices.
 */
export function _createFalImageModelCatalog({
  fetchPage = (url) => fetchWithTimeout(url, {}, 15_000),
  fetchSchema = (endpointId) => fetchWithTimeout(`${SCHEMA_SOURCE}${encodeURIComponent(endpointId)}`, {}, 15_000),
  cachePath = join(PATHS.installRoot, '.cache', 'fal-image-model-catalog.json'),
  now = Date.now,
} = {}) {
  let cached = null;
  let loading = null;
  let pending = null;
  let pendingForced = false;
  let retryAt = 0;
  let error = null;
  const schemas = new Map();
  const present = () => ({
    models: falImageModelChoices(cached?.live || []),
    source: FAL_IMAGE_CATALOG_SOURCE,
    fetchedAt: cached?.fetchedAt ?? null,
    stale: !cached || now() - cached.fetchedAt >= TTL || !!error,
    bundled: !cached,
    error,
    truncated: cached?.truncated === true,
  });
  const read = () => (loading ||= load());
  async function load() {
    const disk = await readFile(cachePath, 'utf8').then(JSON.parse).catch(() => null);
    const parsed = diskLive(disk);
    if (parsed && parsed.fetchedAt <= now()) cached = parsed;
  }
  async function refresh() {
    try {
      const pages = await Promise.all(CATEGORIES.map((category) => fetchCategory(fetchPage, category)));
      const seen = new Set();
      const live = [];
      let truncated = false;
      for (const page of pages) {
        truncated = truncated || page.truncated;
        for (const row of page.rows) {
          if (seen.has(row.id)) continue;
          seen.add(row.id);
          live.push(row);
        }
      }
      cached = { fetchedAt: now(), truncated, live };
      error = null;
      retryAt = 0;
      await mkdir(dirname(cachePath), { recursive: true });
      const file = { version: VERSION, fetchedAt: cached.fetchedAt, truncated, live };
      await writeFile(`${cachePath}.tmp`, JSON.stringify(file));
      await rename(`${cachePath}.tmp`, cachePath);
    } catch (err) {
      error = `fal.ai image catalog refresh unavailable: ${err.message}`;
      retryAt = now() + RETRY;
    }
    return present();
  }
  return {
    current: present,
    ready: read,
    async get({ refresh: force = false } = {}) {
      if (pending) {
        if (force && !pendingForced) return pending.then(() => this.get({ refresh: true }));
        return pending;
      }
      pendingForced = force;
      pending = (async () => {
        await read();
        if (!force && (now() < retryAt || (cached && now() - cached.fetchedAt < TTL))) return present();
        return refresh();
      })().finally(() => { pending = null; });
      return pending;
    },
    async inputSchema(endpointId) {
      const id = typeof endpointId === 'string' ? endpointId.trim() : '';
      const hit = schemas.get(id);
      if (hit && now() - hit.fetchedAt < TTL) return hit.schema;
      const res = await fetchSchema(id);
      if (!res?.ok) throw new Error(`HTTP ${res?.status ?? 0}`);
      const schema = falInputSchemaFromOpenApi(await res.json());
      if (!schema?.prompt) throw new Error('fal.ai schema has no prompt');
      schemas.set(id, { fetchedAt: now(), schema });
      return schema;
    },
    async assertAvailable(modelId) {
      const id = typeof modelId === 'string' ? modelId.trim() : '';
      if (falImageFamily(id)) return;
      if (!isPlausibleFalEndpointId(id)) {
        throw new ServerError(`fal.ai Imagegen has no model "${modelId}"`, { status: 400, code: 'FAL_IMAGE_MODEL_UNKNOWN' });
      }
      const current = await this.get();
      if (!current.models.some((row) => row.id === id)) {
        throw new ServerError(
          `fal.ai Imagegen has no model "${id}" — refresh the model list or choose another endpoint`,
          { status: 400, code: 'FAL_IMAGE_MODEL_UNKNOWN' },
        );
      }
    },
  };
}

const catalog = _createFalImageModelCatalog();
export const getFalImageModelCatalog = (options) => catalog.get(options);
export const falImageInputSchema = (endpointId) => catalog.inputSchema(endpointId);

/** Curated families skip the list. Anything else must be on the loaded list before a paid submit. */
export const assertFalImageModelAvailable = (modelId) => catalog.assertAvailable(modelId);
