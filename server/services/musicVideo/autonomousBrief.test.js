import { describe, it, expect } from 'vitest';
import { __testing } from './autonomousBrief.js';
import { SUNO_LIMITS } from '../../lib/musicVideoAutonomous.js';

const { sanitizeBrief, buildBriefPrompt } = __testing;

describe('sanitizeBrief', () => {
  it('bounds a verbose model answer to what the later stages accept', () => {
    const brief = sanitizeBrief({
      title: 'T'.repeat(500), sunoStyle: 's'.repeat(5000), musicalDescription: 'd',
      concept: { prompt: 'story', style: 'noir' },
      moodBoard: { name: 'Board', description: 'desc', notes: ['a', '', 42, ...Array(20).fill('n')], stylePrompt: 'look', negativePrompt: 'avoid' },
    }, { prompt: 'a courier in the rain' });
    expect(brief.title.length).toBe(SUNO_LIMITS.title);
    expect(brief.sunoStyle.length).toBe(SUNO_LIMITS.style);
    expect(brief.moodBoard.notes).toHaveLength(10);
    expect(brief.moodBoard.notes.every((n) => typeof n === 'string' && n)).toBe(true);
  });

  it('falls back to the operator’s prompt for every missing or wrong-typed field, so a thin answer degrades rather than fails', () => {
    const brief = sanitizeBrief({ title: 7, concept: 'nope', moodBoard: null }, { prompt: 'a courier in the rain' });
    expect(brief).toMatchObject({
      title: 'a courier in the rain', musicalDescription: 'a courier in the rain', sunoStyle: 'a courier in the rain',
      concept: { prompt: 'a courier in the rain', style: '' },
      moodBoard: { name: 'a courier in the rain', notes: [], stylePrompt: '' },
    });
    expect(sanitizeBrief(null, { prompt: 'p' }).title).toBe('p');
  });
});

describe('buildBriefPrompt', () => {
  it('carries the prompt and guidance, and says so when the song is instrumental', () => {
    const prompt = buildBriefPrompt({ prompt: 'rain city', guidance: 'no neon', instrumental: true });
    expect(prompt).toContain('rain city');
    expect(prompt).toContain('no neon');
    expect(prompt).toContain('INSTRUMENTAL');
    expect(buildBriefPrompt({ prompt: 'x', guidance: '', instrumental: false })).not.toContain('INSTRUMENTAL');
  });
});
