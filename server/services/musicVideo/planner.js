import { musicVideoCreativeContext, musicVideoDirectionContext } from '../../lib/musicVideoCreativeContext.js';
/**
 * Music Video — autonomous shot planner (#1855; multi-shot + lyrics #8964).
 *
 * #8964: sections are no longer 1:1 with scenes. `shotPlan.js#planShots`
 * tiles each analyzed section with several bounded shots (pacing ceiling =
 * the renderer's clip capacity, an opening hook, cuts preferring lyric-line /
 * phrase boundaries then downbeats then beats), and every shot carries its
 * section identity plus the lyric lines and phrase intent it spans. The
 * paragraphs below describe the original one-scene-per-section design; the
 * energy segmentation and grid snapping they describe still decide the
 * section edges each shot list is tiled inside.
 *
 * Part of #1760's secondary "autonomous mode" convenience path (the manual
 * director path shipped through Phase 2). Given a project's cached
 * `audioAnalysis.sections`, proposes one scene per section and seeds them
 * onto the director scene board via the same `addProjectScenes` mutator the
 * manual board uses.
 *
 * "Energy-aware durations" falls straight out of the cached analysis with no
 * extra weighting math needed here: `audioAnalysis.js#segmentSections`
 * already derives section boundaries from energy-novelty segmentation, so a
 * loud/eventful stretch of the track is already split into more, shorter
 * sections and a calm stretch into fewer, longer ones — each proposed scene
 * takes its section's span, with the internal cuts snapped onto the analyzed
 * beat grid first (`snapSectionsToGrid`, #4664) so the seeded spans cut on
 * the music rather than on energy-window edges.
 *
 * Director-first (#1760's core design constraint): this only SEEDS the
 * board with ordinary, fully-editable scene records — it never locks or
 * replaces director control, and the seeded scenes are indistinguishable
 * from hand-added ones. Optionally (best-effort, mirroring Creative
 * Director's first-pass asset gen in firstPassGen.js) also asks the
 * active/given AI provider for a first-pass `framePrompt`/`prompt` per scene
 * from the project's concept + section context. A missing/disabled provider
 * or an unparsable response degrades to plain scenes with empty prompts
 * rather than failing the plan request — the director can always fill in
 * prompts by hand afterward.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { extractJson } from '../../lib/jsonExtract.js';
import { runPromptThroughProvider } from '../promptRunner.js';
import { effortArg, recordLlmRoute, resolveMusicVideoLlm } from './llmRoute.js';
import { directShots, planShots, resolveClipCapacitySec, validSections } from './shotPlan.js';
import { getProject, addProjectScenes, mutateProjectRecord } from './projects.js';
import { productionFeedbackContext } from './productionReview.js';
import { parseShotCamera, planShotCameras, shotCameraPromptSection } from './shotCamera.js';
import { getCameraMovement } from '../../lib/cameraMovements.js';

const SCENE_LABEL_MAX = 120;
const SCENE_TEXT_MAX = 2000;
// Lyric text per shot quoted into the LLM prompt (the full text persists on
// the scene); keeps a lyric-dense plan inside the prompt budget.
const PROMPT_LYRIC_MAX = 240;
// The automation brief's standing guidance is prose, not a lyric line.
const PROMPT_GUIDANCE_MAX = 2000;
// A plan with more shots than this would blow the LLM prompt budget for
// marginal value (a 4-minute song at ~5s shots is ~50) — scenes are still
// seeded deterministically above the cap, just without the optional
// first-pass prompt text.
const MAX_SHOTS_FOR_PROMPTS = 120;

// `validSections` moved to shotPlan.js (#8980) so the treatment compiler can
// share it without importing the provider-calling planner; re-exported here.
export { validSections };

/**
 * Pure: turn the shot plan into scene-create inputs, in timeline order. Each
 * shot is a new, non-looping scene (`loop: false`) — the render refuses to
 * silently repeat its clip, so a shot longer than its generated clip asks the
 * director to trim, continue, replace, or explicitly loop it (render.js).
 * The label keeps the section name and numbers the shots inside it.
 */
function sceneInputsFromShots(shots) {
  return shots.map((shot) => {
    const base = shot.sectionLabel || `Section ${shot.sectionIndex + 1}`;
    const label = (shot.shotCount > 1 ? `${base} · ${shot.shotIndex + 1}/${shot.shotCount}` : base).slice(0, SCENE_LABEL_MAX);
    return {
      label,
      sectionLabel: shot.sectionLabel,
      sectionIndex: shot.sectionIndex,
      startSec: shot.startSec,
      endSec: shot.endSec,
      beatAligned: shot.beatAligned,
      loop: false,
      lyricText: shot.lyricText,
      visualIntent: shot.visualIntent,
      ...(shot.codeOverlay ? { codeOverlay: true } : {}),
      ...(shot.visualLayer ? {
        visualLayer: shot.visualLayer, shotMode: shot.shotMode,
        ...(shot.cardText !== undefined ? { cardText: shot.cardText } : {}),
        // A code shot is drawn by the composition: it carries no generation prose.
        ...(shot.visualLayer === 'code' ? {} : directedPrompts(shot)),
      } : {}),
    };
  });
}

const PERFORMANCE_FRAME = 'Frontal medium close-up, face unobstructed, mouth fully visible for source-audio lip-sync.';

// Deterministic direction survives no-provider and partial-response paths, and
// prefixes generated prose so the assigned set/look and keyframe remain explicit.
function directedPrompts(shot, generated = {}) {
  const frame = [
    shot.shotMode === 'performance' && PERFORMANCE_FRAME,
    shot.protagonist && `Subject: ${quote([shot.protagonist.name, shot.protagonist.description, shot.protagonist.face, shot.protagonist.hair, shot.protagonist.signature].filter(Boolean).join('; '), 450)}`,
    shot.set && `Location: ${quote(`${shot.set.name}. ${shot.set.description}. ${shot.set.lighting || ''}`, 550)}`,
    shot.look && `Wardrobe: ${quote(`${shot.look.name}. ${shot.look.description}`, 350)}`,
    generated.framePrompt || (shot.visualLayer === 'card' ? 'Graphic title card.' : 'Cinematic shot in the directed setting.'),
  ].filter(Boolean).join(' ');
  const motion = generated.prompt || (shot.visualLayer === 'card' ? 'Choreograph the graphic scene around the supplied musical anchors; give subject, props and camera a readable action and payoff. Use a hold only when it serves the chosen energy target.'
    : shot.shotMode === 'performance' ? `Perform to the source audio: ${shot.lyricText}`
      : `Stage a readable subject action and camera response for ${shot.lyricText || shot.visualIntent || shot.sectionLabel || 'this instrumental passage'}, timed to the supplied musical anchors and chosen energy target.`);
  return { framePrompt: frame.slice(0, SCENE_TEXT_MAX), prompt: motion.slice(0, SCENE_TEXT_MAX) };
}

const quote = (text, max) => {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * Build the LLM prompt asking for a first-pass framePrompt/prompt per SHOT.
 * Each line carries the shot's musical section (label, energy, position inside
 * the section), its duration, the lyric lines it spans (or that it is
 * instrumental — no lyrics are invented), and any phrase-level visual intent.
 */
export function buildScenePlanPrompt(project, shots) {
  const concept = project.concept || {};
  const direction = project.castAndSets?.status === 'skipped' ? null : project.castAndSets?.direction;
  const conceptLine = concept.prompt ? `Concept: ${concept.prompt}` : '';
  const styleLine = concept.style ? `Visual style: ${concept.style}` : '';
  // #8980: the treatment brief (when the director wrote one) steers the
  // first-pass prompts toward the intended audience, emotion and hook.
  const brief = project.treatment?.brief || {};
  const briefLines = [
    brief.audience && `Audience: ${quote(brief.audience, PROMPT_LYRIC_MAX)}`,
    brief.emotion && `Desired emotion: ${quote(brief.emotion, PROMPT_LYRIC_MAX)}`,
    brief.premise && `Premise: ${quote(brief.premise, PROMPT_LYRIC_MAX)}`,
    brief.hookObjective && `Opening hook objective: ${quote(brief.hookObjective, PROMPT_LYRIC_MAX)}`,
    brief.avoid && `Avoid: ${quote(brief.avoid, PROMPT_LYRIC_MAX)}`,
  ].filter(Boolean).join('\n');
  // Automation-first projects carry the director's standing guidance.
  const guidance = project.automation?.guidance?.trim();
  const guidanceLine = guidance ? `Director guidance: ${quote(guidance, PROMPT_GUIDANCE_MAX)}` : '';
  const savedPlan = project.productionReview?.draft;
  const motionPlan = savedPlan?.motionLanguage
    ? `SAVED ENERGY AND CHOREOGRAPHY DRAFT (planning does not grant approval):\n${quote(savedPlan.motionLanguage, 12000)}\nImplementation: ${quote(savedPlan.implementationPlan || '', 16000)}` : '';
  const hasLyrics = shots.some((s) => s.lyricText);
  const hasDelivery = shots.some((s) => s.delivery?.length);
  const shotLines = shots.map((s, i) => {
    const duration = (s.endSec - s.startSec).toFixed(1);
    const energy = typeof s.sectionEnergy === 'number' ? s.sectionEnergy.toFixed(2) : 'unknown';
    const section = `"${s.sectionLabel || `Section ${s.sectionIndex + 1}`}" shot ${s.shotIndex + 1}/${s.shotCount}`;
    const parts = [`${i}. ${section} — ${duration}s, energy ${energy}`];
    parts.push(s.lyricText ? `lyrics: "${quote(s.lyricText, PROMPT_LYRIC_MAX)}"` : 'instrumental');
    if (s.visualIntent) parts.push(`intent: ${quote(s.visualIntent, PROMPT_LYRIC_MAX)}`);
    if (s.delivery?.length) parts.push(`delivery: ${quote(s.delivery.join('; '), PROMPT_LYRIC_MAX)}`);
    if (s.hook) parts.push('OPENING HOOK');
    if (s.visualLayer) parts.push(`layer: ${s.visualLayer}; mode: ${s.shotMode}`);
    if (s.set) parts.push(`assigned set: ${quote(`${s.set.name}: ${s.set.description}; ${s.set.lighting || ''}`, 650)}`);
    if (s.look) parts.push(`assigned look: ${quote(`${s.look.name}: ${s.look.description}`, 400)}`);
    parts.push(`absolute time: ${s.startSec}–${s.endSec}s`);
    const anchors = (values) => (values || []).filter(t => Number.isFinite(t) && t >= s.startSec && t < s.endSec).slice(0, 16).join(', ');
    for (const kind of ['beats', 'downbeats']) {
      const times = anchors(project.audioAnalysis?.[kind]);
      if (times) parts.push(`${kind} (seconds): ${times}`);
    }
    if (s.shotMode === 'performance') parts.push(PERFORMANCE_FRAME);
    if (s.current?.framePrompt) parts.push(`current frame: ${quote(s.current.framePrompt, PROMPT_GUIDANCE_MAX)}`);
    if (s.current?.prompt) parts.push(`current motion: ${quote(s.current.prompt, PROMPT_GUIDANCE_MAX)}`);
    const currentMove = getCameraMovement(s.current?.camera?.move);
    if (currentMove) parts.push(`current camera: ${currentMove.value}${s.current.camera.speed ? ` (${s.current.camera.speed})` : ''}`);
    return parts.join('; ');
  }).join('\n');
  const revising = shots.some((s) => s.current);

  return `You are directing a music video for "${project.name}".
${conceptLine}
${styleLine}
${musicVideoCreativeContext(concept)}
${musicVideoDirectionContext(direction)}
${briefLines}
${guidanceLine}
${motionPlan}
${productionFeedbackContext(project)}

The song has been cut into these shots (index; musical section and the shot's position inside it; duration; normalized 0..1 section energy — higher is louder/more intense; the lyric lines sung during the shot, or "instrumental"; optional director intent${hasDelivery ? '; optional delivery directions from the lyric sheet' : ''}):
${shotLines}

For EACH shot above, propose a timed composition for its assigned medium (code-authored worlds, selected stills or footage):
- "framePrompt": the opening reference still — subject, setting, lighting, composition. Keep it concrete and visual.
- "prompt": the motion for that shot — subject action, staging and mood — building on the frame. Higher-energy sections read more kinetic; calmer sections more lingering.
- "camera": the shot's camera move from the vocabulary below, with its speed, end framing, whether it lands on the downbeat, and (for a static camera) the reason.
- Shots in the same section are one edited sequence: keep subject and setting continuous, but vary framing (wide / medium / close), angle, or action from shot to shot so consecutive shots cut rather than repeat.
- The OPENING HOOK shot must grab attention immediately.
- In each motion prompt, name absolute start/end times and the supplied musical anchors for subject action, prop transformation, camera framing/movement and any permitted graphic typography. Follow the saved energy target; this proposal still needs human review. Repeated choruses must develop the action, scale or staging instead of replaying the same pose. Include anticipation, payoff and recovery; motivated holds and long takes are valid. Do not replace choreography with continuous camera drift, geometry presence, subtitles alone or an arbitrary fast-cut quota.
${revising ? '- These shots already exist. Revise each one\'s current frame and motion to address the unresolved review feedback, keeping what the feedback does not ask to change.\n' : ''}- If an energy target or required audio timing is absent, identify it as a director decision to review rather than inventing analysis or claiming the plan is approved.
${hasLyrics ? '- Let the lyric lines inform the imagery and emotion of their shot (interpret, do not illustrate word-for-word). Never render the lyrics as on-screen text in footage; assigned card layers use their explicit card text.\n' : ''}${hasDelivery ? '- Follow the delivery directions: spoken or whispered lines play as intimate close-ups; shouts land as hard-hitting cuts or impacts; a silence or stop is a held, frozen or cut-to-black beat.\n' : ''}- Keep the assigned layer and shot mode: performance uses source-audio lip-sync and a frontal medium close-up with the mouth visible; cutaways show narrative action without lip-sync; cards are graphic beats.\n- Honor any director intent given for a shot. Instrumental shots carry no singing or lip-sync.

${shotCameraPromptSection()}

Respond with ONLY a JSON array, one object per shot, in shot-index order (replace every <…> with real content; do NOT output the literal angle-bracket text), no other text:
[{ "index": 0, "framePrompt": "<the opening reference still, ready to render>", "prompt": "<the shot's motion, ready to render>", "camera": { "move": "<camera move id>", "speed": "<slow|moderate|fast|snap>", "endFraming": "<extreme-wide|wide|medium|close|extreme-close>", "onBeat": false, "reason": "<why the camera holds, only for a static move>" } }]`;
}

// A CLI-style provider can echo its input (including this prompt's own JSON
// schema example) ahead of its real answer — extractJson would otherwise grab
// the FIRST balanced array it finds, which can be that echoed example. Mirrors
// mediaPromptRefiner.js#isPlaceholderPrompt: if a field still equals the
// literal `<...>` placeholder, the model parroted the schema rather than
// answering.
const isPlaceholderText = (s) => typeof s === 'string' && /^\s*<.+>\s*$/.test(s);

// shapePredicate for extractJson: an array counts as a real answer only if at
// least one entry has a non-placeholder framePrompt/prompt — so a wholly
// placeholder block (the echoed schema example) is skipped in favor of a
// later candidate block (the model's actual answer), rather than being
// returned outright as extractJson's default "first parseable block" would.
function isUsableScenePlanArray(parsed) {
  return Array.isArray(parsed) && parsed.some((entry) => {
    const fp = typeof entry?.framePrompt === 'string' ? entry.framePrompt : '';
    const p = typeof entry?.prompt === 'string' ? entry.prompt : '';
    return (fp && !isPlaceholderText(fp)) || (p && !isPlaceholderText(p));
  });
}

/**
 * Parse the LLM's scene-prompt response into a `Map<index, {framePrompt, prompt, camera}>`.
 * `camera` is validated against the catalog (shotCamera.js parseShotCamera) and
 * is null when absent or unusable; the planner's family rules apply later.
 */
function parseScenePlanResponse(text, count) {
  const { value: parsed } = extractJson(text, { blockType: 'array', shapePredicate: isUsableScenePlanArray });
  if (!Array.isArray(parsed)) return null;
  const byIndex = new Map();
  for (const entry of parsed) {
    const idx = Number(entry?.index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= count) continue;
    let framePrompt = typeof entry?.framePrompt === 'string' ? entry.framePrompt.trim().slice(0, SCENE_TEXT_MAX) : '';
    let prompt = typeof entry?.prompt === 'string' ? entry.prompt.trim().slice(0, SCENE_TEXT_MAX) : '';
    if (isPlaceholderText(framePrompt)) framePrompt = '';
    if (isPlaceholderText(prompt)) prompt = '';
    const camera = parseShotCamera(entry?.camera);
    if (!framePrompt && !prompt && !camera) continue;
    byIndex.set(idx, { framePrompt, prompt, camera });
  }
  return byIndex.size > 0 ? byIndex : null;
}

/**
 * Best-effort first-pass prompt proposal. Never throws — returns
 * `{ seeded: null, reason }` for every failure mode (no provider configured,
 * provider disabled, LLM call failed, response didn't parse) so the caller
 * can fall back to plain scenes without the whole plan request failing.
 */
async function tryProposeScenePrompts(project, shots, { providerId, model, effort } = {}) {
  if (shots.length > MAX_SHOTS_FOR_PROMPTS) {
    return { seeded: null, reason: 'too-many-shots' };
  }

  // Request pin > the brief's shot-plan pin > its direction LLM > an eligible TUI provider > the active one (llmRoute.js).
  const { provider, selectedModel, route } = await resolveMusicVideoLlm({ providerId, model, effort, automation: project.automation, stage: 'plan' }).catch((err) => {
    console.warn(`⚠️ Music Video plan: provider resolution failed for ${project.id}: ${err.message}`);
    return { provider: null, selectedModel: null, route: null };
  });
  if (!provider) return { seeded: null, reason: 'no-provider' };
  if (provider.enabled === false) return { seeded: null, reason: 'provider-disabled' };

  let text;
  try {
    ({ text } = await runPromptThroughProvider({
      provider,
      model: selectedModel,
      ...effortArg(route),
      prompt: buildScenePlanPrompt(project, shots),
      source: 'music-video-plan',
    }));
  } catch (err) {
    console.warn(`⚠️ Music Video plan: scene-prompt LLM call failed for ${project.id}: ${err.message}`);
    return { seeded: null, reason: 'llm-failed', route };
  }

  const seeded = parseScenePlanResponse(text, shots.length);
  if (!seeded) {
    console.warn(`⚠️ Music Video plan: unparsable scene-prompt response for ${project.id}`);
    return { seeded: null, reason: 'unparsable-response', route };
  }
  return { seeded, reason: null, route };
}

/**
 * Plan + seed a project's scene board from its cached audio analysis.
 *
 * @param {string} id — project id
 * @param {object} [options]
 * @param {boolean} [options.seedPrompts=true] — also attempt first-pass
 *   framePrompt/prompt text via the active/given AI provider (best-effort).
 * @param {string} [options.providerId] — pin a specific provider instead of
 *   the active one.
 * @param {string} [options.model] — model override for the prompt-seeding call.
 * @param {string} [options.effort] — reasoning-effort override for an
 *   effort-capable CLI/TUI provider (clamped by the runner).
 * @param {'replace'|'append'|'require'} [options.mode='append'] — what to do when the
 *   board already has scenes: `replace` swaps the board (keeping work on scenes
 *   whose time span is reused), `append` adds to it, `require` refuses with a
 *   409 `PLAN_MODE_REQUIRED` so a caller must choose (the HTTP route).
 * @param {string} [options.directive] — a production run's directive (#9066),
 *   added to the director guidance the first-pass prompts are written under.
 * @returns {Promise<{ project: object, scenesAdded: number, promptsSeeded: boolean, promptsSkippedReason: string|null, pacing: object, llmRoute: object|null }>}
 *   `llmRoute` is the effective provider/model/effort/transport the prompt call
 *   used (null when none was made); a project with an automation brief also
 *   keeps it under `automation.routes.plan`.
 */
export async function planProject(id, { seedPrompts = true, providerId, model, effort, directive, mode = 'append' } = {}) {
  const project = await getProject(id);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const existingCount = (project.scenes || []).length;
  if (mode === 'require' && existingCount > 0) {
    throw new ServerError(
      `The board already has ${existingCount} shot${existingCount === 1 ? '' : 's'} — choose to replace them or add to the board`,
      { status: 409, code: 'PLAN_MODE_REQUIRED', context: { sceneCount: existingCount } },
    );
  }

  const sections = validSections(project.audioAnalysis?.sections);
  if (sections.length === 0) {
    throw new ServerError(
      'Project has no analyzed sections to plan from — run Analyze first',
      { status: 422, code: 'NOT_ANALYZED' },
    );
  }

  // One shot list drives both the seeded scenes and the prompt, so prompt
  // indices agree 1:1 with `sceneInputs`.
  const { shots, pacing } = directedShotPlan(project, sections);
  const sceneInputs = sceneInputsFromShots(shots);

  let promptsSeeded = false;
  let promptsSkippedReason = seedPrompts ? null : 'not-requested';
  let llmRoute = null;
  let proposedCameras = new Map();
  if (seedPrompts) {
    const guidance = [project.automation?.guidance?.trim(), directive?.trim()].filter(Boolean).join('\n');
    const planning = directive?.trim() ? { ...project, automation: { ...project.automation, guidance } } : project;
    const { seeded, reason, route } = await tryProposeScenePrompts(planning, shots, { providerId, model, effort });
    llmRoute = route || null;
    if (seeded) {
      promptsSeeded = true;
      for (const [idx, fields] of seeded) {
        if (!sceneInputs[idx]) continue;
        if (fields.camera) proposedCameras.set(idx, fields.camera);
        if (shots[idx].visualLayer === 'code') continue;
        if (shots[idx].visualLayer) Object.assign(sceneInputs[idx], directedPrompts(shots[idx], fields));
        else {
          if (fields.framePrompt) sceneInputs[idx].framePrompt = fields.framePrompt;
          if (fields.prompt) sceneInputs[idx].prompt = fields.prompt;
        }
      }
    } else {
      promptsSkippedReason = reason;
    }
  }
  // Every non-card shot gets a catalog camera move (#10589): the model's pick when
  // it passes the family/performance rules, otherwise a deterministic one.
  planShotCameras(shots, proposedCameras).forEach((camera, idx) => {
    if (camera && sceneInputs[idx]) sceneInputs[idx].camera = camera;
  });

  // `addProjectScenes` returns the project it just persisted (read fresh
  // under the same lock/transaction that wrote it, not a re-derived
  // snapshot) — using it directly avoids both a stale-snapshot response
  // (a concurrent edit made while the prompt-seeding LLM call was in
  // flight would otherwise be silently dropped from this response and
  // visually reverted by the client's replaceProject) and a redundant
  // second getProject round trip.
  // Cards need a layered mode, so planning them switches a plain render to composed. Code shots
  // do not: only a composition document draws them, and a composed render would show them black
  // while reading render-ready, so a plain project keeps its mode and its honest "not ready" (#10297).
  const hasCards = sceneInputs.some((s) => s.visualLayer === 'card');
  // Persist card scenes and the mode that renders them in the same transaction.
  // Read the current composition under the lock so concurrent edits survive.
  const { project: persisted, scenes } = await persistPlan(id, sceneInputs, { hasCards, replace: mode === 'replace' });
  // Only a project with an automation brief keeps the route it planned on.
  const updated = (persisted.automation && await recordLlmRoute(id, 'plan', llmRoute)) || persisted;
  console.log(`🪄 Music Video plan: seeded ${scenes.length} scene${scenes.length === 1 ? '' : 's'} for ${id} (prompts ${promptsSeeded ? 'seeded' : `skipped: ${promptsSkippedReason || 'n/a'}`})`);
  return { project: updated, scenesAdded: scenes.length, promptsSeeded, promptsSkippedReason, pacing, llmRoute };
}

/** The directed shot list for a project's analyzed sections. Deterministic for a given analysis. */
function directedShotPlan(project, sections) {
  const { shots, pacing } = planShots(sections, {
    downbeats: project.audioAnalysis?.downbeats,
    beats: project.audioAnalysis?.beats,
    lyricCues: project.lyricCues,
    phrases: project.phrases,
    pacing: project.pacing,
    clipCapacitySec: resolveClipCapacitySec(project.videoSettings),
  });
  return { shots: directShots(shots, project), pacing };
}

const sameSpan = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.01;
const TIMECODE = /(\d{1,2}):(\d{2}(?:\.\d+)?)|(\d+(?:\.\d+)?)s\b/g;

/**
 * Board scenes a review note addresses: its target names the shot label,
 * section or scene id, or a time inside the shot. A note that names no shot
 * addresses every shot, so general feedback is never dropped.
 */
function feedbackSceneIds(scenes, feedback) {
  const ids = new Set();
  for (const item of feedback) {
    const target = String(item.target || '').toLowerCase();
    const times = [...target.matchAll(TIMECODE)].map((m) => (m[3] != null ? Number(m[3]) : Number(m[1]) * 60 + Number(m[2])));
    const named = scenes.filter((scene) => [scene.sceneId, scene.label, scene.sectionLabel]
      .some((name) => typeof name === 'string' && name.trim().length >= 3 && target.includes(name.trim().toLowerCase()))
      || times.some((t) => t >= scene.startSec && t < scene.endSec));
    if (!named.length) return scenes.map((scene) => scene.sceneId);
    for (const scene of named) ids.add(scene.sceneId);
  }
  return scenes.filter((scene) => ids.has(scene.sceneId)).map((scene) => scene.sceneId);
}

/**
 * Propose revised frame/motion prompts for the Board shots that unresolved
 * review feedback names, without re-tiling the board. Each shot keeps its
 * span, takes and selected media; the caller persists the returned fields.
 * A shot whose span still matches the deterministic plan keeps its assigned
 * set, look and layer direction. Throws when no usable proposal comes back.
 * A valid revised camera move (catalog id; a still move with its reason) is kept.
 * @returns {Promise<Map<string, { framePrompt?: string, prompt?: string, camera?: object }>>} revised fields by sceneId
 */
export async function proposeShotRevisions(project, feedback, { providerId, model, effort } = {}) {
  const scenes = (project.scenes || []).filter((scene) => Number.isFinite(scene.startSec) && scene.endSec > scene.startSec);
  if (!scenes.length) throw new ServerError('Plan timed Board shots before revising them from feedback', { status: 409, code: 'NO_SCENES' });
  const targets = new Set(feedbackSceneIds(scenes, feedback));
  const sections = validSections(project.audioAnalysis?.sections);
  const planned = sections.length ? directedShotPlan(project, sections).shots : [];
  const shots = scenes.filter((scene) => targets.has(scene.sceneId)).map((scene, index) => {
    const match = planned.find((shot) => sameSpan(shot.startSec, scene.startSec) && sameSpan(shot.endSec, scene.endSec)
      && (shot.visualLayer || null) === (scene.visualLayer || null));
    const base = match || { sectionLabel: scene.sectionLabel || scene.label, sectionIndex: scene.sectionIndex ?? index,
      shotIndex: 0, shotCount: 1, startSec: scene.startSec, endSec: scene.endSec };
    return { ...base, lyricText: scene.lyricText ?? base.lyricText, visualIntent: scene.visualIntent ?? base.visualIntent,
      sceneId: scene.sceneId, current: { framePrompt: scene.framePrompt, prompt: scene.prompt, camera: scene.camera } };
  });
  const { seeded, reason } = await tryProposeScenePrompts(project, shots, { providerId, model, effort });
  if (!seeded) throw new ServerError(`No revised shots came back (${reason}). Edit the shots by hand or retry.`, { status: 422, code: 'SHOT_REVISION_FAILED' });
  const updates = new Map();
  for (const [index, fields] of seeded) {
    const shot = shots[index];
    const camera = fields.camera && shot.visualLayer !== 'card' ? { camera: fields.camera } : {};
    const prose = fields.framePrompt || fields.prompt;
    updates.set(shot.sceneId, shot.visualLayer && prose ? { ...directedPrompts(shot, fields), ...camera } : {
      ...(fields.framePrompt ? { framePrompt: fields.framePrompt } : {}), ...(fields.prompt ? { prompt: fields.prompt } : {}), ...camera,
    });
  }
  return updates;
}

async function persistPlan(id, sceneInputs, { hasCards, replace }) {
  if (!hasCards && !replace) return addProjectScenes(id, sceneInputs);
  const { addScenes, replaceScenes } = await import('./projectsLogic.js');
  const { normalizeComposition } = await import('./composition.js');
  return mutateProjectRecord(id, (current) => {
    const outcome = (replace ? replaceScenes : addScenes)(current, sceneInputs);
    // An authored whole-song code/document renderer remains the operator's choice.
    if (hasCards && (!current.composition?.mode || current.composition.mode === 'concat')) {
      outcome.project.composition = normalizeComposition({ ...current.composition, mode: 'composed' });
    }
    return outcome;
  });
}
