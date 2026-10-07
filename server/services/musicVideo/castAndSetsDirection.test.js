/**
 * Cast & Sets creative direction — the parse/merge boundary a provider answer
 * crosses: fenced and echoed answers, lenient per-field parsing, the
 * absent-vs-empty merge rule on a revision, and the refusal of a first pass
 * that lacks the required parts.
 */

import { describe, it, expect } from 'vitest';
import {
  applyCastAndSetsDirectionEdits,
  buildCastAndSetsPrompt,
  castAndSetsAllowsImages,
  castAndSetsMedium,
  mergeCastAndSetsDirection,
  parseCastAndSetsResponse,
  songSections,
} from './castAndSetsDirection.js';

const project = {
  name: 'Example Song',
  lyricCues: [{ text: 'line one' }, { text: 'line two' }],
  lyricMarkers: [{ type: 'section', label: 'Verse 1', line: 0 }, { type: 'direction', label: 'Whispered', line: 1 }],
  audioAnalysis: { durationSec: 60, bpm: 128, sections: [{ label: 'Intro', startSec: 0, endSec: 20 }, { label: 'Chorus', startSec: 20, endSec: 60 }] },
  automation: { guidance: 'keep it night-lit' },
  concept: { prompt: 'an escape story', style: 'raw flash' },
};
const sections = songSections(project);

const ANSWER = {
  logline: 'She escapes.',
  protagonist: { name: 'Nova', face: 'weathered', hair: 'grey braid', rules: ['No hats'] },
  looks: [{ name: 'Lab', description: 'grey hoodie' }],
  sets: [
    { name: 'Lab Room', description: 'a lamp room', lighting: 'green', sections: [0] },
    { id: 'Harbor!', name: 'Harbor', description: 'wet stone quay', lighting: 'sodium orange' },
    { name: 'Roof', description: 'rain', lighting: 'red' },
  ],
  songMap: [{ section: 'Chorus', setId: 'roof' }, { section: 0, setId: 'harbor' }, { section: 9, setId: 'roof' }],
  tests: [{ setId: 'lab-room', look: 'Lab', action: 'climbing' }, { setId: 'nowhere', action: 'x' }],
  overlayConcept: 'A falling meter.',
  moodRefs: [2, 7],
};

describe('Cast & Sets direction', () => {
  it('builds a prompt that reads the song and keeps the mood board to look only', () => {
    const prompt = buildCastAndSetsPrompt(project, { moodImages: [{ caption: 'a kitchen', analysis: 'steam and brass' }], board: { style: { prompt: 'green flash' } } });
    expect(prompt).toContain('[Verse 1]\nline one\n[Whispered]\nline two');
    expect(prompt).toContain('Interpret the song');
    expect(prompt).toMatch(/LOOK, LIGHTING, COLOR and TEXTURE only/);
    expect(prompt).toContain('0. a kitchen — steam and brass');
    expect(prompt).toContain('Director guidance: keep it night-lit');
    expect(prompt).toContain('1. Chorus 0:20–1:00');
    expect(prompt).not.toContain('This is a REVISION');
  });

  it('parses a fenced answer after an echoed schema, normalizing ids, the song map and tests', () => {
    const echoed = buildCastAndSetsPrompt(project).split('no other text:\n')[1];
    const parsed = parseCastAndSetsResponse(`${echoed}\n\nSure:\n\`\`\`json\n${JSON.stringify(ANSWER)}\n\`\`\``);
    expect(parsed.logline).toBe('She escapes.');
    const { direction, missing } = mergeCastAndSetsDirection(null, parsed, { sections, moodImageCount: 4 });
    expect(missing).toEqual([]);
    expect(direction.sets.map((s) => s.id)).toEqual(['lab-room', 'harbor', 'roof']);
    expect(direction.sets[0].sections).toEqual(['Intro']);
    // Labels and indices both resolve; an unknown section is dropped.
    expect(direction.songMap).toEqual([{ section: 0, setId: 'harbor' }, { section: 1, setId: 'roof' }]);
    expect(direction.tests).toEqual([{ setId: 'lab-room', look: 'Lab', action: 'climbing', caption: '' }]);
    expect(direction.overlayConcept).toEqual({ summary: 'A falling meter.', elements: [] });
    expect(direction.moodRefs).toEqual([2]);
  });

  it('refuses a first pass missing the protagonist or enough sets', () => {
    const parsed = parseCastAndSetsResponse(JSON.stringify({ logline: 'x', sets: [{ name: 'A', description: 'a' }] }));
    expect(mergeCastAndSetsDirection(null, parsed, { sections }).missing).toEqual(['protagonist', 'looks', 'sets']);
    expect(parseCastAndSetsResponse('no json here')).toBeNull();
  });

  it('keeps a protagonist whose prose fields came back as structure, flattening them to text', () => {
    const parsed = parseCastAndSetsResponse(JSON.stringify({
      logline: 'x',
      protagonist: { name: 'The Vector', description: 'a paper airplane', palette: { primary: '#FFFFFF', accent: '#00F0FF' }, materials: ['paper', 'glow'] },
      world: { lighting: { key: 'neon', fill: 0 } },
    }));
    expect(parsed.protagonist).toMatchObject({ name: 'The Vector', palette: 'primary: #FFFFFF, accent: #00F0FF', materials: 'paper, glow' });
    expect(parsed.world.lighting).toBe('key: neon, fill: 0');
    expect(mergeCastAndSetsDirection(null, parsed, { sections, medium: 'procedural' }).missing).not.toContain('protagonist');
  });

  it('keeps a protagonist with null, boolean or single-string answers in its fields', () => {
    const parsed = parseCastAndSetsResponse(JSON.stringify({
      logline: 'x',
      protagonist: { name: 'A', description: 'b', gesture: null, signature: true, palette: { primary: '#fff', accent: null },
        rules: 'Never lands', expressions: null },
      world: { camera: null },
    }));
    expect(parsed.protagonist).toMatchObject({ name: 'A', signature: 'true', palette: 'primary: #fff', rules: ['Never lands'] });
    expect(parsed.protagonist).not.toHaveProperty('gesture');
    expect(parsed.protagonist).not.toHaveProperty('expressions');
    expect(parsed.world).not.toHaveProperty('camera');
    expect(mergeCastAndSetsDirection(null, parsed, { sections, medium: 'procedural' }).missing).not.toContain('protagonist');
  });

  it('treats a null field in a revision as no change, and an empty one as a clear', () => {
    const { direction: previous } = mergeCastAndSetsDirection(null, parseCastAndSetsResponse(JSON.stringify({ ...ANSWER,
      protagonist: { ...ANSWER.protagonist, gesture: 'wave', rules: ['r1'] }, world: { camera: 'slow dolly' } })), { sections, moodImageCount: 4, medium: 'procedural' });
    const revision = parseCastAndSetsResponse(JSON.stringify({ protagonist: { hair: 'red', gesture: null, rules: null }, world: { camera: null, layout: '' } }));
    const { direction } = mergeCastAndSetsDirection(previous, revision, { sections, moodImageCount: 4, medium: 'procedural' });
    expect(direction.protagonist).toMatchObject({ hair: 'red', gesture: 'wave', rules: ['r1'] });
    expect(direction.world).toMatchObject({ camera: 'slow dolly', layout: '' });
  });

  it('on a revision keeps absent keys, applies present ones, and treats an empty value as a clear', () => {
    const { direction: previous } = mergeCastAndSetsDirection(null, parseCastAndSetsResponse(JSON.stringify({ ...ANSWER, questions: ['Is she right?'], interpretation: 'agents' })), { sections, moodImageCount: 4 });
    const revision = parseCastAndSetsResponse(JSON.stringify({
      protagonist: { hair: 'silver crop' },
      questions: [],
      interpretation: '',
      // A malformed field counts as absent rather than failing the answer.
      looks: 'not a list',
    }));
    expect(revision).not.toHaveProperty('looks');
    const { direction, missing } = mergeCastAndSetsDirection(previous, revision, { sections, moodImageCount: 4 });
    expect(missing).toEqual([]);
    expect(direction.protagonist).toMatchObject({ name: 'Nova', hair: 'silver crop', face: 'weathered', rules: ['No hats'] });
    expect(direction.looks).toEqual(previous.looks);
    expect(direction.sets).toEqual(previous.sets);
    expect(direction.logline).toBe('She escapes.');
    expect(direction.questions).toEqual([]);
    expect(direction.interpretation).toBe('');
  });
});

const PROCEDURAL_ANSWER = {
  logline: 'A paper boat crosses a neon city.',
  protagonist: {
    name: 'Boat', description: 'a folded paper boat', construction: 'three triangles hinged at the keel', shapeLanguage: 'sharp, folded',
    materials: 'flat fills with a soft glow', palette: '#f5f0e6, #ff5a1f', expressions: ['proud: bow lifts', 'tired: bow droops'], movement: 'eases in, bobs on every beat',
  },
  world: { layout: 'a river through stacked streets', depth: 'three parallax planes', camera: 'slow dolly with a beat-synced push', transitions: 'wipe through reflections' },
  sets: [
    { name: 'River', description: 'a neon river', lighting: 'magenta', imageRole: 'Background' },
    { name: 'Bridge', description: 'an iron span', lighting: 'cyan', imageRole: 'decoration' },
    { name: 'Quay', description: 'wet stone', lighting: 'amber', imageRole: 'photo-booth' },
  ],
  looks: [],
};

describe('Cast & Sets procedural medium', () => {
  const procedural = { ...project, productionPolicy: { strategy: 'code-first', maxGeneratedVideoPercent: 0 } };
  it('resolves the medium from the production policy and the brief tools together', () => {
    expect(castAndSetsMedium(procedural)).toBe('procedural');
    expect(castAndSetsMedium({ automation: { tools: ['image:codex', 'code:render'] } })).toBe('procedural');
    // A video tool, an image-only brief and an untouched project stay photographic.
    expect(castAndSetsMedium({ automation: { tools: ['image:codex', 'code:render', 'video:local'] } })).toBe('photographic');
    expect(castAndSetsMedium({ automation: { tools: ['image:codex'] } })).toBe('photographic');
    expect(castAndSetsMedium(project)).toBe('photographic');
    expect(castAndSetsAllowsImages({ automation: { tools: ['code:render'] } })).toBe(false);
    expect(castAndSetsAllowsImages({ automation: { tools: ['image:codex', 'code:render'] } })).toBe(true);
    expect(castAndSetsAllowsImages(project)).toBe(true);
  });

  it('asks for construction, world and image roles instead of a photographic cast', () => {
    const prompt = buildCastAndSetsPrompt(procedural);
    expect(prompt).toContain('PROCEDURAL music video');
    expect(prompt).toContain('"construction"');
    expect(prompt).toContain('"imageRole"');
    expect(prompt).toContain('"cutout"');
    expect(prompt).not.toMatch(/"face"|"hair"|"tests"/);
    expect(buildCastAndSetsPrompt(project)).toContain('"face"');
    // A revision keeps the medium the saved direction was made in, whatever the project says now.
    // ...and a saved photographic direction (no medium) stays photographic under a code-first project.
    expect(buildCastAndSetsPrompt(procedural, { previous: { protagonist: { name: 'Nova' } }, notes: [{ text: 'x' }] })).toContain('"face"');
    expect(buildCastAndSetsPrompt(project, { previous: { medium: 'procedural' }, notes: [{ text: 'bigger sail' }] })).toContain('PROCEDURAL');
  });

  it('merges procedural fields, defaults an unknown image role, and does not require looks', () => {
    const parsed = parseCastAndSetsResponse(JSON.stringify(PROCEDURAL_ANSWER));
    const { direction, missing } = mergeCastAndSetsDirection(null, parsed, { sections, medium: 'procedural' });
    expect(missing).toEqual([]);
    expect(direction).toMatchObject({ medium: 'procedural', looks: [], tests: [] });
    expect(direction.protagonist).toMatchObject({ construction: 'three triangles hinged at the keel', expressions: ['proud: bow lifts', 'tired: bow droops'] });
    expect(direction.world.camera).toBe('slow dolly with a beat-synced push');
    expect(direction.sets.map((s) => s.imageRole)).toEqual(['background', 'decoration', 'background']);

    // Revision: absent keys keep the saved values, a present empty value clears.
    const revision = parseCastAndSetsResponse(JSON.stringify({ protagonist: { movement: '' }, world: { depth: 'two planes' } }));
    const revised = mergeCastAndSetsDirection(direction, revision, { sections }).direction;
    expect(revised.medium).toBe('procedural');
    expect(revised.protagonist).toMatchObject({ movement: '', construction: 'three triangles hinged at the keel' });
    expect(revised.world).toMatchObject({ depth: 'two planes', layout: 'a river through stacked streets' });
    expect(revised.sets).toEqual(direction.sets);
  });

  it('leaves a photographic direction exactly as it was', () => {
    const { direction } = mergeCastAndSetsDirection(null, parseCastAndSetsResponse(JSON.stringify(ANSWER)), { sections });
    expect(direction).not.toHaveProperty('medium');
    expect(direction).not.toHaveProperty('world');
    expect(direction.protagonist).not.toHaveProperty('construction');
    expect(direction.sets[0]).not.toHaveProperty('imageRole');
  });
});

describe('Cast & Sets reusable definitions', () => {
  const DEFINITIONS = { characters: [{
    name: 'Boat', palette: [{ name: 'cream', hex: '#f5f0e6' }],
    parts: [{ id: 'hull', shape: 'rect', x: 40, y: 100, width: 120, height: 40, fill: 'cream' }],
    expressions: [{ name: 'proud', overrides: { hull: { rotate: -4 } } }],
  }] };
  const direct = (extra) => mergeCastAndSetsDirection(null, parseCastAndSetsResponse(JSON.stringify({ ...PROCEDURAL_ANSWER, ...extra })), { sections, medium: 'procedural' }).direction;

  it('asks for definitions and keeps them through a revision (absent keeps, empty clears, unusable keeps)', () => {
    expect(buildCastAndSetsPrompt({ ...project, productionPolicy: { strategy: 'code-first', maxGeneratedVideoPercent: 0 } })).toContain('"definitions"');
    const direction = direct({ definitions: DEFINITIONS });
    expect(direction.definitions.characters[0]).toMatchObject({ id: 'boat', renderer: 'svg' });

    const revise = (answer) => mergeCastAndSetsDirection(direction, parseCastAndSetsResponse(JSON.stringify(answer)), { sections }).direction;
    expect(revise({ protagonist: { movement: 'slower' } }).definitions).toEqual(direction.definitions);
    expect(revise({ definitions: { characters: [{ name: 'Broken', parts: [{ shape: 'path', d: '<bad>' }] }] } }).definitions).toEqual(direction.definitions);
    expect(revise({ definitions: { characters: [] } }).definitions).toEqual({ characters: [] });
  });

  it('gives a photographic direction no definitions', () => {
    const { direction } = mergeCastAndSetsDirection(null, parseCastAndSetsResponse(JSON.stringify({ ...ANSWER, definitions: DEFINITIONS })), { sections });
    expect(direction).not.toHaveProperty('definitions');
  });
});

describe('Cast & Sets direct edits', () => {
  const saved = mergeCastAndSetsDirection(null, parseCastAndSetsResponse(JSON.stringify(PROCEDURAL_ANSWER)), { sections, medium: 'procedural' }).direction;
  const direction = { ...saved, look: 'flat fills', moodRefs: [0, 2] };

  it('replaces present fields, keeps absent ones, clears on empty, and reports what changed', () => {
    const edited = applyCastAndSetsDirectionEdits(direction, {
      protagonist: { palette: '#112233, #445566', movement: '', expressions: ['calm: bow level'] },
      world: { camera: 'locked off' },
      sets: [{ id: direction.sets[0].id, imageRole: 'texture' }],
    }, { sections });
    expect(edited.direction.protagonist).toMatchObject({ palette: '#112233, #445566', movement: '', expressions: ['calm: bow level'], construction: direction.protagonist.construction });
    expect(edited.direction.world).toMatchObject({ camera: 'locked off', layout: direction.world.layout });
    expect(edited.direction.sets[0].imageRole).toBe('texture');
    expect(edited.direction.sets.slice(1)).toEqual(direction.sets.slice(1));
    // The mood-board picks and photographic look are not touched by an edit.
    expect(edited.direction).toMatchObject({ look: 'flat fills', moodRefs: [0, 2], songMap: direction.songMap });
    expect(edited.changed).toEqual(['palette', 'movement', 'expressions', 'world camera', `${direction.sets[0].name} image role`]);
    // Re-saving the same values is no change at all.
    expect(applyCastAndSetsDirectionEdits(direction, { world: { camera: direction.world.camera } }, { sections }).changed).toEqual([]);
  });

  it('refuses a photographic direction, an unknown set, and an edit that empties the protagonist', () => {
    expect(() => applyCastAndSetsDirectionEdits({ ...direction, medium: undefined }, { world: { camera: 'x' } })).toThrow(/procedural/);
    expect(() => applyCastAndSetsDirectionEdits(direction, { sets: [{ id: 'nowhere', imageRole: 'cutout' }] })).toThrow(/Unknown set/);
    const bare = { ...direction, protagonist: { ...direction.protagonist, description: '' } };
    expect(() => applyCastAndSetsDirectionEdits(bare, { protagonist: { construction: '' } })).toThrow(/protagonist/);
  });
});
