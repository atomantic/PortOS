/**
 * Music Video auto-review (#10014) — server-side dispatch of a STANDALONE run's
 * revised sections.
 *
 * A run a production owns has its hand-outs dispatched by productionService
 * (a pool route per step). A run the director started from the board has no
 * pool, so its sections are generated here, without a browser: the board's two
 * scene lanes, routed from the project's SAVED pins — the frame backend from
 * the project's image pin through the MUSIC_VIDEO render target, the clip
 * backend/model/fal options from `project.videoSettings` (a blank pin is the
 * director's "follow the install default" choice, resolved exactly as the
 * board's own request would be). The submission itself is the production
 * lane (`dispatchProductionStep`), tagged with the run's revision so the
 * revision guard still charges every job against `limits.maxGenerations`.
 *
 * A section this server cannot generate is NEVER skipped silently: dispatch
 * stops and returns `halt` with the specific reason, and every section that
 * did not reach the queue has its claim released (and its charge refunded) so
 * the director can fix the cause and resume the revision.
 */

import { shotActionContractProblem } from '../../lib/musicVideoActionContract.js';
import { QUEUEABLE_IMAGE_MODES, IMAGE_GEN_MODE } from '../../lib/generationModes.js';
import { RENDER_TARGET, recordRenderPin } from '../../lib/renderTargets.js';
import { getProject } from './projects.js';
import { releaseRevisionSection } from './revisionService.js';
import { dispatchProductionStep } from './productionDispatch.js';
import { loadPoolEnv, routeUnavailableReason, sceneRequirement } from './productionPool.js';

const unavailable = (reason) => ({ reason });

/** The frame route a standalone run renders on: the project's image pin, then the MUSIC_VIDEO target, then the install default. */
async function frameRoute(project, env) {
  const [{ resolveRenderTargetConfig }, { selectLocalImageModelFromSettings }] = await Promise.all([
    import('../imageGen/cloudProviderConfig.js'),
    import('../imageGen/prepareParams.js'),
  ]);
  const pin = recordRenderPin(project);
  const resolved = resolveRenderTargetConfig(env.settings, RENDER_TARGET.MUSIC_VIDEO, {
    recordMode: pin.mode, recordModel: pin.modelId, fallbackMode: IMAGE_GEN_MODE.EXTERNAL, usableInstallFallback: true,
  });
  if (!QUEUEABLE_IMAGE_MODES.includes(resolved.mode)) {
    return unavailable(`The ${resolved.mode} image backend renders synchronously and cannot run unattended — pin a queued frame backend, or generate this frame on the board`);
  }
  const model = resolved.mode === IMAGE_GEN_MODE.LOCAL
    ? selectLocalImageModelFromSettings(env.settings, '', env.imageModels || [], resolved.modelCandidates)?.id || null
    : resolved.cloud?.modelOverride || null;
  return { route: { kind: 'image', mode: resolved.mode, model } };
}

/** The clip route a standalone run renders on: the project's saved video pin, or the ladder the board's blank pin resolves through. */
async function clipRoute(project, env) {
  const pin = project.videoSettings || {};
  // The audio-reactive lane conditions every clip on a LoRA the board detects
  // in its own catalog and sends with the request; it has no server-side route.
  if (pin.backend === 'local' && pin.generationMode === 'audioReactive') {
    return unavailable('This project renders clips in the audio-reactive lane, which only the board can submit — switch the video renderer, or generate this clip on the board');
  }
  const { resolveVideoMode } = await import('../videoGen/modes.js');
  const mode = pin.backend || resolveVideoMode(null, env.settings, { target: RENDER_TARGET.MUSIC_VIDEO });
  return { route: { kind: 'video', mode, model: mode === 'local' ? pin.modelId || null : null } };
}

/** Plan one section: `{ stepKind, route }` it can be submitted on, or `{ reason }` it cannot. */
async function planSection(project, section, env) {
  const scene = (project.scenes || []).find((entry) => entry.sceneId === section.sceneId);
  if (!scene) return unavailable('its scene no longer exists');
  const problem = shotActionContractProblem(scene.direction?.actionContract, scene);
  if (problem) return unavailable(problem);
  const stepKind = section.kind === 'image' ? 'frame' : 'clip';
  const planned = stepKind === 'frame' ? await frameRoute(project, env) : await clipRoute(project, env);
  if (planned.reason) return planned;
  const refused = await routeUnavailableReason(planned.route, sceneRequirement(project, scene, stepKind), env);
  return refused ? unavailable(refused) : { scene, stepKind, route: planned.route };
}

const label = (project, sceneId) => {
  const scene = (project?.scenes || []).find((entry) => entry.sceneId === sceneId);
  return `"${scene?.label || sceneId}"`;
};

/** How a refused submission stops the run: a spent limit is `limit-reached`; everything else needs the director. */
const haltFor = (err, reason) => (err?.code === 'AUTO_REVIEW_SPEND_LIMIT'
  ? { status: 'limit-reached', reason: err.message }
  : { status: 'needs-human', reason });

/**
 * Submit `sections` (`[{ sceneId, kind: 'image'|'video' }]`, already claimed by
 * `resumeRevision`) for the revision `revisionId` of a standalone run.
 *
 * Returns `{ submitted: [{ sceneId, kind, jobId }], halt }` — `halt` is
 * `{ status, reason }` when a section could not be submitted (the run must
 * stop), else null. Sections submitted before the refusal stay in flight; the
 * refused one and every later one are released.
 */
export async function dispatchRevisedSections({ projectId, revisionId, sections }) {
  const release = (pending) => Promise.all(pending.map((section) => releaseRevisionSection(projectId, revisionId, section.sceneId).catch(() => {})));
  const env = await loadPoolEnv().catch((err) => ({ error: err }));
  if (env.error) {
    await release(sections);
    return { submitted: [], halt: { status: 'needs-human', reason: `The revised sections could not be prepared for generation: ${env.error.message}` } };
  }
  const project = await getProject(projectId);
  const submitted = [];
  for (let i = 0; i < sections.length; i += 1) {
    const section = sections[i];
    const plan = project
      ? await planSection(project, section, env).catch((err) => unavailable(err.message))
      : unavailable('the project no longer exists');
    const stopWith = async (halt) => {
      // Sections already submitted stay in flight; this one and every later one are released.
      await release(sections.slice(i));
      return { submitted, halt };
    };
    if (plan.reason) {
      return stopWith({ status: 'needs-human', reason: `The ${section.kind === 'image' ? 'frame' : 'clip'} for ${label(project, section.sceneId)} cannot be generated automatically: ${plan.reason}` });
    }
    const tag = { projectId, sceneId: section.sceneId, revisionId };
    const sent = await dispatchProductionStep({ stepKind: plan.stepKind, project, scene: plan.scene, route: plan.route, tag, settings: env.settings })
      .catch((err) => ({ error: err }));
    // A job for this section is already live (an earlier hand-out of it): it is paid for and running.
    if (sent.error?.code === 'AUTO_REVIEW_SECTION_IN_FLIGHT') continue;
    if (sent.error) return stopWith(haltFor(sent.error, `The ${plan.stepKind} for ${label(project, section.sceneId)} was refused: ${sent.error.message}`));
    submitted.push({ sceneId: section.sceneId, kind: section.kind, jobId: sent.jobId });
  }
  return { submitted, halt: null };
}
