/**
 * Creative Director — first-pass music-bed generation (#1928).
 *
 * Decides whether to render, derives the prompt, and enqueues it on the media job
 * queue's `'audio'` kind (generation is the Pipeline Audio stage's `generateMusic`).
 * The track attaches to the project's `musicBed` via `creativeDirectorMusicBedHook`,
 * so it lands even if the user navigated away.
 */

import { enqueueJob } from '../mediaJobQueue/index.js';
import { ENGINES, DEFAULT_ENGINE_ID, isEngineHealthy } from '../pipeline/musicGen.js';

// First provisioned engine in ENGINES' declared (preference) order, so a project with
// only a non-default backend still gets a bed; null when none. Sequential on
// purpose: the first healthy one wins and isEngineHealthy caches its verdict.
async function firstReadyEngineId() {
  for (const id of Object.keys(ENGINES)) {
    if (await isEngineHealthy(id)) return id;
  }
  return null;
}

// A music-gen prompt is a short mood/style brief, not the full treatment.
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
 * Enqueue a first-pass music-bed render, or report why it was skipped. Never
 * throws: it must not fail the auto-cast seeding it follows.
 * Returns `{ mode, enqueued, jobId? , reason? }`; `mode` echoes the resolved engine.
 */
export async function enqueueFirstPassMusicBed(project, { engine } = {}) {
  if (!project || typeof project !== 'object' || !project.id) {
    return { mode: engine || DEFAULT_ENGINE_ID, enqueued: false, reason: 'no-project' };
  }
  // Never clobber an existing bed (idempotent re-run).
  if (project.musicBed && typeof project.musicBed.filename === 'string' && project.musicBed.filename) {
    return { mode: engine || DEFAULT_ENGINE_ID, enqueued: false, reason: 'has-music-bed' };
  }
  // An explicit `engine` wins; otherwise prefer any provisioned local backend.
  const resolvedEngine = engine || await firstReadyEngineId() || DEFAULT_ENGINE_ID;
  // Health, not presence: a half-built venv would die at render with an ImportError.
  if (!await isEngineHealthy(resolvedEngine)) {
    return { mode: resolvedEngine, enqueued: false, reason: 'engine-not-ready' };
  }
  const prompt = buildMusicBedPrompt(project);
  if (!prompt) {
    return { mode: resolvedEngine, enqueued: false, reason: 'no-prompt' };
  }
  const queued = await enqueueJob({
    kind: 'audio',
    params: {
      prompt,
      engine: resolvedEngine,
      // Tag so creativeDirectorMusicBedHook files the track onto `musicBed`.
      creativeDirectorMusicBed: { projectId: project.id },
    },
  });
  console.log(`🎼 CD first-pass music bed: queued for project ${project.id.slice(0, 8)} (${resolvedEngine})`);
  return { mode: resolvedEngine, enqueued: true, jobId: queued.jobId };
}
