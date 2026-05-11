import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./stageRunner.js', () => ({
  runStagedLLM: vi.fn(),
}));

import {
  extractScenes,
  sanitizeSceneList,
  SOURCE_KIND,
} from './sceneExtractor.js';
import { runStagedLLM } from './stageRunner.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sanitizeSceneList', () => {
  it('returns title/logline strings + scenes array from a fully-shaped envelope', () => {
    const out = sanitizeSceneList({
      title: '  The Pilot ',
      logline: 'A heist gone wrong.',
      scenes: [
        {
          id: 'scene-01',
          heading: 'Scene 1 — Entry',
          slugline: 'INT. VAULT — NIGHT',
          summary: 'They break in.',
          characters: ['ALICE', 'BOB'],
          action: 'A drill bites into the lock.',
          dialogue: [{ character: 'ALICE', line: 'Quiet.' }],
          visualPrompt: 'a high-tech vault interior, two figures in black tactical gear, dim red emergency light',
          sourceSegmentIds: ['seg-001'],
        },
      ],
    });
    expect(out.title).toBe('The Pilot');
    expect(out.logline).toBe('A heist gone wrong.');
    expect(out.scenes).toHaveLength(1);
    expect(out.scenes[0]).toMatchObject({
      id: 'scene-01',
      heading: 'Scene 1 — Entry',
      slugline: 'INT. VAULT — NIGHT',
      characters: ['ALICE', 'BOB'],
      dialogue: [{ character: 'ALICE', line: 'Quiet.' }],
    });
  });

  it('synthesizes id/heading when LLM omits them', () => {
    const out = sanitizeSceneList({
      scenes: [{ visualPrompt: 'a' }, { visualPrompt: 'b' }, { visualPrompt: 'c' }],
    });
    expect(out.scenes.map((s) => s.id)).toEqual(['scene-01', 'scene-02', 'scene-03']);
    expect(out.scenes.map((s) => s.heading)).toEqual(['Scene 1', 'Scene 2', 'Scene 3']);
  });

  it('coerces missing/non-array fields to safe defaults (no crash on partial LLM output)', () => {
    const out = sanitizeSceneList({
      scenes: [{ id: 's1', characters: 'NOT_AN_ARRAY', dialogue: null, sourceSegmentIds: undefined }],
    });
    expect(out.scenes[0].characters).toEqual([]);
    expect(out.scenes[0].dialogue).toEqual([]);
    expect(out.scenes[0].sourceSegmentIds).toEqual([]);
    expect(out.scenes[0].visualPrompt).toBe('');
    expect(out.scenes[0].slugline).toBeNull();
  });

  it('drops dialogue entries that lack both character and line, trims the rest', () => {
    const out = sanitizeSceneList({
      scenes: [{
        dialogue: [
          { character: ' ALICE ', line: ' Quiet. ' },
          {},                              // both missing → dropped
          { character: 'BOB' },            // line missing but char present → kept
          { line: '...' },                 // char missing but line present → kept
          'not an object',                 // wrong type → dropped
        ],
      }],
    });
    expect(out.scenes[0].dialogue).toEqual([
      { character: 'ALICE', line: 'Quiet.' },
      { character: 'BOB', line: '' },
      { character: '', line: '...' },
    ]);
  });

  it('caps scenes at maxScenes', () => {
    const huge = { scenes: Array.from({ length: 250 }, (_, i) => ({ id: `s${i}` })) };
    const out = sanitizeSceneList(huge, { maxScenes: 10 });
    expect(out.scenes).toHaveLength(10);
  });

  it('returns an empty list shape on garbage input rather than throwing', () => {
    expect(sanitizeSceneList(null)).toEqual({ title: null, logline: null, scenes: [] });
    expect(sanitizeSceneList('not-an-object')).toEqual({ title: null, logline: null, scenes: [] });
    expect(sanitizeSceneList({ scenes: 'oops' })).toEqual({ title: null, logline: null, scenes: [] });
  });

  it('drops non-string character names and trims survivors', () => {
    const out = sanitizeSceneList({ scenes: [{ characters: [' ALICE ', 42, null, 'BOB', ''] }] });
    expect(out.scenes[0].characters).toEqual(['ALICE', 'BOB']);
  });

  it('clamps unbounded LLM string fields to per-field limits (no runaway payloads)', () => {
    const huge = 'a'.repeat(10_000);
    const out = sanitizeSceneList({
      scenes: [{
        summary: huge, action: huge, visualPrompt: huge, slugline: huge, heading: huge,
        dialogue: [{ character: 'X'.repeat(500), line: huge }],
        characters: Array.from({ length: 100 }, (_, i) => `CHAR_${i}`),
        sourceSegmentIds: Array.from({ length: 100 }, (_, i) => `seg-${i}`),
      }],
    });
    const s = out.scenes[0];
    expect(s.summary.length).toBe(2000);
    expect(s.action.length).toBe(2000);
    expect(s.visualPrompt.length).toBe(4000);
    expect(s.slugline.length).toBe(200);
    expect(s.heading.length).toBe(200);
    expect(s.dialogue[0].character.length).toBe(100);
    expect(s.dialogue[0].line.length).toBe(1000);
    expect(s.characters.length).toBe(24);
    expect(s.sourceSegmentIds.length).toBe(32);
  });
});

describe('extractScenes', () => {
  it('routes prose source through the writers-room-script stage', async () => {
    runStagedLLM.mockResolvedValue({
      content: { title: 'X', logline: 'L', scenes: [{ visualPrompt: 'a vault' }] },
      runId: 'run-1', providerId: 'lmstudio', model: 'gpt-oss-120b',
    });

    const result = await extractScenes({
      source: 'Some prose body.',
      sourceKind: SOURCE_KIND.PROSE,
      characters: [{ id: 'c1', name: 'Alice', physicalDescription: 'tall, freckles' }],
      settings: [],
      work: { title: 'My Work', kind: 'short-story', wordCount: 1234 },
    });

    expect(runStagedLLM).toHaveBeenCalledTimes(1);
    const [stage, vars, opts] = runStagedLLM.mock.calls[0];
    expect(stage).toBe('writers-room-script');
    expect(vars.draftBody).toBe('Some prose body.');
    expect(vars.teleplay).toBe('Some prose body.');
    expect(vars.sourceKind).toBe('prose');
    expect(vars.work).toEqual({ title: 'My Work', kind: 'short-story', wordCount: 1234 });
    // existing<X>Json strings are populated through pickPromptFields (id stripped)
    const existingChars = JSON.parse(vars.existingCharactersJson);
    expect(existingChars[0]).toMatchObject({ name: 'Alice', physicalDescription: 'tall, freckles' });
    expect(existingChars[0].id).toBeUndefined();
    expect(opts.returnsJson).toBe(true);
    expect(opts.source).toBe('scene-extract-prose');

    expect(result.extracted.scenes).toHaveLength(1);
    expect(result.runId).toBe('run-1');
    expect(result.providerId).toBe('lmstudio');
    expect(result.model).toBe('gpt-oss-120b');
  });

  it('routes tvScript source through the pipeline-extract-scenes stage with series + issue context', async () => {
    runStagedLLM.mockResolvedValue({
      content: { title: 'X', logline: 'L', scenes: [{ slugline: 'INT. ROOM' }] },
      runId: 'run-2', providerId: 'lmstudio', model: 'gpt-oss-120b',
    });

    await extractScenes({
      source: '## TEASER\n\n### Scene 1\n\n**INT. ROOM — NIGHT**\n\nAction.',
      sourceKind: SOURCE_KIND.TV_SCRIPT,
      series: { name: 'Show', styleNotes: 'noir' },
      issue: { number: 3, title: 'The Pilot' },
    });

    const [stage, vars, opts] = runStagedLLM.mock.calls[0];
    expect(stage).toBe('pipeline-extract-scenes');
    expect(vars.series).toEqual({ name: 'Show', styleNotes: 'noir' });
    expect(vars.issue).toEqual({ number: 3, title: 'The Pilot' });
    expect(opts.source).toBe('scene-extract-tvScript');
  });

  it('forwards providerOverride + custom run-tracking tag', async () => {
    runStagedLLM.mockResolvedValue({
      content: { scenes: [] }, runId: 'r', providerId: 'p', model: 'm',
    });
    await extractScenes({
      source: 'x',
      sourceKind: SOURCE_KIND.PROSE,
      providerOverride: 'lmstudio',
      tag: 'pipeline-storyboards',
    });
    const opts = runStagedLLM.mock.calls[0][2];
    expect(opts.providerOverride).toBe('lmstudio');
    expect(opts.source).toBe('pipeline-storyboards');
  });

  it('rejects unknown sourceKind', async () => {
    await expect(extractScenes({ source: 'x', sourceKind: 'unknown' }))
      .rejects.toThrow(/unknown sourceKind/);
  });

  it('rejects empty source', async () => {
    await expect(extractScenes({ source: '   ', sourceKind: SOURCE_KIND.PROSE }))
      .rejects.toThrow(/source is required/);
    await expect(extractScenes({ source: null, sourceKind: SOURCE_KIND.PROSE }))
      .rejects.toThrow(/source is required/);
  });

  it('still returns a valid envelope when the LLM emits scenes:[] (no crash)', async () => {
    runStagedLLM.mockResolvedValue({ content: {}, runId: 'r', providerId: 'p', model: 'm' });
    const result = await extractScenes({ source: 'x', sourceKind: SOURCE_KIND.PROSE });
    expect(result.extracted.scenes).toEqual([]);
    expect(result.extracted.title).toBeNull();
    expect(result.extracted.logline).toBeNull();
  });
});
