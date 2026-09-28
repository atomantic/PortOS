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
import { resolveProviderAndModel, runPromptThroughProvider } from '../promptRunner.js';
import { planShots, resolveClipCapacitySec, validSections } from './shotPlan.js';
import { getProject, addProjectScenes } from './projects.js';

const SCENE_LABEL_MAX = 120;
const SCENE_TEXT_MAX = 2000;
// Lyric text per shot quoted into the LLM prompt (the full text persists on
// the scene); keeps a lyric-dense plan inside the prompt budget.
const PROMPT_LYRIC_MAX = 240;
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
    };
  });
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
  const hasLyrics = shots.some((s) => s.lyricText);
  const shotLines = shots.map((s, i) => {
    const duration = (s.endSec - s.startSec).toFixed(1);
    const energy = typeof s.sectionEnergy === 'number' ? s.sectionEnergy.toFixed(2) : 'unknown';
    const section = `"${s.sectionLabel || `Section ${s.sectionIndex + 1}`}" shot ${s.shotIndex + 1}/${s.shotCount}`;
    const parts = [`${i}. ${section} — ${duration}s, energy ${energy}`];
    parts.push(s.lyricText ? `lyrics: "${quote(s.lyricText, PROMPT_LYRIC_MAX)}"` : 'instrumental');
    if (s.visualIntent) parts.push(`intent: ${quote(s.visualIntent, PROMPT_LYRIC_MAX)}`);
    if (s.hook) parts.push('OPENING HOOK');
    return parts.join('; ');
  }).join('\n');

  return `You are directing a music video for "${project.name}".
${conceptLine}
${styleLine}
${briefLines}

The song has been cut into these shots (index; musical section and the shot's position inside it; duration; normalized 0..1 section energy — higher is louder/more intense; the lyric lines sung during the shot, or "instrumental"; optional director intent):
${shotLines}

For EACH shot above, propose the shot for a generative video model:
- "framePrompt": the opening reference still — subject, setting, lighting, composition. Keep it concrete and visual.
- "prompt": the motion for that shot — camera move, subject motion, mood — building on the frame. Higher-energy sections read more kinetic; calmer sections more static/lingering.
- Shots in the same section are one edited sequence: keep subject and setting continuous, but vary framing (wide / medium / close), angle, or action from shot to shot so consecutive shots cut rather than repeat.
- The OPENING HOOK shot must grab attention immediately.
${hasLyrics ? '- Let the lyric lines inform the imagery and emotion of their shot (interpret, do not illustrate word-for-word). Never render the lyrics as on-screen text.\n' : ''}- Honor any director intent given for a shot. Instrumental shots carry no singing or lip-sync.

Respond with ONLY a JSON array, one object per shot, in shot-index order (replace every <…> with real content; do NOT output the literal angle-bracket text), no other text:
[{ "index": 0, "framePrompt": "<the opening reference still, ready to render>", "prompt": "<the shot's motion, ready to render>" }]`;
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

/** Parse the LLM's scene-prompt response into a `Map<index, {framePrompt, prompt}>`. */
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
    if (!framePrompt && !prompt) continue;
    byIndex.set(idx, { framePrompt, prompt });
  }
  return byIndex.size > 0 ? byIndex : null;
}

/**
 * Best-effort first-pass prompt proposal. Never throws — returns
 * `{ seeded: null, reason }` for every failure mode (no provider configured,
 * provider disabled, LLM call failed, response didn't parse) so the caller
 * can fall back to plain scenes without the whole plan request failing.
 */
async function tryProposeScenePrompts(project, shots, { providerId, model } = {}) {
  if (shots.length > MAX_SHOTS_FOR_PROMPTS) {
    return { seeded: null, reason: 'too-many-shots' };
  }

  const { provider, selectedModel } = await resolveProviderAndModel({ providerId, model }).catch((err) => {
    console.warn(`⚠️ Music Video plan: provider resolution failed for ${project.id}: ${err.message}`);
    return { provider: null, selectedModel: null };
  });
  if (!provider) return { seeded: null, reason: 'no-provider' };
  if (provider.enabled === false) return { seeded: null, reason: 'provider-disabled' };

  let text;
  try {
    ({ text } = await runPromptThroughProvider({
      provider,
      model: selectedModel,
      prompt: buildScenePlanPrompt(project, shots),
      source: 'music-video-plan',
    }));
  } catch (err) {
    console.warn(`⚠️ Music Video plan: scene-prompt LLM call failed for ${project.id}: ${err.message}`);
    return { seeded: null, reason: 'llm-failed' };
  }

  const seeded = parseScenePlanResponse(text, shots.length);
  if (!seeded) {
    console.warn(`⚠️ Music Video plan: unparsable scene-prompt response for ${project.id}`);
    return { seeded: null, reason: 'unparsable-response' };
  }
  return { seeded, reason: null };
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
 * @returns {Promise<{ project: object, scenesAdded: number, promptsSeeded: boolean, promptsSkippedReason: string|null, pacing: object }>}
 */
export async function planProject(id, { seedPrompts = true, providerId, model } = {}) {
  const project = await getProject(id);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });

  const sections = validSections(project.audioAnalysis?.sections);
  if (sections.length === 0) {
    throw new ServerError(
      'Project has no analyzed sections to plan from — run Analyze first',
      { status: 422, code: 'NOT_ANALYZED' },
    );
  }

  // One shot list drives both the seeded scenes and the prompt, so prompt
  // indices agree 1:1 with `sceneInputs`.
  const { shots, pacing } = planShots(sections, {
    downbeats: project.audioAnalysis?.downbeats,
    beats: project.audioAnalysis?.beats,
    lyricCues: project.lyricCues,
    phrases: project.phrases,
    pacing: project.pacing,
    clipCapacitySec: resolveClipCapacitySec(project.videoSettings),
  });
  const sceneInputs = sceneInputsFromShots(shots);

  let promptsSeeded = false;
  let promptsSkippedReason = seedPrompts ? null : 'not-requested';
  if (seedPrompts) {
    const { seeded, reason } = await tryProposeScenePrompts(project, shots, { providerId, model });
    if (seeded) {
      promptsSeeded = true;
      for (const [idx, fields] of seeded) {
        if (!sceneInputs[idx]) continue;
        if (fields.framePrompt) sceneInputs[idx].framePrompt = fields.framePrompt;
        if (fields.prompt) sceneInputs[idx].prompt = fields.prompt;
      }
    } else {
      promptsSkippedReason = reason;
    }
  }

  // `addProjectScenes` returns the project it just persisted (read fresh
  // under the same lock/transaction that wrote it, not a re-derived
  // snapshot) — using it directly avoids both a stale-snapshot response
  // (a concurrent edit made while the prompt-seeding LLM call was in
  // flight would otherwise be silently dropped from this response and
  // visually reverted by the client's replaceProject) and a redundant
  // second getProject round trip.
  const { project: updated, scenes } = await addProjectScenes(id, sceneInputs);
  console.log(`🪄 Music Video plan: seeded ${scenes.length} scene${scenes.length === 1 ? '' : 's'} for ${id} (prompts ${promptsSeeded ? 'seeded' : `skipped: ${promptsSkippedReason || 'n/a'}`})`);
  return { project: updated, scenesAdded: scenes.length, promptsSeeded, promptsSkippedReason, pacing };
}
