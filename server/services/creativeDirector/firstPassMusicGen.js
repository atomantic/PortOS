/**
 * Creative Director — first-pass music-bed generation (#1928, split from
 * #1867's portrait/video first-pass work).
 *
 * Reuse, not a new pipeline (same constraint firstPassGen.js documents for
 * portraits). The actual generation call is the SAME generator-agnostic
 * `generateMusic` the Pipeline Audio stage already uses
 * (server/services/pipeline/musicGen.js) — this module only decides whether to
 * render, derives the prompt, and enqueues it onto the media job queue's new
 * `'audio'` kind so it runs as a background job instead of blocking the
 * auto-cast request.
 *
 * Unlike the portrait path, there is no catalog ingredient to attach the
 * result to — the issue explicitly calls this out ("no catalog-attach
 * equivalent yet"). The finished track attaches directly onto the Creative
 * Director PROJECT record's `musicBed` field via the durable
 * `creativeDirectorMusicBedHook` (mirrors catalogImageAttachHook, but for a
 * project instead of a catalog ingredient), so a render that completes after
 * the user has navigated away still lands.
 */

import { enqueueJob } from '../mediaJobQueue/index.js';
import { ENGINES, DEFAULT_ENGINE_ID, isEngineReady } from '../pipeline/musicGen.js';

// First provisioned engine in ENGINES' declared order (musicgen, audioldm2,
// acestep), so a project where only a non-default local backend is installed
// (e.g. AudioLDM2 but not MusicGen) still gets a first-pass bed instead of
// silently skipping on a hardcoded DEFAULT_ENGINE_ID check. Returns null when
// nothing is provisioned.
function firstReadyEngineId() {
  return Object.keys(ENGINES).find((id) => isEngineReady(id)) || null;
}

// Keep the derived prompt bounded — a music-gen prompt is a short mood/style
// brief, not the full treatment. Mirrors PORTRAIT_PROMPT_CHARS' "enough
// descriptive text, not the whole payload" posture.
export const MUSIC_BED_PROMPT_CHARS = 400;

/**
 * Pure: derive a music-gen prompt for a project's first-pass bed. The project
 * name anchors the subject; the treatment logline (once auto-compose has run)
 * gives the richest mood/genre signal, falling back to the styleSpec the user
 * set at creation. Returns '' when neither is present, so the caller can skip
 * rather than queue a contentless render.
 */
export function buildMusicBedPrompt(project) {
  if (!project || typeof project !== 'object') return '';
  const name = typeof project.name === 'string' ? project.name.trim() : '';
  const logline = typeof project.treatment?.logline === 'string' ? project.treatment.logline.trim() : '';
  const styleSpec = typeof project.styleSpec === 'string' ? project.styleSpec.trim() : '';
  const detail = logline || styleSpec;
  const joined = name && detail ? `${name} — ${detail}` : (name || detail);
  if (!joined) return '';
  return joined.length > MUSIC_BED_PROMPT_CHARS
    ? `${joined.slice(0, MUSIC_BED_PROMPT_CHARS).trim()}…`
    : joined;
}

/**
 * Enqueue a first-pass music-bed render for the given project, or report why
 * it was skipped. Best-effort and self-contained — never throws, mirrors
 * enqueueFirstPassPortraits' "side-effect of auto-cast, must not fail the
 * seeding it follows" contract.
 *
 * Returns `{ mode, enqueued, jobId? , reason? }`. `mode` echoes the resolved
 * engine id (even when skipped) so the response shape stays predictable.
 */
export async function enqueueFirstPassMusicBed(project, { engine } = {}) {
  if (!project || typeof project !== 'object' || !project.id) {
    return { mode: engine || DEFAULT_ENGINE_ID, enqueued: false, reason: 'no-project' };
  }
  // Never clobber an existing bed — re-running auto-cast with the toggle on
  // stays idempotent, same posture as firstPassGen's portrait-exists check.
  if (project.musicBed && typeof project.musicBed.filename === 'string' && project.musicBed.filename) {
    return { mode: engine || DEFAULT_ENGINE_ID, enqueued: false, reason: 'has-music-bed' };
  }
  // Resolve the engine once the project is known to need a render. An
  // explicit `engine` wins; otherwise prefer any provisioned local backend
  // over assuming the default (musicgen) is the one installed.
  const resolvedEngine = engine || firstReadyEngineId() || DEFAULT_ENGINE_ID;
  if (!isEngineReady(resolvedEngine)) {
    return { mode: resolvedEngine, enqueued: false, reason: 'engine-not-ready' };
  }
  const prompt = buildMusicBedPrompt(project);
  if (!prompt) {
    return { mode: resolvedEngine, enqueued: false, reason: 'no-prompt' };
  }
  const queued = enqueueJob({
    kind: 'audio',
    params: {
      prompt,
      engine: resolvedEngine,
      // Tag the job so the durable creativeDirectorMusicBedHook files the
      // finished track onto this project's `musicBed` field — no mounted
      // client required.
      creativeDirectorMusicBed: { projectId: project.id },
    },
  });
  console.log(`🎼 CD first-pass music bed: queued for project ${project.id.slice(0, 8)} (${resolvedEngine})`);
  return { mode: resolvedEngine, enqueued: true, jobId: queued.jobId };
}
