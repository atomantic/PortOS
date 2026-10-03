/**
 * Hook-level integration tests for the cover/back-cover auto-file feature.
 *
 * `coverUniverseFiler.test.js` covers the helper in isolation. These tests
 * cover the wiring around it — owner parsing, the
 * `reducerStamped && writeOk` gate (or `applyFilename → onStamped` for the
 * comic-pages factory), and the `mediaJobEvents` listener path. The hooks'
 * handlers run inside a `void (async () => {})` IIFE, so each test waits
 * for the post-emit side effect rather than awaiting the handler.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tempData = mkdtempSync(join(tmpdir(), 'portos-coverhook-test-'));

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'PATHS') return { ...actual.PATHS, data: tempData };
      return target[prop];
    },
  });
});

// Mock the series + issue + universe lookups so the hooks see deterministic
// state without bringing the full series/issue stack into scope. The
// universe lookup specifically is read TWICE inside coverUniverseFiler
// (once at queue entry, once as a delete-race guard) — we want both calls
// to see the same record in the happy path.
const seriesStore = new Map();
const issuesStore = new Map();
const universeStore = new Map();
const seasonStore = new Map(); // `${seriesId}::${seasonId}` → season payload

const updateSeasonOnSeriesMock = vi.fn(async (seriesId, seasonId, patchFn) => {
  const key = `${seriesId}::${seasonId}`;
  const cur = seasonStore.get(key);
  if (!cur) return null;
  const patch = patchFn(cur);
  if (!patch || Object.keys(patch).length === 0) return null;
  const next = { ...cur, ...patch };
  seasonStore.set(key, next);
  return next;
});

const updateStageWithLatestMock = vi.fn(async (issueId, _stageId, computeFn) => {
  const issue = issuesStore.get(issueId);
  if (!issue) throw new Error('issue not found');
  const currentStage = issue.stages?.comicPages || null;
  const patch = computeFn(currentStage);
  if (!patch || Object.keys(patch).length === 0) return issue;
  issue.stages = issue.stages || {};
  issue.stages.comicPages = { ...currentStage, ...patch };
  return issue;
});

// The real refreshSeriesCoverImage runs after each cover stamp, so the series
// mock exposes the owned seasons and persists coverImage like the real store.
const seasonsOf = (seriesId) => [...seasonStore.entries()]
  .filter(([key]) => key.startsWith(`${seriesId}::`))
  .map(([key, season]) => ({ id: key.split('::')[1], ...season }));

vi.mock('./series.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  getSeries: vi.fn(async (id) => {
    const series = seriesStore.get(id);
    return series ? { ...series, seasons: seasonsOf(id) } : null;
  }),
  setSeriesCoverImage: vi.fn(async (id, coverImage) => {
    const series = seriesStore.get(id);
    if (!series) return null;
    series.coverImage = coverImage;
    return series;
  }),
  updateSeasonOnSeries: updateSeasonOnSeriesMock,
}));

vi.mock('./issues.js', () => ({
  getIssue: vi.fn(async (id) => issuesStore.get(id) || null),
  listIssues: vi.fn(async ({ seriesId } = {}) => [...issuesStore.values()]
    .filter((i) => !i.deleted && (!seriesId || i.seriesId === seriesId))),
  updateStageWithLatest: updateStageWithLatestMock,
}));

vi.mock('../universeBuilder.js', () => ({
  getUniverse: vi.fn(async (id) => universeStore.get(id) || null),
}));

// Real imports below — these read through the mocks above.
const { mediaJobEvents } = await import('../mediaJobQueue/index.js');
const collections = await import('../mediaCollections.js');
const universeSvc = await import('../universeBuilder.js');
const seasonHook = await import('./seasonCoverFilenameHook.js');
const comicHook = await import('./comicPagesFilenameHook.js');
const { buildSeasonCoverOwner, buildComicPagesOwner } = await import('./owners.js');

// Settle every hook run the emit started, including its collection write.
const drainHooks = () => Promise.all([seasonHook.__testing.drain(), comicHook.__testing.drain()]);
const resetHooks = () => Promise.all([seasonHook.__testing.reset(), comicHook.__testing.reset()]);
const refsIn = async (universeId) => {
  const linked = await collections.findCollectionByUniverseId(universeId);
  return linked ? linked.items.map((it) => it.ref) : null;
};

beforeEach(async () => {
  await resetHooks();
  rmSync(tempData, { recursive: true, force: true });
  mkdirSync(tempData, { recursive: true });
  seriesStore.clear();
  issuesStore.clear();
  universeStore.clear();
  seasonStore.clear();
  updateSeasonOnSeriesMock.mockClear();
  updateStageWithLatestMock.mockClear();
  seasonHook.initSeasonCoverFilenameHook();
  comicHook.initComicPagesFilenameHook();
});

afterEach(async () => {
  await resetHooks();
});

// tempData is minted once (module scope) and reused across every test in
// this file — beforeEach only wipes-and-recreates it, so the LAST test's
// contents (and the root itself) are never removed. Clean it once here
// (#9032).
afterAll(() => {
  rmSync(tempData, { recursive: true, force: true });
});

describe('seasonCoverFilenameHook — universe collection auto-file', () => {
  it('files the cover into the universe collection when the active jobId still matches', async () => {
    const universeId = 'u-season-1';
    const seriesId = 'ser-1';
    const seasonId = 'season-1';
    universeStore.set(universeId, { id: universeId, name: 'Foo' });
    seriesStore.set(seriesId, { id: seriesId, universeId });
    seasonStore.set(`${seriesId}::${seasonId}`, {
      cover: { proofImage: { jobId: 'job-active' } },
    });

    mediaJobEvents.emit('completed', {
      id: 'job-active',
      kind: 'image',
      result: { filename: 'cover-final.png' },
      owner: buildSeasonCoverOwner({ seriesId, seasonId, target: 'cover', variant: 'proof' }),
    });

    await drainHooks();
    expect(await refsIn(universeId)).toEqual(['cover-final.png']);
    expect(seriesStore.get(seriesId).coverImage).toBe('cover-final.png');
  });

  it('does NOT file when the slot jobId no longer matches (stale render lands after a re-render)', async () => {
    const universeId = 'u-season-2';
    const seriesId = 'ser-2';
    const seasonId = 'season-2';
    universeStore.set(universeId, { id: universeId, name: 'Foo' });
    seriesStore.set(seriesId, { id: seriesId, universeId });
    seasonStore.set(`${seriesId}::${seasonId}`, {
      // The slot is on a NEWER jobId — our completion is stale.
      cover: { proofImage: { jobId: 'job-newer' } },
    });

    mediaJobEvents.emit('completed', {
      id: 'job-stale',
      kind: 'image',
      result: { filename: 'stale.png' },
      owner: buildSeasonCoverOwner({ seriesId, seasonId, target: 'cover', variant: 'proof' }),
    });

    await drainHooks();
    const linked = await collections.findCollectionByUniverseId(universeId);
    expect(linked).toBeNull();
  });

  it('does NOT file when the series update write fails (reducerStamped but !writeOk)', async () => {
    const universeId = 'u-season-3';
    const seriesId = 'ser-3';
    const seasonId = 'season-3';
    universeStore.set(universeId, { id: universeId, name: 'Foo' });
    seriesStore.set(seriesId, { id: seriesId, universeId });
    seasonStore.set(`${seriesId}::${seasonId}`, {
      cover: { proofImage: { jobId: 'job-write-fail' } },
    });
    // Force the write to throw after the reducer has chosen to stamp.
    updateSeasonOnSeriesMock.mockImplementationOnce(async (_s, _se, patchFn) => {
      patchFn({ cover: { proofImage: { jobId: 'job-write-fail' } } }); // reducer runs and stamps flag
      throw new Error('boom: simulated write failure');
    });

    mediaJobEvents.emit('completed', {
      id: 'job-write-fail',
      kind: 'image',
      result: { filename: 'should-not-land.png' },
      owner: buildSeasonCoverOwner({ seriesId, seasonId, target: 'cover', variant: 'proof' }),
    });

    await drainHooks();
    const linked = await collections.findCollectionByUniverseId(universeId);
    expect(linked).toBeNull();
  });

  it('parses owner correctly — non-season-cover owners are ignored', async () => {
    const universeId = 'u-season-4';
    const seriesId = 'ser-4';
    universeStore.set(universeId, { id: universeId, name: 'Foo' });
    seriesStore.set(seriesId, { id: seriesId, universeId });

    mediaJobEvents.emit('completed', {
      id: 'job-x',
      kind: 'image',
      result: { filename: 'irrelevant.png' },
      // Wrong namespace — should not be picked up by the season hook.
      owner: 'pipeline:other:not-a-season-cover',
    });

    await drainHooks();
    const linked = await collections.findCollectionByUniverseId(universeId);
    expect(linked).toBeNull();
  });
});

describe('comicPagesFilenameHook — universe collection auto-file', () => {
  it('files the issue cover into the universe collection on completion', async () => {
    const universeId = 'u-comic-1';
    const seriesId = 'ser-comic-1';
    const issueId = 'iss-1';
    universeStore.set(universeId, { id: universeId, name: 'Bar' });
    seriesStore.set(seriesId, { id: seriesId, universeId });
    issuesStore.set(issueId, {
      id: issueId,
      seriesId,
      stages: {
        comicPages: {
          cover: { proofImage: { jobId: 'job-cover-active' } },
        },
      },
    });

    mediaJobEvents.emit('completed', {
      id: 'job-cover-active',
      kind: 'image',
      result: { filename: 'issue-cover.png' },
      owner: buildComicPagesOwner({ issueId, target: 'cover', variant: 'proof' }),
    });

    await drainHooks();
    expect(await refsIn(universeId)).toEqual(['issue-cover.png']);
    expect(seriesStore.get(seriesId).coverImage).toBe('issue-cover.png');
  });

  it('files the issue back-cover on completion (separate target from cover)', async () => {
    const universeId = 'u-comic-2';
    const seriesId = 'ser-comic-2';
    const issueId = 'iss-2';
    universeStore.set(universeId, { id: universeId, name: 'Baz' });
    seriesStore.set(seriesId, { id: seriesId, universeId, coverImage: 'issue-front.png' });
    issuesStore.set(issueId, {
      id: issueId,
      seriesId,
      stages: {
        comicPages: {
          cover: { proofImage: { jobId: 'job-front', filename: 'issue-front.png' } },
          backCover: { proofImage: { jobId: 'job-back-active' } },
        },
      },
    });

    mediaJobEvents.emit('completed', {
      id: 'job-back-active',
      kind: 'image',
      result: { filename: 'issue-back.png' },
      owner: buildComicPagesOwner({ issueId, target: 'backCover', variant: 'proof' }),
    });

    await drainHooks();
    expect(await refsIn(universeId)).toEqual(['issue-back.png']);
    // Back covers never replace the front-cover thumbnail.
    expect(seriesStore.get(seriesId).coverImage).toBe('issue-front.png');
  });

  it('reset waits for a held post-stamp collection filing before teardown can proceed', async () => {
    const universeId = 'u-comic-held';
    const seriesId = 'ser-comic-held';
    const issueId = 'iss-held';
    universeStore.set(universeId, { id: universeId, name: 'Held' });
    seriesStore.set(seriesId, { id: seriesId, universeId });
    issuesStore.set(issueId, {
      id: issueId,
      seriesId,
      stages: { comicPages: { backCover: { proofImage: { jobId: 'job-back-held' } } } },
    });

    // Hold the filer's universe lookup — reached only after the stage write
    // committed and onStamped began — until the test releases it.
    let release;
    const gate = new Promise((r) => { release = r; });
    let entered;
    const reachedHold = new Promise((r) => { entered = r; });
    vi.mocked(universeSvc.getUniverse).mockImplementationOnce(async (id) => {
      entered();
      await gate;
      return universeStore.get(id) || null;
    });

    mediaJobEvents.emit('completed', {
      id: 'job-back-held',
      kind: 'image',
      result: { filename: 'issue-back-held.png' },
      owner: buildComicPagesOwner({ issueId, target: 'backCover', variant: 'proof' }),
    });
    await reachedHold;
    expect(issuesStore.get(issueId).stages.comicPages.backCover.proofImage.filename).toBe('issue-back-held.png');

    let resetSettled = false;
    const resetDone = comicHook.__testing.reset().then(() => { resetSettled = true; });
    try {
      // A full event-loop turn: a reset that doesn't own the in-flight run
      // would have settled by now; one that does stays parked on the gate.
      await new Promise((r) => setImmediate(r));
      expect(resetSettled).toBe(false);
      expect(await refsIn(universeId)).toBeNull();
    } finally {
      // Always release so a failed assertion can't wedge later teardown.
      release();
    }
    await resetDone;
    // Teardown proceeds only after the filing landed — nothing left to race.
    expect(await refsIn(universeId)).toEqual(['issue-back-held.png']);
  });

  it('does NOT file an interior PAGE render — only cover/backCover get universe-bucketed', async () => {
    const universeId = 'u-comic-3';
    const seriesId = 'ser-comic-3';
    const issueId = 'iss-3';
    universeStore.set(universeId, { id: universeId, name: 'Foo' });
    seriesStore.set(seriesId, { id: seriesId, universeId });
    issuesStore.set(issueId, {
      id: issueId,
      seriesId,
      stages: {
        comicPages: {
          pages: [{ proofImage: { jobId: 'job-page-0' } }],
        },
      },
    });

    mediaJobEvents.emit('completed', {
      id: 'job-page-0',
      kind: 'image',
      result: { filename: 'page-0.png' },
      owner: buildComicPagesOwner({ issueId, target: 'page', pageIndex: 0, variant: 'proof' }),
    });

    await drainHooks();
    const linked = await collections.findCollectionByUniverseId(universeId);
    expect(linked).toBeNull();
  });

  it('does NOT file when the slot jobId no longer matches (stale render after re-render)', async () => {
    const universeId = 'u-comic-4';
    const seriesId = 'ser-comic-4';
    const issueId = 'iss-4';
    universeStore.set(universeId, { id: universeId, name: 'Foo' });
    seriesStore.set(seriesId, { id: seriesId, universeId });
    issuesStore.set(issueId, {
      id: issueId,
      seriesId,
      stages: {
        comicPages: {
          cover: { proofImage: { jobId: 'job-newer' } },
        },
      },
    });

    mediaJobEvents.emit('completed', {
      id: 'job-stale-cover',
      kind: 'image',
      result: { filename: 'stale-cover.png' },
      owner: buildComicPagesOwner({ issueId, target: 'cover', variant: 'proof' }),
    });

    await drainHooks();
    const linked = await collections.findCollectionByUniverseId(universeId);
    expect(linked).toBeNull();
  });
});
