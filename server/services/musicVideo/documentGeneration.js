import { musicVideoMediaMode, musicVideoDocumentRenderer, assertMusicVideoMediaSelections } from '../../lib/musicVideoMediaPolicy.js';
import { assertProductionApproval } from './productionReview.js';
/** User-triggered mixed-media document authoring. No provider runs on read or boot. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parse } from '@babel/parser';
import { ServerError } from '../../lib/errorHandler.js';
import { getFilmStyleGrammar, renderFilmStyleGrammarPrompt } from '../../lib/filmStyleGrammars.js';
import { resolveNarrativeEvents } from '../../lib/musicVideoNarrativeEvents.js';
import { isDeterministicCodeSource } from '../../lib/musicVideoValidation.js';
import { summarizeMusicVideoMediumPlan } from '../../lib/musicVideoMediumPlan.js';
import { buildMixedMediaDocumentPrompt, extractCodeSections } from '../codeAnimation/prompt.js';
import { buildCodeTimeline, buildSongDocument, paletteFromProject } from './codeTimeline.js';
import { isOllamaBackedProvider } from '../../lib/aiToolkit/internal/ollamaBacked.js';
import { isLocalInstanceEndpoint } from '../../lib/localEndpoint.js';
import { castAndSetsCodeContext, runModel, styleLinesFor } from './codeGeneration.js';
import { resolveMusicVideoLlm } from './llmRoute.js';
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

// Three's convenience random functions hide Math.random or module-level RNG
// state behind the namespace we supply. Track only that namespace and its
// static aliases, so unrelated local methods with these names remain usable.
function hasAmbientThreeRandom(fn) {
  const random = new Set(['randInt', 'randFloat', 'randFloatSpread', 'seededRandom', 'generateUUID']);
  const aliases = new Map([['ctx', new Set(['context'])]]);
  const nodes = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node.type) nodes.push(node);
    for (const [key, value] of Object.entries(node)) if (!['loc', 'start', 'end'].includes(key)) visit(value);
  };
  visit(fn.body);
  const property = (node) => node.computed ? node.property?.value : node.property?.name;
  const member = (kind, key) => kind === 'context' && key === 'THREE' ? 'three'
    : kind === 'three' && key === 'MathUtils' ? 'math'
      : kind === 'math' && random.has(key) ? 'random' : null;
  const resolve = (node) => {
    if (node?.type === 'Identifier') return aliases.get(node.name) || new Set();
    if (['MemberExpression', 'OptionalMemberExpression'].includes(node?.type)) {
      return new Set([...resolve(node.object)].map(kind => member(kind, property(node))).filter(Boolean));
    }
    return new Set();
  };
  const bind = (pattern, kinds) => {
    if (pattern?.type === 'Identifier') {
      const current = aliases.get(pattern.name) || new Set();
      for (const kind of kinds) current.add(kind);
      aliases.set(pattern.name, current);
    } else if (pattern?.type === 'ObjectPattern') {
      for (const field of pattern.properties) {
        if (field.type !== 'ObjectProperty') continue;
        const key = field.computed ? field.key.value : field.key.name || field.key.value;
        bind(field.value, new Set([...kinds].map(kind => member(kind, key)).filter(Boolean)));
      }
    }
  };
  const bindings = nodes.filter(node => node.type === 'VariableDeclarator' || node.type === 'AssignmentExpression' && node.operator === '=');
  // A bounded fixed point also covers aliases assigned after their declaration.
  for (let pass = 0; pass <= bindings.length; pass++) {
    for (const node of bindings) bind(node.id || node.left, resolve(node.init || node.right));
  }
  return nodes.some(node => resolve(node).has('random'));
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
  if (hasAmbientThreeRandom(fn)) throw fail('Three.js MathUtils random helpers depend on ambient state. Use deterministic arithmetic from env.t or env.frame instead.', 'NONDETERMINISTIC_SECTION');
  if (hasUnsafeReference(fn.body)) throw fail('A section must use only its drawing context and song-time inputs', 'NONDETERMINISTIC_SECTION');
  return source;
}

// The full grammar rides in the shared style contract so every section and every
// Regenerate-section call reads the same medium rules. An id this build does not
// know (a newer peer's catalog) is skipped rather than failing generation.
function styleGrammarLines(project) {
  const id = project.composition?.styleGrammarId;
  if (!id || !getFilmStyleGrammar(id)) return [];
  return ['FILM STYLE GRAMMAR (medium rules; the approved palette and the lyric-readability rules always win over any colour or type it implies):', renderFilmStyleGrammarPrompt(id)];
}

function basisFor(project, includeEvents = true) {
  // These are all inputs that can change which pixels or authoring directions
  // a section means. A new candidate cannot publish across such an edit.
  const input = {
    mediaMode: musicVideoMediaMode(project),
    authoringRenderer: musicVideoDocumentRenderer(project),
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
    // Present only when chosen, so a project without one keeps its existing basis (#10254).
    ...(project.composition?.styleGrammarId ? { styleGrammarId: project.composition.styleGrammarId } : {}),
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
  assertMusicVideoMediaSelections(project);
  if (musicVideoDocumentRenderer(project) === 'three' && (project.scenes || []).some((scene) => scene.referenceImageId || scene.videoHistoryId)) throw fail('Generated Three.js worlds currently use geometry only. Use Canvas or import a document to compose selected media.', 'COMPOSITION_RENDERER_MEDIA_UNSUPPORTED');
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

// A local model spends the whole stream-stall window evaluating a huge prompt before the first
// token, which the stall timer cannot tell apart from a hang (#10515). Above this, a local
// provider authors sections in bounded batches instead of one whole-song request.
export const LOCAL_PROMPT_BUDGET_CHARS = 100_000;

// The scenes overlapping any of `sections` (all of them when every section is listed).
export function batchScenes(scenes, sections) {
  return (scenes || []).filter((scene) => !Number.isFinite(scene.startSec) || !Number.isFinite(scene.endSec)
    || sections.some((section) => scene.startSec < section.endSec && scene.endSec > section.startSec));
}

const isLocalProvider = (provider) => isOllamaBackedProvider(provider) || isLocalInstanceEndpoint(provider?.endpoint);

// Greedily pack consecutive section ids into batches whose prompt stays within budget.
function batchSectionIds(ids, promptFor, budget) {
  const batches = [];
  let current = [];
  for (const id of ids) {
    const next = [...current, id];
    const size = promptFor(next).length;
    if (current.length && size > budget) { batches.push(current); current = [id]; } else current = next;
  }
  if (current.length) batches.push(current);
  for (const batch of batches) {
    const size = promptFor(batch).length;
    if (size > budget) throw fail(`The authoring prompt for section ${batch.join(', ')} is ${size} characters, over the ${budget}-character budget for a local model. Trim the treatment, cast or style context, or choose a provider with a larger context.`, 'COMPOSITION_PROMPT_TOO_LARGE');
  }
  return batches;
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

async function runAuthoring(projectId, { providerId, model, effort, sectionId = null, eventRevision = false, expectedDraft = null, feedback = '', beforeSubmit = null, verifyCurrent = () => {}, promptBudgetChars = LOCAL_PROMPT_BUDGET_CHARS } = {}) {
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
    styleLines: [...await styleLinesFor(project), ...styleGrammarLines(project)],
    ...(project.composition?.styleGrammarId ? { styleGrammarId: project.composition.styleGrammarId } : {}),
  };
  const promptFor = (batchIds) => {
    const sections = context.song.sections.filter((section) => batchIds.includes(section.id));
    // Only the scenes (and storyboard shots) a batch's sections cover: a long storyboard would
    // otherwise put every shot in each batch and push it past a local model's budget.
    const scenes = batchScenes(context.scenes, sections);
    return buildMixedMediaDocumentPrompt({
      renderer: musicVideoDocumentRenderer(project), mediaMode: musicVideoMediaMode(project),
      title: project.name, song: { ...context.song, sections }, palette: context.palette, treatment: project.treatment,
      visualSpec: project.visualSpec, scenes, styleLines: sharedStyle.styleLines,
      onlySectionId: sectionId, sharedStyle, directionContext: castAndSetsCodeContext(project, { sceneIds: scenes.map((scene) => scene.sceneId) }),
    });
  };
  const withFeedback = (prompt) => (feedback ? `${prompt}\n\nReview findings for this section (retain the approved medium and selected assets; never invent a footage fallback):\n${feedback.slice(0, 8000)}` : prompt);
  const guardedBeforeSubmit = async (submission) => {
    const current = await getProject(projectId);
    assertProductionApproval(current, 'storyboard');
    verifyCurrent(current);
    if (basisFor(current) !== context.basis) throw fail('The approved plan changed before authoring', 'COMPOSITION_DRAFT_STALE', 409);
    await beforeSubmit?.(submission);
  };
  const runBatch = async (prompt) => {
    try {
      return await runModel({ providerId, model, effort, automation: project.automation, prompt, source: 'music-video-document', beforeSubmit: guardedBeforeSubmit });
    } catch (err) {
      if (/timed out/i.test(err?.message || '') && !/prompt was \d+ characters/.test(err.message)) err.message += ` (prompt was ${prompt.length} characters)`;
      throw err;
    }
  };
  // Resolve the provider only when there is something to split, so single-section runs are unchanged.
  const fullPrompt = withFeedback(promptFor(ids));
  const batches = ids.length > 1 && fullPrompt.length > promptBudgetChars
    && isLocalProvider((await resolveMusicVideoLlm({ providerId, model, effort, automation: project.automation, stage: 'authoring' })).provider)
    ? batchSectionIds(ids, (batchIds) => withFeedback(promptFor(batchIds)), promptBudgetChars) : null;
  const updated = new Map();
  let run;
  if (batches) {
    console.log(`🎬 Music-video document prompt is ${fullPrompt.length} chars; authoring ${ids.length} sections in ${batches.length} batches on a local model`);
    for (const batch of batches) {
      run = await runBatch(withFeedback(promptFor(batch)));
      for (const [id, source] of acceptedSections(run.text, batch)) updated.set(id, source);
    }
  } else {
    run = await runBatch(fullPrompt);
    for (const [id, source] of acceptedSections(run.text, ids)) updated.set(id, source);
  }
  const merged = new Map((prior?.manifest.sections || []).map((section) => [section.id, section.source]));
  for (const [id, source] of updated) merged.set(id, source);
  const manifest = {
    version: 1, renderer: musicVideoDocumentRenderer(project), mediaMode: musicVideoMediaMode(project), basis: context.basis, structuralBasis: context.structuralBasis, baseDocumentDirectory: project.composition?.document?.directory || null,
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
    renderer: manifest.renderer,
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
