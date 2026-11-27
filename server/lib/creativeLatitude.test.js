import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CREATIVE_LATITUDE_CLAUSE,
  CREATIVE_LATITUDE_HEADING,
  classifyStage,
  hasCreativeLatitude,
  CREATIVE_LATITUDE_TOKENS,
  isCreativeRunSource,
  isCreativeStage,
  withCreativeLatitude,
} from './creativeLatitude.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

describe('the clause itself', () => {
  it('tells the model the operator owns the rights question', () => {
    expect(CREATIVE_LATITUDE_CLAUSE).toContain(CREATIVE_LATITUDE_HEADING);
    expect(CREATIVE_LATITUDE_CLAUSE).toMatch(/solely responsible/i);
    expect(CREATIVE_LATITUDE_CLAUSE).toMatch(/do not refuse/i);
    expect(CREATIVE_LATITUDE_CLAUSE).toMatch(/full fidelity/i);
  });

  it('scopes itself to IP so it does not read as a blanket safety waiver', () => {
    expect(CREATIVE_LATITUDE_CLAUSE).toMatch(/unrelated safety limit(s)? (is|are) unchanged/i);
  });

  it('stays short enough to ride on every creative prompt', () => {
    expect(CREATIVE_LATITUDE_CLAUSE.split(/\s+/).length).toBeLessThan(120);
  });
});

describe('withCreativeLatitude', () => {
  it('prepends the clause so a trailing output contract keeps the last word', () => {
    const out = withCreativeLatitude('Return ONLY valid JSON.');
    expect(out.startsWith(CREATIVE_LATITUDE_HEADING)).toBe(true);
    expect(out.endsWith('Return ONLY valid JSON.')).toBe(true);
  });

  it('is idempotent — a prompt can pass both wiring points', () => {
    const once = withCreativeLatitude('Write a scene.');
    expect(withCreativeLatitude(once)).toBe(once);
    expect(once.split(CREATIVE_LATITUDE_HEADING)).toHaveLength(2);
  });

  it('leaves empty / non-string prompts alone', () => {
    expect(withCreativeLatitude('')).toBe('');
    expect(withCreativeLatitude('   ')).toBe('   ');
    expect(withCreativeLatitude(null)).toBe(null);
    expect(withCreativeLatitude(undefined)).toBe(undefined);
  });

  it('hasCreativeLatitude detects a stamped prompt', () => {
    expect(hasCreativeLatitude(withCreativeLatitude('x'))).toBe(true);
    expect(hasCreativeLatitude('x')).toBe(false);
    expect(hasCreativeLatitude(null)).toBe(false);
  });
});

describe('stage classification', () => {
  it('marks story, art, and canon stages creative', () => {
    for (const stage of [
      'pipeline-prose',
      'pipeline-storyboard-image-prompt',
      'writers-room-script',
      'universe-character-expand',
      'story-builder-idea-expand',
      'fableloom-play-turn',
      'cd-treatment',
      'importer-canon-extract',
      'catalog-ideas-scenes-concepts',
      'manuscript-reformat',
    ]) {
      expect(isCreativeStage(stage), stage).toBe(true);
    }
  });

  it('leaves infrastructure and self-analysis stages unstamped', () => {
    for (const stage of [
      'brain-classifier',
      'cos-task-enhance',
      'memory-evaluate',
      'model-personality-profile',
      'soul-writing-analyzer',
      'twin-trait-extractor',
      'values-alignment-scorer',
      'adversarial-boundary-scorer',
      'multi-turn-consistency-scorer',
    ]) {
      expect(isCreativeStage(stage), stage).toBe(false);
    }
  });

  it('rejects junk input rather than guessing', () => {
    expect(classifyStage('')).toBe('unknown');
    expect(classifyStage(null)).toBe('unknown');
    expect(classifyStage('brand-new-stage')).toBe('unknown');
  });

  // The guard: a stage nobody classified would silently ship without the
  // clause (or carry it when it shouldn't). Every shipped stage must land in
  // one of the two lists, so adding a stage forces the decision.
  it('classifies every stage shipped in data.reference', () => {
    const config = JSON.parse(
      readFileSync(join(REPO_ROOT, 'data.reference', 'prompts', 'stage-config.json'), 'utf-8'),
    );
    const stages = Object.keys(config.stages || {});
    expect(stages.length).toBeGreaterThan(0);
    const unclassified = stages.filter((name) => classifyStage(name) === 'unknown');
    expect(unclassified, `unclassified stages — add them to CREATIVE_* or OPERATIONAL_STAGE_PREFIXES in creativeLatitude.js: ${unclassified.join(', ')}`).toEqual([]);
  });
});

describe('token budgeting', () => {
  it('publishes the clause + separator cost so planners can reserve it', () => {
    // The editorial inline check adds this to its chunk budget because the
    // stamp lands after it measures — a zero/NaN here would silently under-budget.
    expect(CREATIVE_LATITUDE_TOKENS).toBeGreaterThan(0);
    expect(Number.isFinite(CREATIVE_LATITUDE_TOKENS)).toBe(true);
  });
});

describe('run-source classification', () => {
  it('marks the hand-rolled creative services creative', () => {
    for (const source of [
      'mood-board-style-synthesis',
      'universe-style-reference',
      'universe-vision-describe',
      'universe-vision-expand',
      'universe-builder-expansion',
      'universe-builder-generate-variations',
      'media-prompt-refine',
      'media-prompt-from-media',
      'music-describe',
      'music-lyrics',
      'music-video-plan',
      'song-generate',
      'song-derive-parts',
      'chiptune-score',
      'game-asset-feedback',
      'threejs-model-generation',
      'cd-scene-evaluate',
      // The inline editorial checks — no stage template renders them, so the
      // source tag is the only thing that can carry the clause to them.
      'pipeline-editorial-custom',
      'pipeline-editorial-setup-digest',
    ]) {
      expect(isCreativeRunSource(source), source).toBe(true);
    }
  });

  it('leaves operational run sources alone', () => {
    for (const source of [
      'brain-classify',
      'activity-digest',
      'pm2-standardizer',
      'task-enhance',
      'record-merge',
      'goal-scorecard',
      'system-resources',
      '',
      null,
    ]) {
      expect(isCreativeRunSource(source), String(source)).toBe(false);
    }
  });
});
