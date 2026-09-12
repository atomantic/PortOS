import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { makePathsProxy, createTempDataRoot } from '../lib/mockPathsDataRoot.js';

const TEST_DATA_ROOT = createTempDataRoot('project-sidecar-writeback-');
const readFault = vi.hoisted(() => ({ path: null }));
const pipelineFixtures = vi.hoisted(() => ({ sections: [], seriesIds: [] }));
const runStagedLLM = vi.hoisted(() => vi.fn());

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readFile: (...args) => String(args[0]) === readFault.path
      ? Promise.reject(Object.assign(new Error('injected read denial'), { code: 'EACCES' }))
      : actual.readFile(...args),
  };
});

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: TEST_DATA_ROOT }));

vi.mock('./sharing/recordEvents.js', () => ({ emitRecordUpdated: vi.fn() }));
vi.mock('./pipeline/series.js', () => ({
  seriesStore: () => ({ recordDir: (id) => join(TEST_DATA_ROOT, 'pipeline-series', id) }),
  getSeries: vi.fn(async (id) => ({ id, name: 'Test series' })),
  listSeries: vi.fn(async () => pipelineFixtures.seriesIds.map((id) => ({ id }))),
}));
vi.mock('./pipeline/seriesCanon.js', () => ({
  getSeriesCanon: vi.fn(async () => ({
    characters: [{ id: 'char-existing', name: 'Mara', physicalDescription: 'Green eyes', locked: true }],
    places: [],
    objects: [],
  })),
}));
vi.mock('./pipeline/arcPlanner.js', () => ({
  collectManuscriptSections: vi.fn(async () => pipelineFixtures.sections),
  sectionsCorpus: vi.fn((sections) => sections.map((section) => section.content).join('\n')),
  REPLACEMENT_STRATEGIES: new Set(['delta', 'full-page']),
  replacementStrategyForCategory: (category) => category === 'comic-structure' ? 'full-page' : 'delta',
}));
vi.mock('./stageRunner.js', () => ({
  runStagedLLM,
  resolveStageContext: vi.fn(async () => ({ contextWindow: 100_000 })),
}));
vi.mock('../lib/contextBudget.js', () => ({
  manuscriptContentBudgetChars: vi.fn(() => 100_000),
  estimateTokens: vi.fn(() => 0),
}));
vi.mock('./pipeline/manuscriptReview.js', () => ({
  getReview: vi.fn(async () => ({ comments: [] })),
}));

const ask = await import('./askConversations.js');
const characters = await import('./writersRoom/characters.js');
const creativeLedger = await import('./creative/creativeRunLedger.js');
const continuityBible = await import('./pipeline/continuityBible.js');
const editorialScore = await import('./pipeline/editorialScore.js');
const manuscriptComments = await import('./pipeline/manuscriptComments.js');
const reverseOutline = await import('./pipeline/reverseOutline.js');
const { createProjectFileStore } = await import('./projectFileStore.js');

const ASK_ID = 'ask_000000001_deadbeef';
const WORK_ID = 'wr-work-acde';
const SERIES_ID = 'ser-sidecar';
const NOW = '2026-09-11T00:00:00.000Z';

const paths = {
  ask: join(TEST_DATA_ROOT, 'ask-conversations', `${ASK_ID}.json`),
  bible: join(TEST_DATA_ROOT, 'writers-room', 'works', WORK_ID, 'characters.json'),
  creativeLedger: join(TEST_DATA_ROOT, 'creative-ledger', 'project-sidecar.json'),
  continuityBible: join(TEST_DATA_ROOT, 'pipeline-series', SERIES_ID, 'continuity-bible.json'),
  editorialScore: join(TEST_DATA_ROOT, 'pipeline-editorial-health', `${SERIES_ID}.json`),
  manuscriptComments: join(TEST_DATA_ROOT, 'pipeline-series', SERIES_ID, 'manuscript-review.json'),
  reverseOutline: join(TEST_DATA_ROOT, 'pipeline-series', SERIES_ID, 'reverse-outline.json'),
  projectFileStore: join(TEST_DATA_ROOT, 'project-file-store.json'),
};

const projectStore = createProjectFileStore({
  file: paths.projectFileStore,
  kind: 'testProject',
  idPrefix: 'test-project',
  logEmoji: 'test',
  logLabel: 'Test',
  logic: {
    buildProjectRecord: (input, { id, now }) => ({ id, name: input.name, createdAt: now, updatedAt: now }),
    applyProjectPatch: (project, patch) => ({ ...project, ...patch }),
    mergeProjectRecord: (local, remote) => ({ next: remote || local, inserted: !local, remoteWins: true, changed: true }),
  },
});

const seedComment = (id = 'comment-existing') => ({
  id,
  problem: 'Existing finding',
  status: 'open',
  severity: 'medium',
  createdAt: NOW,
  updatedAt: NOW,
});

const durableStores = [
  {
    name: 'Ask conversation',
    path: paths.ask,
    seed: {
      id: ASK_ID,
      title: 'Existing conversation',
      mode: 'ask',
      createdAt: NOW,
      updatedAt: NOW,
      promoted: false,
      turns: [{ id: 'turn-existing', role: 'user', content: 'Existing turn', createdAt: NOW }],
    },
    mutate: () => ask.appendTurn(ASK_ID, { role: 'assistant', content: 'New turn' }),
    preserved: (data) => data.turns.some((turn) => turn.id === 'turn-existing'),
    initialize: async () => {
      const created = await ask.createConversation({ title: 'Initialized' });
      return JSON.parse(readFileSync(ask.__test.pathFor(created.id), 'utf8')).title === 'Initialized';
    },
  },
  {
    name: 'writers-room bible',
    path: paths.bible,
    seed: {
      characters: [{ id: 'wr-char-acde', name: 'Existing character', source: 'user', createdAt: NOW, updatedAt: NOW }],
      updatedAt: NOW,
    },
    mutate: () => characters.createCharacter(WORK_ID, { name: 'New character' }),
    preserved: (data) => data.characters.some((character) => character.id === 'wr-char-acde'),
    initialize: async () => {
      await characters.createCharacter(WORK_ID, { name: 'Initialized character' });
      return JSON.parse(readFileSync(paths.bible, 'utf8')).characters[0].name === 'Initialized character';
    },
  },
  {
    name: 'creative run ledger',
    path: paths.creativeLedger,
    seed: [{ tool: 'existing.tool', outcome: 'executed', at: NOW }],
    mutate: () => creativeLedger.appendCreativeLedgerEntry(
      'project-sidecar',
      { tool: 'new.tool', outcome: 'planned' },
      { dir: dirname(paths.creativeLedger) },
    ),
    preserved: (data) => data.some((entry) => entry.tool === 'existing.tool'),
    initialize: async () => {
      await creativeLedger.appendCreativeLedgerEntry(
        'project-sidecar',
        { tool: 'initialized.tool', outcome: 'executed' },
        { dir: dirname(paths.creativeLedger) },
      );
      return JSON.parse(readFileSync(paths.creativeLedger, 'utf8'))[0].tool === 'initialized.tool';
    },
  },
  {
    name: 'editorial trend ledger',
    path: paths.editorialScore,
    seed: {
      schemaVersion: 1,
      seriesId: SERIES_ID,
      snapshots: [{ runId: 'existing-run', at: NOW, score: 95, ready: true, open: 1, openBySeverity: { high: 0, medium: 1, low: 0 }, openByCategory: { pacing: 1 } }],
    },
    mutate: () => editorialScore.recordTrendSnapshot(SERIES_ID, { runId: 'new-run', comments: [] }),
    preserved: (data) => data.snapshots.some((snapshot) => snapshot.runId === 'existing-run'),
    initialize: async () => {
      await editorialScore.recordTrendSnapshot(SERIES_ID, { runId: 'initialized-run', comments: [] });
      return JSON.parse(readFileSync(paths.editorialScore, 'utf8')).snapshots[0].runId === 'initialized-run';
    },
  },
  {
    name: 'manuscript review',
    path: paths.manuscriptComments,
    seed: { schemaVersion: 1, comments: [seedComment()] },
    mutate: () => manuscriptComments.mergeReviewFromSync(SERIES_ID, {
      schemaVersion: 1,
      comments: [seedComment('comment-new')],
    }),
    preserved: (data) => data.comments.some((comment) => comment.id === 'comment-existing'),
    initialize: async () => {
      await manuscriptComments.mergeReviewFromSync(SERIES_ID, {
        schemaVersion: 1,
        comments: [seedComment('comment-initialized')],
      });
      return JSON.parse(readFileSync(paths.manuscriptComments, 'utf8')).comments[0].id === 'comment-initialized';
    },
  },
  {
    name: 'generic project file store',
    path: paths.projectFileStore,
    seed: [{ id: 'project-existing', name: 'Existing project', createdAt: NOW, updatedAt: NOW }],
    mutate: () => projectStore.createProject({ name: 'New project' }),
    preserved: (data) => data.some((project) => project.id === 'project-existing'),
    initialize: async () => {
      await projectStore.createProject({ name: 'Initialized project' });
      return JSON.parse(readFileSync(paths.projectFileStore, 'utf8'))[0].name === 'Initialized project';
    },
  },
];

const generatedSidecars = [
  {
    name: 'continuity bible',
    path: paths.continuityBible,
    repair: { schemaVersion: 1, seriesId: SERIES_ID, status: 'none', facts: [] },
    mutate: () => continuityBible.generateContinuityBible(SERIES_ID, { force: true }),
    initialized: (data) => data.status === 'complete' && data.facts.some((fact) => fact.subject === 'Mara'),
  },
  {
    name: 'reverse outline',
    path: paths.reverseOutline,
    repair: { schemaVersion: 1, seriesId: SERIES_ID, status: 'complete', generatedAt: '2026-09-10T00:00:00.000Z', plotlines: [], scenes: [] },
    mutate: () => reverseOutline.mergeOutlineFromSync(SERIES_ID, {
      schemaVersion: 1,
      status: 'complete',
      generatedAt: '2026-09-11T00:00:00.000Z',
      plotlines: [],
      scenes: [],
    }),
    initialized: (data) => data.generatedAt === '2026-09-11T00:00:00.000Z',
  },
];

beforeEach(() => {
  readFault.path = null;
  pipelineFixtures.sections = [];
  pipelineFixtures.seriesIds = [];
  runStagedLLM.mockReset();
  rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_DATA_ROOT, { recursive: true });
});

afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

describe.each(durableStores)('$name durable write-back', (store) => {
  it.each(['{"truncated":', ''])('preserves unreadable bytes (%j), then retries without losing valid records', async (bytes) => {
    mkdirSync(dirname(store.path), { recursive: true });
    writeFileSync(store.path, bytes);
    await expect(store.mutate()).rejects.toThrow('Unreadable JSON file');
    expect(readFileSync(store.path, 'utf8')).toBe(bytes);

    writeFileSync(store.path, JSON.stringify(store.seed));
    await store.mutate();
    expect(store.preserved(JSON.parse(readFileSync(store.path, 'utf8')))).toBe(true);
  });

  it('preserves existing bytes on an injected filesystem read failure', async () => {
    mkdirSync(dirname(store.path), { recursive: true });
    const bytes = JSON.stringify(store.seed);
    writeFileSync(store.path, bytes);
    readFault.path = store.path;
    await expect(store.mutate()).rejects.toThrow('Unreadable JSON file');
    expect(readFileSync(store.path, 'utf8')).toBe(bytes);
  });

  it('initializes an absent file through its creation boundary', async () => {
    expect(await store.initialize()).toBe(true);
  });
});

describe.each(generatedSidecars)('$name generated sidecar', (store) => {
  it.each(['{"truncated":', ''])('refuses to rebuild over unreadable bytes (%j) and retries after repair', async (bytes) => {
    mkdirSync(dirname(store.path), { recursive: true });
    writeFileSync(store.path, bytes);
    await expect(store.mutate()).rejects.toThrow('Unreadable JSON file');
    expect(readFileSync(store.path, 'utf8')).toBe(bytes);

    writeFileSync(store.path, JSON.stringify(store.repair));
    await store.mutate();
    expect(store.initialized(JSON.parse(readFileSync(store.path, 'utf8')))).toBe(true);
  });

  it('preserves existing bytes on an injected filesystem read failure', async () => {
    mkdirSync(dirname(store.path), { recursive: true });
    const bytes = JSON.stringify(store.repair);
    writeFileSync(store.path, bytes);
    readFault.path = store.path;
    await expect(store.mutate()).rejects.toThrow('Unreadable JSON file');
    expect(readFileSync(store.path, 'utf8')).toBe(bytes);
  });

  it('initializes an absent file through the rebuild boundary', async () => {
    await store.mutate();
    expect(store.initialized(JSON.parse(readFileSync(store.path, 'utf8')))).toBe(true);
  });
});

it('Ask listing skips an unreadable member without rewriting it or hiding healthy conversations', async () => {
  const healthyId = 'ask_000000002_feedface';
  const healthyPath = join(TEST_DATA_ROOT, 'ask-conversations', `${healthyId}.json`);
  const unreadableBytes = '{"truncated":';
  mkdirSync(dirname(paths.ask), { recursive: true });
  writeFileSync(paths.ask, unreadableBytes);
  writeFileSync(healthyPath, JSON.stringify({
    id: healthyId,
    title: 'Healthy conversation',
    mode: 'ask',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    promoted: false,
    turns: [],
  }));

  expect(await ask.listConversations()).toEqual([
    expect.objectContaining({ id: healthyId, title: 'Healthy conversation' }),
  ]);
  expect(readFileSync(paths.ask, 'utf8')).toBe(unreadableBytes);
});

it('cross-series manuscript lookup skips an unreadable sidecar and finds a healthy one', async () => {
  const unreadableSeries = 'ser-unreadable';
  const healthySeries = 'ser-healthy';
  const unreadablePath = join(TEST_DATA_ROOT, 'pipeline-series', unreadableSeries, 'manuscript-review.json');
  const healthyPath = join(TEST_DATA_ROOT, 'pipeline-series', healthySeries, 'manuscript-review.json');
  const unreadableBytes = '{"truncated":';
  pipelineFixtures.seriesIds = [unreadableSeries, healthySeries];
  mkdirSync(dirname(unreadablePath), { recursive: true });
  mkdirSync(dirname(healthyPath), { recursive: true });
  writeFileSync(unreadablePath, unreadableBytes);
  writeFileSync(healthyPath, JSON.stringify({ schemaVersion: 1, comments: [seedComment('target-comment')] }));

  expect(await manuscriptComments.locateComment('target-comment')).toEqual({
    seriesId: healthySeries,
    comment: expect.objectContaining({ id: 'target-comment' }),
  });
  expect(readFileSync(unreadablePath, 'utf8')).toBe(unreadableBytes);
});

it('reverse-outline generation refuses unreadable state before invoking the model', async () => {
  const unreadableBytes = '{"truncated":';
  pipelineFixtures.sections = [{ issueId: 'issue-1', number: 1, title: 'One', stageId: 'prose', content: 'Draft prose.' }];
  mkdirSync(dirname(paths.reverseOutline), { recursive: true });
  writeFileSync(paths.reverseOutline, unreadableBytes);

  await expect(reverseOutline.generateReverseOutline(SERIES_ID)).rejects.toThrow('Unreadable JSON file');
  expect(runStagedLLM).not.toHaveBeenCalled();
  expect(readFileSync(paths.reverseOutline, 'utf8')).toBe(unreadableBytes);
});
