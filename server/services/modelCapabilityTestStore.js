/**
 * Capability test results — the durable store.
 *
 * Split from `modelCapabilityTests.js` for the same two reasons the assessment
 * store is split from its runner:
 *
 *   1. **AI Provider Usage Policy** (root CLAUDE.md). Nothing in this file can
 *      reach a provider, so a read path that imports it is safe by construction
 *      rather than by review.
 *   2. **No import cycle** — the report builder needs stored results, and the
 *      runner needs to write them.
 *
 * ## Storage (docs/STORAGE.md)
 *
 * `file-primary`, **machine-local — never federated.** A capability result
 * describes what a model did on THIS machine, through THIS runtime, at the
 * quantization installed here. A peer inheriting "passed" for a model it runs at
 * a different quant would be told something untrue about its own install. No
 * sync cursor, no tombstone, no `schemaVersions.js` entry — the same rule
 * `localModelAssessmentStore.js` follows and for the same reason.
 *
 * ## Privacy
 *
 * A record holds the model's own output and, for the sandbox test, the agent
 * transcript — because seeing the output IS the feature. Both are produced
 * inside a throwaway sandbox from a fixed fixture, so neither carries user data,
 * and neither ever leaves this machine. The recorded environment stays coarse
 * (platform, arch, CPU count, total memory) exactly as assessments do: no
 * hostname, no username, no paths.
 */

import { join } from 'path';
import { rename } from 'fs/promises';
import { PATHS, atomicWrite, ensureDir, tryReadFile, safeJSONParse } from '../lib/fileUtils.js';
import { captureDurableEnvironment } from './localModelAssessmentStore.js';

const storeDir = () => join(PATHS.data, 'local-llm');
const storeFile = () => join(storeDir(), 'capability-tests.json');

// Storage-layout version. Bump only when a reader must branch on the shape.
const STORE_SCHEMA_VERSION = 1;

/**
 * Caps on what one record keeps.
 *
 * Generous enough that a real answer is never clipped — a twelve-beat outline
 * runs ~5k characters and a repair transcript ~20k — but bounded, because the
 * whole store is one JSON file rewritten on every save. A runaway model that
 * emits a megabyte must not make the file unreadable for every other result.
 */
export const MAX_OUTPUT_CHARS = 24000;
export const MAX_TRANSCRIPT_CHARS = 80000;

/**
 * Trim to a cap, keeping the end the reader needs.
 *
 * `head` keeps the beginning (a model's answer starts with its answer); `tail`
 * keeps the end (a transcript's verdict is its last lines). Either way the
 * elision is MARKED — silently returning a shortened string would let a
 * truncated outline read as a model that stopped early.
 */
export function clampText(text, limit, keep = 'head') {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  const dropped = value.length - limit;
  const note = `\n\n…[${dropped.toLocaleString('en-US')} characters trimmed by PortOS]\n\n`;
  return keep === 'tail'
    ? note.trimStart() + value.slice(-limit)
    : value.slice(0, limit) + note.trimEnd();
}

/** Identity of one stored result: one record per model per test. */
export const capabilityResultKey = (backend, modelId, testId) => `${backend}:${modelId}:${testId}`;

export const keyOfResult = (r) => capabilityResultKey(r?.backend, r?.modelId, r?.testId);

async function quarantineStore(reason) {
  const parked = `${storeFile()}.corrupt-${Date.now()}`;
  const moved = await rename(storeFile(), parked).then(() => true).catch(() => false);
  console.error(`❌ Capability tests: ${reason} — ${moved ? `parked the old file as ${parked.split('/').pop()}` : 'could not park the old file'}`);
}

export async function loadStore() {
  const raw = await tryReadFile(storeFile());
  // Never written = an empty store, not an error.
  if (raw == null) return { schemaVersion: STORE_SCHEMA_VERSION, results: [], readError: null };
  const parsed = safeJSONParse(raw, null);
  if (!parsed || !Array.isArray(parsed.results)) {
    // Present but unparseable is NOT "nothing has been tested" — say so, or a
    // re-run would quietly overwrite results the user spent minutes earning.
    return { schemaVersion: STORE_SCHEMA_VERSION, results: [], readError: 'capability test results file is unreadable or malformed' };
  }
  return { schemaVersion: parsed.schemaVersion ?? STORE_SCHEMA_VERSION, results: parsed.results, readError: null };
}

/** Every stored result. Disk only — safe from any read path. */
export async function loadResults() {
  return (await loadStore()).results;
}

/**
 * Persist one result, replacing any previous run of the same model+test.
 *
 * History is deliberately not kept: a capability verdict is a statement about
 * the model as installed now, and an older run under a different quantization
 * or runtime build is misleading rather than informative. Re-running is cheap
 * enough that keeping a trail would cost more than it explains.
 */
export async function saveResult(result) {
  const { results, readError } = await loadStore();
  // Rewriting from an empty in-memory list after a failed read would replace
  // every stored result with this one. Quarantine instead — nothing is lost and
  // the feature keeps working.
  if (readError) await quarantineStore(readError);
  const record = {
    ...result,
    output: clampText(result.output, MAX_OUTPUT_CHARS, 'head'),
    transcript: clampText(result.transcript, MAX_TRANSCRIPT_CHARS, 'tail'),
    environment: result.environment ?? captureDurableEnvironment(),
  };
  const key = keyOfResult(record);
  const next = results.filter((r) => keyOfResult(r) !== key);
  next.push(record);
  await ensureDir(storeDir());
  await atomicWrite(storeFile(), { schemaVersion: STORE_SCHEMA_VERSION, results: next });
  return record;
}

/**
 * Drop one recorded result. Reports whether anything was actually removed so the
 * caller can 404 rather than claiming a phantom success.
 */
export async function deleteResult(backend, modelId, testId) {
  const { results, readError } = await loadStore();
  if (readError) return { deleted: false };
  const key = capabilityResultKey(backend, modelId, testId);
  const next = results.filter((r) => keyOfResult(r) !== key);
  if (next.length === results.length) return { deleted: false };
  await ensureDir(storeDir());
  await atomicWrite(storeFile(), { schemaVersion: STORE_SCHEMA_VERSION, results: next });
  console.log(`🧹 Capability tests: dropped ${testId} result for ${backend}/${modelId}`);
  return { deleted: true };
}

/**
 * Stored results indexed by `backend:modelId:testId`, for the report builder.
 * `{}` is a real answer (nothing tested yet), distinct from `readError`.
 */
export async function indexResults() {
  const { results, readError } = await loadStore();
  return { index: Object.fromEntries(results.map((r) => [keyOfResult(r), r])), readError };
}
