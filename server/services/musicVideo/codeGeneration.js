/**
 * User-triggered code-video generation (#9076).
 *
 * Nothing here runs from boot or from a project read. Both entry points are
 * the Generate / Regenerate clicks: they resolve a provider, show it in the
 * log line, and store section functions. The render path never calls them
 * and never asks a footage model for pixels.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { PATHS } from '../../lib/paths.js';
import { isDeterministicCodeSource } from '../../lib/musicVideoValidation.js';
import { universeStyleLines } from '../../lib/styleSourcePrompt.js';
import { buildMusicVideoCodePrompt, extractCodeSections } from '../codeAnimation/prompt.js';
import { normalizeComposition } from './composition.js';
import { getProject, mutateProjectRecord } from './projects.js';
import { buildCodeTimeline, buildSongDocument, paletteFromProject } from './codeTimeline.js';

async function styleLinesFor(project) {
  const universeId = project.concept?.universeId;
  if (!universeId) return [];
  try {
    const { resolveUniverseStyleSource } = await import('../creativeStyleSources.js');
    const universe = await resolveUniverseStyleSource(universeId, { imageSlots: 0 });
    return universe ? universeStyleLines(universe) : [];
  } catch (err) {
    console.warn(`⚠️ Music-video code style source skipped: ${err.message}`);
    return [];
  }
}

function acceptSources(parsed, ids) {
  const wanted = new Set(ids);
  const accepted = [];
  for (const section of parsed) {
    if (!wanted.has(section.id)) continue;
    if (!isDeterministicCodeSource(section.source)) {
      throw new ServerError(`Section ${section.id} used a non-deterministic or networked call`, { status: 422, code: 'NONDETERMINISTIC_SECTION' });
    }
    accepted.push({ id: section.id, source: section.source });
  }
  return accepted;
}

async function runModel({ providerId, model, prompt }) {
  const { assertProvider, resolveProviderAndModel, runPromptThroughProvider } = await import('../promptRunner.js');
  const { provider, selectedModel } = await resolveProviderAndModel({ providerId, model });
  assertProvider(provider, { message: 'No AI provider available to write the code video', code: 'PROVIDER_UNAVAILABLE', status: 400 });
  console.log(`🎬 Music-video code generation on ${provider.id}/${selectedModel || 'default'}`);
  const { text } = await runPromptThroughProvider({
    provider,
    model: selectedModel || undefined,
    prompt,
    source: 'music-video-code',
    cwd: PATHS.data,
  });
  return { text, providerId: provider.id, model: selectedModel || null };
}

function storeCodeVideo(project, { providerId, model, sections, timelineIds }) {
  const allowed = new Set(timelineIds);
  const previous = (project.composition?.codeVideo?.sections || []).filter((section) => allowed.has(section.id));
  const merged = new Map(previous.map((section) => [section.id, section.source]));
  for (const section of sections) merged.set(section.id, section.source);
  const codeVideo = {
    providerId,
    model,
    generatedAt: new Date().toISOString(),
    sections: [...merged.entries()].map(([id, source]) => ({ id, source })),
  };
  return normalizeComposition({ ...(project.composition || {}), mode: 'code', codeVideo });
}

async function writeComposition(projectId, run, sections, timelineIds) {
  const { project } = await mutateProjectRecord(projectId, (current) => ({
    project: {
      ...current,
      composition: storeCodeVideo(current, { providerId: run.providerId, model: run.model, sections, timelineIds }),
      updatedAt: new Date().toISOString(),
    },
  }));
  return project;
}

/**
 * Generate every section. Replaces stored functions for the sections the
 * model returned; a section it omitted keeps its previous function.
 */
export async function generateMusicVideoCode(projectId, { providerId, model } = {}) {
  const project = await getProject(projectId);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const timeline = buildCodeTimeline(project);
  if (!timeline.sections.length) {
    throw new ServerError('Code-rendered video needs a song duration — analyze the track or time a scene or lyric line', { status: 422, code: 'NO_TIMELINE' });
  }
  const song = buildSongDocument(project, timeline);
  const palette = paletteFromProject(project);
  const prompt = buildMusicVideoCodePrompt({
    title: project.name,
    palette,
    song,
    styleLines: await styleLinesFor(project),
  });
  const run = await runModel({ providerId, model, prompt });
  const parsed = extractCodeSections(run.text);
  const sections = acceptSources(parsed, timeline.sections.map((section) => section.id));
  if (!sections.length) {
    throw new ServerError('The model did not return a section function', { status: 422, code: 'NO_SECTION_SOURCE' });
  }
  const updated = await writeComposition(projectId, run, sections, timeline.sections.map((section) => section.id));
  console.log(`✅ Music-video code stored sections=${sections.length}`);
  return { project: updated, providerId: run.providerId, model: run.model };
}

/** Replace one section function. Every other stored function stays. */
export async function regenerateMusicVideoCodeSection(projectId, sectionId, { providerId, model } = {}) {
  const project = await getProject(projectId);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const timeline = buildCodeTimeline(project);
  if (!timeline.sections.some((section) => section.id === sectionId)) {
    throw new ServerError('That section is not on the code timeline', { status: 404, code: 'SECTION_NOT_FOUND' });
  }
  const song = buildSongDocument(project, timeline);
  const prompt = buildMusicVideoCodePrompt({
    title: project.name,
    palette: paletteFromProject(project),
    song,
    styleLines: await styleLinesFor(project),
    onlySectionId: sectionId,
  });
  const run = await runModel({ providerId, model, prompt });
  const sections = acceptSources(extractCodeSections(run.text), [sectionId]);
  if (!sections.length) {
    throw new ServerError('The model did not return that section', { status: 422, code: 'NO_SECTION_SOURCE' });
  }
  const updated = await writeComposition(projectId, run, sections, timeline.sections.map((section) => section.id));
  console.log(`✅ Music-video code replaced section=${sectionId}`);
  return { project: updated, providerId: run.providerId, model: run.model, sectionId };
}
