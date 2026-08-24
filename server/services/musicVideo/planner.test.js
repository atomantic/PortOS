import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../promptRunner.js', () => ({
  resolveProviderAndModel: vi.fn(),
  runPromptThroughProvider: vi.fn(),
}));

vi.mock('./projects.js', () => ({
  getProject: vi.fn(),
  addProjectScenes: vi.fn(),
}));

import { resolveProviderAndModel, runPromptThroughProvider } from '../promptRunner.js';
import { getProject, addProjectScenes } from './projects.js';
import {
  validSections,
  planScenesFromSections,
  buildScenePlanPrompt,
  planProject,
} from './planner.js';

const SECTIONS = [
  { label: 'Intro', startSec: 0, endSec: 10, energy: 0.2 },
  { label: 'Drop', startSec: 10, endSec: 18, energy: 0.95 },
  { label: 'Outro', startSec: 18, endSec: 30, energy: 0.4 },
];

// 120 BPM: a beat every 0.5s, a 4/4 downbeat every 2s. Both SECTIONS
// boundaries (10s, 18s) already sit on a downbeat, so the fixture plans
// unchanged spans that legitimately earn `beatAligned`.
const BEATS = Array.from({ length: 81 }, (_, i) => Number((i * 0.5).toFixed(3)));
const DOWNBEATS = BEATS.filter((_, i) => i % 4 === 0);

function makeProject(overrides = {}) {
  return {
    id: 'mv-1',
    name: 'Neon Nights',
    concept: { prompt: 'cyberpunk chase', style: 'neon, rain-slicked streets' },
    audioAnalysis: { bpm: 120, beats: BEATS, downbeats: DOWNBEATS, sections: SECTIONS, durationSec: 30 },
    scenes: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('validSections', () => {
  it('keeps only sections with a positive forward span within the scene-schema bounds', () => {
    const result = validSections([
      { label: 'A', startSec: 0, endSec: 5 },
      { label: 'bad-order', startSec: 5, endSec: 5 },
      { label: 'bad-reverse', startSec: 8, endSec: 3 },
      { label: 'missing-times' },
      { label: 'negative-start', startSec: -1, endSec: 5 },
      { label: 'over-max', startSec: 0, endSec: 36001 },
      null,
    ]);
    expect(result).toEqual([{ label: 'A', startSec: 0, endSec: 5 }]);
  });

  it('returns [] for a non-array input', () => {
    expect(validSections(null)).toEqual([]);
    expect(validSections(undefined)).toEqual([]);
  });
});

describe('planScenesFromSections', () => {
  const GRID = { beats: BEATS, downbeats: DOWNBEATS };

  it('builds one scene-create input per section, in order', () => {
    const inputs = planScenesFromSections(SECTIONS, GRID);
    expect(inputs).toHaveLength(3);
    expect(inputs[0]).toEqual({
      label: 'Intro', sectionLabel: 'Intro', startSec: 0, endSec: 10, beatAligned: true,
    });
    expect(inputs[1]).toMatchObject({ label: 'Drop', startSec: 10, endSec: 18 });
    expect(inputs[2]).toMatchObject({ label: 'Outro', startSec: 18, endSec: 30 });
  });

  it('each scene duration is its (snapped) section span — energy-aware via segmentation', () => {
    const inputs = planScenesFromSections(SECTIONS, GRID);
    for (let i = 0; i < SECTIONS.length; i++) {
      expect(inputs[i].endSec - inputs[i].startSec).toBe(SECTIONS[i].endSec - SECTIONS[i].startSec);
    }
  });

  it('snaps off-grid section boundaries onto the beat grid, keeping the timeline contiguous', () => {
    // Energy-novelty segmentation cuts on 0.5s window edges, so a real analysis
    // routinely lands a boundary off the beat — 10.3s here snaps to the 10.5s
    // beat (the 10.0s downbeat is outside the tempo-derived tolerance).
    const inputs = planScenesFromSections([
      { label: 'A', startSec: 0, endSec: 10.3 },
      { label: 'B', startSec: 10.3, endSec: 18.2 },
      { label: 'C', startSec: 18.2, endSec: 30 },
    ], GRID);
    expect(inputs.map((i) => [i.startSec, i.endSec])).toEqual([[0, 10.5], [10.5, 18], [18, 30]]);
    expect(inputs.every((i) => i.beatAligned)).toBe(true);
  });

  it('reports beatAligned:false on a scene whose edge could not snap', () => {
    // Nothing snapped, so the flag must not claim otherwise — render.js's
    // beatSnapClips then does its own live snapping instead of freezing the span.
    const inputs = planScenesFromSections([
      { label: 'A', startSec: 0, endSec: 10.3 },
      { label: 'B', startSec: 10.3, endSec: 30 },
    ], { ...GRID, toleranceSec: 0.05 });
    expect(inputs.every((i) => i.beatAligned === false)).toBe(true);
    expect(inputs.map((i) => [i.startSec, i.endSec])).toEqual([[0, 10.3], [10.3, 30]]);
  });

  it('keeps the planned spans honored when the track has no usable tempo', () => {
    // No grid means no live snap to hand the span back to, so dropping the flag
    // would leave the render at each clip's raw source duration instead of the
    // planned section span — the plan would be silently discarded.
    const inputs = planScenesFromSections(SECTIONS, { beats: [], downbeats: [] });
    expect(inputs.every((i) => i.beatAligned === true)).toBe(true);
    expect(inputs.map((i) => [i.startSec, i.endSec])).toEqual([[0, 10], [10, 18], [18, 30]]);
  });

  it('refuses a snap that would push a scene below the minimum scene length', () => {
    const inputs = planScenesFromSections([
      { label: 'A', startSec: 0, endSec: 10.3 },
      { label: 'B', startSec: 10.3, endSec: 30 },
    ], { ...GRID, minSceneSec: 25 });
    expect(inputs.map((i) => [i.startSec, i.endSec])).toEqual([[0, 10.3], [10.3, 30]]);
    expect(inputs.every((i) => i.beatAligned === false)).toBe(true);
  });

  it('falls back to an empty/null label when a section has no label', () => {
    const [input] = planScenesFromSections([{ startSec: 0, endSec: 5 }], GRID);
    expect(input.label).toBe('');
    expect(input.sectionLabel).toBeNull();
  });
});

describe('buildScenePlanPrompt', () => {
  it('includes the project concept, style, and per-section index/label/duration/energy', () => {
    const prompt = buildScenePlanPrompt(makeProject(), SECTIONS);
    expect(prompt).toContain('Neon Nights');
    expect(prompt).toContain('cyberpunk chase');
    expect(prompt).toContain('neon, rain-slicked streets');
    expect(prompt).toContain('0. "Intro" — 10.0s, normalized energy 0.20');
    expect(prompt).toContain('1. "Drop" — 8.0s, normalized energy 0.95');
    expect(prompt).toContain('JSON array');
  });
});

describe('planProject', () => {
  it('404s when the project does not exist', async () => {
    getProject.mockResolvedValue(null);
    await expect(planProject('mv-x')).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('422s when the project has no cached analysis', async () => {
    getProject.mockResolvedValue(makeProject({ audioAnalysis: null }));
    await expect(planProject('mv-1')).rejects.toMatchObject({ status: 422, code: 'NOT_ANALYZED' });
  });

  it('422s when every section is malformed', async () => {
    getProject.mockResolvedValue(makeProject({
      audioAnalysis: { sections: [{ label: 'bad', startSec: 5, endSec: 1 }] },
    }));
    await expect(planProject('mv-1')).rejects.toMatchObject({ status: 422, code: 'NOT_ANALYZED' });
  });

  // addProjectScenes returns the project it just persisted (read fresh under
  // its own lock/transaction), NOT a value the caller derives from the
  // pre-mutation `getProject` snapshot — so the mock's returned project here
  // deliberately differs from `makeProject()` (an extra `renderHistoryId`) to
  // prove `planProject` uses what addProjectScenes hands back, not a stale
  // composition of its own.
  const FRESH_SCENES = [{ sceneId: 's1' }, { sceneId: 's2' }, { sceneId: 's3' }];
  function freshProjectResult(overrides = {}) {
    return { project: { ...makeProject(), renderHistoryId: 'rh-fresh', scenes: FRESH_SCENES, ...overrides }, scenes: FRESH_SCENES };
  }

  it('seeds one scene per section, calls getProject exactly once, and returns the freshly-persisted project from addProjectScenes', async () => {
    const project = makeProject();
    getProject.mockResolvedValue(project);
    addProjectScenes.mockResolvedValue(freshProjectResult());
    resolveProviderAndModel.mockResolvedValue({ provider: null, selectedModel: null });

    const result = await planProject('mv-1');

    expect(getProject).toHaveBeenCalledTimes(1);
    expect(addProjectScenes).toHaveBeenCalledWith('mv-1', expect.arrayContaining([
      expect.objectContaining({ label: 'Intro', startSec: 0, endSec: 10 }),
    ]));
    expect(addProjectScenes.mock.calls[0][1]).toHaveLength(3);
    expect(runPromptThroughProvider).not.toHaveBeenCalled();
    expect(result.project.renderHistoryId).toBe('rh-fresh');
    expect(result.scenesAdded).toBe(3);
    expect(result.promptsSeeded).toBe(false);
    expect(result.promptsSkippedReason).toBe('no-provider');
  });

  it('skips the LLM call entirely when seedPrompts is false', async () => {
    getProject.mockResolvedValue(makeProject());
    addProjectScenes.mockResolvedValue(freshProjectResult());

    const result = await planProject('mv-1', { seedPrompts: false });

    expect(resolveProviderAndModel).not.toHaveBeenCalled();
    expect(result.promptsSeeded).toBe(false);
    expect(result.promptsSkippedReason).toBe('not-requested');
  });

  it('merges first-pass framePrompt/prompt into the matching scenes when the LLM call succeeds', async () => {
    getProject.mockResolvedValue(makeProject());
    addProjectScenes.mockResolvedValue(freshProjectResult());
    resolveProviderAndModel.mockResolvedValue({ provider: { id: 'p1', type: 'api' }, selectedModel: 'gpt' });
    runPromptThroughProvider.mockResolvedValue({
      text: JSON.stringify([
        { index: 0, framePrompt: 'wide establishing shot of a neon alley', prompt: 'slow dolly in' },
        { index: 1, framePrompt: 'close-up under strobing lights', prompt: 'rapid cuts, handheld shake' },
        { index: 2, framePrompt: 'empty street at dawn', prompt: 'static, lingering' },
      ]),
    });

    const result = await planProject('mv-1');

    const seededInputs = addProjectScenes.mock.calls[0][1];
    expect(seededInputs[0].framePrompt).toBe('wide establishing shot of a neon alley');
    expect(seededInputs[0].prompt).toBe('slow dolly in');
    expect(seededInputs[1].framePrompt).toBe('close-up under strobing lights');
    expect(result.promptsSeeded).toBe(true);
    expect(result.promptsSkippedReason).toBeNull();
  });

  // A CLI-style provider can echo its own input (including this prompt's
  // JSON schema example, which uses literal `<...>` placeholders) ahead of
  // its real answer. extractJson's shapePredicate must skip the all-
  // placeholder echoed block and pick the later, genuine response — not
  // persist the placeholder text as if it were a real scene plan.
  it('skips an echoed placeholder array and uses the real response that follows it', async () => {
    getProject.mockResolvedValue(makeProject());
    addProjectScenes.mockResolvedValue(freshProjectResult());
    resolveProviderAndModel.mockResolvedValue({ provider: { id: 'p1', type: 'api' }, selectedModel: 'gpt' });
    runPromptThroughProvider.mockResolvedValue({
      text: `Respond with ONLY a JSON array...
[{ "index": 0, "framePrompt": "<the opening reference still, ready to render>", "prompt": "<the shot's motion, ready to render>" }]

Here is my answer:
[{ "index": 0, "framePrompt": "actual neon alley shot", "prompt": "slow dolly in" }]`,
    });

    const result = await planProject('mv-1');

    const seededInputs = addProjectScenes.mock.calls[0][1];
    expect(seededInputs[0].framePrompt).toBe('actual neon alley shot');
    expect(seededInputs[0].prompt).toBe('slow dolly in');
    expect(result.promptsSeeded).toBe(true);
  });

  it('treats a wholly placeholder response (no real answer anywhere) as unparsable', async () => {
    getProject.mockResolvedValue(makeProject());
    addProjectScenes.mockResolvedValue(freshProjectResult());
    resolveProviderAndModel.mockResolvedValue({ provider: { id: 'p1', type: 'api' }, selectedModel: 'gpt' });
    runPromptThroughProvider.mockResolvedValue({
      text: '[{ "index": 0, "framePrompt": "<the opening reference still, ready to render>", "prompt": "<the shot\'s motion, ready to render>" }]',
    });

    const result = await planProject('mv-1');

    expect(result.promptsSeeded).toBe(false);
    expect(result.promptsSkippedReason).toBe('unparsable-response');
  });

  it('degrades to plain scenes when the LLM call throws', async () => {
    getProject.mockResolvedValue(makeProject());
    addProjectScenes.mockResolvedValue(freshProjectResult());
    resolveProviderAndModel.mockResolvedValue({ provider: { id: 'p1', type: 'api' }, selectedModel: 'gpt' });
    runPromptThroughProvider.mockRejectedValue(new Error('boom'));

    const result = await planProject('mv-1');

    const seededInputs = addProjectScenes.mock.calls[0][1];
    expect(seededInputs[0].framePrompt).toBeUndefined();
    expect(result.promptsSeeded).toBe(false);
    expect(result.promptsSkippedReason).toBe('llm-failed');
  });

  it('degrades to plain scenes when the LLM response is unparsable', async () => {
    getProject.mockResolvedValue(makeProject());
    addProjectScenes.mockResolvedValue(freshProjectResult());
    resolveProviderAndModel.mockResolvedValue({ provider: { id: 'p1', type: 'api' }, selectedModel: 'gpt' });
    runPromptThroughProvider.mockResolvedValue({ text: 'not json at all' });

    const result = await planProject('mv-1');

    expect(result.promptsSeeded).toBe(false);
    expect(result.promptsSkippedReason).toBe('unparsable-response');
  });

  it('skips prompt-seeding when the resolved provider is disabled', async () => {
    getProject.mockResolvedValue(makeProject());
    addProjectScenes.mockResolvedValue(freshProjectResult());
    resolveProviderAndModel.mockResolvedValue({ provider: { id: 'p1', enabled: false }, selectedModel: 'gpt' });

    const result = await planProject('mv-1');

    expect(runPromptThroughProvider).not.toHaveBeenCalled();
    expect(result.promptsSkippedReason).toBe('provider-disabled');
  });

  it('logs and falls through to no-provider when resolveProviderAndModel itself throws', async () => {
    getProject.mockResolvedValue(makeProject());
    addProjectScenes.mockResolvedValue(freshProjectResult());
    resolveProviderAndModel.mockRejectedValue(new Error('toolkit not initialized'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await planProject('mv-1');

    expect(result.promptsSkippedReason).toBe('no-provider');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('toolkit not initialized'));
    warnSpy.mockRestore();
  });

  it('threads the cached beat grid into the snap, so seeded spans cut on the music', async () => {
    getProject.mockResolvedValue(makeProject({
      audioAnalysis: {
        bpm: 120,
        beats: BEATS,
        downbeats: DOWNBEATS,
        durationSec: 30,
        sections: [
          { label: 'A', startSec: 0, endSec: 10.3, energy: 0.2 },
          { label: 'B', startSec: 10.3, endSec: 30, energy: 0.9 },
        ],
      },
    }));
    addProjectScenes.mockResolvedValue(freshProjectResult());

    await planProject('mv-1', { seedPrompts: false });

    const seededInputs = addProjectScenes.mock.calls[0][1];
    expect(seededInputs.map((i) => [i.startSec, i.endSec])).toEqual([[0, 10.5], [10.5, 30]]);
    expect(seededInputs.every((i) => i.beatAligned)).toBe(true);
  });

  it('still honors the planned spans when the cached analysis has no beat grid', async () => {
    getProject.mockResolvedValue(makeProject({
      audioAnalysis: { bpm: null, beats: [], downbeats: [], sections: SECTIONS, durationSec: 30 },
    }));
    addProjectScenes.mockResolvedValue(freshProjectResult());

    await planProject('mv-1', { seedPrompts: false });

    const seededInputs = addProjectScenes.mock.calls[0][1];
    expect(seededInputs.every((i) => i.beatAligned === true)).toBe(true);
    expect(seededInputs.map((i) => [i.startSec, i.endSec])).toEqual([[0, 10], [10, 18], [18, 30]]);
  });
});
