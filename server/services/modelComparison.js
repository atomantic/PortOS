/** Machine-local reference prices and PortOS-run benchmark observations. */
import { join } from 'path';
import { ServerError } from '../lib/errorHandler.js';
import { readFile } from 'fs/promises';
import { PATHS } from '../lib/paths.js';
import { atomicWrite } from '../lib/fileCore.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { modelComparisonCatalogSchema, modelComparisonImportSchema } from '../lib/validation.js';

const queueWrite = createFileWriteQueue();
const catalogPath = () => join(PATHS.data, 'model-comparison.json');
const retiredExternalBenchmark = row => /^(?:Artificial Analysis Intelligence Index|SWE-bench\b)/i.test(row?.benchmark || '')
  || /^(?:aa-v\d|swebench-)/i.test(row?.id || '');
const isPortosBenchmarkObservation = row => row?.id?.startsWith('portos:')
  || /^PortOS Task Bench v\d+\b/.test(row?.benchmark || '');
const hasPortosRunSource = row => [
  row?.quality, row?.costPerTask, row?.inputPerMillion, row?.outputPerMillion,
  row?.reasoningPerMillion, row?.responseSeconds, row?.tokensPerSecond,
  row?.tokensPerRun, row?.inputTokens, row?.outputTokens, row?.apiEquivalentCost,
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
  return { ...catalog, observations: catalog.observations.filter(row => !retiredExternalBenchmark(row)) };
}

async function mergeModelComparison(incoming) {
  const current = await getModelComparison();
  const rows = new Map(current.observations.map(row => [row.id, row]));
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
  if (incoming.observations.some(retiredExternalBenchmark)) {
    throw new ServerError('Artificial Analysis and SWE-bench imports have been retired; use PortOS-run benchmark results.', { status: 410 });
  }
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
