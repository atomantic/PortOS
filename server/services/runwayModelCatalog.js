import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { PATHS } from '../lib/paths.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { RUNWAY_CATALOG_SNAPSHOT } from '../lib/runwayCatalogSnapshot.js';
import { runwaySpecialSchemaContract } from '../lib/runwaySpecialVideoModels.js';

export const RUNWAY_CATALOG_SOURCE = 'https://docs.dev.runwayml.com/openapi.json';
const TTL = 24 * 60 * 60 * 1000;
const RETRY = 5 * 60 * 1000;
// A new shipped snapshot invalidates even a fresh disk cache from an older install.
const VERSION = createHash('sha256').update(JSON.stringify(RUNWAY_CATALOG_SNAPSHOT)).digest('hex');
const fallback = Object.fromEntries(Object.entries(RUNWAY_CATALOG_SNAPSHOT).map(([endpoint, rows]) => [endpoint, rows.map(({ id }) => id)]));
const limitations = [];

function compatibleSchema(row, expected) {
  if (expected.contract) return JSON.stringify(runwaySpecialSchemaContract(row)) === JSON.stringify(expected.contract);
  const p = row.properties;
  const required = row.required || [];
  const allowed = ['model', 'promptText', 'ratio', 'duration', 'promptImage', 'referenceImages'];
  if (required.some((key) => !allowed.includes(key))) return false;
  const d = p.duration?.anyOf?.find((v) => ['integer', 'number'].includes(v.type)) || p.duration || {};
  const ratios = p.ratio?.enum || p.ratio?.anyOf?.find((v) => v.enum)?.enum || [];
  const imageArray = p.promptImage?.anyOf?.find((v) => v.type === 'array');
  const endImage = (imageArray?.items?.properties?.position?.enum || []).includes('last');
  const sameValues = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  return endImage === expected.endImage
    && ('tag' in (p.referenceImages?.items?.properties || {})) === expected.referenceTags
    && required.includes('referenceImages') === (expected.minReferences > 0)
    && p.promptText?.maxLength === expected.promptMax && p.promptText?.minLength === expected.promptMin
    && required.includes('promptText') === expected.promptRequired
    && required.includes('ratio') === expected.ratioRequired
    && sameValues(ratios, expected.ratios)
    && sameValues((p.resolution?.enum || []).map((r) => r.toLowerCase()).filter((r, i, all) => all.indexOf(r) === i), expected.resolutions)
    && (p.seed?.maximum ?? null) === expected.seedMax
    && (p.negativePrompt?.maxLength || 0) === expected.negativePromptMax
    && ('seed' in p) === expected.seed && ('audio' in p) === expected.audio
    && (p.referenceImages?.minItems || 0) === expected.minReferences
    && (p.referenceImages?.maxItems || 0) === expected.maxReferences
    && d.minimum === expected.duration.minimum && d.maximum === expected.duration.maximum
    && sameValues(d.enum || [], expected.duration.enum || []);
}

function parseCatalog(spec) {
  if (spec?.info?.version !== '2024-11-06') throw new Error('Unsupported Runway API schema version');
  const available = {};
  const unsupported = [...limitations];
  for (const endpoint of Object.keys(fallback)) {
    const rows = spec.paths?.[`/v1/${endpoint}`]?.post?.requestBody?.content?.['application/json']?.schema?.oneOf;
    if (!Array.isArray(rows)) throw new Error(`Missing Runway ${endpoint} schema`);
    const ids = rows.map((row) => row?.properties?.model?.const);
    if (ids.some((id) => typeof id !== 'string' || !id || id.length > 100)) throw new Error('Invalid Runway model identifiers');
    available[endpoint] = [];
    for (const row of rows) {
      const id = row.properties.model.const;
      const known = RUNWAY_CATALOG_SNAPSHOT[endpoint].find((item) => item.id === id);
      if (known && compatibleSchema(row, known)) available[endpoint].push(id);
      else unsupported.push({ id, reason: `${endpoint}: requires a PortOS capability update` });
    }
    available[endpoint] = [...new Set(available[endpoint])];
  }
  return { available, unsupported };
}

/** Public documentation, never an invented /models API or an authenticated generation probe.
 * One bounded, machine-local disposable cache; no user data, credentials or federation.
 */
export function _createRunwayModelCatalog({
  fetchSchema = () => fetchWithTimeout(RUNWAY_CATALOG_SOURCE, {}, 15_000),
  cachePath = join(PATHS.installRoot, '.cache', 'runway-model-catalog.json'), now = Date.now,
} = {}) {
  let cached = null;
  let loaded = false;
  let pending = null;
  let pendingForced = false;
  let retryAt = 0;
  let error = null;
  const present = () => ({
    ...(cached?.catalog || { available: fallback, unsupported: limitations }),
    source: RUNWAY_CATALOG_SOURCE, fetchedAt: cached?.fetchedAt ?? null,
    stale: !cached || now() - cached.fetchedAt >= TTL || !!error,
    bundled: !cached, error,
  });
  async function read() {
    if (loaded) return;
    loaded = true;
    const disk = await readFile(cachePath, 'utf8').then(JSON.parse).catch(() => null);
    if (disk?.version === VERSION && Number.isFinite(disk.fetchedAt) && disk.fetchedAt <= now()
      && Object.keys(fallback).every((key) => Array.isArray(disk.catalog?.available?.[key])
        && disk.catalog.available[key].every((id) => fallback[key].includes(id)))
      && Array.isArray(disk.catalog?.unsupported) && disk.catalog.unsupported.every((row) => typeof row?.id === 'string' && typeof row?.reason === 'string')) cached = disk;
  }
  async function refresh() {
    try {
      const res = await fetchSchema();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const catalog = parseCatalog(await res.json());
      cached = { version: VERSION, fetchedAt: now(), catalog };
      error = null;
      retryAt = 0;
      // A disk failure must not throw away a valid in-memory catalog.
      await mkdir(dirname(cachePath), { recursive: true });
      await writeFile(`${cachePath}.tmp`, JSON.stringify(cached));
      await rename(`${cachePath}.tmp`, cachePath);
    } catch (err) {
      error = `Runway catalog refresh unavailable: ${err.message}`;
      retryAt = now() + RETRY;
    }
    return present();
  }
  return {
    current: present,
    /** Loads the persisted cache only; never fetches documentation. */
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
  };
}
const catalog = _createRunwayModelCatalog();
export const getRunwayModelCatalog = (options) => catalog.get(options);

/** Refreshed removals/schema changes fail before a paid submission. No catalog lookup per render. */
export async function assertRunwayCatalogModel(endpoint, modelId) {
  await catalog.ready(); // a restart must not submit from the bundled list before the persisted refresh loads
  const current = catalog.current();
  if (current.available[endpoint] && !current.available[endpoint].includes(modelId)) {
    throw Object.assign(new Error(`Runway ${modelId} is unavailable for ${endpoint}; refresh the model catalog or choose another model`), { status: 400, code: 'RUNWAY_MODEL_UNAVAILABLE' });
  }
}
