/**
 * Creative Director — deterministic smoke-test fixture.
 *
 * Spins up a 3-scene "colored ball" project with `disableAudio: true` and
 * `autoAcceptScenes: true` so the run proves the i2v chaining mechanics
 * end-to-end without the variance of the cognitive evaluator. The scenes
 * are intentionally trivial:
 *
 *   1. Red ball bouncing on white background     (text-to-video baseline)
 *   2. Blue ball bouncing on white background    (continuation from scene 1
 *                                                  — verifies the scene
 *                                                  transition + color change
 *                                                  is driven by the prompt
 *                                                  while motion carries
 *                                                  forward from the seed
 *                                                  frame)
 *   3. Blue ball bouncing on white background    (continuation from scene 2
 *                                                  — verifies pure i2v
 *                                                  continuation doesn't
 *                                                  drift)
 *
 * Result: ~9s total runtime, no LLM in the loop after the project is
 * created, audio rendering disabled. Use as a fast E2E health check after
 * touching anything in the CD pipeline (sceneRunner, mediaJobQueue,
 * completionHook, stitchRunner).
 */

import { createProject, setTreatment } from './local.js';

const SMOKE_SCENES = [
  {
    sceneId: 'scene-1',
    order: 0,
    intent: 'Establish: a red ball bouncing on a plain white background.',
    prompt: 'A red rubber ball bouncing up and down on a plain white background. Simple flat lighting, centered framing, slow gentle bounce, no other objects.',
    negativePrompt: 'text, watermark, blur, motion blur, multiple balls, complex background, shadows, people',
    durationSeconds: 3,
    useContinuationFromPrior: false,
    sourceImageFile: null,
  },
  {
    sceneId: 'scene-2',
    order: 1,
    intent: 'Color change: the same bouncing ball is now blue. Tests that the i2v render honors a prompt-driven color change while preserving the bouncing motion seeded by scene 1\'s last frame.',
    prompt: 'A blue rubber ball bouncing up and down on a plain white background. Simple flat lighting, centered framing, slow gentle bounce, no other objects.',
    negativePrompt: 'text, watermark, blur, motion blur, multiple balls, complex background, shadows, people, red',
    durationSeconds: 3,
    useContinuationFromPrior: true,
    sourceImageFile: null,
  },
  {
    sceneId: 'scene-3',
    order: 2,
    intent: 'Pure continuation: same blue ball, same scene. Tests that i2v chaining holds visual identity across a same-prompt continuation step.',
    prompt: 'A blue rubber ball bouncing up and down on a plain white background. Simple flat lighting, centered framing, slow gentle bounce, no other objects.',
    negativePrompt: 'text, watermark, blur, motion blur, multiple balls, complex background, shadows, people, red',
    durationSeconds: 3,
    useContinuationFromPrior: true,
    sourceImageFile: null,
  },
];

const SMOKE_TREATMENT = {
  logline: 'A red rubber ball changes color to blue and keeps bouncing.',
  synopsis: 'Three short clips that exercise the core mechanics of the Creative Director pipeline: text-to-video for the opening scene, continuation-with-prompt-change for the second, and pure continuation for the third. No characters, no story, no audio — just deterministic geometry against a uniform background so a human can verify the transitions worked at a glance.',
  scenes: SMOKE_SCENES,
};

const SMOKE_DEFAULTS = {
  name: 'CD smoke test (colored ball)',
  aspectRatio: '1:1',
  quality: 'draft',
  modelId: 'ltx23_distilled_q4',
  targetDurationSeconds: 9,
  styleSpec: 'Plain white background, single rubber ball, no text, no people. Flat lighting, centered framing.',
  startingImageFile: null,
  userStory: null,
  disableAudio: true,
  autoAcceptScenes: true,
};

/**
 * Create a fresh smoke-test project with a pre-filled treatment. The
 * caller is expected to POST /:id/start (or call advanceAfterSceneSettled)
 * to kick off the renders. Returns the created project record.
 *
 * Pure orchestration — no HTTP, no UI, no agent spawns.
 */
export async function createSmokeTestProject(overrides = {}) {
  const project = await createProject({ ...SMOKE_DEFAULTS, ...overrides });
  const withTreatment = await setTreatment(project.id, SMOKE_TREATMENT);
  console.log(`🧪 CD smoke project ready: ${withTreatment.id} (${withTreatment.scenes?.length ?? withTreatment.treatment?.scenes?.length ?? 0} scenes, autoAcceptScenes=${withTreatment.autoAcceptScenes ?? SMOKE_DEFAULTS.autoAcceptScenes}, disableAudio=${withTreatment.disableAudio ?? SMOKE_DEFAULTS.disableAudio})`);
  return withTreatment;
}
