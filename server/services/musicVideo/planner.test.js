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
  buildScenePlanPrompt,
  planProject,
} from './planner.js';
import { planShots } from './shotPlan.js';

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

// Contiguous, gap-free tiling of [from, to] — the "complete timeline coverage"
// half of the plan contract.
function expectTiles(shots, from, to) {
  expect(shots[0].startSec).toBe(from);
  expect(shots.at(-1).endSec).toBe(to);
  for (let i = 1; i < shots.length; i++) expect(shots[i].startSec).toBe(shots[i - 1].endSec);
}

describe('planShots', () => {
  const GRID = { beats: BEATS, downbeats: DOWNBEATS };
  const VERSE = [{ label: 'Verse', startSec: 0, endSec: 24, energy: 0.5 }];

  it('splits a verse longer than the clip capacity into bounded, beat-cut shots covering it exactly', () => {
    const { shots, pacing } = planShots(VERSE, { ...GRID, clipCapacitySec: 5 });
    expect(pacing).toEqual({ minShotSec: 2, maxShotSec: 5, hookSec: 3 });
    expect(shots.length).toBeGreaterThanOrEqual(5);
    expectTiles(shots, 0, 24);
    for (const shot of shots) {
      const len = shot.endSec - shot.startSec;
      expect(len).toBeLessThanOrEqual(5);
      expect(len).toBeGreaterThanOrEqual(2);
      expect(shot.beatAligned).toBe(true);
      expect(DOWNBEATS.concat(BEATS)).toContain(shot.startSec);
    }
    // The opening hook is capped separately from the section pacing.
    expect(shots[0].hook).toBe(true);
    expect(shots[0].endSec - shots[0].startSec).toBeLessThanOrEqual(3);
    expect(shots.slice(1).every((s) => !s.hook)).toBe(true);
    // Section identity survives the split.
    expect(shots.every((s) => s.sectionIndex === 0 && s.sectionLabel === 'Verse' && s.shotCount === shots.length)).toBe(true);
    expect(shots.map((s) => s.shotIndex)).toEqual(shots.map((_, i) => i));
    // Deterministic: the same inputs plan the same shots.
    expect(planShots(VERSE, { ...GRID, clipCapacitySec: 5 }).shots).toEqual(shots);
  });

  it('uses a Grok clip capacity and a project pacing ceiling when given', () => {
    const grok = planShots(VERSE, { ...GRID, clipCapacitySec: 10 }).shots;
    expect(grok.every((s) => s.endSec - s.startSec <= 10)).toBe(true);
    expect(grok.length).toBeLessThan(planShots(VERSE, { ...GRID, clipCapacitySec: 5 }).shots.length);
    const paced = planShots(VERSE, { ...GRID, clipCapacitySec: 10, pacing: { maxShotSec: 4 } }).shots;
    expect(paced.every((s) => s.endSec - s.startSec <= 4)).toBe(true);
    expectTiles(paced, 0, 24);
    // A ceiling above the clip capacity cannot plan shots no clip can cover.
    const over = planShots(VERSE, { ...GRID, clipCapacitySec: 5, pacing: { maxShotSec: 12 } });
    expect(over.pacing.maxShotSec).toBe(5);
    expect(over.shots.every((s) => s.endSec - s.startSec <= 5)).toBe(true);
  });

  it('holds the pacing floor at half the ceiling so any span can still be tiled', () => {
    const { shots, pacing } = planShots([{ label: 'Long', startSec: 0, endSec: 25 }], {
      ...GRID, clipCapacitySec: 10, pacing: { minShotSec: 8, maxShotSec: 10 },
    });
    expect(pacing.minShotSec).toBe(5);
    expectTiles(shots, 0, 25);
    expect(shots.every((s) => s.endSec - s.startSec >= 5 && s.endSec - s.startSec <= 10)).toBe(true);
  });

  it('cuts on timed lyric lines (snapped to the beat) and attaches the lines each shot spans', () => {
    const lyricCues = [
      { text: 'line one', startSec: 4.1, endSec: 7.8 },
      { text: 'line two', startSec: 9.9, endSec: 13.5 },
      { text: 'line three', startSec: 14.05, endSec: 17 },
      { text: 'untimed line', startSec: null, endSec: null },
    ];
    const sections = [
      { label: 'Verse', startSec: 0, endSec: 20, energy: 0.5 },
      { label: 'Solo', startSec: 20, endSec: 30, energy: 0.8 },
    ];
    const { shots } = planShots(sections, { ...GRID, lyricCues, clipCapacitySec: 5 });
    expectTiles(shots, 0, 30);
    const cuts = shots.map((s) => s.startSec);
    // 4.1 / 9.9 / 14.05 are sung slightly off the beat; the cuts land on it.
    expect(cuts).toEqual(expect.arrayContaining([4, 10, 14]));
    const at = (t) => shots.find((s) => s.startSec === t);
    expect(at(4).lyricText).toBe('line one');
    expect(at(10).lyricText).toBe('line two');
    expect(at(14).lyricText).toBe('line three');
    // An untimed line is never placed, and the instrumental section invents nothing.
    expect(shots.some((s) => s.lyricText?.includes('untimed'))).toBe(false);
    const solo = shots.filter((s) => s.sectionLabel === 'Solo');
    expect(solo.length).toBeGreaterThan(1);
    expect(solo.every((s) => s.lyricText === null && s.sectionIndex === 1)).toBe(true);
  });

  // The render honors a planned span only for a beatAligned shot; an off-grid
  // cut would hand both neighbours back to their raw clip length and break the
  // planned timeline. A line sung between beats still cuts on the grid.
  it('keeps every planned span honored when lyric lines and the hook fall between beats', async () => {
    const slowBeats = Array.from({ length: 31 }, (_, i) => i * 1.25); // 48 BPM
    const { shots } = planShots([{ label: 'Verse', startSec: 0, endSec: 30 }], {
      beats: slowBeats,
      downbeats: slowBeats.filter((_, i) => i % 4 === 0),
      lyricCues: [{ text: 'between beats', startSec: 8.1, endSec: 11 }],
      pacing: { minShotSec: 2.1, hookSec: 2.4 },
      clipCapacitySec: 5,
    });
    expectTiles(shots, 0, 30);
    expect(shots.every((s) => s.beatAligned)).toBe(true);
    expect(shots.every((s) => slowBeats.includes(s.startSec))).toBe(true);
    expect(shots.map((s) => s.startSec)).toContain(7.5);
  });

  it('carries phrase-level visual intent onto the shots it covers', () => {
    const phrases = [{ label: 'Lift', startSec: 20, endSec: 30, intent: 'slow push toward the sun' }];
    const { shots } = planShots(SECTIONS, { ...GRID, phrases, clipCapacitySec: 5 });
    const outro = shots.filter((s) => s.startSec >= 20);
    expect(outro.length).toBeGreaterThan(0);
    expect(outro.every((s) => s.visualIntent === 'slow push toward the sun' && s.phraseLabel === 'Lift')).toBe(true);
    expect(shots.filter((s) => s.endSec <= 18).every((s) => s.visualIntent === null)).toBe(true);
  });

  // Section edges still come from snapSectionsToGrid (#4664). A ceiling wider
  // than every section keeps one shot per section so the edges are observable.
  describe('section edges', () => {
    const WIDE = { clipCapacitySec: 60, pacing: { hookSec: 60 } };

    it('snaps off-grid section boundaries onto the beat grid, keeping the timeline contiguous', () => {
      const { shots } = planShots([
        { label: 'A', startSec: 0, endSec: 10.3 },
        { label: 'B', startSec: 10.3, endSec: 18.2 },
        { label: 'C', startSec: 18.2, endSec: 30 },
      ], { ...GRID, ...WIDE });
      expect(shots.map((s) => [s.startSec, s.endSec])).toEqual([[0, 10.5], [10.5, 18], [18, 30]]);
      expect(shots.every((s) => s.beatAligned)).toBe(true);
    });

    it('reports beatAligned:false on a shot whose section edge could not snap', () => {
      const { shots } = planShots([
        { label: 'A', startSec: 0, endSec: 10.3 },
        { label: 'B', startSec: 10.3, endSec: 30 },
      ], { ...GRID, ...WIDE, toleranceSec: 0.05 });
      expect(shots.every((s) => s.beatAligned === false)).toBe(true);
      expect(shots.map((s) => [s.startSec, s.endSec])).toEqual([[0, 10.3], [10.3, 30]]);
    });

    it('keeps planned spans honored when the track has no usable tempo', () => {
      const { shots } = planShots(SECTIONS, { beats: [], downbeats: [], clipCapacitySec: 5 });
      expectTiles(shots, 0, 30);
      expect(shots.every((s) => s.beatAligned === true && s.endSec - s.startSec <= 5)).toBe(true);
    });
  });
});

describe('buildScenePlanPrompt', () => {
  it('carries the automation brief guidance into the plan prompt', () => {
    const base = makeProject({ concept: {} });
    expect(buildScenePlanPrompt(base, [])).not.toContain('Director guidance');
    const prompt = buildScenePlanPrompt({ ...base, automation: { tools: [], guidance: '  one long take,\n no cuts ', budgetUsd: null } }, []);
    expect(prompt).toContain('Director guidance: one long take, no cuts');
  });

  it('bounds a maximal production bible without dropping cast identities', () => {
    const subjects = Array.from({ length: 24 }, (_, index) => ({
      id: `subject-${index}`, kind: 'character', role: 'protagonist',
      name: `Subject ${index} ${'n'.repeat(105)}`, description: 'd'.repeat(1000),
    }));
    const base = makeProject({ concept: {} });
    const prompt = buildScenePlanPrompt({ ...base, concept: {
      universeStyle: 'u'.repeat(4000), moodBoardStyle: 'm'.repeat(4000), subjects,
    } }, []);
    expect(prompt.length - buildScenePlanPrompt(base, []).length).toBeLessThanOrEqual(6000);
    for (const subject of subjects) expect(prompt).toContain(subject.name);
    expect(prompt).toContain('descriptions may be abbreviated');
  });

  it('includes the concept, style, and per-shot section/duration/energy/lyrics/intent', () => {
    const { shots } = planShots(SECTIONS, {
      beats: BEATS,
      downbeats: DOWNBEATS,
      clipCapacitySec: 10,
      lyricCues: [{ text: 'we run the night', startSec: 10, endSec: 14 }],
      phrases: [{ label: 'Lift', startSec: 18, endSec: 30, intent: 'the city falls away' }],
    });
    const prompt = buildScenePlanPrompt(makeProject({ concept: {
      prompt: 'cyberpunk chase', style: 'neon, rain-slicked streets', universeStyle: 'Ink silhouettes', moodBoardStyle: 'Watercolor',
      subjects: [{ id: 'lead', kind: 'character', role: 'protagonist', name: 'Example singer', description: 'Silver coat' }],
    } }), shots);
    expect(prompt).toContain('Universe style: Ink silhouettes');
    expect(prompt).toContain('Mood board style: Watercolor');
    expect(prompt).toContain('character (protagonist): Example singer — Silver coat');
    expect(prompt).toContain('Neon Nights');
    expect(prompt).toContain('cyberpunk chase');
    expect(prompt).toContain('neon, rain-slicked streets');
    expect(prompt).toMatch(/0\. "Intro" shot 1\/\d+ — \d+\.\ds, energy 0\.20; instrumental; OPENING HOOK/);
    expect(prompt).toContain('"Drop" shot 1/');
    expect(prompt).toContain('lyrics: "we run the night"');
    expect(prompt).toContain('intent: the city falls away');
    expect(prompt).toContain('Never render the lyrics as on-screen text');
    expect(prompt).toContain('JSON array');
  });

  it('omits the lyric guidance for a track with no lyrics', () => {
    const { shots } = planShots(SECTIONS, { beats: BEATS, downbeats: DOWNBEATS });
    const prompt = buildScenePlanPrompt(makeProject(), shots);
    expect(prompt).not.toContain('lyrics:');
    expect(prompt).not.toContain('on-screen text');
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

  it('seeds several non-looping shots per section, calls getProject exactly once, and returns the freshly-persisted project from addProjectScenes', async () => {
    const project = makeProject();
    getProject.mockResolvedValue(project);
    addProjectScenes.mockResolvedValue(freshProjectResult());
    resolveProviderAndModel.mockResolvedValue({ provider: null, selectedModel: null });

    const result = await planProject('mv-1');

    expect(getProject).toHaveBeenCalledTimes(1);
    // Local renderer (5s clips): 30s of sections → more shots than sections,
    // each labeled within its section and never looping by default.
    const seeded = addProjectScenes.mock.calls[0][1];
    expect(seeded.length).toBeGreaterThan(3);
    expect(seeded[0]).toMatchObject({ label: expect.stringMatching(/^Intro · 1\/\d+$/), sectionLabel: 'Intro', sectionIndex: 0, startSec: 0, loop: false });
    expect(seeded.every((scene) => scene.loop === false && scene.endSec - scene.startSec <= 5)).toBe(true);
    expect(seeded.at(-1)).toMatchObject({ sectionLabel: 'Outro', sectionIndex: 2, endSec: 30 });
    expect(result.pacing).toEqual({ minShotSec: 2, maxShotSec: 5, hookSec: 3 });
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

  it('threads the cached beat grid, lyrics, and pacing into the plan', async () => {
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
      videoSettings: { backend: 'grok', grokDuration: 10 },
      pacing: { maxShotSec: 8 },
      lyricCues: [{ id: 'lc-1', text: 'hold on', startSec: 12.1, endSec: 15 }],
    }));
    addProjectScenes.mockResolvedValue(freshProjectResult());

    await planProject('mv-1', { seedPrompts: false });

    const seededInputs = addProjectScenes.mock.calls[0][1];
    // Section B starts on the snapped 10.5s beat; the project ceiling (8s)
    // wins over the Grok clip length (10s).
    expect(seededInputs.find((i) => i.sectionIndex === 1).startSec).toBe(10.5);
    expect(seededInputs.every((i) => i.beatAligned && i.endSec - i.startSec <= 8)).toBe(true);
    const lyricShots = seededInputs.filter((i) => i.lyricText === 'hold on');
    expect(lyricShots).toHaveLength(1);
    expect(lyricShots[0].startSec).toBeLessThanOrEqual(12.1);
    expect(lyricShots[0].endSec).toBeGreaterThanOrEqual(15);
  });

  it('hands the lyric sheet\'s delivery directions to the first-pass prompt for the shot they fall in', async () => {
    getProject.mockResolvedValue(makeProject({
      lyricCues: [
        { id: 'lc-1', text: 'come closer', startSec: 2, endSec: 4 },
        { id: 'lc-2', text: 'let it out', startSec: 12, endSec: 14 },
      ],
      lyricMarkers: [
        { type: 'direction', label: 'Whispered spoken', kind: 'whispered', line: 0 },
        { type: 'direction', label: 'Shouts', kind: 'shouted', line: 1 },
      ],
    }));
    addProjectScenes.mockResolvedValue(freshProjectResult());
    resolveProviderAndModel.mockResolvedValue({ provider: { id: 'p1', type: 'api' }, selectedModel: 'gpt' });
    runPromptThroughProvider.mockResolvedValue({ text: '[]' });

    await planProject('mv-1');

    const { prompt } = runPromptThroughProvider.mock.calls[0][0];
    const lines = prompt.split('\n');
    expect(lines.find((line) => line.includes('"come closer"'))).toMatch(/delivery: Whispered spoken/);
    expect(lines.find((line) => line.includes('"let it out"'))).toMatch(/delivery: Shouts/);
    expect(prompt).toMatch(/whispered lines play as intimate close-ups/);
  });

  it('still honors the planned spans when the cached analysis has no beat grid', async () => {
    getProject.mockResolvedValue(makeProject({
      audioAnalysis: { bpm: null, beats: [], downbeats: [], sections: SECTIONS, durationSec: 30 },
    }));
    addProjectScenes.mockResolvedValue(freshProjectResult());

    await planProject('mv-1', { seedPrompts: false });

    const seededInputs = addProjectScenes.mock.calls[0][1];
    expect(seededInputs.every((i) => i.beatAligned === true)).toBe(true);
    expect(seededInputs[0].startSec).toBe(0);
    expect(seededInputs.at(-1).endSec).toBe(30);
    for (let i = 1; i < seededInputs.length; i++) expect(seededInputs[i].startSec).toBe(seededInputs[i - 1].endSec);
  });
});
