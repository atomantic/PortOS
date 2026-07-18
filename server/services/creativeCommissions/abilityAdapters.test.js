import { describe, it, expect } from 'vitest';
import {
  ABILITY_ADAPTERS, getAbilityAdapter, buildCommissionDirective,
} from './abilityAdapters.js';
import { CREATIVE_COMMISSION_ABILITIES, ABILITY_GENERATION_SPEC } from '../../lib/creativeCommissionValidation.js';

describe('ability adapter registry', () => {
  it('has an adapter for every supported ability (and no extras)', () => {
    expect(Object.keys(ABILITY_ADAPTERS).sort()).toEqual([...CREATIVE_COMMISSION_ABILITIES].sort());
  });

  it('returns null for an unknown ability', () => {
    expect(getAbilityAdapter('hologram')).toBeNull();
    expect(getAbilityAdapter(undefined)).toBeNull();
  });
});

describe('buildCommissionDirective — video (unchanged brief/feedback fold)', () => {
  it('composes goal + deliverables + constraints from the brief', () => {
    const directive = buildCommissionDirective({
      name: 'Nightly Surreal',
      targetAbility: 'video',
      brief: {
        intent: 'something surreal, dreamlike, unsettlingly beautiful',
        genre: 'surrealism',
        styleSpec: 'flat color, Magritte',
        constraints: { universeId: 'u-123' },
      },
      feedbackWindow: 5,
    });
    expect(directive.goal).toContain('Create a short-form video piece.');
    expect(directive.goal).toContain('something surreal');
    expect(directive.goal).toContain('Genre: surrealism.');
    expect(directive.goal).toContain('Style: flat color, Magritte.');
    expect(directive.deliverables).toEqual(['One rendered video matching the brief']);
    expect(directive.constraints).toEqual({ universeId: 'u-123' });
  });

  it('folds recent feedback into the goal', () => {
    const directive = buildCommissionDirective({
      targetAbility: 'video',
      brief: { intent: 'surreal' },
      feedback: [{ rating: 'down', note: 'less horror' }, { rating: 'up', note: 'more Magritte' }],
      feedbackWindow: 5,
    });
    expect(directive.goal).toContain('Recent likes: more Magritte.');
    expect(directive.goal).toContain('Recent dislikes: less horror.');
  });

  it('omits absent constraints', () => {
    expect(buildCommissionDirective({ targetAbility: 'video', brief: { intent: 'x' } }).constraints).toEqual({});
  });

  it('clamps the goal under the CD 5000-char cap with a large feedback window + long notes', () => {
    const feedback = Array.from({ length: 50 }, (_, i) => ({ rating: i % 2 === 0 ? 'up' : 'down', note: 'z'.repeat(1000) }));
    const directive = buildCommissionDirective({ targetAbility: 'video', brief: { intent: 'surreal' }, feedback, feedbackWindow: 50 });
    expect(directive.goal.length).toBeLessThanOrEqual(4500);
  });

  it('keeps the feedback digest even when the brief text is very long', () => {
    const directive = buildCommissionDirective({
      targetAbility: 'video',
      brief: { intent: 'x'.repeat(2000), styleSpec: 'y'.repeat(3000) },
      feedback: [{ rating: 'down', note: 'less horror' }],
      feedbackWindow: 5,
    });
    expect(directive.goal.length).toBeLessThanOrEqual(4500);
    expect(directive.goal).toContain('Recent dislikes: less horror.');
  });

  it('falls back to the video adapter for an unknown ability', () => {
    const directive = buildCommissionDirective({ targetAbility: 'hologram', brief: { intent: 'x' } });
    expect(directive.goal).toContain('Create a short-form video piece.');
  });
});

describe('per-ability directives steer the planner to the right tools', () => {
  it('image: names still-image tools and counts the stills', () => {
    const d = buildCommissionDirective({ targetAbility: 'image', brief: { intent: 'a lighthouse' }, generation: { imageCount: 3 } });
    expect(d.goal).toContain('Produce 3 still images');
    expect(d.goal).toMatch(/do NOT plan a video/i);
    expect(d.deliverables).toEqual(['3 still images matching the brief']);
  });

  it('image: singular phrasing for a single still', () => {
    const d = buildCommissionDirective({ targetAbility: 'image', brief: { intent: 'x' }, generation: { imageCount: 1 } });
    expect(d.goal).toContain('a single still image');
    expect(d.deliverables).toEqual(['One still image matching the brief']);
  });

  it('music: names the music tools and the target length', () => {
    const d = buildCommissionDirective({ targetAbility: 'music', brief: { intent: 'ambient drone' }, generation: { lengthSeconds: 45 } });
    expect(d.goal).toContain('~45s music');
    expect(d.goal).toMatch(/music generation tools/i);
    expect(d.deliverables).toEqual(['One ~45s music track matching the brief']);
  });

  it('music-video: asks for both a music bed and a video scored to it', () => {
    const d = buildCommissionDirective({ targetAbility: 'music-video', brief: { intent: 'neon drift' } });
    expect(d.goal).toMatch(/music bed AND a matching video/i);
    expect(d.deliverables).toHaveLength(2);
  });

  it('series: scopes to the provided universe when constrained', () => {
    const withU = buildCommissionDirective({ targetAbility: 'series', brief: { intent: 'noir', constraints: { universeId: 'u-9' } }, generation: { episodeCount: 2 } });
    expect(withU.goal).toContain('Create the series within the provided universe');
    expect(withU.goal).toContain('first 2 issues/episodes');
    expect(withU.constraints).toEqual({ universeId: 'u-9' });

    const noU = buildCommissionDirective({ targetAbility: 'series', brief: { intent: 'noir' }, generation: { episodeCount: 1 } });
    expect(noU.goal).toContain('Invent a fitting universe');
  });
});

describe('sanitizeGeneration — fills defaults and preserves only the type keys', () => {
  it('video keeps its keys and drops off-type ones', () => {
    const g = getAbilityAdapter('video').sanitizeGeneration({ quality: 'high', aspectRatio: '9:16', targetDurationSeconds: 20, imageCount: 5, model: ' ltx ' });
    expect(g).toEqual({ model: 'ltx', quality: 'high', aspectRatio: '9:16', targetDurationSeconds: 20 });
  });

  it('image fills defaults for missing keys and clamps an out-of-range count', () => {
    expect(getAbilityAdapter('image').sanitizeGeneration({})).toEqual({ model: null, quality: 'standard', aspectRatio: '16:9', imageCount: 1 });
    expect(getAbilityAdapter('image').sanitizeGeneration({ imageCount: 99 }).imageCount).toBe(1);
    expect(getAbilityAdapter('image').sanitizeGeneration({ imageCount: 4 }).imageCount).toBe(4);
  });

  it('music keeps only model + lengthSeconds', () => {
    expect(getAbilityAdapter('music').sanitizeGeneration({ lengthSeconds: 60, aspectRatio: '16:9' })).toEqual({ model: null, lengthSeconds: 60 });
  });

  it('series keeps only model + episodeCount', () => {
    expect(getAbilityAdapter('series').sanitizeGeneration({ episodeCount: 3, quality: 'high' })).toEqual({ model: null, episodeCount: 3 });
  });

  it('every adapter default matches ABILITY_GENERATION_SPEC', () => {
    for (const [ability, spec] of Object.entries(ABILITY_GENERATION_SPEC)) {
      const sani = getAbilityAdapter(ability).sanitizeGeneration({});
      for (const [k, v] of Object.entries(spec.defaults)) expect(sani[k]).toBe(v);
    }
  });
});

describe('buildProjectParams — every type yields well-formed render settings', () => {
  const ctx = { defaultVideoModelId: () => 'ltx-default' };

  it('video maps its generation onto the render geometry', () => {
    const p = getAbilityAdapter('video').buildProjectParams({ generation: { aspectRatio: '1:1', quality: 'draft', targetDurationSeconds: 15 } }, ctx);
    expect(p).toEqual({ aspectRatio: '1:1', quality: 'draft', modelId: 'ltx-default', targetDurationSeconds: 15 });
  });

  it('non-video types still carry harmless geometry defaults', () => {
    for (const ability of ['image', 'music', 'series']) {
      const p = getAbilityAdapter(ability).buildProjectParams({ generation: {} }, ctx);
      expect(p.aspectRatio).toBe('16:9');
      expect(p.quality).toBe('standard');
      expect(p.modelId).toBe('ltx-default');
      expect(typeof p.targetDurationSeconds).toBe('number');
    }
  });
});
