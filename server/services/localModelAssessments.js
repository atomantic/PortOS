/**
 * Measured local-model assessments — the run + durable store.
 *
 * PortOS's existing "does it fit" answer is a size estimate: weight bytes × 1.2
 * against total RAM minus a reserve (`huggingFaceCatalog.js#classifyFit`). It
 * never runs the model, so it cannot distinguish a model that loads and streams
 * comfortably from one that loads, thrashes, and crawls — and it says nothing
 * about how either behaves once the prompt is long.
 *
 * This service closes that gap by actually running the model: one bounded
 * generation per context length, through the SAME provider seam the Local LLM
 * playground uses (`localLlmPlayground.runLocalLlmTest`), recording throughput,
 * time-to-first-token, resident footprint, and the environment the measurement
 * was taken in. `lib/localModelAssessment.js` turns that evidence into a verdict
 * and an intent-specific ranking.
 *
 * ## AI Provider Usage Policy (root CLAUDE.md) — read before editing
 *
 * Assessments call an LLM, so they are STRICTLY user-triggered. This module
 * mirrors the `initDrillCache` / `requestCacheFill` split from
 * `meatspacePostDrillCache.js`:
 *
 *   - `loadAssessments()` / `getAssessmentReport()` read ONLY what is already on
 *     disk. Zero LLM calls. Safe from boot, from a poll, from anywhere.
 *   - `runAssessment()` is the only function that touches a provider, and it is
 *     reachable only from `POST /api/local-llm/assessments/run` — a deliberate
 *     user action whose UI names the backend, the model, and the number of runs
 *     before it fires.
 *
 * There is NO scheduler, NO boot hook, and NO "assess everything installed"
 * background sweep. Do not add one: a fresh install must be silent on the LLM
 * front until the user asks.
 *
 * ## Privacy
 *
 * The recorded environment is deliberately coarse — platform, arch, CPU count,
 * total/available memory, backend name. It never captures a hostname, a
 * username, a path, or any other machine identity, because assessments are
 * user-visible and end up in bug reports.
 *
 * ## Storage (docs/STORAGE.md)
 *
 * `file-primary`, **intentionally machine-local — never federated.** An
 * assessment is a statement about THIS machine's hardware; a peer's copy would
 * be actively misleading (a peer's 8 GB laptop must not inherit a 128 GB box's
 * "fits" verdict). No sync cursor, no tombstone, no schema-version entry.
 */

import { join } from 'path';
import { rename } from 'fs/promises';
import os from 'os';
import { PATHS, atomicWrite, ensureDir, tryReadFile, safeJSONParse } from '../lib/fileUtils.js';
import { getAvailableMemoryGb } from '../lib/localMemory.js';
import {
  ASSESSMENT_INTENTS,
  classifyFitVerdict,
  classifySampleFailure,
  rankByIntent,
  summarizePerformance,
} from '../lib/localModelAssessment.js';
import { runLocalLlmTest } from './localLlmPlayground.js';
import { listModels } from './localLlm.js';
import {
  getLoadedModels as getLoadedOllamaModels,
  getLastInstalledModelsError as getOllamaListError,
} from './ollamaManager.js';
import { getLastListError as getLmStudioListError } from './lmStudioManager.js';

const ASSESSMENTS_DIR = join(PATHS.data, 'local-llm');
const ASSESSMENTS_FILE = join(ASSESSMENTS_DIR, 'assessments.json');

// Storage-layout version for the on-disk file. Bump only when the persisted
// shape changes in a way a reader must branch on.
const STORE_SCHEMA_VERSION = 1;

const GB = 2 ** 30;

// Nominal context sizes to sample, in approximate tokens. Three points is the
// minimum that shows a TREND rather than a single data point, and the top of
// the range is where a local model typically starts paging. Users can override
// per run; the route caps the list so one request can't turn into a 20-run job.
export const DEFAULT_CONTEXT_TOKENS = [512, 4096, 16384];

// Conventional English chars-per-token ratio, used ONLY to size the filler
// prompt for a requested nominal context. PortOS has no tokenizer, so nothing
// downstream reports a token *measurement* — see the throughput unit note in
// lib/localModelAssessment.js.
const CHARS_PER_TOKEN = 4;

// Each sample generates a short answer: the point is measuring prefill + decode
// at a given context, not producing text. Small and fixed so throughput is
// comparable across models and across context lengths.
const SAMPLE_MAX_TOKENS = 96;

// Per-sample ceiling. A model that cannot answer a trivial question within two
// minutes at this context has, for assessment purposes, failed at it — the
// timeout is recorded as a resource failure and the run moves on to the next
// context rather than hanging the request.
const SAMPLE_TIMEOUT_MS = 120000;

const SAMPLE_SYSTEM_PROMPT =
  'You are being benchmarked. Answer the final question in one short sentence. Do not summarize the reference text.';

// Deterministic filler, generated rather than stored, so a long context costs no
// repository bytes. Distinct numbered lines (not one repeated line) keep a
// backend's prefix cache from making a long prompt look artificially cheap.
function buildFillerPrompt(contextTokens) {
  const targetChars = Math.max(0, Math.round(contextTokens * CHARS_PER_TOKEN));
  const lines = [];
  let length = 0;
  for (let n = 1; length < targetChars; n += 1) {
    const line = `Reference item ${n}: a placeholder record used only to occupy context during measurement.\n`;
    lines.push(line);
    length += line.length;
  }
  return lines.join('');
}

/** The prompt for one sample: filler to fill the context, then a trivial question. */
export function buildSamplePrompt(contextTokens) {
  const filler = buildFillerPrompt(contextTokens);
  return `${filler}\nIgnoring every reference item above, what is 2 + 2? Answer with the number only.`;
}

/**
 * Coarse description of the machine the measurement was taken on. Deliberately
 * carries NO machine identity (see the privacy note at the top of this file).
 */
export async function captureEnvironment() {
  const totalGb = os.totalmem() / GB;
  // `null` (not `0`) when the probe fails — an unknown budget must not read as
  // "no memory available", which would make every model look like it fits
  // nothing.
  const availableGb = await getAvailableMemoryGb().catch(() => null);
  return {
    platform: os.platform(),
    arch: os.arch(),
    cpuCount: os.cpus()?.length ?? null,
    totalMemoryGb: Number(totalGb.toFixed(1)),
    availableMemoryGb: Number.isFinite(availableGb) ? Number(availableGb.toFixed(1)) : null,
    // The budget the fit verdict is scored against: never more than what is
    // actually free right now, never more than the box has.
    memoryBudgetGb: Number.isFinite(availableGb)
      ? Number(Math.min(totalGb, availableGb).toFixed(1))
      : null,
  };
}

// ---- store ------------------------------------------------------------------

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

// Move an unparseable store aside so a fresh one can be written without losing
// whatever the old file held. Best-effort: if the rename fails there is nothing
// further to preserve, and refusing the write outright would leave assessments
// permanently unusable.
async function quarantineStore(reason) {
  const parked = `${ASSESSMENTS_FILE}.corrupt-${Date.now()}`;
  const moved = await rename(ASSESSMENTS_FILE, parked).then(() => true).catch(() => false);
  console.error(`❌ Local LLM: ${reason} — ${moved ? `parked the old file as ${parked.split('/').pop()}` : 'could not park the old file'}`);
}

async function loadStore() {
  const raw = await tryReadFile(ASSESSMENTS_FILE);
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

const assessmentKey = (backend, modelId) => `${backend}:${modelId}`;

async function saveAssessment(assessment) {
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
  await ensureDir(ASSESSMENTS_DIR);
  await atomicWrite(ASSESSMENTS_FILE, { schemaVersion: STORE_SCHEMA_VERSION, assessments: next });
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
  await ensureDir(ASSESSMENTS_DIR);
  await atomicWrite(ASSESSMENTS_FILE, { schemaVersion: STORE_SCHEMA_VERSION, assessments: next });
  console.log(`🧹 Local LLM: dropped assessment for ${backend}/${modelId}`);
  return { deleted: true };
}

// ---- measurement ------------------------------------------------------------

/**
 * Turn one `runLocalLlmTest` result into a recorded sample.
 *
 * The distinction that matters: a run that produced no text is a FAILURE even
 * when `runLocalLlmTest` resolved without an `error` (it resolves rather than
 * throws on timeout). Recording it as a success with `charsPerSecond: 0` would
 * feed a fabricated zero into the speed average.
 */
export function toSample(contextTokens, result) {
  const timings = result?.timings || {};
  const ok = !result?.error && typeof result?.text === 'string' && result.text.trim().length > 0;
  return {
    contextTokens,
    ok,
    // Every timing is null-or-measured; nothing is defaulted to 0.
    charsPerSecond: ok && Number.isFinite(timings.charsPerSecond) ? timings.charsPerSecond : null,
    ttftMs: ok && Number.isFinite(timings.ttftMs) ? timings.ttftMs : null,
    totalMs: Number.isFinite(timings.totalMs) ? timings.totalMs : null,
    chars: Number.isFinite(timings.chars) ? timings.chars : null,
    error: result?.error || (ok ? null : 'model produced no output'),
  };
}

/** Resident bytes for a model, from Ollama's `/api/ps`. `null` when unknown. */
async function residentGbFor(backend, modelId) {
  // Only Ollama reports a resident size (`/api/ps` → `size`). LM Studio's
  // loaded-model listing carries no footprint, so the honest answer there is
  // `null` — not a size copied from the weight file, which would silently
  // re-introduce the estimate this feature exists to replace.
  if (backend !== 'ollama') return null;
  const loaded = await getLoadedOllamaModels().catch(() => []);
  const match = loaded.find((m) => m?.id === modelId || m?.name === modelId);
  const bytes = match?.size;
  return Number.isFinite(bytes) && bytes > 0 ? Number((bytes / GB).toFixed(2)) : null;
}

// Human-readable reason behind a non-`fits` verdict, or `null` for `fits`.
// Quotes the backend's own error where there is one — a verbatim OOM message is
// far more actionable than a paraphrase.
function describeVerdict(verdict, samples) {
  if (verdict === 'fits') return null;
  const backendError = samples.find((s) => s?.error)?.error || null;
  if (verdict === 'unknown') return backendError || 'no sample produced a usable measurement';
  if (verdict === 'incompatible') return backendError || 'the backend refused this model';
  return backendError || 'every context length tested exhausted this machine';
}

/**
 * Run one model's assessment. **The only LLM-calling entry point in this
 * module** — see the AI Provider Usage Policy note at the top.
 *
 * Samples run sequentially, smallest context first, so a model that dies at the
 * largest size has already recorded its working sizes. A resource failure stops
 * the remaining (larger) contexts: they cannot succeed once a smaller one has
 * exhausted memory, and running them would only burn minutes. An `incompatible`
 * failure stops immediately for the same reason.
 *
 * @param {object} options
 * @param {'ollama'|'lmstudio'} options.backend
 * @param {string} options.modelId
 * @param {number[]} [options.contextTokens] nominal context sizes to sample
 * @param {AbortSignal} [options.signal] client disconnect
 * @returns {Promise<object>} the persisted assessment record
 */
export async function runAssessment({ backend, modelId, contextTokens = DEFAULT_CONTEXT_TOKENS, signal } = {}) {
  const contexts = [...new Set(contextTokens)].filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  const environment = await captureEnvironment();
  const installed = await listModels(backend).catch(() => []);
  const card = installed.find((m) => m?.id === modelId) || null;

  console.log(`📏 Local LLM: assessing ${backend}/${modelId} across ${contexts.length} context sizes`);

  const samples = [];
  for (const context of contexts) {
    if (signal?.aborted) break;
    // runLocalLlmTest resolves (never throws) for in-stream failures, but can
    // still throw before the stream opens — an unconfigured provider. Catch that
    // into the same result shape so one bad backend records a failed sample
    // instead of aborting the whole assessment with no evidence at all.
    const result = await runLocalLlmTest({
      backend,
      modelId,
      prompt: buildSamplePrompt(context),
      systemPrompt: SAMPLE_SYSTEM_PROMPT,
      temperature: 0,
      maxTokens: SAMPLE_MAX_TOKENS,
      timeoutMs: SAMPLE_TIMEOUT_MS,
      signal,
    }).catch((err) => ({ backend, modelId, text: '', error: err?.message || 'assessment run failed' }));

    const sample = toSample(context, result);
    samples.push(sample);
    if (!sample.ok && classifySampleFailure(sample)) break;
  }

  const verdict = classifyFitVerdict(samples);
  const assessment = {
    backend,
    modelId,
    params: card?.params ?? null,
    // `null` = never measured; the LM Studio path legitimately reports null.
    residentGb: verdict === 'fits' ? await residentGbFor(backend, modelId) : null,
    assessedAt: new Date().toISOString(),
    environment,
    verdict,
    verdictReason: describeVerdict(verdict, samples),
    samples,
    performance: summarizePerformance(samples),
  };

  // A cancelled run is NOT evidence. `runLocalLlmTest` converts a client
  // disconnect into the same "Timed out after Nms" result a genuine resource
  // failure produces, so persisting here would record a user closing the tab as
  // `does-not-fit` — or, if they cancelled before the first sample landed, as an
  // `unknown` that silently removes the model from the "not yet measured" list.
  // Return the partial record so the caller can show what was gathered, but
  // leave the store untouched.
  if (signal?.aborted) {
    console.log(`📏 Local LLM: ${backend}/${modelId} assessment cancelled — not recorded`);
    return { ...assessment, cancelled: true };
  }

  console.log(`📏 Local LLM: ${backend}/${modelId} → ${verdict} (${assessment.performance.samplesOk}/${samples.length} samples ok)`);
  return saveAssessment(assessment);
}

/**
 * Everything the UI needs to explain local-model choice, read from disk only.
 *
 * `assessed` / `unassessed` split installed models by whether evidence exists —
 * an unassessed model is NOT ranked and NOT presented as a poor choice; it is
 * presented as unknown, with a button to measure it.
 *
 * @param {{ intent?: string }} [options]
 */
export async function getAssessmentReport({ intent = 'balanced' } = {}) {
  const { assessments, readError } = await loadStore();
  const resolvedIntent = ASSESSMENT_INTENTS.includes(intent) ? intent : 'balanced';

  // Both managers cache an EMPTY list on a failed read rather than throwing, so
  // `[]` alone cannot distinguish "this backend has no models" from "the list
  // could not be read" — and presenting the second as the first would silently
  // hide every assessable model plus the reason. Each manager's own list-error
  // getter is the authoritative signal; a `.catch` here is only the backstop.
  const listed = Object.fromEntries(await Promise.all(
    ['ollama', 'lmstudio'].map(async (backend) => {
      const models = await listModels(backend).catch((err) => ({ error: err?.message || 'model list failed' }));
      if (!Array.isArray(models)) return [backend, { models: null, error: models.error }];
      const error = backend === 'ollama' ? getOllamaListError() : getLmStudioListError();
      return [backend, { models, error: error || null }];
    })
  ));

  const listErrors = Object.entries(listed).filter(([, r]) => r.error).map(([backend]) => backend);
  const installedKeys = new Set(
    Object.entries(listed).flatMap(([backend, r]) => (r.models || []).map((m) => assessmentKey(backend, m?.id)))
  );

  // A model the user has since deleted must not keep showing up as a
  // recommendation — it cannot run. But only drop it when the backend's list is
  // TRUSTWORTHY: an unreadable list would otherwise wipe every recommendation
  // for that backend, which is the same "failed read read as empty" mistake.
  const trusted = new Set(Object.entries(listed).filter(([, r]) => Array.isArray(r.models) && !r.error).map(([backend]) => backend));
  const isStillInstalled = (a) =>
    !trusted.has(a?.backend) || installedKeys.has(assessmentKey(a?.backend, a?.modelId));
  const stillInstalled = assessments.filter(isStillInstalled);
  const uninstalled = assessments
    .filter((a) => !isStillInstalled(a))
    .map((a) => ({ backend: a?.backend || null, modelId: a?.modelId || null }));

  const { ranked, excluded } = rankByIntent(stillInstalled, resolvedIntent);

  const assessedKeys = new Set(assessments.map((a) => assessmentKey(a?.backend, a?.modelId)));
  const unassessed = [];
  for (const [backend, { models }] of Object.entries(listed)) {
    if (!Array.isArray(models)) continue;
    for (const model of models) {
      if (model?.id && !assessedKeys.has(assessmentKey(backend, model.id))) {
        unassessed.push({ backend, modelId: model.id, params: model.params ?? null });
      }
    }
  }

  return {
    intent: resolvedIntent,
    intents: ASSESSMENT_INTENTS,
    defaultContextTokens: DEFAULT_CONTEXT_TOKENS,
    assessments,
    unassessed,
    // Backends whose model list could not be trusted — distinct from "listed,
    // and legitimately empty".
    listErrors,
    // Measurements for models that are no longer installed. Kept on disk (a
    // re-install should not cost another run) but excluded from the ranking.
    uninstalled,
    readError,
    ranked,
    excluded,
  };
}
