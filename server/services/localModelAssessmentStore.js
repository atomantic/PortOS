/**
 * Measured local-model assessments — the durable store and the environment the
 * measurements are only valid for.
 *
 * Split out of `localModelAssessments.js` so the READ side has no path to a
 * provider. Two reasons that matters:
 *
 *   1. **AI Provider Usage Policy** (root CLAUDE.md). Everything here touches
 *      disk (plus, on the run path, one cheap version probe). Nothing in this
 *      file can reach an LLM, so importing it from a status/catalog read is safe
 *      by construction rather than by review.
 *   2. **No import cycle.** `localModelAssessments.js` imports `localLlm.js`
 *      (for the installed-model list), so `localLlm.js` could not import the
 *      store back from there. It imports this module instead.
 *
 * ## Storage (docs/STORAGE.md)
 *
 * `file-primary`, **intentionally machine-local — never federated.** An
 * assessment is a statement about THIS machine's hardware; a peer's copy would
 * be actively misleading (a peer's 8 GB laptop must not inherit a 128 GB box's
 * "fits" verdict). No sync cursor, no tombstone, no schema-version entry.
 *
 * ## Privacy
 *
 * The recorded environment is deliberately coarse — platform, arch, CPU count,
 * total/available memory, backend version. It never captures a hostname, a
 * username, a path, or any other machine identity, because assessments are
 * user-visible and end up in bug reports.
 */

import { join } from 'path';
import { rename } from 'fs/promises';
import os from 'os';
import { PATHS, atomicWrite, ensureDir, tryReadFile, safeJSONParse } from '../lib/fileUtils.js';
import { getAvailableMemoryGb } from '../lib/localMemory.js';
import { compareEnvironments, describeStaleness, measuredFitVerdict } from '../lib/localModelAssessment.js';
import { getVersion as getOllamaVersion } from './ollamaManager.js';

// Resolved lazily, not at import time: `PATHS.data` is patched by suites that
// re-root the data dir, and a module-level `join()` would capture (or crash on)
// whatever the value happened to be the moment this module was first imported.
const assessmentsDir = () => join(PATHS.data, 'local-llm');
const assessmentsFile = () => join(assessmentsDir(), 'assessments.json');

// Storage-layout version for the on-disk file. Bump only when the persisted
// shape changes in a way a reader must branch on.
const STORE_SCHEMA_VERSION = 1;

const GB = 2 ** 30;

// ---- environment ------------------------------------------------------------

/**
 * The machine facts that are free to read: no subprocess, no network. Used on
 * every READ path (catalog badges, status) to decide whether a stored
 * measurement still describes this machine.
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
 * Coarse description of the machine a measurement was taken on. Deliberately
 * carries NO machine identity (see the privacy note at the top of this file).
 *
 * Costs a `vm_stat` subprocess (macOS) and, for Ollama, one loopback HTTP GET —
 * so this is the RUN-path capture. Read paths use `captureDurableEnvironment()`
 * plus, where they can afford it, `captureLiveEnvironments()`.
 *
 * @param {{ backend?: string }} [options]
 */
export async function captureEnvironment({ backend } = {}) {
  const totalGb = os.totalmem() / GB;
  // `null` (not `0`) when the probe fails — an unknown budget must not read as
  // "no memory available", which would make every model look like it fits
  // nothing.
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
    // `null` = not recorded, which is the honest answer for LM Studio (it
    // exposes no version endpoint) and for a stopped Ollama. It must never
    // default to a string, or a later comparison would read a fabricated
    // "unchanged".
    backendVersion: backend === 'ollama' ? await getOllamaVersion().catch(() => null) : null,
  };
}

// A backend UPDATE is one of the things that invalidates a measurement, so the
// read paths have to see the live version too — but the catalog path runs on
// every debounced keystroke, and an unconditional probe there would be one
// loopback GET per keystroke. Cache it briefly instead.
//
// `fetched` is the sentinel that keeps "never probed" distinct from "probed and
// Ollama is down" (a legitimate `null`); without it a down backend would be
// re-probed on every single call.
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
 * Live environment for a STALENESS comparison, including the backend version.
 * Costs one loopback GET for Ollama, so it belongs on paths that already talk to
 * the backend (the assessments report) — not on the catalog badge path.
 *
 * @param {{ backends?: string[] }} [options]
 * @returns {Promise<Record<string, object>>} keyed by backend
 */
export async function captureLiveEnvironments({ backends = ['ollama', 'lmstudio'] } = {}) {
  const durable = captureDurableEnvironment();
  const entries = await Promise.all(backends.map(async (backend) => [
    backend,
    { ...durable, backendVersion: await liveBackendVersion(backend) },
  ]));
  return Object.fromEntries(entries);
}

// ---- store ------------------------------------------------------------------

export const assessmentKey = (backend, modelId) => `${backend}:${modelId}`;

// Move an unparseable store aside so a fresh one can be written without losing
// whatever the old file held. Best-effort: if the rename fails there is nothing
// further to preserve, and refusing the write outright would leave assessments
// permanently unusable.
async function quarantineStore(reason) {
  const parked = `${assessmentsFile()}.corrupt-${Date.now()}`;
  const moved = await rename(assessmentsFile(), parked).then(() => true).catch(() => false);
  console.error(`❌ Local LLM: ${reason} — ${moved ? `parked the old file as ${parked.split('/').pop()}` : 'could not park the old file'}`);
}

export async function loadStore() {
  const raw = await tryReadFile(assessmentsFile());
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
 * Read the persisted assessments. Disk only — never calls a provider, so this is
 * safe from boot, a poll, or any read path.
 *
 * @returns {Promise<Array<object>>} `[]` means "no assessments recorded", which
 *   is a real, measured-empty answer — distinct from a read failure, which is
 *   surfaced by `loadStore().readError`.
 */
export async function loadAssessments() {
  return (await loadStore()).assessments;
}

export async function saveAssessment(assessment) {
  const { assessments, readError } = await loadStore();
  // An unreadable store reports zero assessments, and writing on top of that
  // would replace every prior measurement with this one record — a read failure
  // silently destroying data the user spent minutes of compute on. Quarantine
  // the unreadable file instead: nothing is lost, and the feature keeps working
  // rather than wedging on a file the user has no way to repair from the UI.
  if (readError) await quarantineStore(readError);
  const key = assessmentKey(assessment.backend, assessment.modelId);
  // One record per (backend, model): the newest measurement supersedes the old
  // one. History is not kept — a stale reading from a different memory state is
  // worse than no reading, and the run is cheap to repeat.
  const next = assessments.filter((a) => assessmentKey(a?.backend, a?.modelId) !== key);
  next.push(assessment);
  await ensureDir(assessmentsDir());
  await atomicWrite(assessmentsFile(), { schemaVersion: STORE_SCHEMA_VERSION, assessments: next });
  return assessment;
}

/**
 * Drop one recorded assessment. Returns whether a record was actually removed,
 * so the caller can 404 rather than reporting a phantom success.
 */
export async function deleteAssessment(backend, modelId) {
  const { assessments, readError } = await loadStore();
  // Same hazard as saveAssessment: rewriting from an empty in-memory list would
  // wipe the file. A delete against an unreadable store has nothing to remove.
  if (readError) return { deleted: false };
  const key = assessmentKey(backend, modelId);
  const next = assessments.filter((a) => assessmentKey(a?.backend, a?.modelId) !== key);
  if (next.length === assessments.length) return { deleted: false };
  await ensureDir(assessmentsDir());
  await atomicWrite(assessmentsFile(), { schemaVersion: STORE_SCHEMA_VERSION, assessments: next });
  console.log(`🧹 Local LLM: dropped assessment for ${backend}/${modelId}`);
  return { deleted: true };
}

// ---- measured evidence for the ESTIMATE-driven surfaces ---------------------

/**
 * Annotate one assessment with how well its recorded environment still matches
 * the machine as it is now.
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
 * Compact measured-fit records the catalog badge and the editorial
 * recommendation fold in, keyed by model id for one backend.
 *
 * Disk only apart from a 60s-cached backend-version probe: the memory/CPU facts
 * are free to read, and the version is what catches a backend update, which is
 * just as stale-making as a RAM change.
 *
 * @param {string} backend
 * @returns {Promise<Record<string, {fit:string|null, verdict:string, assessedAt:string|null, stale:boolean, staleReason:string|null, meanCharsPerSecond:number|null, residentGb:number|null}>>}
 */
export async function getMeasuredFits(backend) {
  const { assessments } = await loadStore();
  const live = { ...captureDurableEnvironment(), backendVersion: await liveBackendVersion(backend) };
  const out = {};
  for (const assessment of assessments) {
    if (assessment?.backend !== backend || !assessment?.modelId) continue;
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
      // LM Studio model ids are repo-level and carry no quant, so the quant the
      // measurement actually ran has to travel separately or a Q4 reading would
      // decorate every quant of the repo. `null` = the record predates this
      // field (or the backend reported none), and a consumer must then decline
      // to match a quantized variant rather than guess.
      quantization: assessment.quantization ?? null,
    };
  }
  return out;
}
