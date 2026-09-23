import { describe, expect, it } from 'vitest';
import {
  buildCodeAnimationBriefPrompt,
  extractBriefIdea,
  projectCanonForBrief,
} from './brief.js';
import { CODE_ANIMATION_LIMITS } from './prompt.js';

const FORMAT = { durationSeconds: 20, aspectRatio: '16:9' };

const UNIVERSE = {
  name: 'Example Universe',
  logline: 'A drowned city keeps its lamps lit',
  premise: 'Lamplighters trade memory for oil',
  embrace: ['ink wash', 'muted indigo'],
  avoid: ['photorealism'],
  styleNotes: 'quiet, melancholic, slow camera',
  styleReferences: [{ title: 'Night markets', prompt: 'paper lanterns over water' }],
  characters: [{ name: 'Mira', role: 'lamplighter', physicalDescription: 'tall, oil-stained coat' }],
  places: [{ name: 'The Lower Market', description: 'flooded arcade of stalls' }],
  objects: [{ name: 'The Brass Wick', significance: 'the last lamp that never gutters' }],
};

describe('projectCanonForBrief', () => {
  it('keeps the named entities and the fields a film can stage, and caps the list', () => {
    const rows = projectCanonForBrief([
      { name: 'Mira', role: 'lamplighter', motivations: ['keep the lamps lit', 'find her brother'], sliders: { warmth: 3 }, id: 'chr-1' },
      { name: '  ', role: 'nobody' },
      { name: 'Corin' },
      { name: 'Vale' },
    ], 'characters', 2);
    expect(rows).toEqual([
      { name: 'Mira', role: 'lamplighter', motivations: 'keep the lamps lit, find her brother' },
      { name: 'Corin' },
    ]);
  });

  it('is empty for a universe with no canon of that kind', () => {
    expect(projectCanonForBrief(undefined, 'places', 6)).toEqual([]);
  });
});

describe('buildCodeAnimationBriefPrompt', () => {
  it('grounds the brief in the universe bible, its cast, and the artist\'s spark', () => {
    const prompt = buildCodeAnimationBriefPrompt({
      universe: UNIVERSE,
      moodBoard: { name: 'Dusk', description: 'amber evenings', items: [{ caption: 'harbor glow' }] },
      seedIdea: 'a chase that ends in silence',
      format: FORMAT,
      current: { title: 'The Brass Wick', concept: '', onScreenText: '', styleNotes: '' },
    });
    expect(prompt).toContain('20-second 16:9 animated film');
    expect(prompt).toContain('a chase that ends in silence');
    expect(prompt).toContain('The film is set in the universe "Example Universe"');
    expect(prompt).toContain('Logline: A drowned city keeps its lamps lit');
    expect(prompt).toContain('- Mira — role: lamplighter; physicalDescription: tall, oil-stained coat');
    expect(prompt).toContain('- The Lower Market — description: flooded arcade of stalls');
    expect(prompt).toContain('- The Brass Wick — significance: the last lamp that never gutters');
    expect(prompt).toContain('Mood board: "Dusk"');
    expect(prompt).toContain('Title: The Brass Wick');
    expect(prompt).toContain('"title": "..."');
  });

  it('tells the model to invent a cast when the universe has no canon yet', () => {
    const prompt = buildCodeAnimationBriefPrompt({
      universe: { name: 'Bare World', embrace: [], avoid: [] },
      format: FORMAT,
    });
    expect(prompt).toContain('no canon characters, places, or objects recorded yet');
    expect(prompt).not.toContain('CHARACTERS (');
  });

  it('falls back to a blank-slate instruction with nothing to go on', () => {
    const prompt = buildCodeAnimationBriefPrompt({ format: FORMAT });
    expect(prompt).toContain('invent a striking, self-contained concept');
  });
});

describe('extractBriefIdea', () => {
  const response = (body) => `Here you go:\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\``;

  it('parses a fenced brief and keeps an intentionally empty field empty', () => {
    expect(extractBriefIdea(response({
      title: 'The Brass Wick',
      concept: 'Mira climbs the flooded arcade…',
      onScreenText: '',
      styleNotes: 'colder blues at the climax',
    }))).toEqual({
      title: 'The Brass Wick',
      concept: 'Mira climbs the flooded arcade…',
      onScreenText: '',
      styleNotes: 'colder blues at the climax',
    });
  });

  it('clamps every field to the limit the brief form enforces', () => {
    const parsed = extractBriefIdea(response({
      title: 'T'.repeat(500),
      concept: 'C'.repeat(CODE_ANIMATION_LIMITS.conceptMax + 100),
      onScreenText: 'O'.repeat(CODE_ANIMATION_LIMITS.textMax + 100),
      styleNotes: 'S'.repeat(CODE_ANIMATION_LIMITS.styleNotesMax + 100),
    }));
    expect(parsed.title.length).toBe(200);
    expect(parsed.concept.length).toBe(CODE_ANIMATION_LIMITS.conceptMax);
    expect(parsed.onScreenText.length).toBe(CODE_ANIMATION_LIMITS.textMax);
    expect(parsed.styleNotes.length).toBe(CODE_ANIMATION_LIMITS.styleNotesMax);
  });

  it('rejects a response with no usable concept', () => {
    expect(() => extractBriefIdea('I could not write that.')).toThrow(/did not return a usable brief/);
    expect(() => extractBriefIdea(response({ concept: '   ' }))).toThrow(/did not return a usable brief/);
  });
});
