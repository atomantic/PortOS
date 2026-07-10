/**
 * Creative Director — server-side scene evaluator (local-vision path).
 *
 * The `evaluate` step judges a freshly-rendered scene against the style spec +
 * scene intent. Historically this spawned a full CoS coding agent that landed
 * on the active provider's HEAVY model (Opus for Claude) purely to Read a
 * couple of thumbnails and PATCH a verdict — vastly overpowered for a bounded
 * "look at 1-3 frames, score 3 dimensions, accept/retry/fail" decision.
 *
 * This module runs that same decision server-side through PortOS's existing
 * vision-API path (`runPromptThroughProvider({ screenshots })`), preferring a
 * LOCAL vision-capable model (Ollama/LM Studio VLM). A CoS *agent* task can't
 * use a local vision model at all — `agentProviderResolution.js` rejects
 * `type:'api'` providers (no file-writing harness) and a claude-on-Ollama CLI
 * coding model isn't vision-capable — so the only way to evaluate on a local
 * vision model is this direct API call.
 *
 * `dispatchSceneEvaluation` is the single entry point the orchestrator calls.
 * When no vision-capable API provider is configured/available (or the vision
 * call fails), it falls back to the original Opus-agent path
 * (`enqueueEvaluateTask`), so installs without a local vision model keep
 * working exactly as before.
 */

import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { z } from 'zod';

import { PATHS } from '../../lib/fileUtils.js';
import { safeUnder } from '../../lib/ffmpeg.js';
import { extractJson } from '../../lib/jsonExtract.js';
import { runPromptThroughProvider, assertVisionRunUsedImages } from '../../lib/promptRunner.js';
import { buildEvaluateVisionPrompt, CD_MAX_SCENE_RETRIES } from '../../lib/creativeDirectorPrompts.js';
import { getSettings } from '../settings.js';
import { getProviderById } from '../providers.js';
import { listVisionModels } from '../localLlm.js';
import { addItem } from '../mediaCollections.js';
import { updateScene, recordRun, updateRun } from './local.js';
import { resolveStagePin } from './projectsLogic.js';
import { enqueueEvaluateTask } from './agentBridge.js';

// Cap frames per call — the runner base64-inlines every frame into one request
// body, so a large batch balloons the prompt and a local VLM's context window.
// 5 samples across the timeline is plenty to judge a short clip.
const MAX_EVAL_FRAMES = 5;
// Local VLMs on modest hardware can be slow to first token; give them room.
// This timeout is the only bound on generation length — the toolkit's api
// runner does not send `max_tokens`, so a verbose model is capped by time, not
// tokens (the structured-JSON prompt keeps a compliant model's reply short).
const VISION_EVAL_TIMEOUT_MS = 180000;

// Local backends served by an aiToolkit `api`-type provider. Auto-resolution
// only picks from these — the whole point is a LOCAL vision model. An explicit
// assignment (below) may still point at any configured API vision provider.
const LOCAL_VISION_BACKENDS = new Set(['ollama', 'lmstudio']);

// Only `accepted` is load-bearing — everything else is advisory. Map an
// explicit JSON `null` to `undefined` (absent) BEFORE validation, then
// `.catch(undefined)` drops anything that doesn't fit rather than rejecting the
// whole verdict. Two footguns this guards against:
//   - Numbers: `z.coerce.number` turns `null`/an object into `0`/`NaN`; the
//     null→undefined map + min/max bound + `.catch` mean a model emitting
//     `"score": 85` (percent) or `"imageStrength": null` drops the field instead
//     of forcing 0 or nuking the verdict.
//   - Strings: use strict `z.string()` (NOT `z.coerce.string()`) so a malformed
//     nested shape like `"refinedPrompt": {"prompt":"add fog"}` doesn't coerce to
//     the literal `"[object Object]"` and get written as the retry render prompt.
//     A non-string just drops to undefined, leaving the prompt unchanged.
const nullToUndefined = (v) => (v === null ? undefined : v);
const optNumber = z.preprocess(nullToUndefined, z.coerce.number().min(0).max(1).optional().catch(undefined));
const optString = (max) => z.preprocess(nullToUndefined, z.string().max(max).optional().catch(undefined));
const verdictSchema = z.object({
  accepted: z.boolean(),
  score: optNumber,
  notes: optString(2000),
  refinedPrompt: optString(8000),
  imageStrength: optNumber,
});

/**
 * Parse a vision model's reply into a validated verdict. Uses the shared
 * `extractJson` (code-fence stripping, balanced-block walking, trailing-comma
 * repair) to tolerate chatter around the object, preferring the block that
 * actually carries a boolean `accepted`. Throws when no usable verdict is
 * present so the caller falls back to the agent path.
 *
 * Pure — exported for tests.
 */
export function parseVisionVerdict(text) {
  const { value } = extractJson(String(text || ''), {
    shapePredicate: (v) => v && typeof v === 'object' && typeof v.accepted === 'boolean',
  });
  if (value === undefined) throw new Error('no JSON verdict in vision reply');
  return verdictSchema.parse(value);
}

/**
 * Resolve which API provider + model should run the vision evaluation.
 *
 * Order:
 *   1. Explicit assignment — the project's own `modelOverrides.evaluation` pin
 *      (per-project CD provider/model pins) when set, else the global
 *      `settings.creativeDirector.evaluation` pin (set via AI Assignments).
 *      Honored as long as it's an enabled API provider; the assigned `model`
 *      (if any) is used verbatim.
 *   2. Auto — the first installed local (Ollama/LM Studio) vision-capable model.
 *
 * @param {object} [project] the CD project, for its per-project override.
 * @returns {Promise<{ provider: object, model: string|undefined }|null>} null
 *   when nothing suitable is configured (caller falls back to the agent).
 */
export async function resolveVisionEvalTarget(project) {
  // An API provider is usable only if it exists and is enabled — vision runs
  // through the api-only chat path, so a CLI/TUI provider can't serve it.
  const usableApiProvider = async (id) => {
    const p = await getProviderById(id).catch(() => null);
    return p && p.type === 'api' && p.enabled !== false ? p : null;
  };

  const settings = await getSettings().catch(() => ({}));
  const assigned = resolveStagePin('evaluation', project, settings);

  if (assigned.providerId) {
    const provider = await usableApiProvider(assigned.providerId);
    if (provider) return { provider, model: assigned.model || undefined };
    // A stale/invalid pin shouldn't silently downgrade to Opus — fall through
    // to auto-resolution so a healthy local VLM is still preferred.
  }

  // Scan ALL local vision candidates, not just the first: the first entry may
  // belong to a disabled/missing provider (e.g. Ollama off) while a later one
  // (e.g. LM Studio) is usable. Stopping at the first would wrongly fall back
  // to the Opus agent.
  const visionModels = await listVisionModels().catch(() => []);
  for (const m of visionModels) {
    if (!LOCAL_VISION_BACKENDS.has(m.backend)) continue;
    const provider = await usableApiProvider(m.providerId);
    if (provider) return { provider, model: m.id };
  }
  return null;
}

/**
 * Collect the on-disk frame paths for a scene's evaluation. Prefers the
 * multi-frame timeline samples; falls back to the single `{jobId}.jpg`
 * thumbnail. Only returns files that actually exist (frames can be deleted with
 * the underlying video while a project is paused).
 */
function collectFramePaths(scene) {
  // safeUnder basenames + rejects `..`/slashes so a tampered scene.renderedJobId
  // or evaluationFrames entry can't traverse outside the thumbnails dir.
  const frames = Array.isArray(scene.evaluationFrames) ? scene.evaluationFrames : [];
  const paths = frames
    .map((f) => safeUnder(PATHS.videoThumbnails, f))
    .filter((p) => p && existsSync(p))
    .slice(0, MAX_EVAL_FRAMES);
  if (paths.length) return paths;
  if (scene.renderedJobId) {
    const single = safeUnder(PATHS.videoThumbnails, `${scene.renderedJobId}.jpg`);
    if (single && existsSync(single)) return [single];
  }
  return [];
}

/**
 * Evaluate a scene with a vision model. Resolves the provider, attaches the
 * sampled frames, and parses a structured verdict.
 *
 * @returns {Promise<
 *   | { ok: true, verdict: object, llm: { provider: string, model: string|null }, runId: string }
 *   | { ok: false, fallbackToAgent: true, reason: string }
 * >}
 */
export async function evaluateSceneWithVision(project, scene) {
  const target = await resolveVisionEvalTarget(project);
  if (!target) {
    return { ok: false, fallbackToAgent: true, reason: 'no vision-capable API provider configured' };
  }

  const frames = collectFramePaths(scene);
  if (frames.length === 0) {
    // No image on disk — the vision API path has nothing to send. The agent's
    // template has the same prerequisite, but let it handle the edge case.
    return { ok: false, fallbackToAgent: true, reason: 'no evaluation frames on disk' };
  }

  // Record a RUNNING evaluate run BEFORE the (up-to-180s) vision call so a
  // concurrent advanceAfterSceneSettled (user clicks Start/Resume, or a stale
  // completion fires) sees a live run via completionHook's `noLiveEvaluateRun`
  // check and won't dispatch a second evaluation of the same render. This
  // mirrors the agent path, which records a running run in agentBridge before
  // enqueueing. applySceneVerdict flips this run to completed on success.
  const runId = randomUUID();
  await recordRun(project.id, {
    runId,
    kind: 'evaluate',
    sceneId: scene.sceneId || null,
    status: 'running',
    via: 'vision',
    provider: target.provider.id,
    model: target.model || null,
  }).catch((err) => console.log(`⚠️ CD vision recordRun(running) failed: ${err.message}`));

  try {
    const prompt = buildEvaluateVisionPrompt(project, scene, frames.length);
    const result = await runPromptThroughProvider({
      provider: target.provider,
      model: target.model,
      prompt,
      source: 'cd-scene-evaluate',
      screenshots: frames,
      timeout: VISION_EVAL_TIMEOUT_MS,
    });

    // Guard against a silent fallback to a non-API provider (which would drop the
    // images and hallucinate a verdict from the prompt text alone).
    const ran = assertVisionRunUsedImages(result, target.provider);
    const verdict = parseVisionVerdict(result.text);
    return {
      ok: true,
      verdict,
      llm: { provider: ran.id || target.provider.id, model: result.model || target.model || null },
      runId,
    };
  } catch (err) {
    // The vision call / parse failed — close the running run so it doesn't
    // linger as "live" and block the agent fallback's own orphan handling.
    await updateRun(project.id, runId, { status: 'failed', completedAt: new Date().toISOString() })
      .catch(() => {});
    throw err;
  }
}

// advanceAfterSceneSettled is dynamically imported to avoid a static import
// cycle (completionHook → sceneEvaluator → completionHook).
const loadAdvance = () => import('./completionHook.js').then((m) => m.advanceAfterSceneSettled);

/**
 * Apply a parsed verdict to a scene, driving the exact same transitions the
 * agent's PATCH + orchestrator would:
 *   - accepted            → status 'accepted' + add the rendered video to the
 *                           project collection, then advance.
 *   - miss, retries left  → status 'pending' + refined prompt + retryCount++
 *                           (+ optional imageStrength), then advance (re-render).
 *   - miss, exhausted     → status 'failed', then advance.
 *
 * `score`/`imageStrength` are already validated to [0,1]-or-undefined by
 * `verdictSchema`, so no re-clamping is needed here.
 *
 * `runId` closes the RUNNING evaluate run opened by evaluateSceneWithVision.
 * When absent (a direct caller), a completed run is recorded instead so the
 * Runs tab still shows a local-model evaluation.
 */
export async function applySceneVerdict(project, scene, verdict, llm = null, runId = null) {
  const evaluation = {
    accepted: !!verdict.accepted,
    score: verdict.score,
    notes: verdict.notes || '',
    sampledAt: new Date().toISOString(),
  };
  const retryCount = scene.retryCount || 0;

  // Close the in-flight evaluate run (or record a fresh completed one) so the
  // Runs tab shows a local-model evaluation instead of a silent gap.
  const runPatch = {
    status: 'completed',
    completedAt: evaluation.sampledAt,
    via: 'vision',
    provider: llm?.provider || null,
    model: llm?.model || null,
  };
  await (runId
    ? updateRun(project.id, runId, runPatch)
    : recordRun(project.id, { kind: 'evaluate', sceneId: scene.sceneId || null, ...runPatch })
  ).catch((err) => console.log(`⚠️ CD vision run record failed: ${err.message}`));

  // Advancing to the next scene / stitch is a downstream orchestration step —
  // fire-and-forget and self-healing (idempotent, re-triggered on the next
  // Start/Resume/completion), exactly how the PATCH route calls it. Its failure
  // must NOT propagate out of applySceneVerdict: dispatchSceneEvaluation's catch
  // would otherwise overwrite the scene we just correctly settled
  // (accepted/pending) with 'failed' for a purely downstream error (e.g. an
  // ffmpeg stitch failure on the final accepted scene).
  const advance = async () => {
    const advanceAfterSceneSettled = await loadAdvance();
    return advanceAfterSceneSettled(project.id).catch((err) =>
      console.log(`⚠️ CD advance after scene ${scene.sceneId} settled failed: ${err.message}`));
  };

  if (verdict.accepted) {
    await updateScene(project.id, scene.sceneId, { status: 'accepted', evaluation });
    if (project.collectionId && scene.renderedJobId) {
      await addItem(project.collectionId, { kind: 'video', ref: scene.renderedJobId })
        .catch((err) => {
          // Idempotent — a re-evaluation of an already-collected scene is fine.
          if (!/already in collection/i.test(err.message)) {
            console.log(`⚠️ CD collection add failed for ${scene.renderedJobId}: ${err.message}`);
          }
        });
    }
    console.log(`✅ CD scene ${scene.sceneId} accepted by vision (${llm?.provider || 'local'}/${llm?.model || '?'})`);
    return advance();
  }

  if (retryCount < CD_MAX_SCENE_RETRIES) {
    const patch = { status: 'pending', retryCount: retryCount + 1, evaluation };
    if (verdict.refinedPrompt && verdict.refinedPrompt.trim()) patch.prompt = verdict.refinedPrompt.trim();
    if (verdict.imageStrength !== undefined) patch.imageStrength = verdict.imageStrength;
    await updateScene(project.id, scene.sceneId, patch);
    console.log(`🔁 CD scene ${scene.sceneId} rejected by vision — retry ${patch.retryCount}/${CD_MAX_SCENE_RETRIES}`);
    return advance();
  }

  await updateScene(project.id, scene.sceneId, { status: 'failed', evaluation });
  console.log(`⛔ CD scene ${scene.sceneId} failed by vision — retries exhausted`);
  return advance();
}

// In-process re-entrancy guard keyed on project:sceneId, acquired SYNCHRONOUSLY
// at the top of dispatch — before any await — so it closes the whole window,
// including slow (cache-cold) provider discovery, not just the vision call. Both
// dispatch call sites (sceneRunner render-completion + completionHook orphan
// resume) go through here, so a concurrent advanceAfterSceneSettled can't start
// a second evaluation of the same render. The persisted running-run marker below
// is the cross-path/observability backstop; this Set is the primary guard.
const inflightSceneEval = new Set();

/**
 * Single entry point the orchestrator calls to settle a rendered scene. Tries
 * the local-vision path; on no-provider or ANY failure falls back to the
 * Opus-agent path. Never throws — it runs outside the Express request lifecycle
 * (job-completion hook / orchestrator), where an uncaught throw would crash the
 * process.
 */
export async function dispatchSceneEvaluation(project, scene) {
  const lockKey = `${project.id}:${scene.sceneId}`;
  if (inflightSceneEval.has(lockKey)) {
    console.log(`⏳ CD scene ${scene.sceneId} evaluation already in flight — skipping duplicate dispatch`);
    return null;
  }
  inflightSceneEval.add(lockKey);
  try {
    return await runSceneEvaluation(project, scene);
  } finally {
    inflightSceneEval.delete(lockKey);
  }
}

async function runSceneEvaluation(project, scene) {
  let result;
  try {
    result = await evaluateSceneWithVision(project, scene);
  } catch (err) {
    console.log(`⚠️ CD vision eval errored for scene ${scene.sceneId} — falling back to agent: ${err.message}`);
    result = { ok: false, fallbackToAgent: true, reason: err.message };
  }

  if (result.ok) {
    try {
      await applySceneVerdict(project, scene, result.verdict, result.llm, result.runId);
      return { via: 'vision', verdict: result.verdict, llm: result.llm };
    } catch (err) {
      // Verdict came back but persisting/advancing threw. Don't re-run on the
      // agent — that could double-apply the verdict (and re-add to the
      // collection). Best-effort mark the scene failed so the orchestrator can
      // recover, and never throw (this runs outside the request lifecycle).
      console.error(`❌ CD applySceneVerdict failed for scene ${scene.sceneId}: ${err.message}`);
      await updateScene(project.id, scene.sceneId, {
        status: 'failed',
        evaluation: {
          accepted: false,
          notes: `Vision verdict could not be applied: ${err.message}`,
          sampledAt: new Date().toISOString(),
        },
      }).catch((e) => console.log(`⚠️ CD verdict-failure mark for ${scene.sceneId} failed: ${e.message}`));
      const advanceAfterSceneSettled = await loadAdvance();
      return advanceAfterSceneSettled(project.id).catch(() => {});
    }
  }

  console.log(`🎬 CD scene ${scene.sceneId} evaluation via agent (${result.reason})`);
  // Honor the never-throws contract: enqueueEvaluateTask can reject on a disk /
  // prompt-build failure, and this runs off a media-job event listener whose
  // floating promise would surface as an unhandledRejection (fatal on modern
  // Node). The scene stays 'evaluating' on failure, so a later resume retries.
  return enqueueEvaluateTask(project, scene).catch((err) => {
    console.error(`❌ CD agent-eval enqueue failed for scene ${scene.sceneId}: ${err.message}`);
    return null;
  });
}
