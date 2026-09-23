import { afterEach, expect, it, vi } from 'vitest';
import { modelComparisonImportSchema } from '../lib/validation.js';

vi.mock('./modelComparison.js', () => ({
  importModelComparison: vi.fn(async value => value),
}));

const { importModelComparison } = await import('./modelComparison.js');
const {
  parseEpochAiBenchmarkArchive,
  syncEpochAiCatalog,
  transformEpochBenchmarkData,
} = await import('./epochAiBenchmarks.js');

const retrievedAt = '2026-09-23T00:00:00.000Z';

function storedZip(entries) {
  const localEntries = entries.map(([name, text]) => {
    const nameBytes = Buffer.from(name);
    const content = Buffer.from(text);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt32LE(content.length, 18);
    header.writeUInt32LE(content.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    return Buffer.concat([header, nameBytes, content]);
  });
  const centralDirectoryStart = Buffer.alloc(4);
  centralDirectoryStart.writeUInt32LE(0x02014b50, 0);
  return Buffer.concat([...localEntries, centralDirectoryStart]);
}

function fixtureData(releaseDate = '2025-06-01') {
  const archive = storedZip([
    ['benchmark_metadata.csv', `benchmark,release_date,score_column,scale,source_file\nGPQA Diamond,${releaseDate},score,percent,gpqa_diamond.csv\n`],
    ['model_metadata.csv', 'model_version,display_name,organization\nexample-model-v2,Example Model,Example Labs\n'],
    ['gpqa_diamond.csv', 'Model version,Agent,Reasoning effort,Run date,Shots,score\nexample-model-v2,Example Harness,high,2026-05-01,5,72.5\n'],
  ]);
  return parseEpochAiBenchmarkArchive(archive);
}

afterEach(() => {
  vi.restoreAllMocks();
  importModelComparison.mockClear();
});

it('imports versioned benchmark scores with their run configuration and CC BY attribution', async () => {
  const data = await fixtureData();
  const observations = transformEpochBenchmarkData(data, { retrievedAt });

  expect(observations).toHaveLength(1);
  expect(observations[0]).toMatchObject({
    provider: 'Example Labs',
    model: 'example-model',
    effort: 'high',
    benchmark: 'Epoch AI: GPQA Diamond (released 2025-06-01; score column: score)',
    quality: {
      value: 72.5,
      source: { url: 'https://epoch.ai/data/benchmark_data.zip', retrievedAt },
    },
  });
  expect(observations[0].configuration).toContain('agent=Example Harness');
  expect(observations[0].configuration).toContain('reasoning effort=high');
  expect(observations[0].configuration).toContain('shots=5');
  expect(observations[0].notes).toContain('CC BY 4.0');
  expect(observations[0].notes).toContain('https://creativecommons.org/licenses/by/4.0/');
  expect(modelComparisonImportSchema.parse({ schemaVersion: 1, observations }).observations).toHaveLength(1);

  const nextVersion = transformEpochBenchmarkData(await fixtureData('2025-08-15'), { retrievedAt });
  expect(nextVersion[0].benchmark).not.toBe(observations[0].benchmark);
  expect(nextVersion[0].id).not.toBe(observations[0].id);

  const reordered = {
    ...data,
    datasets: new Map([...data.datasets].map(([name, rows]) => [
      name,
      rows.map(row => Object.fromEntries(Object.entries(row).reverse())),
    ])),
  };
  expect(transformEpochBenchmarkData(reordered, { retrievedAt })[0].id).toBe(observations[0].id);
});

it('rejects an invalid archive before importing any existing evidence', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(Buffer.from('not a zip'), { status: 200 }));

  await expect(syncEpochAiCatalog()).rejects.toMatchObject({ status: 502 });
  expect(importModelComparison).not.toHaveBeenCalled();
});
