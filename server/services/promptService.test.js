import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The toolkit singleton is the only thing buildPrompt reaches out to. Stubbing
// it keeps this a pure test of the render pipeline (partial expansion →
// variable substitution → creative IP-latitude stamp).
const stages = new Map();
const templates = new Map();

vi.mock('../lib/aiToolkitState.js', () => ({
  setAIToolkitInstance: vi.fn(),
  requireToolkit: () => ({
    services: {
      prompts: {
        getStage: (name) => stages.get(name) || null,
        getStageTemplate: async (name) => templates.get(name) || null,
        getVariables: () => ({}),
      },
    },
  }),
}));

vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { data: fileURLToPath(new URL('../../data.reference/', import.meta.url)) },
}));

const { buildPrompt, previewPrompt } = await import('./promptService.js');
const { CREATIVE_LATITUDE_HEADING } = await import('../lib/creativeLatitude.js');

const defineStage = (name, template) => {
  stages.set(name, { name, variables: [] });
  templates.set(name, template);
};

beforeEach(() => {
  stages.clear();
  templates.clear();
});

describe('buildPrompt — creative IP-latitude clause', () => {
  it('stamps a creative stage so the model does not genericize named IP', async () => {
    defineStage('pipeline-prose', 'Write chapter {{n}}.');
    const out = await buildPrompt('pipeline-prose', { n: 3 });
    expect(out).toContain(CREATIVE_LATITUDE_HEADING);
    expect(out).toContain('Write chapter 3.');
    // Prepended: the stage's own output contract keeps the last word.
    expect(out.startsWith(CREATIVE_LATITUDE_HEADING)).toBe(true);
    expect(out.trimEnd().endsWith('Write chapter 3.')).toBe(true);
  });

  it('leaves an operational stage unstamped', async () => {
    defineStage('cos-task-enhance', 'Rewrite this task: {{task}}.');
    const out = await buildPrompt('cos-task-enhance', { task: 'ship it' });
    expect(out).toBe('Rewrite this task: ship it.');
  });

  it('throws on an unknown stage rather than rendering an unstamped prompt', async () => {
    await expect(buildPrompt('no-such-stage', {})).rejects.toThrow(/not found/);
  });
});

describe('shipped editorial prompt preview', () => {
  it('expands the shared lens, scene map, manuscript preamble and JSON findings contract', async () => {
    const stage = 'pipeline-editorial-arc-transitions';
    const template = await readFile(new URL(`../../data.reference/prompts/stages/${stage}.md`, import.meta.url), 'utf8');
    defineStage(stage, template);
    const manuscript = '# Issue 2 — Example (prose)\n\nThe lantern went out.';
    const preview = await previewPrompt(stage, {
      characterEvolution: 'Kiri — tragic-refusal',
      sceneMap: 'Issue 2 — Hall — Kiri',
      manuscript,
    });
    expect(preview).toContain('## Authored character evolution (five-stage lens)');
    expect(preview).toContain('Kiri — tragic-refusal');
    expect(preview).toContain('*control strategy failing*');
    expect(preview).toContain('## Scene segmentation');
    expect(preview).toContain('Issue 2 — Hall — Kiri');
    expect(preview).toContain('## Manuscript');
    expect(preview).toContain(manuscript);
    expect(preview).toContain('## Output contract');
    expect(preview).toContain('"findings": [');
    expect(preview).not.toContain('{{>');

    const noLens = await previewPrompt(stage, { manuscript });
    expect(noLens).not.toContain('## Authored character evolution');
    expect(noLens).not.toContain('## Scene segmentation');
  });
});
