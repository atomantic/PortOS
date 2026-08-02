import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildStageGroups,
  stageGroupLabel,
  stageGroupLabelFor,
  stageGroupKeyFor,
  stageHaystack,
  OTHER_GROUP_LABEL,
} from './promptStageGroups.js';

const stage = (name, description = '') => ({ name, description });

describe('stageGroupLabel', () => {
  it('takes the prefix before an em-dash', () => {
    expect(stageGroupLabel('Creative Director — Treatment')).toBe('Creative Director');
    expect(stageGroupLabel('Pipeline — Reader Panel: The Editor')).toBe('Pipeline');
  });

  it('splits on the FIRST dash so a dashed suffix stays in the name', () => {
    expect(stageGroupLabel('Pipeline — Reverse Outline — v2')).toBe('Pipeline');
  });

  it('accepts an en-dash or a plain hyphen separator too', () => {
    expect(stageGroupLabel('Importer – Analyze')).toBe('Importer');
    // What a user actually types in the Create Stage modal.
    expect(stageGroupLabel('Writers Room - My Pass')).toBe('Writers Room');
  });

  it('requires the separator to be spaced, so in-word hyphens do not split', () => {
    expect(stageGroupLabel('Twin Spoken-vs-Written Comparison')).toBe('Twin');
    expect(stageGroupLabel('Multi-Turn Consistency Scorer')).toBe(OTHER_GROUP_LABEL);
  });

  it('falls back to a known leading word for pre-dash names', () => {
    expect(stageGroupLabel('CoS Agent Briefing')).toBe('CoS');
    expect(stageGroupLabel('Brain Daily Digest')).toBe('Brain');
    expect(stageGroupLabel('App Detection')).toBe('App Detection');
  });

  it('prefers the longest matching word prefix', () => {
    expect(stageGroupLabel('Model Personality Self-Profile')).toBe('Model Personality');
  });

  it('matches a word prefix on a hyphenated stage key', () => {
    expect(stageGroupLabel('cos-evaluate')).toBe('CoS');
    expect(stageGroupLabel('brain-classifier')).toBe('Brain');
  });

  it('does not match a word prefix mid-name', () => {
    expect(stageGroupLabel('Values-Alignment Scorer')).toBe(OTHER_GROUP_LABEL);
  });

  it('degrades to Other for empty / unknown names', () => {
    expect(stageGroupLabel('')).toBe(OTHER_GROUP_LABEL);
    expect(stageGroupLabel(null)).toBe(OTHER_GROUP_LABEL);
    expect(stageGroupLabel('Wholly Novel Thing')).toBe(OTHER_GROUP_LABEL);
  });
});

describe('stageHaystack', () => {
  it('covers title, description and key, lowercased', () => {
    const h = stageHaystack('brain-daily-digest', stage('Brain Daily Digest', 'Summarize the day'));
    expect(h).toContain('brain daily digest');
    expect(h).toContain('summarize the day');
    expect(h).toContain('brain-daily-digest');
  });

  it('tolerates a missing config', () => {
    expect(stageHaystack('lonely-key', undefined)).toContain('lonely-key');
  });
});

describe('buildStageGroups', () => {
  const stages = {
    'pipeline-prose-draft': stage('Pipeline — Prose Draft', 'Draft the prose'),
    'pipeline-comic-script': stage('Pipeline — Comic Book Script', 'Panels and balloons'),
    'creative-director-treatment': stage('Creative Director — Treatment', 'Treatment doc'),
    'cos-evaluate': stage('CoS Task Evaluation', 'Grade a task'),
    'brain-classifier': stage('Brain Classifier', 'Classify a thought'),
    'values-alignment-scorer': stage('Values-Alignment Scorer', 'Score alignment'),
  };

  it('returns every stage grouped when unfiltered', () => {
    const { groups, matchCount, totalCount } = buildStageGroups(stages);
    expect(totalCount).toBe(6);
    expect(matchCount).toBe(6);
    expect(groups.map(g => g.label)).toEqual([
      'Brain', 'CoS', 'Creative Director', 'Pipeline', OTHER_GROUP_LABEL,
    ]);
  });

  it('pins Other last regardless of alphabetical position', () => {
    const { groups } = buildStageGroups(stages);
    expect(groups[groups.length - 1].label).toBe(OTHER_GROUP_LABEL);
  });

  it('sorts stages by display name within a group', () => {
    const { groups } = buildStageGroups(stages);
    const pipeline = groups.find(g => g.label === 'Pipeline');
    expect(pipeline.stages.map(([, c]) => c.name)).toEqual([
      'Pipeline — Comic Book Script',
      'Pipeline — Prose Draft',
    ]);
  });

  it('filters on the title', () => {
    const { groups, matchCount } = buildStageGroups(stages, { query: 'comic' });
    expect(matchCount).toBe(1);
    expect(groups).toHaveLength(1);
    expect(groups[0].stages[0][0]).toBe('pipeline-comic-script');
  });

  it('filters on the description', () => {
    const { matchCount, groups } = buildStageGroups(stages, { query: 'balloons' });
    expect(matchCount).toBe(1);
    expect(groups[0].stages[0][0]).toBe('pipeline-comic-script');
  });

  it('filters on the stage key', () => {
    const { matchCount } = buildStageGroups(stages, { query: 'values-alignment' });
    expect(matchCount).toBe(1);
  });

  it('is case-insensitive and AND-joins terms', () => {
    expect(buildStageGroups(stages, { query: 'PIPELINE PROSE' }).matchCount).toBe(1);
    expect(buildStageGroups(stages, { query: 'pipeline treatment' }).matchCount).toBe(0);
  });

  it('treats a whitespace-only query as no filter', () => {
    expect(buildStageGroups(stages, { query: '   ' }).matchCount).toBe(6);
  });

  // The list the server ships as `systemStages` on GET /api/prompts.
  const systemStageKeys = ['cos-evaluate', 'brain-classifier'];

  it('narrows to system stages when systemOnly is set', () => {
    const { groups, matchCount, totalCount } = buildStageGroups(stages, { systemOnly: true, systemStageKeys });
    expect(totalCount).toBe(6);
    expect(matchCount).toBe(2);
    expect(groups.flatMap(g => g.stages.map(([k]) => k)).sort()).toEqual(['brain-classifier', 'cos-evaluate']);
  });

  it('composes systemOnly with a query', () => {
    const { matchCount } = buildStageGroups(stages, { query: 'classify', systemOnly: true, systemStageKeys });
    expect(matchCount).toBe(1);
    expect(buildStageGroups(stages, { query: 'prose', systemOnly: true, systemStageKeys }).matchCount).toBe(0);
  });

  // A server that predates the `systemStages` key (or a failed load) leaves the
  // list empty — System-only must then read as "nothing known", never throw.
  it('matches nothing under systemOnly when no keys were served', () => {
    expect(buildStageGroups(stages, { systemOnly: true }).matchCount).toBe(0);
    expect(buildStageGroups(stages, { systemOnly: true, systemStageKeys: [] }).groups).toEqual([]);
  });

  it('ignores systemStageKeys when systemOnly is off', () => {
    expect(buildStageGroups(stages, { systemStageKeys }).matchCount).toBe(6);
  });

  it('returns no groups but a real total when nothing matches', () => {
    const { groups, matchCount, totalCount } = buildStageGroups(stages, { query: 'zzzz' });
    expect(groups).toEqual([]);
    expect(matchCount).toBe(0);
    expect(totalCount).toBe(6);
  });

  it('handles an empty / missing stage map', () => {
    expect(buildStageGroups({})).toEqual({ groups: [], matchCount: 0, totalCount: 0 });
    expect(buildStageGroups(null).totalCount).toBe(0);
    expect(buildStageGroups(undefined).groups).toEqual([]);
  });

  it('groups a name-less stage by its key', () => {
    const { groups } = buildStageGroups({ 'cos-report-summary': {} });
    expect(groups[0].label).toBe('CoS');
  });

  it('merges case-variant family names into one group, keeping the first spelling', () => {
    const { groups } = buildStageGroups({
      'a': stage('Pipeline — Alpha'),
      'b': stage('pipeline — beta'),
      'c': stage('PIPELINE — gamma'),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('pipeline');
    expect(groups[0].label).toBe('Pipeline');
    expect(groups[0].stages).toHaveLength(3);
  });
});

describe('stageGroupLabelFor / stageGroupKeyFor', () => {
  it('prefers the display name and falls back to the key', () => {
    expect(stageGroupLabelFor('x', stage('Importer — Analyze'))).toBe('Importer');
    expect(stageGroupLabelFor('brain-classifier', {})).toBe('Brain');
    expect(stageGroupLabelFor('brain-classifier', undefined)).toBe('Brain');
  });

  it('agrees with the key buildStageGroups buckets under', () => {
    const stages = { 'brain-classifier': {}, 'creative-director-treatment': stage('Creative Director — Treatment') };
    const { groups } = buildStageGroups(stages);
    for (const { key: groupKey, stages: rows } of groups) {
      for (const [key, config] of rows) expect(stageGroupKeyFor(key, config)).toBe(groupKey);
    }
  });

  it('case-folds the key so differently-spelled families share one group', () => {
    expect(stageGroupKeyFor('a', stage('Pipeline — X'))).toBe(stageGroupKeyFor('b', stage('pipeline — y')));
  });
});

// Drift guard: the word-prefix fallback is a curated list, so a NEW stage family
// that skips the `Family — Specific` convention would silently land in `Other`
// with nothing to notice it. Pin the shipped catalog's Other bucket so adding
// such a stage fails here instead of quietly becoming unfiled in the UI.
describe('shipped stage catalog', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const seeded = JSON.parse(
    readFileSync(resolve(repoRoot, 'data.reference', 'prompts', 'stage-config.json'), 'utf8'),
  ).stages;

  it('files every shipped stage except the three known un-prefixed scorers', () => {
    const { groups, totalCount } = buildStageGroups(seeded);
    expect(totalCount).toBeGreaterThan(100);
    const other = groups.find(g => g.label === OTHER_GROUP_LABEL);
    expect(other?.stages.map(([key]) => key) ?? []).toEqual([
      'adversarial-boundary-scorer',
      'multi-turn-consistency-scorer',
      'values-alignment-scorer',
    ]);
  });

  it('keeps every shipped group non-empty and Other last', () => {
    const { groups } = buildStageGroups(seeded);
    expect(groups.every(g => g.stages.length > 0)).toBe(true);
    expect(groups[groups.length - 1].label).toBe(OTHER_GROUP_LABEL);
  });
});
