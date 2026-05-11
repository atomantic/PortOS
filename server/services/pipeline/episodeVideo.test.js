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
