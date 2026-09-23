/** On-demand Epoch AI benchmark CSV sync for the model comparison catalog. */
import { createHash } from 'crypto';
import { Readable } from 'stream';
import { ServerError } from '../lib/errorHandler.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { collectZipEntry, parseZip } from '../lib/zipStream.js';
import { modelComparisonImportSchema } from '../lib/validation.js';
import { importModelComparison } from './modelComparison.js';
import { KNOWN_EFFORTS, parseModelNameAndEffort, slugify } from './artificialAnalysis.js';

const EPOCH_AI_ARCHIVE_URL = 'https://epoch.ai/data/benchmark_data.zip';
const EPOCH_AI_CITATION_URL = 'https://epoch.ai/benchmarks/use-this-data';
const EPOCH_AI_REQUEST_TIMEOUT_MS = 30_000;
const MAX_EPOCH_ARCHIVE_BYTES = 15 * 1024 * 1024;
const MAX_EPOCH_CSV_MEMBER_BYTES = 1024 * 1024;
const MAX_EPOCH_CSV_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_EPOCH_ARCHIVE_ENTRIES = 200;

const identityHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
const cleanCell = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const normalizedName = value => String(value || '').toLowerCase().replace(/\.0(?=$|[^0-9])/g, '').replace(/[^a-z0-9]/g, '');

// Epoch's benchmark CSVs use different columns for run setup, so retain the
// source-specific fields broadly and exclude only model metadata, row IDs,
// provenance text, and the selected score itself.
const NON_CONFIGURATION_COLUMNS = new Set([
  'Model version', 'Release date', 'Organization', 'Country',
  'Training compute (FLOP)', 'Training compute notes', 'id', 'UUID',
  'Source', 'Source link', 'Source Link', 'Source link (site from table)',
  'Notes', 'Notes (details)', 'Log viewer', 'Logs',
]);

const BENCHMARK_VERSION_COLUMNS = [
  'Benchmark version', 'Benchmark variant', 'METR version', 'LiveBench Version',
];

function invalidArchive() {
  return new ServerError('Epoch AI returned an invalid or incomplete benchmark archive; retry sync', { status: 502 });
}

async function readBoundedResponse(response) {
  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_EPOCH_ARCHIVE_BYTES) {
    throw new ServerError('Epoch AI benchmark archive exceeds the supported size; retry sync later', { status: 502 });
  }
  const reader = response.body?.getReader?.();
  if (!reader) throw invalidArchive();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_EPOCH_ARCHIVE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new ServerError('Epoch AI benchmark archive exceeds the supported size; retry sync later', { status: 502 });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (size === 0) throw invalidArchive();
  return Buffer.concat(chunks, size);
}

function collectCsvMembers(archive) {
  const source = Readable.from([archive]);
  const parser = parseZip();
  const reads = [];
  const files = new Map();
  let entryCount = 0;
  let totalBytes = 0;

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (fn === reject) {
        source.destroy();
        parser.destroy();
      }
      fn(value);
    };
    const fail = error => settle(reject, error instanceof ServerError ? error : invalidArchive());

    source.on('error', fail);
    const stream = source.pipe(parser);
    stream.on('error', fail);
    stream.on('entry', entry => {
      entryCount += 1;
      if (entryCount > MAX_EPOCH_ARCHIVE_ENTRIES) {
        entry.autodrain();
        fail(invalidArchive());
        return;
      }
      const name = String(entry.path || '');
      if (name.includes('/') || !name.toLowerCase().endsWith('.csv')) {
        entry.autodrain();
        return;
      }
      const read = collectZipEntry(entry, MAX_EPOCH_CSV_MEMBER_BYTES)
        .then(buffer => {
          totalBytes += buffer.length;
          if (totalBytes > MAX_EPOCH_CSV_TOTAL_BYTES || files.has(name)) throw invalidArchive();
          files.set(name, buffer.toString('utf8'));
        })
        .catch(error => fail(error));
      reads.push(read);
    });
    stream.on('close', () => {
      Promise.all(reads).then(() => settle(resolve, files)).catch(fail);
    });
  });
}

export function parseEpochCsv(text, label = 'benchmark CSV') {
  if (typeof text !== 'string' || !text.length) throw invalidArchive();
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  const pushRow = () => {
    row.push(field);
    if (row.some(cell => cell.trim())) rows.push(row);
    row = [];
    field = '';
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === ',' ) {
      row.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      pushRow();
    } else if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === '"') {
      throw new ServerError('Epoch AI ' + label + ' contains malformed CSV; retry sync', { status: 502 });
    } else {
      field += character;
    }
  }
  if (quoted) throw new ServerError('Epoch AI ' + label + ' contains an unterminated CSV field; retry sync', { status: 502 });
  if (field.length || row.length) pushRow();
  if (rows.length < 2) throw new ServerError('Epoch AI ' + label + ' contains no data rows; retry sync', { status: 502 });

  const headers = rows[0].map((header, index) => (index === 0 ? header.replace(/^\uFEFF/, '') : header).trim());
  if (headers.some(header => !header) || new Set(headers).size !== headers.length) {
    throw new ServerError('Epoch AI ' + label + ' contains invalid CSV headers; retry sync', { status: 502 });
  }
  return rows.slice(1).map(cells => {
    if (cells.length > headers.length) {
      throw new ServerError('Epoch AI ' + label + ' contains a malformed CSV row; retry sync', { status: 502 });
    }
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']));
  });
}

function resolveBenchmarkFile(benchmark, filesByStem) {
  const sourceFile = cleanCell(benchmark.source_file);
  if (sourceFile) return sourceFile;
  const direct = filesByStem.get(normalizedName(benchmark.benchmark)) || [];
  if (direct.length === 1) return direct[0];
  if (direct.length > 1) throw invalidArchive();
  if (normalizedName(benchmark.benchmark) === 'csqa2') return 'common_sense_qa_2_external.csv';
  return '';
}

export async function parseEpochAiBenchmarkArchive(archive) {
  if (!Buffer.isBuffer(archive) || archive.length === 0 || archive.length > MAX_EPOCH_ARCHIVE_BYTES) {
    throw invalidArchive();
  }
  let members;
  try {
    members = await collectCsvMembers(archive);
  } catch (error) {
    if (error instanceof ServerError) throw error;
    throw invalidArchive();
  }

  const benchmarkText = members.get('benchmark_metadata.csv');
  const modelText = members.get('model_metadata.csv');
  if (!benchmarkText || !modelText) throw invalidArchive();
  const benchmarkMetadata = parseEpochCsv(benchmarkText, 'benchmark metadata');
  const modelMetadata = parseEpochCsv(modelText, 'model metadata');
  const fileNames = [...members.keys()].filter(name => name !== 'benchmark_metadata.csv' && name !== 'model_metadata.csv');
  const filesByStem = new Map();
  for (const fileName of fileNames) {
    const stem = fileName.replace(/\.csv$/i, '').replace(/_external$/i, '');
    const key = normalizedName(stem);
    filesByStem.set(key, [...(filesByStem.get(key) || []), fileName]);
  }

  const selectedNames = new Set();
  for (const benchmark of benchmarkMetadata) {
    if (!cleanCell(benchmark.benchmark)) throw invalidArchive();
    const fileName = resolveBenchmarkFile(benchmark, filesByStem);
    if (!fileName) continue;
    if (!members.has(fileName)) throw invalidArchive();
    selectedNames.add(fileName);
  }
  if (selectedNames.size === 0) throw invalidArchive();
  const datasets = new Map([...selectedNames].map(fileName => [fileName, parseEpochCsv(members.get(fileName), fileName)]));
  return { benchmarkMetadata, modelMetadata, datasets };
}

export async function fetchEpochAiBenchmarkData() {
  let response;
  let archive;
  try {
    response = await fetchWithTimeout(EPOCH_AI_ARCHIVE_URL, { headers: { Accept: 'application/zip' } }, EPOCH_AI_REQUEST_TIMEOUT_MS);
    if (!response.ok) {
      throw new ServerError('Epoch AI benchmark download failed (' + response.status + ')', { status: 502 });
    }
    archive = await readBoundedResponse(response);
  } catch (error) {
    if (error instanceof ServerError) throw error;
    if (error?.name === 'AbortError') throw new ServerError('Epoch AI benchmark download timed out; retry sync', { status: 502 });
    throw error;
  }
  return parseEpochAiBenchmarkArchive(archive);
}

function numericScore(value) {
  if (value === null || value === undefined || cleanCell(value) === '') return null;
  const raw = cleanCell(value);
  if (/^(?:n\/a|na|not available|—|-|null)$/i.test(raw)) return null;
  const numeric = Number(raw.replace(/%$/, ''));
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new ServerError('Epoch AI returned a malformed benchmark score; retry sync', { status: 502 });
  }
  return numeric;
}

function normalizeEffort(value) {
  const effort = cleanCell(value).toLowerCase().replace(/\s+/g, '-');
  if (!effort || ['unknown', 'n/a', 'na', 'none', 'unspecified'].includes(effort)) return 'unspecified';
  if (effort === 'very_high') return 'xhigh';
  return effort.slice(0, 80);
}

function resolveModel(row, modelMetadataByVersion) {
  const modelVersion = cleanCell(row['Model version']);
  if (!modelVersion) return null;
  const metadata = modelMetadataByVersion.get(modelVersion) || {};
  const displayName = cleanCell(metadata.display_name || row.Name || modelVersion);
  const parsedName = parseModelNameAndEffort(displayName);
  const model = slugify(parsedName.baseName || displayName);
  if (!model) return null;
  const versionEffort = modelVersion.match(/_([a-z][a-z0-9-]*)$/i)?.[1];
  const explicitEffort = row['Reasoning effort'] || row['Reasoning level'] || row.Reasoning;
  const effort = normalizeEffort(explicitEffort || (KNOWN_EFFORTS.includes(String(versionEffort || '').toLowerCase()) ? versionEffort : parsedName.effort));
  const provider = cleanCell(row.Organization || metadata.organization || row.Provider || 'Unknown').slice(0, 160) || 'Unknown';
  return { modelVersion, model, effort, provider };
}

function rowConfiguration(row, modelVersion, scoreColumn) {
  const parts = ['model version=' + modelVersion];
  const entries = Object.entries(row)
    .filter(([field, value]) => field !== scoreColumn && !NON_CONFIGURATION_COLUMNS.has(field) && cleanCell(value))
    .sort(([left], [right]) => left.localeCompare(right));
  for (const [field, value] of entries) {
    parts.push(field.toLowerCase() + '=' + cleanCell(value));
  }
  return parts;
}

function benchmarkVersionName(metadata, row) {
  const name = cleanCell(metadata.benchmark);
  const rowVersions = BENCHMARK_VERSION_COLUMNS
    .map(field => cleanCell(row[field]))
    .filter(Boolean);
  const distinctVersions = [...new Set(rowVersions)];
  const releaseDate = cleanCell(metadata.release_date);
  const qualifiers = [
    ...distinctVersions,
    ...(releaseDate && !name.includes(releaseDate) ? ['released ' + releaseDate] : []),
    ...(cleanCell(metadata.score_column) ? ['score column: ' + cleanCell(metadata.score_column)] : []),
  ];
  const suffix = qualifiers.length ? ' (' + qualifiers.join('; ') + ')' : '';
  return ('Epoch AI: ' + name + suffix).slice(0, 160);
}

function benchmarkScore(row, metadata) {
  const scoreColumn = cleanCell(metadata.score_column);
  if (!scoreColumn) return null;
  if (!Object.prototype.hasOwnProperty.call(row, scoreColumn)) throw invalidArchive();
  return numericScore(row[scoreColumn]);
}

export function transformEpochBenchmarkData(data, { retrievedAt = new Date().toISOString() } = {}) {
  if (!data || !Array.isArray(data.benchmarkMetadata) || !Array.isArray(data.modelMetadata) || !(data.datasets instanceof Map)) {
    throw invalidArchive();
  }
  const filesByStem = new Map();
  for (const file of data.datasets.keys()) {
    const stem = file.replace(/\.csv$/i, '').replace(/_external$/i, '');
    const key = normalizedName(stem);
    filesByStem.set(key, [...(filesByStem.get(key) || []), file]);
  }
  const modelMetadataByVersion = new Map(data.modelMetadata
    .filter(row => cleanCell(row.model_version))
    .map(row => [cleanCell(row.model_version), row]));
  const observations = [];
  const seenIds = new Set();

  for (const benchmark of data.benchmarkMetadata) {
    const fileName = resolveBenchmarkFile(benchmark, filesByStem);
    const rows = data.datasets.get(fileName);
    if (!rows) continue;
    for (const row of rows) {
      if (!row || typeof row !== 'object') throw invalidArchive();
      const resolved = resolveModel(row, modelMetadataByVersion);
      if (!resolved) continue;
      const qualityValue = benchmarkScore(row, benchmark);
      if (qualityValue === null) continue;

      const benchmarkName = benchmarkVersionName(benchmark, row);
      const scoreColumn = cleanCell(benchmark.score_column);
      let configParts = rowConfiguration(row, resolved.modelVersion, scoreColumn);
      let identity = [benchmarkName, scoreColumn, resolved.modelVersion, resolved.effort, configParts];
      let id = 'epoch-ai-' + identityHash(identity);
      if (seenIds.has(id)) {
        const sourceRowId = cleanCell(row.id);
        if (!sourceRowId) throw invalidArchive();
        configParts = [...configParts, 'source record id=' + sourceRowId];
        identity = [benchmarkName, scoreColumn, resolved.modelVersion, resolved.effort, configParts];
        id = 'epoch-ai-' + identityHash(identity);
      }
      if (seenIds.has(id)) throw invalidArchive();
      seenIds.add(id);

      const scale = cleanCell(benchmark.scale) || 'source-reported scale';
      const release = cleanCell(benchmark.release_date);
      const external = /_external\.csv$/i.test(fileName);
      const methodology = 'Epoch AI ' + cleanCell(benchmark.benchmark)
        + (release ? ' (benchmark release ' + release + ')' : '')
        + '; published score column "' + cleanCell(benchmark.score_column) + '" on the ' + scale + ' scale'
        + '; run configuration is recorded per observation. No score rescaling is applied.';
      observations.push({
        id,
        provider: resolved.provider,
        model: resolved.model,
        effort: resolved.effort,
        configuration: ('Epoch AI run; ' + configParts.join('; ')).slice(0, 500),
        billing: 'unknown',
        benchmark: benchmarkName,
        quality: {
          value: qualityValue,
          source: { url: EPOCH_AI_ARCHIVE_URL, retrievedAt, methodology },
        },
        costPerTask: null,
        inputPerMillion: null,
        outputPerMillion: null,
        reasoningPerMillion: null,
        responseSeconds: null,
        tokensPerSecond: null,
        quota: null,
        notes: 'Epoch AI, Capabilities & Benchmarking CSV archive (' + EPOCH_AI_CITATION_URL + '); attributed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Benchmark questions and answers remain their creators’ property.'
          + (external ? ' This is an external-run row; Epoch AI states that external rows retain their original source licensing.' : ''),
      });
    }
  }
  if (observations.length === 0) {
    throw new ServerError('Epoch AI returned no usable benchmark observations; retry sync', { status: 502 });
  }
  return observations;
}

export async function syncEpochAiCatalog() {
  const data = await fetchEpochAiBenchmarkData();
  const observations = transformEpochBenchmarkData(data);
  const validated = modelComparisonImportSchema.parse({ schemaVersion: 1, observations });
  const updated = await importModelComparison(validated);
  const fetched = [...data.datasets.values()].reduce((total, rows) => total + rows.length, 0);
  return { success: true, fetched, observations: observations.length, total: updated.observations.length, catalog: updated };
}
