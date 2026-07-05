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
import { updateScene, recordRun } from './local.js';
import { enqueueEvaluateTask } from './agentBridge.js';

// Cap frames per call — the runner base64-inlines every frame into one request
// body, so a large batch balloons the prompt and a local VLM's context window.
// 5 samples across the timeline is plenty to judge a short clip.
const MAX_EVAL_FRAMES = 5;
// Local VLMs on modest hardware can be slow to first token; give them room.
const VISION_EVAL_TIMEOUT_MS = 180000;
// Structured JSON verdict, so the reply can't truncate mid-object.
const VISION_EVAL_MAX_TOKENS = 600;

// Local backends served by an aiToolkit `api`-type provider. Auto-resolution
// only picks from these — the whole point is a LOCAL vision model. An explicit
// assignment (below) may still point at any configured API vision provider.
const LOCAL_VISION_BACKENDS = new Set(['ollama', 'lmstudio']);

// Only `accepted` is load-bearing — everything else is advisory. Coerce loose
// numbers/strings, and `.catch(undefined)` so an out-of-range or unparseable
// optional field just drops out instead of rejecting the whole verdict (which
// would needlessly fall the scene back to the Opus agent). A model that emits
// `"score": 85` meaning 85% shouldn't nuke an otherwise-usable accept/reject.
const verdictSchema = z.object({
  accepted: z.boolean(),
  score: z.coerce.number().min(0).max(1).optional().catch(undefined),
  notes: z.coerce.string().max(2000).optional().catch(undefined),
  refinedPrompt: z.coerce.string().max(8000).optional().catch(undefined),
  imageStrength: z.coerce.number().min(0).max(1).optional().catch(undefined),
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
 *   1. Explicit assignment — `settings.creativeDirector.evaluation.providerId`
 *      (set via AI Assignments). Honored as long as it's an enabled API
 *      provider; the assigned `model` (if any) is used verbatim.
 *   2. Auto — the first installed local (Ollama/LM Studio) vision-capable model.
 *
 * @returns {Promise<{ provider: object, model: string|undefined }|null>} null
 *   when nothing suitable is configured (caller falls back to the agent).
 */
export async function resolveVisionEvalTarget() {
  // An API provider is usable only if it exists and is enabled — vision runs
  // through the api-only chat path, so a CLI/TUI provider can't serve it.
  const usableApiProvider = async (id) => {
    const p = await getProviderById(id).catch(() => null);
    return p && p.type === 'api' && p.enabled !== false ? p : null;
  };

  const settings = await getSettings().catch(() => ({}));
  const assigned = settings?.creativeDirector?.evaluation || {};

  if (assigned.providerId) {
    const provider = await usableApiProvider(assigned.providerId);
    if (provider) return { provider, model: assigned.model || undefined };
    // A stale/invalid pin shouldn't silently downgrade to Opus — fall through
    // to auto-resolution so a healthy local VLM is still preferred.
  }

  const visionModels = await listVisionModels().catch(() => []);
  const local = visionModels.find((m) => LOCAL_VISION_BACKENDS.has(m.backend));
  if (local) {
    const provider = await usableApiProvider(local.providerId);
    if (provider) return { provider, model: local.id };
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
 *   | { ok: true, verdict: object, llm: { provider: string, model: string|null } }
 *   | { ok: false, fallbackToAgent: true, reason: string }
 * >}
 */
export async function evaluateSceneWithVision(project, scene) {
  const target = await resolveVisionEvalTarget();
  if (!target) {
    return { ok: false, fallbackToAgent: true, reason: 'no vision-capable API provider configured' };
  }

  const frames = collectFramePaths(scene);
  if (frames.length === 0) {
    // No image on disk — the vision API path has nothing to send. The agent's
    // template has the same prerequisite, but let it handle the edge case.
    return { ok: false, fallbackToAgent: true, reason: 'no evaluation frames on disk' };
  }

  const prompt = buildEvaluateVisionPrompt(project, scene, frames.length);
  const result = await runPromptThroughProvider({
    provider: target.provider,
    model: target.model,
    prompt,
    source: 'cd-scene-evaluate',
    screenshots: frames,
    timeout: VISION_EVAL_TIMEOUT_MS,
    maxTokens: VISION_EVAL_MAX_TOKENS,
  });

  // Guard against a silent fallback to a non-API provider (which would drop the
  // images and hallucinate a verdict from the prompt text alone).
  const ran = assertVisionRunUsedImages(result, target.provider);
  const verdict = parseVisionVerdict(result.text);
  return {
    ok: true,
    verdict,
    llm: { provider: ran.id || target.provider.id, model: result.model || target.model || null },
  };
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
 */
export async function applySceneVerdict(project, scene, verdict, llm = null) {
  const evaluation = {
    accepted: !!verdict.accepted,
    score: verdict.score,
    notes: verdict.notes || '',
    sampledAt: new Date().toISOString(),
  };
  const retryCount = scene.retryCount || 0;

  // Best-effort run record so the Runs tab shows a local-model evaluation
  // instead of a silent gap where an agent run used to be.
  await recordRun(project.id, {
    kind: 'evaluate',
    sceneId: scene.sceneId || null,
    status: 'completed',
    completedAt: evaluation.sampledAt,
    via: 'vision',
    provider: llm?.provider || null,
    model: llm?.model || null,
  }).catch((err) => console.log(`⚠️ CD vision recordRun failed: ${err.message}`));

  const advanceAfterSceneSettled = await loadAdvance();

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
    return advanceAfterSceneSettled(project.id);
  }

  if (retryCount < CD_MAX_SCENE_RETRIES) {
    const patch = { status: 'pending', retryCount: retryCount + 1, evaluation };
    if (verdict.refinedPrompt && verdict.refinedPrompt.trim()) patch.prompt = verdict.refinedPrompt.trim();
    if (verdict.imageStrength !== undefined) patch.imageStrength = verdict.imageStrength;
    await updateScene(project.id, scene.sceneId, patch);
    console.log(`🔁 CD scene ${scene.sceneId} rejected by vision — retry ${patch.retryCount}/${CD_MAX_SCENE_RETRIES}`);
    return advanceAfterSceneSettled(project.id);
  }

  await updateScene(project.id, scene.sceneId, { status: 'failed', evaluation });
  console.log(`⛔ CD scene ${scene.sceneId} failed by vision — retries exhausted`);
  return advanceAfterSceneSettled(project.id);
}

/**
 * Single entry point the orchestrator calls to settle a rendered scene. Tries
 * the local-vision path; on no-provider or ANY failure falls back to the
 * Opus-agent path. Never throws — it runs outside the Express request lifecycle
 * (job-completion hook / orchestrator), where an uncaught throw would crash the
 * process.
 */
export async function dispatchSceneEvaluation(project, scene) {
  let result;
  try {
    result = await evaluateSceneWithVision(project, scene);
  } catch (err) {
    console.log(`⚠️ CD vision eval errored for scene ${scene.sceneId} — falling back to agent: ${err.message}`);
    result = { ok: false, fallbackToAgent: true, reason: err.message };
  }

  if (result.ok) {
    try {
      await applySceneVerdict(project, scene, result.verdict, result.llm);
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
