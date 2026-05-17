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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

vi.mock('./series.js', () => ({
  getSeries: vi.fn(async (id) => seriesStore.get(id) || null),
  updateSeasonOnSeries: updateSeasonOnSeriesMock,
}));

vi.mock('./issues.js', () => ({
  getIssue: vi.fn(async (id) => issuesStore.get(id) || null),
  updateStageWithLatest: updateStageWithLatestMock,
}));

vi.mock('../universeBuilder.js', () => ({
  getUniverse: vi.fn(async (id) => universeStore.get(id) || null),
}));

// Real imports below — these read through the mocks above.
const { mediaJobEvents } = await import('../mediaJobQueue/index.js');
const collections = await import('../mediaCollections.js');
const seasonHook = await import('./seasonCoverFilenameHook.js');
const comicHook = await import('./comicPagesFilenameHook.js');
const { buildSeasonCoverOwner, buildComicPagesOwner } = await import('./owners.js');

async function waitFor(predicate, { timeoutMs = 1000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor: predicate never became true');
}

beforeEach(() => {
  rmSync(tempData, { recursive: true, force: true });
  mkdirSync(tempData, { recursive: true });
  seriesStore.clear();
  issuesStore.clear();
  universeStore.clear();
  seasonStore.clear();
  updateSeasonOnSeriesMock.mockClear();
  updateStageWithLatestMock.mockClear();
  seasonHook.__testing.reset();
  comicHook.__testing.reset();
  seasonHook.initSeasonCoverFilenameHook();
  comicHook.initComicPagesFilenameHook();
});

afterEach(() => {
  seasonHook.__testing.reset();
  comicHook.__testing.reset();
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

    await waitFor(async () => {
      const linked = await collections.findCollectionByUniverseId(universeId);
      return linked?.items?.some((it) => it.ref === 'cover-final.png');
    });
    const linked = await collections.findCollectionByUniverseId(universeId);
    expect(linked.items.map((it) => it.ref)).toEqual(['cover-final.png']);
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

    // Give the IIFE time to run; verify the universe collection never gets
    // the stale filename. A small wait is enough — the handler's path is
    // synchronous through await microtasks once the mocks resolve.
    await new Promise((r) => setTimeout(r, 60));
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

    await new Promise((r) => setTimeout(r, 60));
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

    await new Promise((r) => setTimeout(r, 60));
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

    await waitFor(async () => {
      const linked = await collections.findCollectionByUniverseId(universeId);
      return linked?.items?.some((it) => it.ref === 'issue-cover.png');
    });
  });

  it('files the issue back-cover on completion (separate target from cover)', async () => {
    const universeId = 'u-comic-2';
    const seriesId = 'ser-comic-2';
    const issueId = 'iss-2';
    universeStore.set(universeId, { id: universeId, name: 'Baz' });
    seriesStore.set(seriesId, { id: seriesId, universeId });
    issuesStore.set(issueId, {
      id: issueId,
      seriesId,
      stages: {
        comicPages: {
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

    await waitFor(async () => {
      const linked = await collections.findCollectionByUniverseId(universeId);
      return linked?.items?.some((it) => it.ref === 'issue-back.png');
    });
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

    await new Promise((r) => setTimeout(r, 60));
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

    await new Promise((r) => setTimeout(r, 60));
    const linked = await collections.findCollectionByUniverseId(universeId);
    expect(linked).toBeNull();
  });
});
