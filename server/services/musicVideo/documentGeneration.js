import { assertProductionApproval } from './productionReview.js';
/** User-triggered mixed-media document authoring. No provider runs on read or boot. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parse } from '@babel/parser';
import { ServerError } from '../../lib/errorHandler.js';
import { resolveNarrativeEvents } from '../../lib/musicVideoNarrativeEvents.js';
import { isDeterministicCodeSource } from '../../lib/musicVideoValidation.js';
import { summarizeMusicVideoMediumPlan } from '../../lib/musicVideoMediumPlan.js';
import { buildMixedMediaDocumentPrompt, extractCodeSections } from '../codeAnimation/prompt.js';
import { buildCodeTimeline, buildSongDocument, paletteFromProject } from './codeTimeline.js';
import { castAndSetsCodeContext, runModel, styleLinesFor } from './codeGeneration.js';
import { getProject } from './projects.js';
import { buildDocumentData, documentAspect, documentRenderClock, documentSongDuration, DOCUMENT_FRAME_SIZES, resolveSceneMedia } from './documentRender.js';
import { acceptGeneratedDocument, readDocumentFiles, stageGeneratedDocument } from './compositionDocument.js';

const fail = (message, code = 'COMPOSITION_AUTHORING_INVALID', status = 422) => new ServerError(message, { code, status });
const jsonForScript = (value) => JSON.stringify(value).replace(/</g, '\\u003c');
const FORBIDDEN_GLOBALS = new Set(['window', 'document', 'globalThis', 'self', 'fetch', 'XMLHttpRequest', 'WebSocket',
  'Date', 'performance', 'crypto', 'Function', 'eval', 'setTimeout', 'setInterval', 'requestAnimationFrame']);

function hasUnsafeReference(node) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(hasUnsafeReference);
  if (node.type === 'Identifier' && FORBIDDEN_GLOBALS.has(node.name)) return true;
  if (node.type === 'MemberExpression' && node.object?.name === 'Math'
    && (node.property?.name === 'random' || node.property?.value === 'random')) return true;
  if (node.type === 'MemberExpression' && (node.property?.name === 'constructor' || node.property?.value === 'constructor')) return true;
  return Object.entries(node).some(([key, value]) => key !== 'loc' && key !== 'start' && key !== 'end' && hasUnsafeReference(value));
}

// Only an exact function declaration is embedded as a literal in generated.js.
// In particular, no model-supplied top-level statement ever runs in the page.
function checkedFunction(source) {
  if (!isDeterministicCodeSource(source)) throw fail('A section contains a networked or non-deterministic call', 'NONDETERMINISTIC_SECTION');
  let body;
  try { body = parse(source, { sourceType: 'script' }).program.body; }
  catch { throw fail('A section function has invalid JavaScript', 'INVALID_SECTION_SOURCE'); }
  const fn = body[0];
  if (body.length !== 1 || fn?.type !== 'FunctionDeclaration' || fn.id?.name !== 'render' || fn.async || fn.generator
    || fn.params.length !== 2 || fn.params[0]?.name !== 'ctx' || fn.params[1]?.name !== 'env') {
    throw fail('Return exactly function render(ctx, env) for each section', 'INVALID_SECTION_SOURCE');
  }
  if (hasUnsafeReference(fn.body)) throw fail('A section must use only its drawing context and song-time inputs', 'NONDETERMINISTIC_SECTION');
  return source;
}

function basisFor(project, includeEvents = true) {
  // These are all inputs that can change which pixels or authoring directions
  // a section means. A new candidate cannot publish across such an edit.
  const input = {
    name: project.name || null,
    productionDraft: project.productionReview?.draft || null,
    treatment: project.treatment || null,
    productionPolicy: project.productionPolicy || null,
    visualSpec: project.visualSpec || null,
    concept: project.concept || null,
    trackId: project.trackId || null,
    uploadedAudioFilename: project.uploadedAudioFilename || null,
    audioAnalysis: project.audioAnalysis || null,
    lyricCues: project.lyricCues || null,
    lyricMarkers: project.lyricMarkers || null,
    scenes: project.scenes || [],
    compositionStyle: project.composition?.style || { color: '#ffffff', font: 'sans' },
    ...(includeEvents ? { eventInputs: eventInputs(project) } : {}),
  };
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

const eventInputs = (project) => ({
  narrativeEvents: project.composition?.narrativeEvents || [],
  reactiveSections: project.composition?.reactiveSections || [],
});

function matchesBasis(project, manifest) {
  if (manifest.structuralBasis) return manifest.basis === basisFor(project);
  const inputs = eventInputs(project);
  return !inputs.narrativeEvents.length && !inputs.reactiveSections.length && manifest.basis === basisFor(project, false);
}

function affectedEventSections(before, after) {
  const changedSpans = [];
  const oldEvents = new Map((before.narrativeEvents || []).map((event) => [event.id, event]));
  const newEvents = new Map((after.narrativeEvents || []).map((event) => [event.id, event]));
  for (const id of new Set([...oldEvents.keys(), ...newEvents.keys()])) {
    const old = oldEvents.get(id); const next = newEvents.get(id);
    if (JSON.stringify(old) !== JSON.stringify(next)) changedSpans.push(...[old, next].filter(Boolean));
  }
  return after.sections.filter((section) => {
    const oldGain = (before.reactiveSections || []).find((entry) => entry.sectionId === section.id);
    const nextGain = (after.reactiveSections || []).find((entry) => entry.sectionId === section.id);
    return JSON.stringify(oldGain) !== JSON.stringify(nextGain)
      || changedSpans.some((event) => event.startSec < section.endSec && event.endSec > section.startSec);
  }).map((section) => section.id);
}

async function authoringContext(project) {
  const plan = summarizeMusicVideoMediumPlan(project);
  if (plan.strategy === 'code-first' && plan.blocked) {
    throw fail(plan.unresolved.filter((item) => item.blocking).map((item) => item.message).join(' '), 'COMPOSITION_MEDIUM_PLAN_INCOMPLETE');
  }
  const duration = documentSongDuration(project);
  const timeline = buildCodeTimeline(project);
  if (!duration || !timeline.sections.length || timeline.durationSec > duration + 1 / 24) {
    throw fail('Analyze a song of at most 15 minutes and time its sections before generating a composition', 'NO_TIMELINE');
  }
  const song = {
    ...buildSongDocument(project, timeline),
    featureNames: Object.keys(project.audioAnalysis?.features || {}).slice(0, 40),
  };
  const { loadHistory } = await import('../videoGen/history.js');
  const history = (project.scenes || []).some((scene) => scene.videoHistoryId) ? await loadHistory() : [];
  const media = await resolveSceneMedia(project, { history, strictLayers: true });
  const frame = DOCUMENT_FRAME_SIZES[documentAspect(project)];
  const data = buildDocumentData(project, { media, frame, clock: documentRenderClock(duration), songDurationSec: duration, generated: true });
  Object.assign(song, { narrativeEvents: data.song.narrativeEvents, reactiveSections: data.song.reactiveSections });
  const scenes = data.scenes.map((scene) => {
    const original = project.scenes.find((entry) => entry.sceneId === scene.sceneId);
    const wanted = scene.visualLayer === 'still' ? 'image' : scene.visualLayer === 'footage' ? 'video' : null;
    if (wanted && (scene.startSec == null || scene.endSec == null || scene.media?.kind !== wanted)) {
      throw fail(`Scene ${scene.sceneId} needs a timed, selected ${wanted === 'video' ? 'clip' : 'still'} already available on this machine`, 'COMPOSITION_MEDIA_MISSING');
    }
    return {
      sceneId: scene.sceneId, label: scene.label, startSec: scene.startSec, endSec: scene.endSec,
      visualLayer: scene.visualLayer, visualIntent: scene.visualIntent,
      direction: (project.treatment?.shotDirections || []).find((direction) => direction.sceneId === scene.sceneId) || scene.direction,
      assetId: scene.media?.kind === 'video' ? original.videoHistoryId : scene.media?.kind === 'image' ? original.referenceImageId : null,
      mediaKind: scene.media?.kind || null,
      inSec: scene.media?.inSec ?? null, outSec: scene.media?.outSec ?? null,
    };
  });
  return { song, scenes, basis: basisFor(project), structuralBasis: basisFor(project, false), palette: paletteFromProject(project) };
}

function acceptedSections(text, ids) {
  const parsed = extractCodeSections(text);
  const wanted = new Set(ids);
  const accepted = new Map();
  for (const entry of parsed) {
    if (!wanted.has(entry.id) || accepted.has(entry.id)) continue;
    accepted.set(entry.id, checkedFunction(entry.source));
  }
  if (accepted.size !== wanted.size) {
    throw fail(`The authoring model returned ${accepted.size} of ${wanted.size} required section functions`, 'MISSING_SECTION_SOURCE');
  }
  return accepted;
}

function generatedFiles(manifest) {
  const functions = manifest.sections.map(({ id, source }) => `${jsonForScript(id)}: (${source}\n)`).join(',\n');
  const script = `window.PORTOS_MV_GENERATED = { song: ${jsonForScript(manifest.song)}, palette: ${jsonForScript(manifest.palette)}, sections: {\n${functions}\n} };\n`;
  return [
    { rel: 'generated.js', data: Buffer.from(script) },
    { rel: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
  ];
}

async function priorManifest(project) {
  const pointer = project.composition?.documentDraft || project.composition?.document;
  if (pointer?.source?.kind !== 'generated') throw fail('Generate a mixed-media document before revising a section', 'NO_GENERATED_DOCUMENT', 409);
  const files = await readDocumentFiles({ ...project, composition: { ...project.composition, document: pointer } });
  const file = files.get('manifest.json');
  if (!file) throw fail('The generated document manifest is missing', 'COMPOSITION_DOCUMENT_MISSING', 409);
  const manifest = JSON.parse(await readFile(file.abs, 'utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.sections) || !manifest.basis) throw fail('The generated document manifest is invalid');
  return { pointer, manifest };
}

async function runAuthoring(projectId, { providerId, model, effort, sectionId = null, eventRevision = false, expectedDraft = null, feedback = '', beforeSubmit = null, verifyCurrent = () => {} } = {}) {
  const project = await getProject(projectId);
  if (!project) throw fail('Project not found', 'NOT_FOUND', 404);
  assertProductionApproval(project, 'storyboard');
  const context = await authoringContext(project);
  let prior = null;
  if (sectionId || eventRevision) {
    prior = await priorManifest(project);
    if (eventRevision ? (prior.manifest.structuralBasis || prior.manifest.basis) !== context.structuralBasis : !matchesBasis(project, prior.manifest)) throw fail('The treatment or selected media changed — generate a fresh document', 'COMPOSITION_DRAFT_STALE', 409);
    if (project.composition?.documentDraft
      && (project.composition?.document?.directory || null) !== (prior.manifest.baseDocumentDirectory || null)) {
      throw fail('The selected document changed — generate a fresh candidate', 'COMPOSITION_DRAFT_STALE', 409);
    }
    if (sectionId && !prior.manifest.sections.some((section) => section.id === sectionId)) throw fail('Section not found in the generated document', 'SECTION_NOT_FOUND', 404);
    if (expectedDraft !== prior.pointer.directory) throw fail('The candidate changed — review it again', 'COMPOSITION_DRAFT_STALE', 409);
  }
  const ids = eventRevision ? affectedEventSections(prior.manifest.song, context.song)
    : sectionId ? [sectionId] : context.song.sections.map((section) => section.id);
  if (!ids.length) throw fail('No narrative event or section gain changes to revise', 'NO_EVENT_CHANGES', 409);
  const sharedStyle = prior?.manifest.sharedStyle || {
    palette: context.palette,
    treatment: { brief: project.treatment?.brief || null, motifs: project.treatment?.arc?.motifs || [], arc: project.treatment?.arc?.beats || [], styleLook: project.treatment?.styleLook || null },
    visualSpec: project.visualSpec || null,
    styleLines: await styleLinesFor(project),
  };
  const prompt = buildMixedMediaDocumentPrompt({
    title: project.name, song: { ...context.song, sections: context.song.sections.filter((section) => ids.includes(section.id)) }, palette: context.palette, treatment: project.treatment,
    visualSpec: project.visualSpec, scenes: context.scenes, styleLines: sharedStyle.styleLines,
    onlySectionId: sectionId, sharedStyle, directionContext: castAndSetsCodeContext(project),
  });
  const directedPrompt = feedback ? `${prompt}\n\nReview findings for this section (retain the approved medium and selected assets; never invent a footage fallback):\n${feedback.slice(0, 8000)}` : prompt;
  const run = await runModel({ providerId, model, effort, automation: project.automation, prompt: directedPrompt, source: 'music-video-document', beforeSubmit: async (submission) => {
    const current = await getProject(projectId);
    assertProductionApproval(current, 'storyboard');
    verifyCurrent(current);
    if (basisFor(current) !== context.basis) throw fail('The approved plan changed before authoring', 'COMPOSITION_DRAFT_STALE', 409);
    await beforeSubmit?.(submission);
  } });
  const updated = acceptedSections(run.text, ids);
  const merged = new Map((prior?.manifest.sections || []).map((section) => [section.id, section.source]));
  for (const [id, source] of updated) merged.set(id, source);
  const manifest = {
    version: 1, basis: context.basis, structuralBasis: context.structuralBasis, baseDocumentDirectory: project.composition?.document?.directory || null,
    changedSectionIds: [...new Set([...((prior && project.composition?.documentDraft) ? prior.manifest.changedSectionIds || [] : []), ...ids])],
    beforeSong: prior ? (project.composition?.documentDraft ? prior.manifest.beforeSong || prior.manifest.song : prior.manifest.song) : null,
    sharedStyle, song: context.song, palette: context.palette,
    scenes: context.scenes,
    sections: context.song.sections.map(({ id }) => ({ id, source: merged.get(id) })),
    providerId: run.providerId, model: run.model,
  };
  const active = project.composition?.document?.directory || null;
  const draft = project.composition?.documentDraft?.directory || null;
  const result = await stageGeneratedDocument(projectId, generatedFiles(manifest), {
    verifyCurrent: (current) => {
      assertProductionApproval(current, 'storyboard');
      verifyCurrent(current);
      if (basisFor(current) !== context.basis || (current.composition?.document?.directory || null) !== active
        || (current.composition?.documentDraft?.directory || null) !== draft) {
        throw fail('The project or candidate changed during generation — review the current state and retry', 'COMPOSITION_DRAFT_STALE', 409);
      }
    },
  });
  return { ...result, providerId: run.providerId, model: run.model };
}

export const generateMixedMediaDocument = (projectId, input = {}) => runAuthoring(projectId, input);
export const regenerateMixedMediaSection = (projectId, sectionId, input = {}) => runAuthoring(projectId, { ...input, sectionId });
export const reviseMixedMediaEvents = (projectId, input = {}) => runAuthoring(projectId, { ...input, eventRevision: true });

export async function acceptMixedMediaDocument(projectId, directory, { verifyCurrent = () => {} } = {}) {
  const project = await getProject(projectId);
  if (!project?.composition?.documentDraft || project.composition.documentDraft.directory !== directory) {
    throw fail('The composition candidate changed', 'COMPOSITION_DRAFT_STALE', 409);
  }
  const { manifest } = await priorManifest(project);
  return acceptGeneratedDocument(projectId, directory, {
    verifyCurrent: (current) => {
      verifyCurrent(current);
      if (!matchesBasis(current, manifest) || (current.composition?.document?.directory || null) !== (manifest.baseDocumentDirectory || null)) {
        throw fail('The treatment or selected media changed — generate a fresh document', 'COMPOSITION_DRAFT_STALE', 409);
      }
    },
  });
}

export async function readMixedMediaCandidate(projectId) {
  const project = await getProject(projectId);
  if (!project) throw fail('Project not found', 'NOT_FOUND', 404);
  if (!project.composition?.documentDraft && project.composition?.document?.source?.kind !== 'generated') return { candidate: null, source: null, sections: [] };
  const { pointer, manifest } = await priorManifest(project);
  const currentSong = buildSongDocument(project);
  const resolved = resolveNarrativeEvents(project, currentSong.sections, currentSong.fps);
  Object.assign(currentSong, { narrativeEvents: resolved.events, reactiveSections: project.composition?.reactiveSections || [] });
  return {
    candidate: project.composition?.documentDraft || null,
    source: pointer,
    sections: (manifest.song?.sections || []).map(({ id, label, startSec, endSec }) => ({ id, label, startSec, endSec })),
    providerId: manifest.providerId, model: manifest.model,
    eventRevisionAvailable: !resolved.unresolved.length && (manifest.structuralBasis || manifest.basis) === basisFor(project, false)
      && affectedEventSections(manifest.song, currentSong).length > 0,
    comparisons: (manifest.changedSectionIds || []).map((id) => ({
      sectionId: id,
      before: (manifest.beforeSong?.narrativeEvents || []).filter((event) => event.sectionId === id),
      after: (manifest.song?.narrativeEvents || []).filter((event) => event.sectionId === id),
    })),
    stale: !matchesBasis(project, manifest)
      || (Boolean(project.composition?.documentDraft)
        && (project.composition?.document?.directory || null) !== (manifest.baseDocumentDirectory || null)),
  };
}
