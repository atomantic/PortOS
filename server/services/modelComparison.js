/** Machine-local public reference catalog; see docs/MODEL-COMPARISON.md. */
import { join } from 'path';
import { ServerError } from '../lib/errorHandler.js';
import { readFile } from 'fs/promises';
import { PATHS } from '../lib/paths.js';
import { atomicWrite } from '../lib/fileCore.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { modelComparisonImportSchema } from '../lib/validation.js';

const queueWrite = createFileWriteQueue();
const catalogPath = () => join(PATHS.data, 'model-comparison.json');

export async function getModelComparison() {
  const raw = await readFile(catalogPath(), 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return readFile(join(PATHS.root, 'data.reference/model-comparison.json'), 'utf8');
  });
  // A malformed or future-version catalog must surface an error, never be
  // replaced with an empty store by the next import.
  return modelComparisonImportSchema.parse(JSON.parse(raw));
}

export function importModelComparison(input) {
  const incoming = modelComparisonImportSchema.parse(input);
  return queueWrite(async () => {
    const current = await getModelComparison();
    const rows = new Map(current.observations.map(row => [row.id, row]));
    for (const row of incoming.observations) {
      const prior = rows.get(row.id);
      if (prior) {
        // Stable ids cannot silently change the meaning of existing evidence.
        for (const key of ['provider', 'model', 'effort', 'configuration', 'billing', 'benchmark']) {
          if (row[key] !== prior[key]) throw new ServerError(`Observation identity changed: ${row.id}`, { status: 409 });
        }
        for (const key of ['quality', 'costPerTask', 'inputPerMillion', 'outputPerMillion', 'reasoningPerMillion', 'responseSeconds', 'tokensPerSecond', 'quota']) {
          const before = prior[key];
          if (before && (!row[key] || Date.parse(row[key].source.retrievedAt) < Date.parse(before.source.retrievedAt))) row[key] = before;
        }
      }
      rows.set(row.id, row);
    }
    const result = modelComparisonImportSchema.parse({ schemaVersion: 1, observations: [...rows.values()] });
    await atomicWrite(catalogPath(), result);
    return result;
  });
}

export { syncArtificialAnalysisCatalog, transformAAModelsToObservations } from './artificialAnalysis.js';
