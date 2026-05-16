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

  it('round-trips LLM-emitted shots[] on a scene', () => {
    const out = sanitizeSceneList({
      scenes: [{
        heading: 'Scene 1', visualPrompt: 'wide',
        shots: [
          { id: 'shot-01', description: 'wide on the kitchen', durationSeconds: 5, continuityFromShotId: null },
          { id: 'shot-02', description: 'close on the kettle', durationSeconds: 3, continuityFromShotId: 'shot-01' },
        ],
      }],
    });
    expect(out.scenes[0].shots).toEqual([
      { id: 'shot-01', description: 'wide on the kitchen', durationSeconds: 5, continuityFromShotId: null },
      { id: 'shot-02', description: 'close on the kettle', durationSeconds: 3, continuityFromShotId: 'shot-01' },
    ]);
  });

  it('drops continuity references that point to unknown or forward shots', () => {
    const out = sanitizeSceneList({
      scenes: [{
        heading: 'Scene 1',
        shots: [
          { id: 'shot-01', description: 'a', continuityFromShotId: 'shot-99' },   // unknown → null
          { id: 'shot-02', description: 'b', continuityFromShotId: 'shot-03' },   // forward → null
          { id: 'shot-03', description: 'c', continuityFromShotId: 'shot-03' },   // self → null
          { id: 'shot-04', description: 'd', continuityFromShotId: 'shot-02' },   // valid backward
        ],
      }],
    });
    const shots = out.scenes[0].shots;
    expect(shots[0].continuityFromShotId).toBe(null);
    expect(shots[1].continuityFromShotId).toBe(null);
    expect(shots[2].continuityFromShotId).toBe(null);
    expect(shots[3].continuityFromShotId).toBe('shot-02');
  });

  it('defaults durationSeconds to 4 and clamps out-of-range values', () => {
    const out = sanitizeSceneList({
      scenes: [{
        shots: [
          { description: 'a' },                              // missing → 4
          { description: 'b', durationSeconds: 'nope' },     // NaN → 4
          { description: 'c', durationSeconds: 0 },          // below floor → 1
          { description: 'd', durationSeconds: 999 },        // above ceiling → 30
          { description: 'e', durationSeconds: 7.6 },        // rounded → 8
        ],
      }],
    });
    const shots = out.scenes[0].shots;
    expect(shots[0].durationSeconds).toBe(4);
    expect(shots[1].durationSeconds).toBe(4);
    expect(shots[2].durationSeconds).toBe(1);
    expect(shots[3].durationSeconds).toBe(30);
    expect(shots[4].durationSeconds).toBe(8);
  });

  it('synthesizes shot ids when the LLM omits them', () => {
    const out = sanitizeSceneList({
      scenes: [{ shots: [{ description: 'first' }, { description: 'second' }] }],
    });
    expect(out.scenes[0].shots.map((s) => s.id)).toEqual(['shot-01', 'shot-02']);
  });

  it('drops shots without a description (empty content is not a shot)', () => {
    const out = sanitizeSceneList({
      scenes: [{
        shots: [
          { id: 'shot-01', description: 'real' },
          { id: 'shot-02', description: '   ' },  // whitespace-only → dropped
          { id: 'shot-03' },                       // missing → dropped
        ],
      }],
    });
    expect(out.scenes[0].shots).toHaveLength(1);
    expect(out.scenes[0].shots[0].id).toBe('shot-01');
  });

  it('caps shots[] per scene at SHOTS_PER_SCENE_MAX (16)', () => {
    const out = sanitizeSceneList({
      scenes: [{
        shots: Array.from({ length: 30 }, (_, i) => ({ description: `shot ${i}` })),
      }],
    });
    expect(out.scenes[0].shots).toHaveLength(16);
  });

  it('missing shots[] on a scene yields an empty array (back-compat)', () => {
    const out = sanitizeSceneList({ scenes: [{ heading: 'Scene 1', visualPrompt: 'w' }] });
    expect(out.scenes[0].shots).toEqual([]);
  });

  it('whitespace-only shot id falls back to a synthesized id', () => {
    const out = sanitizeSceneList({
      scenes: [{ shots: [{ id: '   ', description: 'real' }] }],
    });
    expect(out.scenes[0].shots[0].id).toBe('shot-01');
  });

  it('continuity ref to a shot dropped for empty description collapses to null', () => {
    const out = sanitizeSceneList({
      scenes: [{
        shots: [
          { id: 'shot-01', description: '' },                            // dropped — no description
          { id: 'shot-02', description: 'real', continuityFromShotId: 'shot-01' },
        ],
      }],
    });
    // Only shot-02 survives; its continuity ref points to a dropped shot
    // and therefore collapses to null rather than fabricating a substitute.
    expect(out.scenes[0].shots).toHaveLength(1);
    expect(out.scenes[0].shots[0].continuityFromShotId).toBe(null);
  });

  it('duplicate shot ids resolve continuity refs to the first occurrence', () => {
    const out = sanitizeSceneList({
      scenes: [{
        shots: [
          { id: 'shot-01', description: 'a' },
          { id: 'shot-01', description: 'b' },                            // duplicate id
          { id: 'shot-03', description: 'c', continuityFromShotId: 'shot-01' },
        ],
      }],
    });
    // findIndex returns idx 0 (the first 'shot-01'). idx 0 < idx 2 → valid
    // backward reference. Documents the dedup-resolution-to-first behavior.
    expect(out.scenes[0].shots[2].continuityFromShotId).toBe('shot-01');
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

  it('routes teleplay source through the pipeline-extract-scenes stage with series + issue context', async () => {
    runStagedLLM.mockResolvedValue({
      content: { title: 'X', logline: 'L', scenes: [{ slugline: 'INT. ROOM' }] },
      runId: 'run-2', providerId: 'lmstudio', model: 'gpt-oss-120b',
    });

    await extractScenes({
      source: '## TEASER\n\n### Scene 1\n\n**INT. ROOM — NIGHT**\n\nAction.',
      sourceKind: SOURCE_KIND.TELEPLAY,
      series: { name: 'Show', styleNotes: 'noir' },
      issue: { number: 3, title: 'The Pilot' },
    });

    const [stage, vars, opts] = runStagedLLM.mock.calls[0];
    expect(stage).toBe('pipeline-extract-scenes');
    expect(vars.series).toEqual({ name: 'Show', styleNotes: 'noir' });
    expect(vars.issue).toEqual({ number: 3, title: 'The Pilot' });
    expect(opts.source).toBe('scene-extract-teleplay');
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
