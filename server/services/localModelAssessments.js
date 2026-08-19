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
 * ## Where the pieces live
 *
 * The durable store, the environment capture, and the privacy/storage contract
 * moved to `localModelAssessmentStore.js` — that module has no path to a
 * provider, so read-only consumers (the catalog fit badge, `localLlm.getStatus`)
 * can import it without importing this one, and without an import cycle through
 * `localLlm.js`.
 */

import {
  ASSESSMENT_INTENTS,
  classifyFitVerdict,
  classifySampleFailure,
  rankByIntent,
  summarizePerformance,
} from '../lib/localModelAssessment.js';
import {
  assessmentKey,
  captureEnvironment,
  captureLiveEnvironments,
  deleteAssessment,
  loadAssessments,
  loadStore,
  saveAssessment,
  withStaleness,
} from './localModelAssessmentStore.js';
import { runLocalLlmTest } from './localLlmPlayground.js';
import { listModels } from './localLlm.js';
import {
  getLoadedModels as getLoadedOllamaModels,
  getLastInstalledModelsError as getOllamaListError,
} from './ollamaManager.js';
import { getLastListError as getLmStudioListError } from './lmStudioManager.js';

// Re-exported so the store split stays an implementation detail for callers that
// only ever wanted "the assessments feature".
export { captureEnvironment, deleteAssessment, loadAssessments };

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
 * @param {(frame: object) => void} [options.onProgress] per-sample progress.
 *   A run is minutes long on a large model, so the caller (the route) forwards
 *   these to the `localLlm:progress` socket event the pull/migrate paths already
 *   use. Frames carry `backend` + `modelId` so a listener can tell a frame from
 *   THIS run apart from an unrelated model install streaming on the same event.
 * @returns {Promise<object>} the persisted assessment record
 */
export async function runAssessment({ backend, modelId, contextTokens = DEFAULT_CONTEXT_TOKENS, signal, onProgress } = {}) {
  const contexts = [...new Set(contextTokens)].filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  // The listener runs outside the request lifecycle's error path in some callers
  // (a socket emit can throw on a closed io), and a broken progress consumer must
  // never abort a measurement the user is paying minutes for.
  const emit = (frame) => {
    if (typeof onProgress !== 'function') return;
    try { onProgress({ scope: 'assessment', backend, modelId, ...frame }); }
    catch (err) { console.error(`❌ Local LLM: assessment progress listener failed: ${err.message}`); }
  };
  const environment = await captureEnvironment({ backend });
  const installed = await listModels(backend).catch(() => []);
  const card = installed.find((m) => m?.id === modelId) || null;

  console.log(`📏 Local LLM: assessing ${backend}/${modelId} across ${contexts.length} context sizes`);
  emit({
    event: 'start',
    sampleIndex: 0,
    sampleCount: contexts.length,
    message: `Measuring ${modelId} — ${contexts.length} generation${contexts.length === 1 ? '' : 's'}…`,
  });

  const samples = [];
  for (const context of contexts) {
    if (signal?.aborted) break;
    emit({
      event: 'start',
      sampleIndex: samples.length,
      sampleCount: contexts.length,
      contextTokens: context,
      message: `${modelId}: sample ${samples.length + 1}/${contexts.length} at ${context.toLocaleString('en-US')} tokens of context…`,
    });
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
    // Report what the sample actually measured, not just that it finished — a
    // multi-minute run should show throughput accumulating rather than a bar
    // that only moves between contexts.
    emit({
      event: 'start',
      sampleIndex: samples.length,
      sampleCount: contexts.length,
      contextTokens: context,
      sample,
      message: sample.ok
        ? `${modelId}: ${context.toLocaleString('en-US')} tokens → ${sample.charsPerSecond ?? '?'} chars/s`
        : `${modelId}: ${context.toLocaleString('en-US')} tokens → failed (${sample.error})`,
    });
    if (!sample.ok && classifySampleFailure(sample)) break;
  }

  const verdict = classifyFitVerdict(samples);
  const assessment = {
    backend,
    modelId,
    params: card?.params ?? null,
    // LM Studio serves one quant per install but reports a repo-level id, so the
    // quant has to be recorded separately for a catalog badge to know WHICH
    // build was measured. `null` on Ollama (its id already carries the tag) and
    // whenever the backend reported none.
    quantization: card?.quantization ?? null,
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
    // A terminal frame either way, or a listener's banner sits on the last
    // sample forever. `cancelled` is NOT `error` — nothing failed.
    emit({ event: 'complete', cancelled: true, message: `${modelId}: assessment cancelled — nothing recorded` });
    return { ...assessment, cancelled: true };
  }

  console.log(`📏 Local LLM: ${backend}/${modelId} → ${verdict} (${assessment.performance.samplesOk}/${samples.length} samples ok)`);
  emit({
    event: 'complete',
    verdict,
    message: `${modelId}: ${verdict} (${assessment.performance.samplesOk}/${samples.length} samples ok)`,
  });
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
  const { assessments: stored, readError } = await loadStore();
  const resolvedIntent = ASSESSMENT_INTENTS.includes(intent) ? intent : 'balanced';

  // Every stored record is compared against the machine as it is NOW. A reading
  // taken before a RAM upgrade or a backend update describes hardware that no
  // longer exists, and nothing else on this page would ever say so — the user
  // would have to remember. This path can afford the backend-version probe (it
  // already lists models from both backends); the catalog badge path cannot, and
  // uses the free durable-fields comparison instead.
  const liveEnvironments = await captureLiveEnvironments();
  const assessments = stored.map((a) => withStaleness(a, liveEnvironments[a?.backend] || null));

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
    // The machine as it is now, so the panel can name the difference rather than
    // just flagging "stale". Keyed by backend because the backend version is
    // part of what makes a reading stale.
    liveEnvironments,
  };
}
