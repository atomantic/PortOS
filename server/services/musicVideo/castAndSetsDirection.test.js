/**
 * Cast & Sets creative direction — the parse/merge boundary a provider answer
 * crosses: fenced and echoed answers, lenient per-field parsing, the
 * absent-vs-empty merge rule on a revision, and the refusal of a first pass
 * that lacks the required parts.
 */

import { describe, it, expect } from 'vitest';
import {
  buildCastAndSetsPrompt,
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
