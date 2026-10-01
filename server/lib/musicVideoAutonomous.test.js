import { describe, it, expect } from 'vitest';
import {
  AUTONOMOUS_DEFAULT_TOOLS,
  SUNO_LIMITS,
  autonomousMedium,
  autonomousPool,
  ideaToPrompt,
  normalizeAutonomousBrief,
  normalizeAutopilotParams,
  pickBrainIdea,
  sunoAudioUrl,
  sunoSongFields,
  sunoSongIdsFromHrefs,
} from './musicVideoAutonomous.js';
import { sanitizeTaskMetadata } from './cosValidation.js';
import { musicVideoAutonomousStartSchema } from './musicVideoValidation.js';

describe('normalizeAutonomousBrief', () => {
  it('defaults to the free local tools, no checkpoints, no budget — nothing metered unless opted in', () => {
    const brief = normalizeAutonomousBrief({ prompt: '  a song about rain  ' });
    expect(brief).toMatchObject({
      prompt: 'a song about rain', tools: AUTONOMOUS_DEFAULT_TOOLS, checkpoints: [], budgetUsd: null,
      llm: null, authoring: null, origin: { kind: 'manual', ideaId: null },
    });
    expect(brief.limits).toEqual({ maxGenerations: 40, maxReviewAttempts: 3 });
  });

  it('drops unknown tools/checkpoints, models for unpicked tools, and out-of-range limits', () => {
    const brief = normalizeAutonomousBrief({
      prompt: 'p', tools: ['image:local', 'bogus', 'code:render'], checkpoints: ['song', 'nope', 'cast'],
      models: { 'image:local': 'flux2-dev', 'video:local': 'unpicked', 'image:nope': 'x' },
      limits: { maxGenerations: 9999, maxReviewAttempts: 2 }, budgetUsd: -5, providerId: ' prov ', model: ' m ',
    });
    expect(brief.tools).toEqual(['image:local', 'code:render']);
    expect(brief.checkpoints).toEqual(['song', 'cast']);
    expect(brief.models).toEqual({ 'image:local': 'flux2-dev' });
    expect(brief.limits).toEqual({ maxGenerations: 40, maxReviewAttempts: 2 });
    expect(brief.budgetUsd).toBeNull();
    expect(brief.llm).toEqual({ providerId: 'prov', model: 'm' });
  });

  it('agrees with the start schema: whatever the schema accepts normalizes to a brief the run can use', () => {
    const body = musicVideoAutonomousStartSchema.parse({
      prompt: 'p', tools: ['video:local'], checkpoints: ['lyrics'], models: { 'video:local': 'ltx' }, budgetUsd: 5,
      authoring: { providerId: 'a', model: 'b' }, origin: { kind: 'schedule', ideaId: 'idea-1' },
    });
    expect(normalizeAutonomousBrief(body)).toMatchObject({ budgetUsd: 5, authoring: { providerId: 'a', model: 'b' }, origin: { kind: 'schedule', ideaId: 'idea-1' } });
    expect(() => musicVideoAutonomousStartSchema.parse({ prompt: 'p', tools: ['nope'] })).toThrow();
    expect(() => musicVideoAutonomousStartSchema.parse({ prompt: '' })).toThrow();
  });
});

describe('tool picks → how the video is made', () => {
  it('any image/video tool means footage production; code alone means a code-rendered video', () => {
    expect(autonomousMedium(['code:render'])).toBe('code');
    expect(autonomousMedium(['code:render', 'image:local'])).toBe('footage');
    expect(autonomousMedium([])).toBe('code');
  });

  it('builds the production route pool from the picks, pinning models where given', () => {
    expect(autonomousPool(['image:local', 'video:grok', 'code:render'], { 'image:local': 'flux2-dev' }))
      .toEqual([{ kind: 'image', mode: 'local', model: 'flux2-dev' }, { kind: 'video', mode: 'grok' }]);
  });
});

describe('Suno field shaping', () => {
  it('bounds every field to what the form accepts and sends no lyrics for an instrumental', () => {
    const long = 'x'.repeat(9000);
    const fields = sunoSongFields({ title: long, style: long, lyrics: long });
    expect(fields.title.length).toBe(SUNO_LIMITS.title);
    expect(fields.style.length).toBe(SUNO_LIMITS.style);
    expect(fields.lyrics.length).toBe(SUNO_LIMITS.lyrics);
    expect(sunoSongFields({ title: 't', style: 's', lyrics: 'words', instrumental: true })).toEqual({ title: 't', style: 's', lyrics: '', instrumental: true });
    expect(sunoSongFields({}).title).toBe('Untitled');
  });

  it('reads song ids out of workspace links, ignoring everything else and repeats', () => {
    const a = '0a1b2c3d-1111-2222-3333-444455556666';
    const b = '9f8e7d6c-aaaa-bbbb-cccc-ddddeeeeffff';
    expect(sunoSongIdsFromHrefs([`/song/${a}`, '/create', `https://suno.com/song/${b.toUpperCase()}?x=1`, `/song/${a}`, null, '/song/not-a-uuid']))
      .toEqual([a, b]);
    expect(sunoAudioUrl(a)).toBe(`https://cdn1.suno.ai/${a}.mp3`);
  });
});

describe('Brain idea selection', () => {
  const ideas = [
    { id: 'c', title: 'C', status: 'active', createdAt: '2026-03-01T00:00:00.000Z', tags: ['song'] },
    { id: 'a', title: 'A', status: 'active', createdAt: '2026-01-01T00:00:00.000Z', tags: [] },
    { id: 'b', title: 'B', status: 'done', createdAt: '2025-12-01T00:00:00.000Z', tags: ['song'] },
  ];

  it('takes the oldest active idea no earlier run used', () => {
    expect(pickBrainIdea(ideas).id).toBe('a');
    expect(pickBrainIdea(ideas, { usedIdeaIds: ['a'] }).id).toBe('c');
    expect(pickBrainIdea(ideas, { usedIdeaIds: ['a', 'c'] })).toBeNull();
  });

  it('limits to tagged ideas case-insensitively when tags are set', () => {
    expect(pickBrainIdea(ideas, { tags: ['SONG'] }).id).toBe('c');
    expect(pickBrainIdea(ideas, { tags: ['missing'] })).toBeNull();
  });

  it('turns an idea into the run prompt', () => {
    expect(ideaToPrompt({ title: 'T', oneLiner: 'one', notes: 'more' })).toBe('T\n\none\n\nmore');
  });
});

describe('scheduled-task params', () => {
  it('survive task-metadata sanitization, re-normalized, and a non-object is dropped', () => {
    const saved = sanitizeTaskMetadata({ musicVideoAutopilot: { tools: ['image:local', 'junk'], ideaTags: ['Song', 'song', ' '], budgetUsd: 3 } });
    expect(saved.musicVideoAutopilot).toMatchObject({ tools: ['image:local'], ideaTags: ['Song', 'song'], budgetUsd: 3 });
    expect(saved.musicVideoAutopilot).toEqual(normalizeAutopilotParams(saved.musicVideoAutopilot));
    expect(sanitizeTaskMetadata({ musicVideoAutopilot: 'nope' })).toBeNull();
  });
});
