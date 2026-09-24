/** Shipped public reference data and machine-local PortOS benchmark observations. */
import { join } from 'path';
import { ServerError } from '../lib/errorHandler.js';
import { readFile } from 'fs/promises';
import { PATHS } from '../lib/paths.js';
import { atomicWrite } from '../lib/fileCore.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { modelComparisonCatalogSchema, modelComparisonImportSchema } from '../lib/validation.js';

const queueWrite = createFileWriteQueue();
const catalogPath = () => join(PATHS.data, 'model-comparison.json');
const isPortosBenchmarkObservation = row => row?.id?.startsWith('portos:')
  || /^PortOS Task Bench v\d+\b/.test(row?.benchmark || '');
const hasPortosRunSource = row => [
  row?.quality, row?.costPerTask, row?.inputPerMillion, row?.outputPerMillion,
  row?.reasoningPerMillion, row?.responseSeconds, row?.tokensPerSecond,
  row?.tokensPerRun, row?.inputTokens, row?.outputTokens, row?.apiEquivalentCost, row?.quota,
].some(metric => typeof metric?.source?.url === 'string'
  && /^portos:\/\/model-comparison\/[0-9a-f-]{36}$/i.test(metric.source.url));

export async function getModelComparison() {
  const raw = await readFile(catalogPath(), 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return readFile(join(PATHS.root, 'data.reference/model-comparison.json'), 'utf8');
  });
  // A malformed or future-version catalog must surface an error, never be
  // replaced with an empty store by the next import.
  const catalog = modelComparisonCatalogSchema.parse(JSON.parse(raw));
  return catalog;
}

/** Public comparison data always comes from the shipped catalog, never local files. */
export async function getShippedModelComparison() {
  const raw = await readFile(join(PATHS.root, 'data.reference/model-comparison.json'), 'utf8');
  const catalog = modelComparisonCatalogSchema.parse(JSON.parse(raw));
  return {
    ...catalog,
    observations: catalog.observations.filter(row =>
      !isPortosBenchmarkObservation(row) && !hasPortosRunSource(row)),
  };
}

/** Local task-benchmark history is exposed only to Models → Performance. */
export async function getPortosModelBenchmarkObservations() {
  const catalog = await getModelComparison();
  return {
    schemaVersion: catalog.schemaVersion,
    observations: catalog.observations.filter(isPortosBenchmarkObservation),
  };
}

async function mergeModelComparison(incoming) {
  const [current, publicCatalog] = await Promise.all([getModelComparison(), getPublicModelComparison()]);
  const rows = new Map([...current.observations, ...publicCatalog.observations].map(row => [row.id, row]));
  for (const row of incoming.observations) {
    const prior = rows.get(row.id);
    if (prior) {
      // Stable ids cannot silently change the meaning of existing evidence.
      for (const key of ['provider', 'model', 'effort', 'configuration', 'billing', 'benchmark']) {
        if (row[key] !== prior[key]) throw new ServerError(`Observation identity changed: ${row.id}`, { status: 409 });
      }
      for (const key of ['quality', 'costPerTask', 'apiEquivalentCost', 'inputPerMillion', 'outputPerMillion', 'reasoningPerMillion', 'responseSeconds', 'tokensPerSecond', 'tokensPerRun', 'inputTokens', 'outputTokens', 'quota']) {
        const before = prior[key];
        if (before && (!row[key] || Date.parse(row[key].source.retrievedAt) < Date.parse(before.source.retrievedAt))) row[key] = before;
      }
    }
    rows.set(row.id, row);
  }
  const result = modelComparisonCatalogSchema.parse({ schemaVersion: 1, observations: [...rows.values()] });
  await atomicWrite(catalogPath(), result);
  return result;
}

export function importModelComparison(input) {
  const incoming = modelComparisonImportSchema.parse(input);
  if (incoming.observations.some(row => isPortosBenchmarkObservation(row) || hasPortosRunSource(row))) {
    throw new ServerError('PortOS benchmark observations can only be created by the explicit benchmark run.', { status: 400 });
  }
  return queueWrite(() => mergeModelComparison(incoming));
}

export function recordPortosModelBenchmark(observation) {
  const incoming = modelComparisonImportSchema.parse({ schemaVersion: 1, observations: [observation] });
  if (!isPortosBenchmarkObservation(observation) || !hasPortosRunSource(observation)) {
    throw new ServerError('Invalid PortOS benchmark observation.', { status: 400 });
  }
  return queueWrite(() => mergeModelComparison(incoming));
}

/** Merge release evidence with researched local evidence without exposing run history. */
export async function getPublicModelComparison() {
  const [shipped, local] = await Promise.all([getShippedModelComparison(), getModelComparison()]);
  const rows = new Map(shipped.observations.map(row => [row.id, row]));
  for (const row of local.observations) {
    if (isPortosBenchmarkObservation(row) || hasPortosRunSource(row)) continue;
    const prior = rows.get(row.id);
    if (!prior) { rows.set(row.id, row); continue; }
    for (const key of ['provider', 'model', 'effort', 'configuration', 'billing', 'benchmark']) {
      if (row[key] !== prior[key]) throw new ServerError(`Observation identity changed: ${row.id}`, { status: 409 });
    }
    const merged = { ...prior };
    for (const key of Object.keys(row)) {
      if (row[key]?.source && (!prior[key]?.source || Date.parse(row[key].source.retrievedAt) >= Date.parse(prior[key].source.retrievedAt))) merged[key] = row[key];
    }
    if (Object.keys(row).some(key => merged[key] === row[key] && row[key]?.source && merged[key] !== prior[key])) merged.notes = row.notes;
    rows.set(row.id, merged);
  }
  return { schemaVersion: 1, observations: [...rows.values()] };
}
