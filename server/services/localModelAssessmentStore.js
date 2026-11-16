/**
 * Measured local-model assessments — the durable store and the environment the
 * measurements are only valid for.
 *
 * Split out of `localModelAssessments.js` so the READ side has no path to a provider:
 *
 *   1. **AI Provider Usage Policy** (root AGENTS.md). Everything here touches disk (plus,
 *      on the run path, one cheap version probe); nothing can reach an LLM, so a
 *      status/catalog read importing it is safe by construction.
 *   2. **No import cycle.** `localModelAssessments.js` imports `localLlm.js`, so
 *      `localLlm.js` imports this module instead.
 *
 * Storage: `file-primary` (`data/local-llm/assessments.json`) — machine-local, never
 * federated: an assessment describes THIS machine's hardware. One capped record per
 * model, no sync cursor or tombstone; backed up because a run costs minutes of compute.
 *
 * ## Privacy
 *
 * The recorded environment is coarse — platform, arch, CPU count, total/available memory,
 * backend version. Never a hostname, username, path, or other machine identity, because
 * assessments are user-visible and end up in bug reports.
 */

import { join } from 'path';
import { rename } from 'fs/promises';
import os from 'os';
import { PATHS, atomicWrite, ensureDir, tryReadFileStrict, safeJSONParse } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { ServerError } from '../lib/errorHandler.js';
import { getAvailableMemoryGb } from './localMemory.js';
import { compareEnvironments, describeStaleness, measuredFitVerdict } from '../lib/localModelAssessment.js';
import { ASSESSABLE_RUNTIMES } from '../lib/localProviderRuntime.js';
import { getVersion as getOllamaVersion } from './ollamaManager.js';

// Resolved lazily: `PATHS.data` is patched by suites that re-root the data dir, and a
// module-level `join()` would capture the value at first import.
const assessmentsDir = () => join(PATHS.data, 'local-llm');
const assessmentsFile = () => join(assessmentsDir(), 'assessments.json');

// Storage-layout version for the on-disk file. Bump only when the persisted
// shape changes in a way a reader must branch on.
const STORE_SCHEMA_VERSION = 1;

const GB = 2 ** 30;

// ---- environment ------------------------------------------------------------

/**
 * The machine facts that are free to read (no subprocess, no network). Used on every READ
 * path to decide whether a stored measurement still describes this machine.
 */
export function captureDurableEnvironment() {
  return {
    platform: os.platform(),
    arch: os.arch(),
    cpuCount: os.cpus()?.length ?? null,
    totalMemoryGb: Number((os.totalmem() / GB).toFixed(1)),
  };
}

/**
 * Coarse description of the machine a measurement was taken on, with NO machine identity
 * (see the privacy note above).
 *
 * Costs a `vm_stat` subprocess (macOS) and, for Ollama, one loopback HTTP GET, so this is
 * the RUN-path capture. Read paths use `captureDurableEnvironment()` plus, where affordable,
 * `captureLiveEnvironments()`.
 *
 * @param {{ backend?: string }} [options]
 */
export async function captureEnvironment({ backend } = {}) {
  const totalGb = os.totalmem() / GB;
  // `null` (not `0`) when the probe fails: an unknown budget must not read as "no memory
  // available", which would make every model look like it fits nothing.
  const availableGb = await getAvailableMemoryGb().catch(() => null);
  return {
    ...captureDurableEnvironment(),
    totalMemoryGb: Number(totalGb.toFixed(1)),
    availableMemoryGb: Number.isFinite(availableGb) ? Number(availableGb.toFixed(1)) : null,
    // The budget the fit verdict is scored against: never more than what is
    // actually free right now, never more than the box has.
    memoryBudgetGb: Number.isFinite(availableGb)
      ? Number(Math.min(totalGb, availableGb).toFixed(1))
      : null,
    // `null` = not recorded (LM Studio exposes no version endpoint; Ollama may be stopped). Never
    // default to a string, or a later comparison would read a fabricated "unchanged".
    backendVersion: backend === 'ollama' ? await getOllamaVersion().catch(() => null) : null,
  };
}

// A backend UPDATE invalidates a measurement, so read paths need the live version, but the
// catalog path runs on every debounced keystroke; cache the probe briefly.
//
// `fetched` keeps "never probed" distinct from "probed and Ollama is down" (a legitimate
// `null`), so a down backend is not re-probed on every call.
const VERSION_CACHE_MS = 60000;
let versionCache = { value: null, at: 0, fetched: false };

async function liveBackendVersion(backend) {
  // Only Ollama reports a version; LM Studio exposes none, so `null` there is
  // "not recorded", and a comparison against it is skipped rather than failed.
  if (backend !== 'ollama') return null;
  const now = Date.now();
  if (versionCache.fetched && now - versionCache.at < VERSION_CACHE_MS) return versionCache.value;
  const value = await getOllamaVersion().catch(() => null);
  versionCache = { value, at: now, fetched: true };
  return value;
}

/** Test seam: drop the cached backend version so a suite can re-probe. */
export function __resetBackendVersionCache() {
  versionCache = { value: null, at: 0, fetched: false };
}

/**
 * Live environment for a STALENESS comparison, including the backend version. Costs one
 * loopback GET for Ollama, so it belongs on paths that already talk to the backend, not the
 * catalog badge path.
 *
 * @param {{ backends?: string[] }} [options]
 * @returns {Promise<Record<string, object>>} keyed by backend
 */
export async function captureLiveEnvironments({ backends = ASSESSABLE_RUNTIMES } = {}) {
  const durable = captureDurableEnvironment();
  const entries = await Promise.all(backends.map(async (backend) => [
    backend,
    { ...durable, backendVersion: await liveBackendVersion(backend) },
  ]));
  return Object.fromEntries(entries);
}

// ---- store ------------------------------------------------------------------

/**
 * Identity of one stored measurement.
 *
 * `tuningKey` is the stable signature from `lib/localModelTuning.js`. An UNTUNED measurement
 * passes `''`, so records stored before tuning existed keep resolving without a migration and
 * a tuned run of the same model lands beside it.
 */
export const assessmentKey = (backend, modelId, tuningKey = '') =>
  (tuningKey ? `${backend}:${modelId}@${tuningKey}` : `${backend}:${modelId}`);

/** The key of a stored record, from whichever fields it carries. */
export const keyOfAssessment = (a) => assessmentKey(a?.backend, a?.modelId, a?.tuningKey || '');

// Move an unparseable store aside so a fresh one can be written without losing the old
// contents. Best-effort: refusing the write would leave assessments permanently unusable.
async function quarantineStore(reason) {
  const parked = `${assessmentsFile()}.corrupt-${Date.now()}`;
  const moved = await rename(assessmentsFile(), parked).then(() => true).catch(() => false);
  console.error(`❌ Local LLM: ${reason} — ${moved ? `parked the old file as ${parked.split('/').pop()}` : 'could not park the old file'}`);
}

// One tail for the whole file: save and delete are read-modify-write cycles over the same
// document, so a delete overlapping a save would otherwise persist its stale pre-image.
const queueWrite = createFileWriteQueue();

/**
 * 503 for a store whose bytes could not be read (EACCES / EIO / ...). Not provably corrupt,
 * so a writer must refuse rather than park or replace it. Shared with the capability store.
 */
export const unreadableStoreError = (label) =>
  new ServerError(`${label} could not be read from disk; refusing to overwrite it`, { status: 503, code: 'UNREADABLE_STORE' });

export async function loadStore() {
  const { ok, value: raw } = await tryReadFileStrict(assessmentsFile());
  // A filesystem failure is NOT "never assessed": reporting an empty store here
  // let the next save write a one-record file over a perfectly good one.
  if (!ok) {
    return { schemaVersion: STORE_SCHEMA_VERSION, assessments: [], readError: 'assessments file could not be read', unreadable: true };
  }
  // Never read = an empty store, not an error: the file simply doesn't exist
  // until the first assessment runs.
  if (raw == null) return { schemaVersion: STORE_SCHEMA_VERSION, assessments: [], readError: null };
  const parsed = safeJSONParse(raw, null);
  if (!parsed || !Array.isArray(parsed.assessments)) {
    // Present but unparseable is NOT an empty store — say so rather than
    // silently reporting "nothing assessed" and letting a re-run overwrite it.
    return { schemaVersion: STORE_SCHEMA_VERSION, assessments: [], readError: 'assessments file is unreadable or malformed' };
  }
  return { schemaVersion: parsed.schemaVersion ?? STORE_SCHEMA_VERSION, assessments: parsed.assessments, readError: null };
}

/**
 * Read the persisted assessments. Disk only — never calls a provider, so it is safe from
 * boot, a poll, or any read path.
 *
 * @returns {Promise<Array<object>>} `[]` means measured-empty, distinct from a read failure,
 *   which is surfaced by `loadStore().readError`.
 */
export async function loadAssessments() {
  return (await loadStore()).assessments;
}

export const saveAssessment = (assessment) => queueWrite(async () => {
  const { assessments, readError, unreadable } = await loadStore();
  if (unreadable) throw unreadableStoreError('Local model assessments');
  // An unreadable store reports zero assessments; writing on top of it would silently replace
  // every prior measurement. Quarantine the file instead so nothing is lost and the feature
  // keeps working.
  if (readError) await quarantineStore(readError);
  const key = keyOfAssessment(assessment);
  // One record per (backend, model, TUNING): the newest supersedes the old for that exact
  // configuration (a stale reading from a different memory state is worse than none). Different
  // tunings answer different questions, so both survive.
  const next = assessments.filter((a) => keyOfAssessment(a) !== key);
  next.push(assessment);
  await ensureDir(assessmentsDir());
  await atomicWrite(assessmentsFile(), { schemaVersion: STORE_SCHEMA_VERSION, assessments: next });
  return assessment;
});

/**
 * Drop one recorded assessment. Returns whether a record was removed so the caller can 404.
 */
export const deleteAssessment = (backend, modelId, tuningKey = '') => queueWrite(async () => {
  const { assessments, readError, unreadable } = await loadStore();
  if (unreadable) throw unreadableStoreError('Local model assessments');
  // Same hazard as saveAssessment: rewriting from an empty in-memory list would
  // wipe the file. A delete against an unreadable store has nothing to remove.
  if (readError) return { deleted: false };
  const key = assessmentKey(backend, modelId, tuningKey);
  const next = assessments.filter((a) => keyOfAssessment(a) !== key);
  if (next.length === assessments.length) return { deleted: false };
  await ensureDir(assessmentsDir());
  await atomicWrite(assessmentsFile(), { schemaVersion: STORE_SCHEMA_VERSION, assessments: next });
  console.log(`🧹 Local LLM: dropped assessment for ${backend}/${modelId}${tuningKey ? ` (${tuningKey})` : ''}`);
  return { deleted: true };
});

// ---- measured evidence for the ESTIMATE-driven surfaces ---------------------

/**
 * Annotate one assessment with how well its recorded environment still matches the machine
 * as it is now.
 *
 * @param {object} assessment
 * @param {object|null} liveEnvironment
 */
export function withStaleness(assessment, liveEnvironment) {
  const staleness = compareEnvironments(assessment?.environment, liveEnvironment);
  return {
    ...assessment,
    staleness: { ...staleness, description: describeStaleness(staleness) },
  };
}

/**
 * Compact measured-fit records the catalog badge and editorial recommendation fold in, keyed
 * by model id for one backend.
 *
 * Disk only apart from a 60s-cached backend-version probe (a backend update is as stale-making
 * as a RAM change).
 *
 * @param {string} backend
 * @returns {Promise<Record<string, {fit:string|null, verdict:string, assessedAt:string|null, stale:boolean, staleReason:string|null, meanCharsPerSecond:number|null, residentGb:number|null}>>}
 */
export async function getMeasuredFits(backend) {
  const { assessments } = await loadStore();
  const live = { ...captureDurableEnvironment(), backendVersion: await liveBackendVersion(backend) };
  const out = {};
  // A model can hold several measurements (one per tuning); the badge shows the newest (every
  // tuning is visible on the Performance page). Records with no timestamp sort last.
  const newestFirst = [...assessments].sort(
    (a, b) => String(b?.assessedAt || '').localeCompare(String(a?.assessedAt || ''))
  );
  for (const assessment of newestFirst) {
    if (assessment?.backend !== backend || !assessment?.modelId) continue;
    if (out[assessment.modelId]) continue;
    const staleness = compareEnvironments(assessment.environment, live);
    out[assessment.modelId] = {
      fit: measuredFitVerdict(assessment),
      verdict: assessment.verdict || 'unknown',
      assessedAt: assessment.assessedAt || null,
      stale: staleness.stale,
      staleReason: describeStaleness(staleness),
      // `null` = never measured on both of these; a consumer rendering them must
      // say "not measured" rather than showing a zero.
      meanCharsPerSecond: Number.isFinite(assessment.performance?.meanCharsPerSecond)
        ? assessment.performance.meanCharsPerSecond
        : null,
      residentGb: Number.isFinite(assessment.residentGb) ? assessment.residentGb : null,
      // LM Studio model ids are repo-level with no quant, so the measured quant travels separately
      // or a Q4 reading would decorate every quant. `null` = unrecorded; a consumer must decline to
      // match a quantized variant rather than guess.
      quantization: assessment.quantization ?? null,
      // Which launch configuration produced this reading. `null` = backend defaults/untuned, a
      // real answer, not unknown.
      tuningLabel: assessment.tuningLabel ?? null,
    };
  }
  return out;
}
