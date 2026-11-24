/**
 * covers.test.js
 *
 * Comic and volume cover prompt composition and render+persist. Split from visualStages.test.js (#16214); shared mocks and state live in
 * visualStages.testFixtures.js.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above imports; the shared fixtures module is
// loaded the same way.
const h = await vi.hoisted(() => import('./visualStages.testFixtures.js'));

vi.mock('./issues.js', () => h.issuesFactory());
vi.mock('./series.js', () => h.seriesFactory());
vi.mock('../settings.js', () => h.settingsFactory());
vi.mock('../universeBuilder.js', () => h.universeBuilderFactory());
vi.mock('../mediaJobQueue/index.js', () => h.mediaJobQueueFactory());
vi.mock('../stageRunner.js', () => h.stageRunnerFactory());
vi.mock('../../lib/mediaModels.js', () => h.mediaModelsFactory());
vi.mock('../characterLoraResolver.js', () => h.characterLoraResolverFactory());

const {
  assertStageUnlockedMock,
  enqueueJobMock,
  getIssueMock,
  mockIssue,
  updateSeasonOnSeriesMock,
  updateStageWithLatestMock,
} = h;
const {
  composeComicCoverPrompt,
  composeVolumeCoverPrompt,
  enqueueComicCover,
  renderComicCover,
  renderComicBackCover,
  renderVolumeCover,
  renderVolumeBackCover,
} = await import('./visualStages.js');

beforeEach(() => {
  h.resetMocks();
});

describe('per-stage lock enforcement', () => {
  it('checks the comicPages lock before queueing a cover render', async () => {
    await enqueueComicCover('iss-test', {});
    expect(assertStageUnlockedMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'iss-test' }), 'comicPages');
  });
});

describe('composeComicCoverPrompt', () => {
  const SERIES_NAMED = { name: 'Bone Walker', styleNotes: 'gritty ink-wash' };

  it('includes the masthead text, the issue-number tag, and the cover concept body', () => {
    const prompt = composeComicCoverPrompt({
      series: SERIES_NAMED,
      issue: { number: 7, title: 'The Long Sweep' },
      coverScript: 'Kessa crouches on the rib spine at dawn.',
    });
    expect(prompt).toMatch(/series masthead "Bone Walker"/);
    expect(prompt).toMatch(/issue-number tag reading "#7"/);
    expect(prompt).toMatch(/Cover concept: Kessa crouches on the rib spine at dawn\./);
    expect(prompt).toMatch(/issue title "The Long Sweep"/);
    expect(prompt).toMatch(/Art style: gritty ink-wash/);
  });

  it('falls back to the issue title when no cover concept is supplied', () => {
    const prompt = composeComicCoverPrompt({
      series: SERIES_NAMED,
      issue: { number: 1, title: 'Sunrise' },
      coverScript: '',
    });
    expect(prompt).toMatch(/Cover concept: A single dramatic hero image evoking "Sunrise"\./);
  });

  it('falls back to a generic hero image when neither cover concept nor issue title is set', () => {
    const prompt = composeComicCoverPrompt({
      series: SERIES_NAMED,
      issue: { number: 1, title: '' },
      coverScript: '',
    });
    expect(prompt).toMatch(/A single dramatic hero image of the protagonist mid-action\./);
  });

  it('emits a generic masthead instruction when the series has no name', () => {
    const prompt = composeComicCoverPrompt({
      series: { name: '', styleNotes: '' },
      issue: { number: 3, title: 'X' },
      coverScript: 'something',
    });
    expect(prompt).toMatch(/Render a bold comic-book series masthead/);
    // No empty quoted masthead string leaks through.
    expect(prompt).not.toMatch(/masthead ""/);
  });

  it('clamps a non-positive issue number to 1 for the visible tag', () => {
    const prompt = composeComicCoverPrompt({
      series: SERIES_NAMED,
      issue: { number: 0, title: '' },
      coverScript: '',
    });
    expect(prompt).toMatch(/issue-number tag reading "#1"/);
  });

  it('prepends the world style tokens (influences.embrace) when a world is provided', () => {
    // Same migration as the page-prompt test above — covers stop reading
    // a legacy prose stylePrompt; they now live as embrace chips.
    const world = {
      influences: {
        embrace: ['cinematic ink illustration', 'dramatic lighting'],
        avoid: [],
      },
    };
    const prompt = composeComicCoverPrompt({
      series: SERIES_NAMED,
      world,
      issue: { number: 1, title: 'X' },
      coverScript: 'something',
    });
    expect(prompt).toMatch(/cinematic ink illustration/);
  });

  it('injects series.titleLogo as the masthead design cue when present', () => {
    const prompt = composeComicCoverPrompt({
      series: {
        ...SERIES_NAMED,
        titleLogo: 'Hand-lettered slab serif in salt-crusted iron, hairline crack through the O.',
      },
      issue: { number: 1, title: 'X' },
      coverScript: 'something',
    });
    expect(prompt).toMatch(/Logo design: Hand-lettered slab serif in salt-crusted iron/);
    expect(prompt).toMatch(/series masthead "Bone Walker"/);
  });

  it('renders the author byline near the bottom when series.author is set', () => {
    const prompt = composeComicCoverPrompt({
      series: { ...SERIES_NAMED, author: 'A. Foundryworker' },
      issue: { number: 1, title: 'X' },
      coverScript: 'something',
    });
    expect(prompt).toMatch(/author byline reading "By A. Foundryworker"/);
  });

  it('omits the author byline when series.author is empty', () => {
    const prompt = composeComicCoverPrompt({
      series: { ...SERIES_NAMED, author: '' },
      issue: { number: 1, title: 'X' },
      coverScript: 'something',
    });
    expect(prompt).not.toMatch(/author byline/i);
  });
});

describe('composeVolumeCoverPrompt', () => {
  it('integrates titleLogo + author into the volume cover prompt', () => {
    const prompt = composeVolumeCoverPrompt({
      series: { name: 'Salt Run', styleNotes: 's', titleLogo: 'Engraved iron caps', author: 'J. Doe' },
      season: { number: 2, title: 'The Long Sweep' },
      coverScript: 'A wide hero shot of the foundry skyline.',
    });
    expect(prompt).toMatch(/trade-paperback FRONT cover/);
    expect(prompt).toMatch(/series masthead "Salt Run"/);
    expect(prompt).toMatch(/Logo design: Engraved iron caps/);
    expect(prompt).toMatch(/volume tag reading "VOL\. 2"/);
    expect(prompt).toMatch(/volume title "The Long Sweep"/);
    expect(prompt).toMatch(/author byline reading "By J\. Doe"/);
  });
});

describe('enqueueComicCover', () => {
  beforeEach(() => {
    // Default mock chain: getIssue returns mockIssue with no cover, settings
    // returns local mode. Each test can override `getIssueMock` for special cases.
    getIssueMock.mockImplementation(async () => ({
      ...structuredClone(mockIssue),
      number: 5,
      title: 'Hero Issue',
    }));
  });

  it('builds the cover prompt and enqueues a local image job by default', async () => {
    const result = await enqueueComicCover('iss-test', {});
    expect(result.jobId).toBe('job-fake-1234');
    expect(result.mode).toBe('local');
    expect(result.prompt).toMatch(/issue-number tag reading "#5"/);
    expect(enqueueJobMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'image',
      owner: 'pipeline:iss-test:comicPages:cover:proof',
      params: expect.objectContaining({
        pythonPath: '/usr/bin/python3',
        prompt: expect.stringContaining('Cover concept:'),
      }),
    }));
  });

  it('uses the option-supplied coverScript over the persisted stages.comicPages.cover.script', async () => {
    getIssueMock.mockResolvedValueOnce({
      ...structuredClone(mockIssue),
      number: 2,
      title: 'X',
      stages: {
        ...mockIssue.stages,
        comicPages: {
          ...mockIssue.stages.comicPages,
          cover: { script: 'persisted concept' },
        },
      },
    });
    const result = await enqueueComicCover('iss-test', { coverScript: 'fresh override concept' });
    expect(result.coverScript).toBe('fresh override concept');
    expect(result.prompt).toMatch(/Cover concept: fresh override concept/);
    expect(result.prompt).not.toMatch(/persisted concept/);
  });

  it('falls back to the persisted cover.script when no coverScript option is supplied', async () => {
    getIssueMock.mockResolvedValueOnce({
      ...structuredClone(mockIssue),
      number: 2,
      title: 'X',
      stages: {
        ...mockIssue.stages,
        comicPages: {
          ...mockIssue.stages.comicPages,
          cover: { script: 'persisted concept' },
        },
      },
    });
    const result = await enqueueComicCover('iss-test', {});
    expect(result.coverScript).toBe('persisted concept');
    expect(result.prompt).toMatch(/Cover concept: persisted concept/);
  });

  it('honors options.mode = "codex" when codex is enabled', async () => {
    const settingsMod = await import('../settings.js');
    settingsMod.getSettings.mockResolvedValueOnce({
      imageGen: {
        local: { pythonPath: '/usr/bin/python3' },
        mode: 'local',
        codex: { enabled: true, codexPath: '/usr/local/bin/codex', model: 'dall-e-3' },
      },
      videoGen: {},
    });
    const result = await enqueueComicCover('iss-test', { mode: 'codex' });
    expect(result.mode).toBe('codex');
    expect(enqueueJobMock).toHaveBeenCalledWith(expect.objectContaining({
      params: expect.objectContaining({ mode: 'codex' }),
    }));
  });

  it('falls back to local when options.mode = "codex" but codex toggle is off', async () => {
    const settingsMod = await import('../settings.js');
    settingsMod.getSettings.mockResolvedValueOnce({
      imageGen: {
        local: { pythonPath: '/usr/bin/python3' },
        mode: 'local',
        codex: { enabled: false },
      },
      videoGen: {},
    });
    const result = await enqueueComicCover('iss-test', { mode: 'codex' });
    expect(result.mode).toBe('local');
    expect(enqueueJobMock).toHaveBeenCalledWith(expect.objectContaining({
      params: expect.objectContaining({ pythonPath: '/usr/bin/python3' }),
    }));
  });

  it('falls back to local when settings.imageGen.mode = "codex" but codex toggle is off', async () => {
    const settingsMod = await import('../settings.js');
    settingsMod.getSettings.mockResolvedValueOnce({
      imageGen: {
        local: { pythonPath: '/usr/bin/python3' },
        mode: 'codex',
        codex: { enabled: false },
      },
      videoGen: {},
    });
    const result = await enqueueComicCover('iss-test', {});
    expect(result.mode).toBe('local');
  });

  it('auto-selects codex when codex is enabled and no mode is pinned', async () => {
    const settingsMod = await import('../settings.js');
    settingsMod.getSettings.mockResolvedValueOnce({
      imageGen: {
        local: { pythonPath: '/usr/bin/python3' },
        codex: { enabled: true, codexPath: '/usr/local/bin/codex', model: 'dall-e-3' },
      },
      videoGen: {},
    });
    const result = await enqueueComicCover('iss-test', {});
    expect(result.mode).toBe('codex');
  });
});

// #2220 — the render+persist entry points behind BOTH the route handler and the
// CDO orchestrator tool: enqueue the job AND write the in-flight slot the
// filename hook depends on (the bare enqueue* alone silently drops orchestrated
// covers).
describe('renderComicCover / renderComicBackCover (enqueue + persist)', () => {
  beforeEach(() => {
    getIssueMock.mockImplementation(async () => ({
      ...structuredClone(mockIssue), number: 5, title: 'Hero Issue',
    }));
  });

  it('enqueues then persists the proof slot onto stages.comicPages.cover.proofImage', async () => {
    const result = await renderComicCover('iss-test', { width: 832, height: 1216 });
    expect(result.jobId).toBe('job-fake-1234');
    expect(enqueueJobMock).toHaveBeenCalledTimes(1);
    expect(updateStageWithLatestMock).toHaveBeenCalledWith('iss-test', 'comicPages', expect.any(Function));
    expect(result.stage.cover.proofImage).toMatchObject({
      jobId: 'job-fake-1234', filename: null, width: 832, height: 1216,
    });
    // proof slot must NOT carry the final-only fromProof flag
    expect(result.stage.cover.proofImage).not.toHaveProperty('fromProof');
  });

  it('persists onto finalImage (with fromProof) when target=final + useProofAsBase', async () => {
    getIssueMock.mockResolvedValueOnce({
      ...structuredClone(mockIssue), number: 5, title: 'Hero',
      stages: { ...mockIssue.stages, comicPages: { ...mockIssue.stages.comicPages, cover: { proofImage: { filename: 'proof.png' } } } },
    });
    const result = await renderComicCover('iss-test', { target: 'final', useProofAsBase: true });
    expect(result.variant).toBe('final');
    expect(result.stage.cover.finalImage).toMatchObject({ jobId: 'job-fake-1234', fromProof: true });
  });

  it('writes the coverScript into the slot only when supplied (absent preserves)', async () => {
    const withScript = await renderComicCover('iss-test', { coverScript: 'new concept' });
    expect(withScript.stage.cover.script).toBe('new concept');

    updateStageWithLatestMock.mockClear();
    const absent = await renderComicCover('iss-test', {});
    // computeFn returned a patch without `script`, so the persisted value is untouched
    expect(absent.stage.cover).not.toHaveProperty('script');
  });

  it('renderComicBackCover lands on the backCover slot', async () => {
    const result = await renderComicBackCover('iss-test', {});
    expect(result.stage.backCover.proofImage.jobId).toBe('job-fake-1234');
    expect(result.backCoverScript).toBeDefined();
  });
});

describe('renderVolumeCover / renderVolumeBackCover (enqueue + persist)', () => {
  it('enqueues then persists the proof slot onto season.cover.proofImage', async () => {
    const result = await renderVolumeCover('ser-test', 'sea-test', { width: 1024, height: 1536 });
    expect(result.jobId).toBe('job-fake-1234');
    expect(updateSeasonOnSeriesMock).toHaveBeenCalledWith('ser-test', 'sea-test', expect.any(Function));
    expect(result.season.cover.proofImage).toMatchObject({ jobId: 'job-fake-1234', width: 1024, height: 1536 });
    expect(result.series.seasons[0].cover.proofImage.jobId).toBe('job-fake-1234');
  });

  it('renderVolumeBackCover lands on the season.backCover slot', async () => {
    const result = await renderVolumeBackCover('ser-test', 'sea-test', {});
    expect(result.season.backCover.proofImage.jobId).toBe('job-fake-1234');
  });
});

// #2241 — the page render+persist entry point behind BOTH the route handler and
// the CDO orchestrator tool: enqueue the job AND write the in-flight slot onto
// pages[pageIndex] the filename hook depends on (the bare enqueueVisualComicPage
// alone silently dropped orchestrated pages).
