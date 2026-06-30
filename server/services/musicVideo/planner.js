/**
 * Music Video — autonomous shot planner (#1855).
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
 * simply takes its section's exact span.
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
import { resolveProviderAndModel, runPromptThroughProvider } from '../../lib/promptRunner.js';
import { getProject, addProjectScenes } from './projects.js';

const SECTION_LABEL_MAX = 120;
const SCENE_TEXT_MAX = 2000;
// A music video plan with more sections than this would blow the LLM prompt
// budget for marginal value (typical analyses produce single-digit-to-low-
// dozens of sections) — scenes are still seeded deterministically above the
// cap, just without the optional first-pass prompt text.
const MAX_SECTIONS_FOR_PROMPTS = 80;

/**
 * Keep only sections with a valid forward-time span. Defensive against a
 * malformed/legacy cached analysis — `musicVideoAudioAnalysisSchema` doesn't
 * enforce `endSec > startSec` per section. Shared by the scene-input builder
 * and the LLM prompt builder so their array indices always agree.
 */
export function validSections(sections) {
  return (Array.isArray(sections) ? sections : [])
    .filter((s) => s && typeof s.startSec === 'number' && typeof s.endSec === 'number' && s.endSec > s.startSec);
}

/**
 * Pure: derive one scene-create input per analyzed section, in section
 * order. `sections` must already be filtered via `validSections` — the
 * caller owns that so this stays a straight 1:1 map (no index drift between
 * this and the LLM prompt's section list).
 */
export function planScenesFromSections(sections) {
  return sections.map((s) => {
    const label = typeof s.label === 'string' ? s.label.slice(0, SECTION_LABEL_MAX) : '';
    return {
      label,
      sectionLabel: label || null,
      startSec: s.startSec,
      endSec: s.endSec,
      beatAligned: true,
    };
  });
}

/** Build the LLM prompt asking for a first-pass framePrompt/prompt per section. */
export function buildScenePlanPrompt(project, sections) {
  const concept = project.concept || {};
  const conceptLine = concept.prompt ? `Concept: ${concept.prompt}` : '';
  const styleLine = concept.style ? `Visual style: ${concept.style}` : '';
  const sectionLines = sections.map((s, i) => {
    const duration = (s.endSec - s.startSec).toFixed(1);
    const energy = typeof s.energy === 'number' ? s.energy.toFixed(2) : 'unknown';
    return `${i}. "${s.label || `Section ${i + 1}`}" — ${duration}s, normalized energy ${energy}`;
  }).join('\n');

  return `You are directing a music video for "${project.name}".
${conceptLine}
${styleLine}

The track has been split into these sections (index, label, duration, normalized 0..1 energy — higher energy means a louder/more intense part of the song):
${sectionLines}

For EACH section above, propose ONE shot for a generative video model:
- "framePrompt": the opening reference still — subject, setting, lighting, composition. Keep it concrete and visual.
- "prompt": the motion for that shot — camera move, subject motion, mood — building on the frame. Higher-energy sections should read more kinetic; calmer sections more static/lingering.

Respond with ONLY a JSON array, one object per section, in section-index order, no other text:
[{ "index": 0, "framePrompt": "...", "prompt": "..." }]`;
}

/** Parse the LLM's scene-prompt response into a `Map<index, {framePrompt, prompt}>`. */
function parseScenePlanResponse(text, count) {
  const { value: parsed } = extractJson(text, { blockType: 'array' });
  if (!Array.isArray(parsed)) return null;
  const byIndex = new Map();
  for (const entry of parsed) {
    const idx = Number(entry?.index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= count) continue;
    const framePrompt = typeof entry?.framePrompt === 'string' ? entry.framePrompt.trim().slice(0, SCENE_TEXT_MAX) : '';
    const prompt = typeof entry?.prompt === 'string' ? entry.prompt.trim().slice(0, SCENE_TEXT_MAX) : '';
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
async function tryProposeScenePrompts(project, sections, { providerId, model } = {}) {
  if (sections.length > MAX_SECTIONS_FOR_PROMPTS) {
    return { seeded: null, reason: 'too-many-sections' };
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
      prompt: buildScenePlanPrompt(project, sections),
      source: 'music-video-plan',
    }));
  } catch (err) {
    console.warn(`⚠️ Music Video plan: scene-prompt LLM call failed for ${project.id}: ${err.message}`);
    return { seeded: null, reason: 'llm-failed' };
  }

  const seeded = parseScenePlanResponse(text, sections.length);
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
 * @returns {Promise<{ project: object, scenesAdded: number, promptsSeeded: boolean, promptsSkippedReason: string|null }>}
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

  const sceneInputs = planScenesFromSections(sections);

  let promptsSeeded = false;
  let promptsSkippedReason = seedPrompts ? null : 'not-requested';
  if (seedPrompts) {
    const { seeded, reason } = await tryProposeScenePrompts(project, sections, { providerId, model });
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

  const scenes = await addProjectScenes(id, sceneInputs);
  // Assemble the response in-memory from the pre-mutation `project` + the
  // scenes `addProjectScenes` just returned, rather than a second
  // getProject round trip — addScenes' `touch()` only changes `scenes` +
  // `updatedAt`, so this mirrors exactly what a re-fetch would return
  // without a second DB transaction / whole-file re-read (the client's
  // single-scene `addMusicVideoScene` path already composes state this way).
  const updated = { ...project, scenes: [...(project.scenes || []), ...scenes], updatedAt: new Date().toISOString() };
  console.log(`🪄 Music Video plan: seeded ${scenes.length} scene${scenes.length === 1 ? '' : 's'} for ${id} (prompts ${promptsSeeded ? 'seeded' : `skipped: ${promptsSkippedReason || 'n/a'}`})`);
  return { project: updated, scenesAdded: scenes.length, promptsSeeded, promptsSkippedReason };
}
