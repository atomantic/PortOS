import { describe, expect, it } from 'vitest';
import {
  composeSequenceTakePrompt, defaultSequenceTakeModelId, proposeSequenceTakeOffsets, sequenceTakeModelProblem,
  sequenceTakeRecord, sequenceTakeRun, sequenceTakeSelectionPatch, unionSequenceTakeReferences,
} from './musicVideoSequenceTake.js';

const H3 = 'minimax/h3-max/reference-to-video';
const SEEDANCE = 'bytedance/seedance-2.5/reference-to-video';

const shot = (n, startSec, endSec, extra = {}) => ({
  sceneId: `s${n}`, label: `Shot ${n}`, order: n, startSec, endSec, prompt: `action ${n}`, referenceImageId: `frame-${n}.png`, ...extra,
});
const project = (scenes, extra = {}) => ({ id: 'p1', scenes, ...extra });

describe('sequenceTakeRun', () => {
  const scenes = [shot(0, 0, 2), shot(1, 2, 4.5), shot(2, 4.5, 6), shot(3, 6, 9)];

  it('accepts consecutive board shots and sums their lengths', () => {
    const run = sequenceTakeRun(project(scenes), ['s1', 's2', 's3']);
    expect(run.ok).toBe(true);
    expect(run.members.map((s) => s.sceneId)).toEqual(['s1', 's2', 's3']);
    expect(run.durationSec).toBe(7);
  });

  it('refuses one shot, more than six, a gap, a reordering and a duplicate', () => {
    const many = Array.from({ length: 7 }, (_, i) => shot(i, i, i + 1));
    expect(sequenceTakeRun(project(scenes), ['s1']).code).toBe('SEQUENCE_TAKE_RUN_SIZE');
    expect(sequenceTakeRun(project(many), many.map((s) => s.sceneId)).code).toBe('SEQUENCE_TAKE_RUN_SIZE');
    expect(sequenceTakeRun(project(scenes), ['s0', 's2']).code).toBe('SEQUENCE_TAKE_NOT_CONSECUTIVE');
    expect(sequenceTakeRun(project(scenes), ['s2', 's1']).code).toBe('SEQUENCE_TAKE_NOT_CONSECUTIVE');
    expect(sequenceTakeRun(project(scenes), ['s1', 's1']).code).toBe('SEQUENCE_TAKE_NOT_CONSECUTIVE');
    expect(sequenceTakeRun(project(scenes), ['s1', 'gone']).code).toBe('SEQUENCE_TAKE_SCENE_MISSING');
  });

  it('refuses a performance shot, a still, a return and an untimed shot', () => {
    const cases = [
      { shotMode: 'performance' },
      { visualLayer: 'still' },
      { sourceTake: { sceneId: 's0' } },
      { startSec: null },
    ];
    for (const extra of cases) {
      const run = sequenceTakeRun(project([shot(0, 0, 2), shot(1, 2, 4, extra)]), ['s0', 's1']);
      expect(run.code).toBe('SEQUENCE_TAKE_SHOT_INELIGIBLE');
    }
  });
});

describe('models', () => {
  it('takes only fal reference-to-video models', () => {
    expect(sequenceTakeModelProblem(H3)).toBeNull();
    expect(sequenceTakeModelProblem(SEEDANCE)).toBeNull();
    expect(sequenceTakeModelProblem('minimax/h3-max/image-to-video')).toMatch(/reference-to-video/);
    expect(sequenceTakeModelProblem('not-a-model')).toMatch(/curated/);
  });

  it('defaults to the project model only when it is a reference model', () => {
    expect(defaultSequenceTakeModelId({ videoSettings: { falModelId: SEEDANCE } })).toBe(SEEDANCE);
    expect(defaultSequenceTakeModelId({ videoSettings: { falModelId: 'minimax/h3-max/image-to-video' } })).toBe(H3);
  });
});

describe('unionSequenceTakeReferences', () => {
  const frames = [{ key: '/f1', sceneId: 's1' }, { key: '/f2', sceneId: 's2' }];

  it('sends frames first, then each shot\'s references once', () => {
    const { references, omitted } = unionSequenceTakeReferences({
      frames,
      extras: [[{ key: '/alice', label: 'Alice', role: 'character' }, { key: '/diner', role: 'set' }], [{ key: '/alice', label: 'Alice' }, { key: '/f1' }]],
      max: 9,
    });
    expect(references.map((r) => r.key)).toEqual(['/f1', '/f2', '/alice', '/diner']);
    expect(references.map((r) => r.kind)).toEqual(['frame', 'frame', 'reference', 'reference']);
    expect(omitted).toBe(0);
  });

  it('keeps differently treated versions of the same original as separate shot frames', () => {
    const same = [
      { key: '/f1', sceneId: 's1', treatmentKey: 'quartz' },
      { key: '/f1', sceneId: 's2', treatmentKey: 'print' },
      { key: '/f1', sceneId: 's3', treatmentKey: 'print' },
    ];
    const { references } = unionSequenceTakeReferences({ frames: same, max: 9 });
    expect(references.map(frame => frame.sceneId)).toEqual(['s1', 's2']);
  });

  it('drops references past the cap and counts them, never a frame', () => {
    const { references, omitted, overCap } = unionSequenceTakeReferences({
      frames, extras: [[{ key: '/a' }, { key: '/b' }], [{ key: '/c' }]], max: 3,
    });
    expect(references.map((r) => r.key)).toEqual(['/f1', '/f2', '/a']);
    expect(omitted).toBe(2);
    expect(overCap).toBe(false);
    expect(unionSequenceTakeReferences({ frames, extras: [], max: 1 }).overCap).toBe(true);
  });
});

describe('composeSequenceTakePrompt', () => {
  const members = [shot(1, 2, 4.5, { camera: { move: 'dolly-in' } }), shot(2, 4.5, 6), shot(3, 7, 9)];
  const references = [
    { kind: 'frame', sceneId: 's1' }, { kind: 'frame', sceneId: 's2' }, { kind: 'frame', sceneId: 's3' },
    { kind: 'reference', label: 'Alice', role: 'character' },
  ];

  it('numbers the shots with hard cuts, names each frame, and writes shared lines once', () => {
    const p = project(members, { concept: { style: 'warm 16mm' } });
    const { prompt, promptAdditions, windows } = composeSequenceTakePrompt({ project: p, members, modelId: H3, references });
    expect(windows).toEqual([
      { sceneId: 's1', startSec: 0, endSec: 2.5 }, { sceneId: 's2', startSec: 2.5, endSec: 4 }, { sceneId: 's3', startSec: 4, endSec: 6 },
    ]);
    expect(prompt).toContain('Shot 1 (0-2.5s): Image 1. action 1');
    expect(prompt).toContain('Shot 3 (4-6s): Image 3. action 3');
    expect(prompt.match(/\nHard cut\.\n/g)).toHaveLength(2);
    expect(prompt).toContain('Image 4 is Alice');
    expect(prompt.match(/warm 16mm/g)).toHaveLength(1);
    // Every line PortOS adds is a labeled addition; the shots' own prompts are not.
    for (const addition of promptAdditions) expect(prompt).toContain(addition.id === 'shot-headers' ? 'Shot 1 (' : addition.text);
    expect(promptAdditions.map((a) => a.id)).toEqual(expect.arrayContaining(['sequence-take', 'reference-map', 'project-style', 'shot-headers']));
    expect(promptAdditions.some((a) => a.text.includes('action 1'))).toBe(false);
  });

  it('describes a shared comparison sheet as several people, not one face', () => {
    const pair = [...references.slice(0, 3), { kind: 'reference', label: 'Alice and Bob · comparison sheet', role: 'character', comparison: { names: ['Alice', 'Bob'], sides: true } }];
    const { prompt } = composeSequenceTakePrompt({ project: project(members), members, modelId: H3, references: pair });
    expect(prompt).toContain("Image 4 is Alice and Bob · comparison sheet: keep each person's exact face");
    expect(prompt).not.toContain('keep this exact face');
  });

  it('uses the model\'s own reference spelling', () => {
    const { prompt } = composeSequenceTakePrompt({ project: project(members), members, modelId: SEEDANCE, references });
    expect(prompt).toContain('Shot 2 (2.5-4s): @Image2.');
  });

  it('stretches the shot times to fill a model minimum longer than the run', () => {
    const short = [shot(1, 0, 1), shot(2, 1, 2.5)];
    const { prompt, windows } = composeSequenceTakePrompt({ project: project(short), members: short, modelId: H3, references: [], seconds: 5 });
    expect(prompt).toContain('Shot 1 (0-2s)');
    expect(prompt).toContain('Shot 2 (2-5s)');
    // The windows a shot needs stay its own length.
    expect(windows).toEqual([{ sceneId: 's1', startSec: 0, endSec: 1 }, { sceneId: 's2', startSec: 1, endSec: 2.5 }]);
  });
});

// Back-to-back windows of the given lengths, as composeSequenceTakePrompt plans them.
const windowsOf = (...lengths) => composeSequenceTakePrompt({ project: project([]), modelId: H3,
  members: lengths.map((len, i) => shot(i + 1, 0, len)) }).windows;

describe('proposeSequenceTakeOffsets', () => {
  const windows = windowsOf(3, 3, 3, 3);

  it('places each shot in the segment between detected cuts, centred', () => {
    // A 12s take whose cuts landed early and late.
    const { ok, offsets } = proposeSequenceTakeOffsets({ windows, cutsSec: [3.5, 6.25, 8.5], clipSec: 12 });
    expect(ok).toBe(true);
    expect(offsets.map((o) => o.from)).toEqual(['start', 'cut', 'cut', 'cut']);
    // Shot 1: 0-3.5 centred → 0.25. Shot 2: 3.5-6.25 is shorter than 3s → on the cut. Shot 4: 8.5-12 centred → 8.75.
    expect(offsets.map((o) => o.offsetSec)).toEqual([0.25, 3.5, 6.25, 8.75]);
    expect(offsets.every((o) => Number.isInteger(o.offsetFrames) && o.offsetFrames === Math.round(o.offsetSec * 24))).toBe(true);
  });

  it('keeps the planned in-point where no cut is near, and ignores stray cuts', () => {
    const { offsets } = proposeSequenceTakeOffsets({ windows, cutsSec: [0.4, 6.1], clipSec: 12 });
    expect(offsets.map((o) => o.from)).toEqual(['start', 'planned', 'cut', 'planned']);
    // Shot 2 keeps its planned start at 3s and is centred in 3-6.1s (the cut matched for shot 3), on the frame grid.
    expect(offsets[1].offsetFrames).toBe(73);
  });

  it('plans every in-point when detection failed, scaled to a longer clip', () => {
    const two = windowsOf(1, 1.5);
    const { offsets } = proposeSequenceTakeOffsets({ windows: two, cutsSec: null, clipSec: 5 });
    expect(offsets.map((o) => o.from)).toEqual(['start', 'planned']);
    // The plan's change at 1s of 2.5s lands at 2s of a 5s clip; shot 2 is centred in 2-5s.
    expect(offsets.map((o) => o.offsetSec)).toEqual([0.5, 2.75]);
  });

  it('never runs a window past the clip end', () => {
    const { offsets } = proposeSequenceTakeOffsets({ windows, cutsSec: [3, 6, 11.5], clipSec: 12 });
    expect(offsets[3].offsetSec).toBe(9);
  });

  it('refuses a clip shorter than one shot', () => {
    expect(proposeSequenceTakeOffsets({ windows, cutsSec: [], clipSec: 2 }).ok).toBe(false);
    expect(proposeSequenceTakeOffsets({ windows, cutsSec: [], clipSec: Number.NaN }).ok).toBe(false);
  });
});

describe('sequence take records and selection', () => {
  const record = { sceneIds: ['s1', 's2'], index: 1, offsetFrames: 72, from: 'cut' };

  it('keeps a bounded record and drops a malformed one', () => {
    expect(sequenceTakeRecord(record)).toEqual(record);
    expect(sequenceTakeRecord({ ...record, offsetFrames: -1 })).toBeNull();
    expect(sequenceTakeRecord({ ...record, sceneIds: ['s1'] })).toBeNull();
    expect(sequenceTakeRecord({ ...record, from: 'guess', index: 9 })).toEqual({ sceneIds: ['s1', 's2'], offsetFrames: 72, from: 'planned' });
  });

  const seqTake = { kind: 'video', assetId: 'clip-seq', sequence: record };
  const plain = { kind: 'video', assetId: 'clip-own' };

  it('picking a sequence take sets the shot\'s in-point; re-picking it keeps a nudge', () => {
    expect(sequenceTakeSelectionPatch({ videoHistoryId: 'clip-own', takes: [plain, seqTake] }, seqTake)).toEqual({ offsetFrames: 72 });
    expect(sequenceTakeSelectionPatch({ videoHistoryId: 'clip-seq', offsetFrames: 80, takes: [seqTake] }, seqTake)).toEqual({});
    expect(sequenceTakeSelectionPatch({ takes: [] }, { ...seqTake, sequence: { ...record, offsetFrames: 0, from: 'start' } })).toEqual({ offsetFrames: null });
  });

  it('leaving a sequence take clears its in-point; other clip changes keep the director\'s offset', () => {
    expect(sequenceTakeSelectionPatch({ videoHistoryId: 'clip-seq', offsetFrames: 72, takes: [seqTake, plain] }, plain)).toEqual({ offsetFrames: null });
    expect(sequenceTakeSelectionPatch({ videoHistoryId: 'other', offsetFrames: 5, takes: [{ kind: 'video', assetId: 'other' }, plain] }, plain)).toEqual({});
    expect(sequenceTakeSelectionPatch({ videoHistoryId: 'clip-own' }, { kind: 'image', assetId: 'f' })).toEqual({});
  });
});
