import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the persistence + LLM + queue surface so the new function tests
// exercise pure orchestration without hitting disk or providers. Mocks
// must register before the SUT is imported (vi.mock hoists).
const mockIssue = {
  id: 'iss-test',
  seriesId: 'ser-test',
  stages: {
    storyboards: {
      scenes: [
        { slugline: 'INT. LAB — NIGHT', description: 'Scene 1 baseline.', imageJobId: null },
        { slugline: 'EXT. STREET — DAY', description: 'Scene 2 baseline.', imageJobId: null },
      ],
    },
    comicPages: {
      pages: [
        {
          panels: [
            { description: 'Panel 1 baseline.', dialogue: [], caption: '', sfx: '' },
            { description: 'Panel 2 baseline.', dialogue: [{ character: 'X', line: 'line' }], caption: 'c', sfx: 's' },
          ],
        },
      ],
    },
  },
};

const getIssueMock = vi.fn(async () => structuredClone(mockIssue));
const updateStageMock = vi.fn(async (issueId, stageId, patch) => ({
  issue: { ...mockIssue, stages: { ...mockIssue.stages, [stageId]: { ...mockIssue.stages[stageId], ...patch } } },
  stage: { ...mockIssue.stages[stageId], ...patch },
}));
vi.mock('./issues.js', () => ({
  getIssue: (...a) => getIssueMock(...a),
  updateStage: (...a) => updateStageMock(...a),
  VISUAL_STAGE_IDS: ['comicPages', 'storyboards', 'episodeVideo'],
  STAGE_IDS: ['idea', 'prose', 'comicScript', 'tvScript', 'comicPages', 'storyboards', 'episodeVideo'],
}));

vi.mock('./series.js', () => ({
  getSeries: vi.fn(async () => ({ id: 'ser-test', name: 'Test', styleNotes: 'noir', characters: [], settings: [] })),
}));

vi.mock('../settings.js', () => ({
  getSettings: vi.fn(async () => ({ imageGen: { local: { pythonPath: '/usr/bin/python3' }, mode: 'local' }, videoGen: {} })),
}));

vi.mock('../universeBuilder.js', () => ({ getUniverse: vi.fn(async () => null) }));

const enqueueJobMock = vi.fn(() => ({ jobId: 'job-fake-1234' }));
vi.mock('../mediaJobQueue/index.js', () => ({ enqueueJob: (...a) => enqueueJobMock(...a) }));

const runStagedLLMMock = vi.fn(async () => ({
  content: { prompt: 'refined prompt body', changes: ['tightened the framing'] },
  runId: 'run-abc12345',
  providerId: 'codex',
  model: 'gpt-4o',
}));
vi.mock('../../lib/stageRunner.js', () => ({ runStagedLLM: (...a) => runStagedLLMMock(...a) }));

vi.mock('../../lib/mediaModels.js', () => ({
  getDefaultVideoModelId: () => 'ltx-default',
  getVideoModels: () => [{ id: 'ltx-default' }, { id: 'ltx-extra' }],
}));

const {
  composeComicPagePrompt,
  composeComicCoverPrompt,
  enqueueComicCover,
  enqueueStoryboardSceneVideo,
  refineComicPanelPrompt,
  refineStoryboardScenePrompt,
} = await import('./visualStages.js');

beforeEach(() => {
  getIssueMock.mockClear();
  updateStageMock.mockClear();
  enqueueJobMock.mockClear();
  runStagedLLMMock.mockClear();
});

const SERIES = {
  name: 'Bone Walker',
  styleNotes: 'gritty ink-wash, muted earthtones, heavy contrast',
};

const PAGE = {
  panels: [
    {
      description: 'Wide establishing shot inside a fossilized rib, morning sun streaming in.',
      caption: 'The titan died nine thousand years ago.',
      dialogue: [],
      sfx: '',
    },
    {
      description: 'Tight close-up — a beetle picks its way along polished bone.',
      caption: 'No one has told the rib.',
      dialogue: [{ character: 'KESSA', line: "If you had any sense, you'd stow away." }],
      sfx: 'fmp',
    },
  ],
};

describe('composeComicPagePrompt', () => {
  it('returns empty string when page has no panels', () => {
    expect(composeComicPagePrompt({ series: SERIES, page: { panels: [] }, pageNumber: 1 })).toBe('');
    expect(composeComicPagePrompt({ series: SERIES, page: null, pageNumber: 1 })).toBe('');
  });

  it('builds a multi-panel page layout prompt with series name, style, panel count, and per-panel breakdown', () => {
    const prompt = composeComicPagePrompt({ series: SERIES, page: PAGE, pageNumber: 1 });
    expect(prompt).toMatch(/single full printable comic book page/i);
    expect(prompt).toMatch(/"Bone Walker"/);
    expect(prompt).toMatch(/page 1/i);
    expect(prompt).toMatch(/2 clearly bordered panels/);
    expect(prompt).toMatch(/Art style: gritty ink-wash/);
    expect(prompt).toMatch(/Panel 1: Wide establishing shot/);
    expect(prompt).toMatch(/Panel 2: Tight close-up/);
    expect(prompt).toMatch(/Narration caption box reads: "The titan died/);
    expect(prompt).toMatch(/Speech balloon reads: "If you had any sense, you'd stow away\." \(spoken by KESSA\)\./);
    expect(prompt).toMatch(/SFX lettering: fmp/);
  });

  it('lifts parenthetical speaker modifiers into balloon-style hints without leaking them into the lettered text', () => {
    const page = {
      panels: [{
        description: 'Lina ducks behind a market stall, hand to her ear.',
        dialogue: [
          { character: 'ETTA (EARPIECE)', line: 'Stall forty-one is the buy.' },
          { character: 'LINA (WHISPERED)', line: "Don't get clever." },
          { character: 'LINA (THOUGHT)', line: 'He always gets clever.' },
        ],
      }],
    };
    const prompt = composeComicPagePrompt({ series: SERIES, page, pageNumber: 1 });
    // The lettered text is exactly the quoted line — no speaker label, no parenthetical.
    expect(prompt).toMatch(/Speech balloon reads: "Stall forty-one is the buy\." \(spoken by ETTA; jagged electronic\/transmission balloon[^)]*\)\./);
    expect(prompt).toMatch(/Speech balloon reads: "Don't get clever\." \(spoken by LINA; dashed-outline whisper balloon\)\./);
    expect(prompt).toMatch(/Speech balloon reads: "He always gets clever\." \(spoken by LINA; cloud-outline thought balloon[^)]*\)\./);
    // Defensive: the raw "(EARPIECE)" / "(WHISPERED)" / "(THOUGHT)" labels must
    // never appear inside the lettered balloon text. Scope the check to the
    // `Speech balloon reads: "..."` segments only — the layout instruction
    // itself legitimately cites these labels in quotes as a forbid-list.
    const balloonTexts = [...prompt.matchAll(/Speech balloon reads: "([^"]+)"/g)].map((m) => m[1]);
    expect(balloonTexts).toHaveLength(3);
    for (const text of balloonTexts) {
      expect(text).not.toMatch(/\(EARPIECE\)/);
      expect(text).not.toMatch(/\(WHISPERED\)/);
      expect(text).not.toMatch(/\(THOUGHT\)/);
      expect(text).not.toMatch(/^[A-Z]+:/); // no `NAME:` prefix inside balloon
    }
  });

  it('forbids speaker labels inside balloon lettering via the layout instruction', () => {
    const prompt = composeComicPagePrompt({ series: SERIES, page: PAGE, pageNumber: 1 });
    expect(prompt).toMatch(/balloon contains ONLY the quoted text/i);
    expect(prompt).toMatch(/NEVER letter the speaker's name/i);
  });

  it('uses singular "panel" wording for a one-panel splash page', () => {
    const splash = { panels: [{ description: 'Hero stands silhouetted against the sunrise.' }] };
    const prompt = composeComicPagePrompt({ series: SERIES, page: splash, pageNumber: 5 });
    expect(prompt).toMatch(/1 clearly bordered panel\b/);
    expect(prompt).not.toMatch(/clearly bordered panels\b/);
  });

  it('skips empty caption / dialogue / sfx fields without leaving dangling labels', () => {
    const sparse = {
      panels: [
        { description: 'A solitary frame.', caption: '', dialogue: [], sfx: '' },
      ],
    };
    const prompt = composeComicPagePrompt({ series: SERIES, page: sparse, pageNumber: 1 });
    expect(prompt).toMatch(/Panel 1: A solitary frame\./);
    expect(prompt).not.toMatch(/Caption:/);
    expect(prompt).not.toMatch(/Dialogue:/);
    expect(prompt).not.toMatch(/SFX:/);
  });

  it('falls back to "continuation of previous beat" when a panel has no description', () => {
    const noDesc = { panels: [{ description: '' }] };
    const prompt = composeComicPagePrompt({ series: SERIES, page: noDesc, pageNumber: 1 });
    expect(prompt).toMatch(/Panel 1: continuation of previous beat\./);
  });

  it('prepends world.stylePrompt when a world is provided', () => {
    const world = { stylePrompt: 'cinematic ink illustration, dramatic lighting', negativePrompt: '' };
    const prompt = composeComicPagePrompt({ series: SERIES, world, page: PAGE, pageNumber: 1 });
    expect(prompt).toMatch(/cinematic ink illustration/);
  });

  it('appends extraStyle into the Art style clause', () => {
    const prompt = composeComicPagePrompt({
      series: SERIES,
      page: PAGE,
      pageNumber: 1,
      extraStyle: 'aged paper texture',
    });
    expect(prompt).toMatch(/Art style: gritty ink-wash, muted earthtones, heavy contrast, aged paper texture/);
  });

  it('does not double-punctuate when description / caption / sfx already end in . ! ?', () => {
    const page = {
      panels: [{
        description: 'Wide shot with morning sun streaming in.',
        caption: 'No one has told the rib.',
        dialogue: [{ character: 'KESSA', line: 'Move it!' }],
        sfx: 'CRASH!',
      }],
    };
    const prompt = composeComicPagePrompt({ series: SERIES, page, pageNumber: 1 });
    // Each pre-terminated segment should keep its terminator, never `..` or `!.`.
    expect(prompt).not.toMatch(/streaming in\.\./);
    expect(prompt).not.toMatch(/has told the rib\.\."/);
    expect(prompt).not.toMatch(/Move it!\."/);
    expect(prompt).not.toMatch(/CRASH!\./);
  });

  it('still appends a terminator when the field has no sentence-end punctuation', () => {
    const page = { panels: [{ description: 'A solitary frame', sfx: 'fmp' }] };
    const prompt = composeComicPagePrompt({ series: SERIES, page, pageNumber: 1 });
    expect(prompt).toMatch(/Panel 1: A solitary frame\./);
    expect(prompt).toMatch(/SFX lettering: fmp\./);
  });
});

describe('enqueueStoryboardSceneVideo', () => {
  it('rejects a non-integer sceneIndex', async () => {
    await expect(enqueueStoryboardSceneVideo('iss-test', 'nope')).rejects.toThrow(/non-negative integer/);
  });

  it('rejects when sceneIndex is out of range', async () => {
    await expect(enqueueStoryboardSceneVideo('iss-test', 99)).rejects.toThrow(/out of range/);
  });

  it('rejects when the scene has no description', async () => {
    getIssueMock.mockResolvedValueOnce({
      ...structuredClone(mockIssue),
      stages: { ...mockIssue.stages, storyboards: { scenes: [{ description: '   ' }] } },
    });
    await expect(enqueueStoryboardSceneVideo('iss-test', 0)).rejects.toThrow(/no description/);
  });

  it('rejects when modelId is unknown for this platform', async () => {
    await expect(enqueueStoryboardSceneVideo('iss-test', 0, { modelId: 'ltx-typo' }))
      .rejects.toThrow(/Unknown video model/);
  });

  it('rejects when local python is not configured', async () => {
    const settingsMod = await import('../settings.js');
    settingsMod.getSettings.mockResolvedValueOnce({ imageGen: { local: { pythonPath: null }, mode: 'local' }, videoGen: {} });
    await expect(enqueueStoryboardSceneVideo('iss-test', 0)).rejects.toThrow(/VIDEO_GEN_NOT_CONFIGURED|is not configured/);
  });

  it('happy path: enqueues a t2v video job and persists sceneVideoJobId on the scene', async () => {
    const result = await enqueueStoryboardSceneVideo('iss-test', 0, { aspectRatio: '9:16' });
    expect(result.jobId).toBe('job-fake-1234');
    expect(result.sceneIndex).toBe(0);
    expect(enqueueJobMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'video',
      params: expect.objectContaining({ mode: 't2v', disableAudio: true, width: 432, height: 768 }),
    }));
    expect(updateStageMock).toHaveBeenCalledWith('iss-test', 'storyboards', expect.objectContaining({
      status: 'edited',
      scenes: expect.arrayContaining([
        expect.objectContaining({ sceneVideoJobId: 'job-fake-1234' }),
      ]),
    }));
  });
});

describe('refineComicPanelPrompt', () => {
  it('rejects a non-integer pageIndex / panelIndex', async () => {
    await expect(refineComicPanelPrompt('iss-test', 'nope', 0)).rejects.toThrow(/non-negative integers/);
    await expect(refineComicPanelPrompt('iss-test', 0, -1)).rejects.toThrow(/non-negative integers/);
  });

  it('returns 404 when the page does not exist', async () => {
    await expect(refineComicPanelPrompt('iss-test', 99, 0)).rejects.toThrow(/page.*out of range|PIPELINE_COMIC_PAGE_NOT_FOUND/);
  });

  it('returns 404 when the panel does not exist', async () => {
    await expect(refineComicPanelPrompt('iss-test', 0, 99)).rejects.toThrow(/panel.*out of range|PIPELINE_COMIC_PANEL_NOT_FOUND/);
  });

  it('rejects when the panel has no description', async () => {
    getIssueMock.mockResolvedValueOnce({
      ...structuredClone(mockIssue),
      stages: { ...mockIssue.stages, comicPages: { pages: [{ panels: [{ description: '   ' }] }] } },
    });
    await expect(refineComicPanelPrompt('iss-test', 0, 0)).rejects.toThrow(/no description to refine/);
  });

  it('rejects when the LLM returns an empty refined prompt', async () => {
    runStagedLLMMock.mockResolvedValueOnce({
      content: { prompt: '   ', changes: [] }, runId: 'r', providerId: 'p', model: 'm',
    });
    await expect(refineComicPanelPrompt('iss-test', 0, 0)).rejects.toThrow(/empty refined prompt/);
  });

  it('happy path: replaces the panel description and returns changes + runId', async () => {
    const result = await refineComicPanelPrompt('iss-test', 0, 0);
    expect(result.runId).toBe('run-abc12345');
    expect(result.changes).toEqual(['tightened the framing']);
    expect(runStagedLLMMock).toHaveBeenCalledWith(
      'pipeline-comic-panel-image-prompt',
      expect.objectContaining({ description: expect.stringContaining('Panel 1 baseline.') }),
      expect.objectContaining({ returnsJson: true }),
    );
    expect(updateStageMock).toHaveBeenCalledWith('iss-test', 'comicPages', expect.objectContaining({
      status: 'edited',
      pages: expect.arrayContaining([
        expect.objectContaining({
          panels: expect.arrayContaining([
            expect.objectContaining({ description: 'refined prompt body' }),
          ]),
        }),
      ]),
    }));
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

  it('prepends world.stylePrompt when a world is provided', () => {
    const world = { stylePrompt: 'cinematic ink illustration, dramatic lighting', negativePrompt: '' };
    const prompt = composeComicCoverPrompt({
      series: SERIES_NAMED,
      world,
      issue: { number: 1, title: 'X' },
      coverScript: 'something',
    });
    expect(prompt).toMatch(/cinematic ink illustration/);
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
      owner: 'pipeline:iss-test:comicPages:cover',
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

describe('refineStoryboardScenePrompt', () => {
  it('rejects a non-integer sceneIndex', async () => {
    await expect(refineStoryboardScenePrompt('iss-test', 'nope')).rejects.toThrow(/non-negative integer/);
  });

  it('returns 404 when the scene does not exist', async () => {
    await expect(refineStoryboardScenePrompt('iss-test', 99)).rejects.toThrow(/out of range/);
  });

  it('rejects when the scene has no description', async () => {
    getIssueMock.mockResolvedValueOnce({
      ...structuredClone(mockIssue),
      stages: { ...mockIssue.stages, storyboards: { scenes: [{ description: '   ' }] } },
    });
    await expect(refineStoryboardScenePrompt('iss-test', 0)).rejects.toThrow(/no description to refine/);
  });

  it('rejects when the LLM returns an empty refined prompt', async () => {
    runStagedLLMMock.mockResolvedValueOnce({
      content: { prompt: '', changes: [] }, runId: 'r', providerId: 'p', model: 'm',
    });
    await expect(refineStoryboardScenePrompt('iss-test', 0)).rejects.toThrow(/empty refined prompt/);
  });

  it('happy path: replaces the scene description and uses the storyboard template', async () => {
    const result = await refineStoryboardScenePrompt('iss-test', 1);
    expect(result.runId).toBe('run-abc12345');
    expect(runStagedLLMMock).toHaveBeenCalledWith(
      'pipeline-storyboard-image-prompt',
      expect.objectContaining({
        sceneNumber: 2,
        slugline: 'EXT. STREET — DAY',
        hasSlugline: true,
        description: expect.stringContaining('Scene 2 baseline.'),
      }),
      expect.objectContaining({ returnsJson: true }),
    );
    expect(updateStageMock).toHaveBeenCalledWith('iss-test', 'storyboards', expect.objectContaining({
      status: 'edited',
      scenes: expect.arrayContaining([
        expect.objectContaining({ description: 'refined prompt body' }),
      ]),
    }));
  });
});
