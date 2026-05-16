import { describe, it, expect, vi, beforeEach } from 'vitest';

const fileStore = new Map();

vi.mock('../../lib/fileUtils.js', () => ({
  PATHS: { data: '/mock/data' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn(async (path, data) => { fileStore.set(path, data); }),
  readJSONFile: vi.fn(async (path, fallback) => (fileStore.has(path) ? fileStore.get(path) : fallback)),
}));

let uuidCounter = 0;
vi.mock('crypto', async () => {
  const actual = await vi.importActual('crypto');
  return { ...actual, randomUUID: () => `uuid-${++uuidCounter}` };
});

const cdCreated = [];
const cdTreatments = [];
vi.mock('../creativeDirector/local.js', () => ({
  createProject: vi.fn(async (input) => {
    const project = { id: `cd-uuid-${++uuidCounter}`, ...input, treatment: null };
    cdCreated.push(project);
    return project;
  }),
  setTreatment: vi.fn(async (id, treatment) => {
    cdTreatments.push({ id, treatment });
    return { id, treatment };
  }),
}));

vi.mock('../creativeDirector/completionHook.js', () => ({
  startCreativeDirectorProject: vi.fn(async () => undefined),
}));

vi.mock('../../lib/mediaModels.js', () => ({
  getDefaultVideoModelId: () => 'ltx23_distilled_q4',
}));

vi.mock('../settings.js', () => ({
  getSettings: vi.fn(async () => ({})),
}));

const svc = await import('./episodeVideo.js');
const issuesSvc = await import('./issues.js');
const seriesSvc = await import('./series.js');

async function seedSeriesAndIssue({ scenes = [] } = {}) {
  const series = await seriesSvc.createSeries({
    name: 'TestSeries',
    logline: 'A test logline.',
    premise: 'Premise.',
    styleNotes: 'moebius linework, cinematic',
  });
  const issue = await issuesSvc.createIssue({
    seriesId: series.id,
    title: 'Pilot',
  });
  if (scenes.length) {
    await issuesSvc.updateStage(issue.id, 'storyboards', {
      status: 'edited',
      scenes,
    });
  }
  return { series, issue };
}

describe('pipeline episodeVideo helper', () => {
  beforeEach(() => {
    fileStore.clear();
    cdCreated.length = 0;
    cdTreatments.length = 0;
    uuidCounter = 0;
    vi.clearAllMocks();
  });

  it('buildTreatmentFromStoryboards composes prompts with series style notes', () => {
    const treatment = svc.buildTreatmentFromStoryboards({
      series: { logline: 'A logline.', styleNotes: 'moebius linework' },
      issue: {
        id: 'iss-12345678',
        title: 'Pilot',
        stages: {
          idea: { output: 'beat sheet' },
          storyboards: {
            scenes: [
              { slugline: 'INT. FOUNDRY', description: 'Lina enters' },
              { slugline: 'EXT. STREET', description: 'A chase begins' },
            ],
          },
        },
      },
    });
    expect(treatment.scenes).toHaveLength(2);
    expect(treatment.scenes[0].prompt).toContain('moebius linework');
    expect(treatment.scenes[0].prompt).toContain('Lina enters');
    expect(treatment.scenes[0].useContinuationFromPrior).toBe(false);
    expect(treatment.scenes[1].useContinuationFromPrior).toBe(true);
    expect(treatment.logline).toBe('A logline.');
  });

  it('buildTreatmentFromStoryboards rejects empty storyboards', () => {
    expect(() => svc.buildTreatmentFromStoryboards({
      series: { styleNotes: 's' },
      issue: { id: 'iss-1', title: 't', stages: { storyboards: { scenes: [] } } },
    })).toThrow(/no scenes/i);
  });

  it('buildTreatmentFromStoryboards expands shots[] into per-shot CD scenes with within-scene chaining', () => {
    const treatment = svc.buildTreatmentFromStoryboards({
      series: { logline: 'L', styleNotes: 's' },
      issue: {
        id: 'iss-aaaaaaaa',
        title: 'P',
        stages: {
          idea: { output: '' },
          storyboards: {
            scenes: [
              {
                slugline: 'INT. KITCHEN',
                description: 'wide on the kitchen',
                shots: [
                  { id: 'shot-01', description: 'wide on the room', durationSeconds: 5 },
                  { id: 'shot-02', description: 'push in on the kettle', durationSeconds: 3, continuityFromShotId: 'shot-01' },
                  { id: 'shot-03', description: 'reaction shot of the cook', durationSeconds: 2 },
                ],
              },
              {
                slugline: 'EXT. STREET',
                description: 'a chase begins',
                shots: [
                  { id: 'shot-01', description: 'wide of the alley', durationSeconds: 4 },
                  { id: 'shot-02', description: 'low angle running', durationSeconds: 3, continuityFromShotId: 'shot-01' },
                ],
              },
            ],
          },
        },
      },
    });
    // 3 + 2 = 5 CD scenes total.
    expect(treatment.scenes).toHaveLength(5);
    // First scene's first shot → fresh angle.
    expect(treatment.scenes[0].useContinuationFromPrior).toBe(false);
    // Within-scene shots chain (i2v continuation).
    expect(treatment.scenes[1].useContinuationFromPrior).toBe(true);
    expect(treatment.scenes[2].useContinuationFromPrior).toBe(true);
    // First shot of the SECOND storyboard scene resets the chain (deliberate cut).
    expect(treatment.scenes[3].useContinuationFromPrior).toBe(false);
    expect(treatment.scenes[4].useContinuationFromPrior).toBe(true);
    // Per-shot durations honored (not the scene's durationSeconds field).
    expect(treatment.scenes[0].durationSeconds).toBe(5);
    expect(treatment.scenes[1].durationSeconds).toBe(3);
    // Order is contiguous after flattening.
    expect(treatment.scenes.map((s) => s.order)).toEqual([0, 1, 2, 3, 4]);
    // CD scene id encodes both storyboard scene and shot index.
    expect(treatment.scenes[0].sceneId).toMatch(/-s1-sh1$/);
    expect(treatment.scenes[3].sceneId).toMatch(/-s2-sh1$/);
  });

  it('buildTreatmentFromStoryboards falls back to one CD scene per storyboard scene when shots[] is empty', () => {
    const treatment = svc.buildTreatmentFromStoryboards({
      series: { logline: 'L', styleNotes: 's' },
      issue: {
        id: 'iss-bbbbbbbb',
        title: 'P',
        stages: {
          storyboards: {
            scenes: [
              { slugline: 'INT.', description: 'one' },
              { slugline: 'EXT.', description: 'two' },
            ],
          },
        },
      },
    });
    expect(treatment.scenes).toHaveLength(2);
    expect(treatment.scenes[0].sceneId).toMatch(/-s1$/); // legacy id (no -shN suffix)
    expect(treatment.scenes[0].useContinuationFromPrior).toBe(false);
    expect(treatment.scenes[1].useContinuationFromPrior).toBe(true);
  });

  it('buildTreatmentFromStoryboards uses scene.description as fallback when a shot description is empty', () => {
    const treatment = svc.buildTreatmentFromStoryboards({
      series: { logline: 'L', styleNotes: 's' },
      issue: {
        id: 'iss-cccccccc',
        title: 'P',
        stages: {
          storyboards: {
            scenes: [{
              slugline: 'INT. CAFE',
              description: 'a cozy cafe at dawn',
              shots: [{ id: 'shot-01', description: '' }],
            }],
          },
        },
      },
    });
    expect(treatment.scenes[0].prompt).toContain('cozy cafe at dawn');
  });

  it('buildTreatmentFromStoryboards truncates flattened shot count at MAX_SCENES (30)', () => {
    // 15 scenes × 3 shots = 45 shots → truncated at 30.
    const scenes = Array.from({ length: 15 }, (_, i) => ({
      slugline: `INT. ${i}`,
      description: 'desc',
      shots: [
        { id: 'shot-01', description: 'a' },
        { id: 'shot-02', description: 'b' },
        { id: 'shot-03', description: 'c' },
      ],
    }));
    const treatment = svc.buildTreatmentFromStoryboards({
      series: { logline: 'L', styleNotes: 's' },
      issue: { id: 'iss-dddddddd', title: 'P', stages: { storyboards: { scenes } } },
    });
    expect(treatment.scenes).toHaveLength(30);
    expect(treatment.scenes.at(-1).order).toBe(29);
  });

  it('buildTreatmentFromStoryboards drops scenes without description', () => {
    const treatment = svc.buildTreatmentFromStoryboards({
      series: { styleNotes: 's' },
      issue: {
        id: 'iss-12345678',
        title: 't',
        stages: {
          storyboards: {
            scenes: [
              { description: 'first' },
              { description: '   ' },
              { description: 'third' },
            ],
          },
        },
      },
    });
    expect(treatment.scenes).toHaveLength(2);
  });

  it('startEpisodeVideoForIssue creates a CD project + persists cdProjectId on the stage', async () => {
    const { issue } = await seedSeriesAndIssue({
      scenes: [
        { slugline: 'INT.', description: 'opens on a foundry' },
        { slugline: 'EXT.', description: 'streets at dusk' },
      ],
    });
    const result = await svc.startEpisodeVideoForIssue(issue.id);
    expect(result.cdProjectId).toMatch(/^cd-/);
    expect(result.scenes).toBe(2);
    expect(result.reused).toBe(false);
    expect(cdCreated).toHaveLength(1);
    expect(cdCreated[0].autoAcceptScenes).toBe(true);
    expect(cdCreated[0].disableAudio).toBe(true);
    expect(cdCreated[0].sourceIssueId).toBe(issue.id);
    expect(cdTreatments).toHaveLength(1);
    expect(cdTreatments[0].treatment.scenes).toHaveLength(2);
    const refreshed = await issuesSvc.getIssue(issue.id);
    expect(refreshed.stages.episodeVideo.cdProjectId).toBe(result.cdProjectId);
    expect(refreshed.stages.episodeVideo.status).toBe('generating');
    // Persisted render settings so a page reload (or a fresh tab) can
    // restore the picker state — defaults applied since no overrides given.
    expect(refreshed.stages.episodeVideo.aspectRatio).toBe('16:9');
    expect(refreshed.stages.episodeVideo.quality).toBe('standard');
  });

  it('startEpisodeVideoForIssue persists user-overridden aspectRatio + quality on the stage', async () => {
    const { issue } = await seedSeriesAndIssue({
      scenes: [{ description: 'foo' }],
    });
    await svc.startEpisodeVideoForIssue(issue.id, { aspectRatio: '9:16', quality: 'high' });
    const refreshed = await issuesSvc.getIssue(issue.id);
    expect(refreshed.stages.episodeVideo.aspectRatio).toBe('9:16');
    expect(refreshed.stages.episodeVideo.quality).toBe('high');
  });

  it('startEpisodeVideoForIssue reuses an existing cdProjectId by default', async () => {
    const { issue } = await seedSeriesAndIssue({
      scenes: [{ description: 'one' }, { description: 'two' }, { description: '' }],
    });
    const first = await svc.startEpisodeVideoForIssue(issue.id);
    cdCreated.length = 0;
    const second = await svc.startEpisodeVideoForIssue(issue.id);
    expect(second.cdProjectId).toBe(first.cdProjectId);
    expect(second.reused).toBe(true);
    // Reuse path emits the same `scenes` count shape as the fresh-start path
    // so SSE consumers (autoRunner) don't have to guard against undefined.
    // Empty descriptions are filtered (matches buildTreatmentFromStoryboards).
    expect(second.scenes).toBe(2);
    expect(cdCreated).toHaveLength(0);
  });

  it('startEpisodeVideoForIssue force:true creates a new project', async () => {
    const { issue } = await seedSeriesAndIssue({
      scenes: [{ description: 'one' }],
    });
    const first = await svc.startEpisodeVideoForIssue(issue.id);
    cdCreated.length = 0;
    const second = await svc.startEpisodeVideoForIssue(issue.id, { force: true });
    expect(second.cdProjectId).not.toBe(first.cdProjectId);
    expect(second.reused).toBe(false);
    expect(cdCreated).toHaveLength(1);
  });

  it('startEpisodeVideoForIssue rejects when storyboards is empty', async () => {
    const { issue } = await seedSeriesAndIssue({ scenes: [] });
    await expect(svc.startEpisodeVideoForIssue(issue.id))
      .rejects.toMatchObject({ code: svc.ERR_NO_STORYBOARDS });
  });
});
