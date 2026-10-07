// Creative approval behavior is covered through production review routes and orchestration.
vi.mock('./productionReview.js', async (load) => ({ ...await load(), assertProductionApproval: vi.fn() }));
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

const h = vi.hoisted(() => ({ calls: 0, prompt: '', response: '', onSubmit: null, onPrepare: null, provider: { id: 'stub-provider' }, args: null }));
vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-mv-document-author-'),
}));
vi.mock('../promptRunner.js', () => ({
  assertProvider: () => {},
  resolveProviderAndModel: async () => ({ provider: h.provider, selectedModel: 'fixture-model' }),
  runPromptThroughProvider: async ({ prompt, beforeExecute, ...args }) => {
    h.args = args;
    await h.onPrepare?.();
    if (beforeExecute) await beforeExecute({ provider: { id: 'stub-provider' }, model: 'fixture-model' });
    h.calls += 1; h.prompt = prompt;
    if (h.onSubmit) await h.onSubmit();
    return { text: h.response };
  },
}));

const { PATHS } = await import('../../lib/paths.js');
const projects = await import('./projects.js');
const { importDocumentTemplate } = await import('./compositionDocument.js');
const { generateMixedMediaDocument, regenerateMixedMediaSection, reviseMixedMediaEvents, readMixedMediaCandidate, acceptMixedMediaDocument } = await import('./documentGeneration.js');

const source = (color) => `function render(ctx, env) { ctx.fillStyle = '${color}'; ctx.fillRect(0, 0, env.width, env.height); }`;
const response = (colors) => JSON.stringify({ sections: Object.entries(colors).map(([id, color]) => ({ id, source: source(color) })) });
const manifestAt = async (document) => JSON.parse(await readFile(join(PATHS.data, document.directory, 'manifest.json'), 'utf8'));

afterAll(() => cleanupTempDataRoots());
beforeEach(() => { h.provider = { id: 'stub-provider' }; h.args = null; h.onSubmit = null; h.onPrepare = null; h.calls = 0; h.prompt = ''; h.response = response({ intro: '#112233', still: '#445566', clip: '#778899' }); });

async function fixture() {
  await mkdir(PATHS.images, { recursive: true });
  await mkdir(PATHS.videos, { recursive: true });
  await writeFile(join(PATHS.images, 'still.png'), 'selected still');
  await writeFile(join(PATHS.videos, 'clip.webm'), 'selected clip');
  await writeFile(join(PATHS.data, 'video-history.json'), JSON.stringify([{ id: 'vh-clip', filename: 'clip.webm', numFrames: 240, fps: 24, width: 640, height: 360 }]));
  const created = await projects.createProject({ name: 'Example Song' });
  await projects.mutateProjectRecord(created.id, (current) => ({ project: {
    ...current,
    audioAnalysis: { durationSec: 30, beats: [0, 10, 20], downbeats: [0, 10, 20], features: { brightness: [0.2] }, sections: [
      { id: 'intro', label: 'Intro', startSec: 0, endSec: 10 },
      { id: 'still', label: 'Verse', startSec: 10, endSec: 20 },
      { id: 'clip', label: 'Hook', startSec: 20, endSec: 30 },
    ] },
    lyricCues: [{ id: 'l1', text: 'Example words', startSec: 19.8, endSec: 21, words: [{ w: 'Example', startSec: 20 }] }],
    visualSpec: { palette: ['#112233', '#ffffff', '#ff7700'], cameraRules: 'Low angle' },
    productionPolicy: { strategy: 'code-first', maxGeneratedVideoPercent: 0 },
    treatment: { revision: 1, brief: { premise: 'A paper kite crosses the city', graphicLanguage: 'Ink and cut paper' }, arc: { motifs: [{ name: 'Kite', evolution: 'Fold to flight' }] }, shotDirections: [
      { sceneId: 's-intro', medium: 'procedural', mediumRationale: 'Open with graphics' },
      { sceneId: 's-still', medium: 'still', mediumRationale: 'Hold the selected image' },
      { sceneId: 's-clip', medium: 'existing-footage', mediumRationale: 'Use the selected take', framing: 'Tight', transitionIn: 'Hard cut' },
    ] },
    scenes: [
      { sceneId: 's-intro', order: 0, startSec: 0, endSec: 10 },
      { sceneId: 's-still', order: 1, startSec: 10, endSec: 20, referenceImageId: 'still.png' },
      { sceneId: 's-clip', order: 2, startSec: 20, endSec: 30, shotMode: 'performance', videoHistoryId: 'vh-clip', takes: [
        { kind: 'video', assetId: 'vh-clip', shotInstruction: { shotMode: 'performance', edit: { inSec: 1, outSec: 8 } } },
      ] },
    ],
  } }));
  return created.id;
}

describe('treatment-driven mixed-media document authoring', () => {
  it('runs authoring on the pinned provider with its effort, and drops effort for a provider that has none (#9545)', async () => {
    const id = await fixture();
    h.provider = { id: 'stub-provider', type: 'cli', command: 'claude' };
    await generateMixedMediaDocument(id, { providerId: 'stub-provider', effort: 'high' });
    expect(h.args).toMatchObject({ provider: { id: 'stub-provider' }, model: 'fixture-model', effort: 'high', source: 'music-video-document' });

    h.provider = { id: 'stub-provider', type: 'api' };
    await generateMixedMediaDocument(id, { providerId: 'stub-provider', effort: 'high' });
    expect(h.args).not.toHaveProperty('effort');
  });

  it('splits an oversized whole-song prompt into bounded batches on a local provider only (#10515)', async () => {
    const id = await fixture();
    h.provider = { id: 'stub-provider', type: 'api' };
    await generateMixedMediaDocument(id, { providerId: 'stub-provider' });
    const whole = h.prompt.length;
    expect(h.calls).toBe(1);

    // A hosted provider keeps the single whole-song request, whatever its size.
    h.calls = 0;
    await generateMixedMediaDocument(id, { providerId: 'stub-provider', promptBudgetChars: whole - 1 });
    expect(h.calls).toBe(1);

    h.provider = { id: 'ollama', type: 'api' };
    h.calls = 0;
    const sizes = [];
    h.onSubmit = async () => { sizes.push(h.prompt.length); };
    const { document } = await generateMixedMediaDocument(id, { providerId: 'ollama', promptBudgetChars: whole - 1 });
    expect(h.calls).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThan(whole);
    const manifest = await manifestAt(document);
    expect(manifest.sections.map((s) => s.id)).toEqual(['intro', 'still', 'clip']);
    expect(manifest.sections.every((s) => s.source.includes('function render'))).toBe(true);

    h.calls = 0;
    await generateMixedMediaDocument(id, { providerId: 'ollama', promptBudgetChars: whole });
    expect(h.calls).toBe(1);

    await expect(generateMixedMediaDocument(id, { providerId: 'ollama', promptBudgetChars: 1 }))
      .rejects.toMatchObject({ code: 'COMPOSITION_PROMPT_TOO_LARGE', message: expect.stringMatching(/\d+ characters/) });
  });

  it('scopes each local batch to the scenes and storyboard shots its sections cover', async () => {
    const id = await fixture();
    await projects.mutateProjectRecord(id, (current) => ({ project: { ...current, productionReview: { ...current.productionReview, draft: {
      ...(current.productionReview?.draft || {}),
      storyboard: ['s-intro', 's-still', 's-clip'].map((sceneId) => ({ sceneId, lyricCueIds: [], action: `choreography for ${sceneId}`, staging: '', camera: '', transition: '' })),
    } } } }));
    h.provider = { id: 'ollama', type: 'api' };
    const prompts = [];
    h.onSubmit = async () => { prompts.push(h.prompt); };
    await generateMixedMediaDocument(id, { providerId: 'ollama' });
    const whole = prompts[0];
    expect(whole).toContain('choreography for s-clip');

    prompts.length = 0;
    // A budget that only fits one section per request.
    await generateMixedMediaDocument(id, { providerId: 'ollama', promptBudgetChars: whole.length - 200 });
    const intro = prompts.find((prompt) => prompt.includes('"id":"intro"'));
    expect(intro).toContain('choreography for s-intro');
    expect(intro).not.toContain('choreography for s-clip');
    expect(intro).not.toContain('"sceneId":"s-clip"');
  });

  it('re-authors a section a local batch dropped on its own, and fails only when the retry misses it too', async () => {
    const id = await fixture();
    h.provider = { id: 'ollama', type: 'api' };
    await generateMixedMediaDocument(id, { providerId: 'ollama' });
    const budget = h.prompt.length - 1;
    const all = response({ intro: '#112233', still: '#445566', clip: '#778899' });
    const sectionsAsked = (prompt) => ['intro', 'still', 'clip'].filter((s) => prompt.includes(`"id":"${s}"`));
    // A multi-section batch comes back without its last section; a single-section ask succeeds.
    h.onSubmit = async () => {
      const asked = sectionsAsked(h.prompt);
      h.response = asked.length > 1 ? response(Object.fromEntries(asked.slice(0, -1).map((s) => [s, '#010203']))) : all;
    };
    h.calls = 0;
    const { document } = await generateMixedMediaDocument(id, { providerId: 'ollama', promptBudgetChars: budget });
    const manifest = await manifestAt(document);
    expect(manifest.sections.map((s) => s.id)).toEqual(['intro', 'still', 'clip']);
    expect(manifest.sections.every((s) => s.source.includes('function render'))).toBe(true);
    expect(h.calls).toBeGreaterThan(2);

    // A returned section that fails its source check is retried on its own too.
    h.onSubmit = async () => {
      const asked = sectionsAsked(h.prompt);
      h.response = asked.length > 1
        ? JSON.stringify({ sections: asked.map((s, i) => ({ id: s, source: i === asked.length - 1 ? 'function render(ctx, env) { ctx.fillRect(Math.random(), 0, 1, 1); }' : source('#010203') })) })
        : all;
    };
    const retried = await manifestAt((await generateMixedMediaDocument(id, { providerId: 'ollama', promptBudgetChars: budget })).document);
    expect(retried.sections.every((s) => !s.source.includes('Math.random'))).toBe(true);

    // The retry missing it too is a hard failure naming the count.
    h.onSubmit = async () => { h.response = response({ intro: '#010203' }); };
    await expect(generateMixedMediaDocument(id, { providerId: 'ollama', promptBudgetChars: budget }))
      .rejects.toMatchObject({ code: 'MISSING_SECTION_SOURCE' });
  });

  it('names the prompt size when authoring times out with no output (#10515)', async () => {
    const id = await fixture();
    h.onSubmit = async () => { throw new Error('API execution timed out after 600000ms with no stream progress'); };
    await expect(generateMixedMediaDocument(id)).rejects.toThrow(/prompt was \d+ characters/);
  });

  it('accepts a legacy generated manifest and upgrades it through an event-only revision', async () => {
    const id = await fixture();
    const first = (await generateMixedMediaDocument(id)).document;
    const legacy = await manifestAt(first);
    legacy.basis = legacy.structuralBasis;
    delete legacy.structuralBasis;
    delete legacy.song.narrativeEvents;
    delete legacy.song.reactiveSections;
    await writeFile(join(PATHS.data, first.directory, 'manifest.json'), JSON.stringify(legacy));
    expect((await readMixedMediaCandidate(id)).stale).toBe(false);
    await acceptMixedMediaDocument(id, first.directory);
    const current = await projects.getProject(id);
    await projects.updateProject(id, { composition: { ...current.composition, narrativeEvents: [{ id: 'new', name: 'Reveal', kind: 'reveal',
      anchor: { kind: 'time', atSec: 1 }, durationSec: 1, narrativeFunction: 'Introduce the kite', mediumRationale: 'Exact graphic' }] } });
    h.response = response({ intro: '#00ff00' });
    const updated = (await reviseMixedMediaEvents(id, { expectedDraft: first.directory })).document;
    expect((await manifestAt(updated)).structuralBasis).toBe(legacy.basis);
    expect((await projects.getProject(id)).scenes).toEqual(current.scenes);
  });

  it('resolves onset/word events and revises only their old/new sections while retaining accepted takes', async () => {
    const id = await fixture();
    const event = { id: 'reveal', name: 'Kite opens', kind: 'reveal', anchor: { kind: 'onset', band: 'low', index: 0 }, durationSec: 1,
      narrativeFunction: 'Reveal flight', mediumRationale: 'Precise cut-paper graphic', text: 'FLIGHT' };
    await projects.updateProject(id, { composition: { mode: 'document', narrativeEvents: [event], reactiveSections: [{ sectionId: 'intro', gain: 1, maxGain: 0.2 }] } });
    await projects.mutateProjectRecord(id, (current) => ({ project: { ...current, audioAnalysis: { ...current.audioAnalysis,
      features: { envelopes: { fps: 1, rms: [1], low: [1], mid: [0], high: [0] }, onsets: { low: [0.51], mid: [], high: [] } },
    } } }));
    const first = (await generateMixedMediaDocument(id)).document;
    const before = await manifestAt(first);
    expect(before.song.narrativeEvents[0]).toMatchObject({ startFrame: 13, endFrame: 37, sectionId: 'intro' });
    expect(h.prompt).toContain('Precise cut-paper graphic');
    expect(h.prompt).toContain('env.reactiveGain');
    await acceptMixedMediaDocument(id, first.directory);
    const original = await projects.getProject(id);
    await projects.updateProject(id, { composition: { ...original.composition, narrativeEvents: [{ ...event, anchor: { kind: 'word', cueId: 'l1', wordIndex: 0 } }] } });
    expect((await readMixedMediaCandidate(id)).eventRevisionAvailable).toBe(true);
    h.response = response({ intro: '#aa0000', clip: '#00aa00' });
    const second = (await reviseMixedMediaEvents(id, { expectedDraft: first.directory })).document;
    const after = await manifestAt(second);
    expect(after.changedSectionIds).toEqual(['intro', 'clip']);
    expect(after.song.narrativeEvents[0]).toMatchObject({ startFrame: 480, endFrame: 504 });
    expect(after.sections.find((section) => section.id === 'still').source).toBe(before.sections.find((section) => section.id === 'still').source);
    expect((await projects.getProject(id)).scenes).toEqual(original.scenes);
    expect((await projects.getProject(id)).composition.document.directory).toBe(first.directory);
    await acceptMixedMediaDocument(id, second.directory);
    await expect(reviseMixedMediaEvents(id, { expectedDraft: second.directory })).rejects.toMatchObject({ code: 'NO_EVENT_CHANGES' });
    expect(h.calls).toBe(2); // document code only, no media generation
    const comparisons = (await readMixedMediaCandidate(id)).comparisons;
    expect(comparisons.find((entry) => entry.sectionId === 'intro').before[0].startFrame).toBe(13);
    expect(comparisons.find((entry) => entry.sectionId === 'clip').after[0].startFrame).toBe(480);
  });

  it('fails unresolved anchors before spending and refuses publication across a concurrent event edit', async () => {
    const id = await fixture();
    const event = { id: 'hold', name: 'Pause', kind: 'silence', anchor: { kind: 'onset', band: 'mid', index: 8 }, durationSec: 1,
      narrativeFunction: 'Let the image breathe', mediumRationale: 'Hold existing media' };
    await projects.updateProject(id, { composition: { mode: 'document', narrativeEvents: [event] } });
    await expect(generateMixedMediaDocument(id)).rejects.toMatchObject({ code: 'NARRATIVE_EVENT_UNRESOLVED' });
    expect(h.calls).toBe(0);
    await projects.updateProject(id, { composition: { mode: 'document', narrativeEvents: [{ ...event, anchor: { kind: 'time', atSec: 1 } }] } });
    const first = (await generateMixedMediaDocument(id)).document;
    h.onSubmit = async () => {
      const current = await projects.getProject(id);
      await projects.updateProject(id, { composition: { ...current.composition, narrativeEvents: [{ ...event, anchor: { kind: 'time', atSec: 2 } }] } });
    };
    await expect(regenerateMixedMediaSection(id, 'intro', { expectedDraft: first.directory })).rejects.toMatchObject({ code: 'COMPOSITION_DRAFT_STALE' });
    expect((await projects.getProject(id)).composition.documentDraft.directory).toBe(first.directory);
    await expect(acceptMixedMediaDocument(id, first.directory)).rejects.toMatchObject({ code: 'COMPOSITION_DRAFT_STALE' });
  });

  it('preflights selected media before a provider call and stages a reviewable 30-second document', async () => {
    const id = await fixture();
    const original = await projects.getProject(id);
    await projects.mutateProjectRecord(id, (current) => ({ project: { ...current, scenes: current.scenes.map((s) => s.sceneId === 's-still' ? { ...s, referenceImageId: 'missing.png' } : s) } }));
    await expect(generateMixedMediaDocument(id)).rejects.toMatchObject({ code: 'COMPOSITION_MEDIA_MISSING' });
    expect(h.calls).toBe(0);
    await projects.mutateProjectRecord(id, (current) => ({ project: { ...current, scenes: original.scenes } }));
    const active = (await importDocumentTemplate(id)).document;
    const { document: candidate } = await generateMixedMediaDocument(id, { providerId: 'stub-provider', model: 'fixture-model' });
    const project = await projects.getProject(id);
    expect(project.composition.document.directory).toBe(active.directory);
    expect(project.composition.documentDraft.directory).toBe(candidate.directory);
    const manifest = await manifestAt(candidate);
    expect(manifest.song.durationSec).toBe(30);
    expect(manifest.scenes.map((s) => [s.visualLayer, s.assetId])).toEqual([
      ['card', null], ['still', 'still.png'], ['footage', 'vh-clip'],
    ]);
    expect(manifest.scenes[2].inSec).toBe(1);
    expect(h.prompt).toContain('A paper kite crosses the city');
    expect(h.prompt).toContain('Fold to flight');
    expect(h.prompt).toContain('brightness');
    expect(h.prompt).toContain('still.png');
    expect(h.prompt).toContain('vh-clip');
    expect(h.calls).toBe(1); // no image or video provider
    expect(await readFile(join(PATHS.data, candidate.directory, 'generated.js'), 'utf8')).toContain('function render(ctx, env)');
  });

  it('carries a film style grammar in the shared style contract, reuses it for Regenerate section, and goes stale when it changes', async () => {
    const id = await fixture();
    await generateMixedMediaDocument(id);
    expect(h.prompt).not.toContain('FILM STYLE GRAMMAR');
    const plain = await projects.getProject(id);
    await projects.updateProject(id, { composition: { ...plain.composition, styleGrammarId: 'risograph-two-ink' } });
    const first = (await generateMixedMediaDocument(id)).document;
    expect(h.prompt).toContain('FILM STYLE GRAMMAR');
    expect(h.prompt).toContain('## Film style grammar: ');
    const manifest = await manifestAt(first);
    expect(manifest.sharedStyle.styleGrammarId).toBe('risograph-two-ink');
    expect(manifest.sharedStyle.styleLines.join('\n')).toContain('Camera vocabulary:');
    h.response = response({ still: '#00ff00' });
    await regenerateMixedMediaSection(id, 'still', { expectedDraft: first.directory });
    expect(h.prompt).toContain('## Film style grammar: ');
    const current = await projects.getProject(id);
    await projects.updateProject(id, { composition: { ...current.composition, styleGrammarId: 'blueprint-draft' } });
    expect((await readMixedMediaCandidate(id)).stale).toBe(true);
    await expect(acceptMixedMediaDocument(id, current.composition.documentDraft.directory)).rejects.toMatchObject({ code: 'COMPOSITION_DRAFT_STALE' });
  });

  it('revises one section, preserves the other functions, and refuses a stale acceptance', async () => {
    const id = await fixture();
    const motionLanguage = 'Energy: playful. 0–10s unfold on downbeats; 20–30s expand the chorus gesture.';
    await projects.mutateProjectRecord(id, current => ({ project: { ...current, productionReview: { draft: { motionLanguage, implementationPlan: 'Hinged paper rig and analytic camera arc.' } } } }));
    const first = (await generateMixedMediaDocument(id)).document;
    expect(h.prompt).toContain(motionLanguage);
    const before = await manifestAt(first);
    h.response = response({ still: '#00ff00' });
    const second = (await regenerateMixedMediaSection(id, 'still', { expectedDraft: first.directory })).document;
    const after = await manifestAt(second);
    expect(h.prompt).toContain(motionLanguage);
    expect(h.prompt).toContain('Hinged paper rig and analytic camera arc.');
    expect(after.sections.map((s) => s.source)).toEqual([before.sections[0].source, source('#00ff00'), before.sections[2].source]);
    await expect(regenerateMixedMediaSection(id, 'still', { expectedDraft: first.directory })).rejects.toMatchObject({ code: 'COMPOSITION_DRAFT_STALE' });
    await projects.mutateProjectRecord(id, (current) => ({ project: {
      ...current, scenes: current.scenes.map((scene) => scene.sceneId === 's-clip'
        ? { ...scene, takes: [{ ...scene.takes[0], shotInstruction: { shotMode: 'performance', edit: { inSec: 2, outSec: 8 } } }] }
        : scene),
    } }));
    await expect(acceptMixedMediaDocument(id, second.directory)).rejects.toMatchObject({ code: 'COMPOSITION_DRAFT_STALE' });
    expect((await projects.getProject(id)).composition.documentDraft.directory).toBe(second.directory);
  });

  it('refuses a candidate after the uploaded master song changes without changing its analysis shape', async () => {
    const id = await fixture();
    const candidate = (await generateMixedMediaDocument(id)).document;
    await projects.mutateProjectRecord(id, (current) => ({ project: {
      ...current, uploadedAudioFilename: 'replacement-master.wav',
    } }));
    await expect(acceptMixedMediaDocument(id, candidate.directory)).rejects.toMatchObject({ code: 'COMPOSITION_DRAFT_STALE' });
  });
});


it('checks production authorization before provider submission and again before candidate publication/acceptance', async () => {
  const id = await fixture();
  const blocked = () => { throw Object.assign(new Error('Production canceled'), { code: 'PRODUCTION_STEP_CLOSED' }); };
  await expect(generateMixedMediaDocument(id, { beforeSubmit: blocked })).rejects.toMatchObject({ code: 'PRODUCTION_STEP_CLOSED' });
  expect(h.calls).toBe(0);
  let active = true;
  h.onSubmit = () => { active = false; };
  await expect(generateMixedMediaDocument(id, { verifyCurrent: () => { if (!active) blocked(); } })).rejects.toMatchObject({ code: 'PRODUCTION_STEP_CLOSED' });
  expect(h.calls).toBe(1);
  expect((await projects.getProject(id)).composition?.documentDraft).toBeUndefined();
  h.onSubmit = null; h.onPrepare = null;
  const staged = (await generateMixedMediaDocument(id)).document;
  await expect(acceptMixedMediaDocument(id, staged.directory, { verifyCurrent: blocked })).rejects.toMatchObject({ code: 'PRODUCTION_STEP_CLOSED' });
  expect((await projects.getProject(id)).composition.documentDraft.directory).toBe(staged.directory);
});

it('hands the approved procedural definitions and rules to the document author, and nothing from an unapproved check-in', async () => {
  const id = await fixture();
  const castAndSets = (status) => ({ status, direction: {
    medium: 'procedural',
    protagonist: { name: 'Kite', description: 'a paper kite', movement: 'sways on the downbeat' },
    world: { camera: 'locked wide, slow push' },
    definitions: { characters: [{ id: 'kite', name: 'Kite', renderer: 'svg', palette: [], parts: [{ id: 'sail', shape: 'polygon', points: [[100, 20], [160, 100], [100, 180], [40, 100]], fill: '#ff7700' }], expressions: [], poses: [], motion: [] }] },
  } });
  await projects.mutateProjectRecord(id, (current) => ({ project: { ...current, castAndSets: castAndSets('review') } }));
  await generateMixedMediaDocument(id);
  expect(h.prompt).not.toContain('APPROVED CAST & SETS');

  await projects.mutateProjectRecord(id, (current) => ({ project: { ...current, castAndSets: castAndSets('approved') } }));
  await generateMixedMediaDocument(id);
  expect(h.prompt).toContain('APPROVED CAST & SETS DEFINITIONS AND RULES');
  expect(h.prompt).toContain('camera: locked wide, slow push');
  expect(h.prompt).toContain('movement: sways on the downbeat');
  expect(h.prompt).toContain('"shape":"polygon"');
});


it('refuses a changed production draft after provider preparation and before paid authoring', async () => {
  const id = await fixture();
  h.onPrepare = () => projects.mutateProjectRecord(id, project => ({ project: { ...project,
    productionReview: { draft: { motionLanguage: 'Revised choreography' } },
  } }));
  await expect(generateMixedMediaDocument(id)).rejects.toMatchObject({ code: 'COMPOSITION_DRAFT_STALE' });
  expect(h.calls).toBe(0);
});

it('refuses ambient Three.js random helpers and their aliases while allowing deterministic local helpers', async () => {
  const created = await projects.createProject({ name: 'Example deterministic world', mediaMode: 'code-only' });
  await projects.mutateProjectRecord(created.id, current => ({ project: { ...current,
    audioAnalysis: { durationSec: 1, beats: [], downbeats: [], sections: [{ id: 'world', startSec: 0, endSec: 1 }] },
    composition: { mode: 'document', authoringRenderer: 'three' },
  } }));
  // Library helpers hide the ambient RNG from the existing Math.random guard;
  // namespace aliases and destructured calls must not bypass admission either.
  const bodies = [
    'ctx.THREE.MathUtils.randFloat(0, 1)',
    'ctx.THREE.MathUtils.randInt(0, 10)',
    'ctx.THREE.MathUtils.randFloatSpread(10)',
    'ctx.THREE.MathUtils.seededRandom()',
    'ctx.THREE.MathUtils.generateUUID()',
    'const { THREE } = ctx; const utils = THREE.MathUtils; utils["randFloat"](0, 1)',
    'const { MathUtils: { seededRandom: sample } } = ctx.THREE; sample()',
    'let utils; utils = ctx.THREE.MathUtils; const { randInt: sample } = utils; sample(0, 10)',
  ];
  for (const body of bodies) {
    h.response = JSON.stringify({ sections: [{ id: 'world', source: `function render(ctx, env) { ${body}; }` }] });
    await expect(generateMixedMediaDocument(created.id), body).rejects.toMatchObject({ code: 'NONDETERMINISTIC_SECTION' });
    expect((await projects.getProject(created.id)).composition.documentDraft).toBeUndefined();
  }
  h.response = JSON.stringify({ sections: [{ id: 'world', source: `function render(ctx, env) {
    const local = { randFloat: (seed) => (Math.sin(seed * 123.45) + 1) / 2 };
    const { THREE } = ctx;
    ctx.scene.background = new THREE.Color(local.randFloat(env.frame), 0.5, 0.2);
  }` }] });
  const candidate = await generateMixedMediaDocument(created.id);
  expect((await manifestAt(candidate.document)).renderer).toBe('three');
});
