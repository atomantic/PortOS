/**
 * Shared mocks and state for the visualStages leaf suites (covers, comicPages,
 * storyboards, visualStageHelpers.appearances). Split from visualStages.test.js (#16214).
 *
 * `vi.mock` calls are hoisted per test file, so each suite declares them and
 * delegates the factories here. `persistedStages` is reassigned per test, so it
 * lives on the exported `state` object (an ES binding cannot be reassigned
 * from the importing file).
 */
import { vi } from 'vitest';

export const mockIssue = {
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

// The stage state the serialized write tail sees. Kept separate from
// `mockIssue` so a test can point the outer `getIssue` read AND the write-tail

export const state = { persistedStages: structuredClone(mockIssue.stages) };

export const DEFAULT_GET_ISSUE = async () => structuredClone(mockIssue);
export const getIssueMock = vi.fn(DEFAULT_GET_ISSUE);
export const updateStageMock = vi.fn(async (issueId, stageId, patch) => ({
  issue: { ...mockIssue, stages: { ...mockIssue.stages, [stageId]: { ...mockIssue.stages[stageId], ...patch } } },
  stage: { ...mockIssue.stages[stageId], ...patch },
}));
export const assertStageUnlockedMock = vi.fn(() => undefined);
// updateStageWithLatest runs the caller's computeFn against the latest comicPages
// stage (mirrors the real serialized-write behavior) so the render+persist tests
// can assert the exact slot the route/tool would write.
export const DEFAULT_UPDATE_STAGE_WITH_LATEST = async (issueId, stageId, computeFn) => {
  const current = structuredClone(state.persistedStages[stageId] || {});
  const patch = computeFn(current);
  const stage = { ...current, ...patch };
  return { issue: { ...mockIssue, stages: { ...mockIssue.stages, [stageId]: stage } }, stage };
};
export const updateStageWithLatestMock = vi.fn(DEFAULT_UPDATE_STAGE_WITH_LATEST);
export const issuesFactory = () => ({
  getIssue: (...a) => getIssueMock(...a),
  updateStage: (...a) => updateStageMock(...a),
  updateStageWithLatest: (...a) => updateStageWithLatestMock(...a),
  assertStageUnlocked: (...a) => assertStageUnlockedMock(...a),
  VISUAL_STAGE_IDS: ['comicPages', 'storyboards', 'episodeVideo'],
  STAGE_IDS: ['idea', 'prose', 'comicScript', 'teleplay', 'comicPages', 'storyboards', 'episodeVideo'],
});

export const SEASON = { id: 'sea-test', number: 1, title: 'Volume One' };
// updateSeasonOnSeries runs the caller's patchFn against the target season and
// returns the merged series (mirrors the real per-series write tail).
export const updateSeasonOnSeriesMock = vi.fn(async (seriesId, seasonId, patchFn) => {
  const patch = patchFn(structuredClone(SEASON));
  const season = { ...SEASON, ...patch };
  return { id: seriesId, seasons: [season] };
});
export const seriesFactory = () => ({
  getSeries: vi.fn(async () => ({ id: 'ser-test', name: 'Test', styleNotes: 'noir', characters: [], settings: [], seasons: [SEASON] })),
  updateSeasonOnSeries: (...a) => updateSeasonOnSeriesMock(...a),
  STYLE_PROMPT_OVERRIDE_MODE_DEFAULT: 'prepend',
});

export const settingsFactory = () => ({
  getSettings: vi.fn(async () => ({ imageGen: { local: { pythonPath: '/usr/bin/python3' }, mode: 'local' }, videoGen: {} })),
});

export const universeBuilderFactory = () => ({
  getUniverse: vi.fn(async () => null),
  joinInfluenceList: (arr) =>
    Array.isArray(arr) ? arr.filter((t) => typeof t === 'string' && t.trim()).join(', ') : '',
});

export const enqueueJobMock = vi.fn(() => ({ jobId: 'job-fake-1234' }));
// A tiny stand-in queue so the orphan-cancel tests (#3413) can assert that a
// rejected stage write leaves NO queued job behind for that owner — the real
// `listJobs({ owner })` contract, without the real worker.
export const fakeQueue = [];
const enqueueIntoFakeQueue = (args) => {
  const result = enqueueJobMock(args);
  fakeQueue.push({ id: result.jobId, owner: args.owner, status: 'queued' });
  return result;
};
export const listFakeJobs = ({ owner, status } = {}) => fakeQueue.filter(
  (j) => (!owner || j.owner === owner) && (!status || j.status === status),
);
export const cancelJobMock = vi.fn(async (jobId) => {
  const job = fakeQueue.find((j) => j.id === jobId && j.status === 'queued');
  if (!job) return { ok: false, code: 'NOT_FOUND' };
  job.status = 'canceled';
  return { ok: true, status: 'canceled' };
});
export const mediaJobQueueFactory = () => ({
  enqueueJob: (...a) => enqueueIntoFakeQueue(...a),
  cancelJob: (...a) => cancelJobMock(...a),
});

export const DEFAULT_RUN_STAGED_LLM = async () => ({
  content: { prompt: 'refined prompt body', changes: ['tightened the framing'] },
  runId: 'run-abc12345',
  providerId: 'codex',
  model: 'gpt-4o',
});
export const runStagedLLMMock = vi.fn(DEFAULT_RUN_STAGED_LLM);
export const stageRunnerFactory = () => ({ runStagedLLM: (...a) => runStagedLLMMock(...a) });

export const mediaModelsFactory = () => ({
  getDefaultVideoModelId: () => 'ltx-default',
  getVideoModels: () => [{ id: 'ltx-default' }, { id: 'ltx-extra' }],
  // Local queueing now requires an explicit selected model ID, and character
  // LoRA compatibility must resolve against that same model.
  getImageModels: () => [{ id: 'dev', hardwareCompatibility: { state: 'available' } }],
});

// Keep the character-LoRA resolver off the real data/loras directory; tests
// that assert auto-apply behavior override this mock's return value.
export const resolveCharacterLorasMock = vi.fn(async () => []);
export const characterLoraResolverFactory = () => ({
  resolveCharacterLoras: (...a) => resolveCharacterLorasMock(...a),
});

// Point BOTH the outer `getIssue` read and the serialized write tail at the
// same storyboards scenes, so a mutator computed inside the write region sees
// the array the caller validated against.
export const useStoryboardScenes = (scenes) => {
  state.persistedStages.storyboards = { scenes: structuredClone(scenes) };
  getIssueMock.mockResolvedValueOnce({
    ...structuredClone(mockIssue),
    stages: { ...structuredClone(mockIssue.stages), storyboards: { scenes: structuredClone(scenes) } },
  });
};

export const resetMocks = () => {
  state.persistedStages = structuredClone(mockIssue.stages);
  // Restore implementations, not just call logs — tests that install a
  // stateful write tail (#3400) or a describe-level getIssue would otherwise
  // leak into every later test in the suite.
  getIssueMock.mockReset();
  getIssueMock.mockImplementation(DEFAULT_GET_ISSUE);
  updateStageMock.mockClear();
  updateStageWithLatestMock.mockReset();
  updateStageWithLatestMock.mockImplementation(DEFAULT_UPDATE_STAGE_WITH_LATEST);
  enqueueJobMock.mockReset();
  enqueueJobMock.mockImplementation(() => ({ jobId: 'job-fake-1234' }));
  fakeQueue.length = 0;
  cancelJobMock.mockClear();
  updateSeasonOnSeriesMock.mockClear();
  assertStageUnlockedMock.mockClear();
  // Restore the default implementation — several #904 tests install a
  // per-test mockImplementation/mockRejectedValue that would otherwise leak
  // into the next test (mockClear resets calls, not the implementation).
  runStagedLLMMock.mockReset();
  runStagedLLMMock.mockImplementation(DEFAULT_RUN_STAGED_LLM);
};
