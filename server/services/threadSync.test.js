/** Brain threads are tracked topics, not message threads. */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';
vi.mock('../lib/fileUtils.js', async (original) => makePathsProxy(await original(), {
  dataRoot: () => lazyTempDataRoot('thread-sync-test-'),
}));
vi.mock('./instanceIdentity.js', () => ({ getInstanceId: async () => 'example-instance' }));
const { getAppById, resolveAppForgeTarget, resolveForgeExecOptions, execGh, ensureForgeReachable } = vi.hoisted(() => ({
  getAppById: vi.fn(), resolveAppForgeTarget: vi.fn(), resolveForgeExecOptions: vi.fn(), execGh: vi.fn(), ensureForgeReachable: vi.fn(),
}));
vi.mock('./apps.js', () => ({ getAppById }));
vi.mock('../lib/workTracker.js', async (original) => ({ ...await original(), resolveAppForgeTarget }));
vi.mock('./forgeExecOptions.js', () => ({ resolveForgeExecOptions }));
vi.mock('./github.js', () => ({ execGh, ensureForgeReachable }));
import * as storage from './brainStorage.js';
import { syncGithubThreads } from './threadSync.js';
const sync = (body = { appId: 'example-app' }) => syncGithubThreads(body);
const issue = { number: 42, title: 'Example issue', state: 'OPEN' };
let sequence = 0;
const currentRecord = async () => (await storage.getAll('threads')).find(t => t.source?.key.includes(`repo-${sequence}`));
beforeEach(() => {
  vi.clearAllMocks();
  sequence++;
  getAppById.mockResolvedValue({ repoPath: '/example/repo', forgeAccount: 'example-account' });
  resolveAppForgeTarget.mockResolvedValue({ tracker: 'github', target: {
    forge: 'github', apiHost: 'github.example.com', fullName: `example/repo-${sequence}`,
    repoSpec: `github.example.com/example/repo-${sequence}`,
  } });
  resolveForgeExecOptions.mockResolvedValue({ cwd: '/example/repo', env: { EXAMPLE: 'pinned' }, customEnv: { EXAMPLE: 'pinned' } });
  ensureForgeReachable.mockResolvedValue({ ok: true });
  execGh.mockResolvedValue(JSON.stringify([issue]));
});
afterAll(cleanupTempDataRoots);
describe('assigned GitHub issue ingestion through the real store', () => {
  it('preserves human edits, unknown fields and tombstones across repeat discovery and closure', async () => {
    expect((await sync({ appId: 'example-app', pinned: true })).created).toBe(1);
    const record = await currentRecord();
    expect(record).toMatchObject({ title: issue.title, pinned: true, status: 'open', externalState: 'open' });
    expect(record.id).toMatch(/^gh-[a-f0-9]{64}$/);
    expect(execGh).toHaveBeenCalledWith(expect.arrayContaining(['--assignee', '@me', '--repo', `github.example.com/example/repo-${sequence}`]), undefined, { cwd: '/example/repo', env: { EXAMPLE: 'pinned' } });
    expect(resolveForgeExecOptions).toHaveBeenCalledWith('/example/repo', { forgeAccount: 'example-account' });
    expect(ensureForgeReachable).toHaveBeenCalledWith('thread-sync', { hostname: 'github.example.com', env: { EXAMPLE: 'pinned' } });
    await storage.update('threads', record.id, { title: 'My title', status: 'waiting', priority: 'urgent', notes: 'My notes', nextAction: 'Call', futureField: { keep: true } });
    execGh.mockResolvedValue(JSON.stringify([{ ...issue, title: 'Renamed externally', state: 'CLOSED' }]));
    expect((await sync())).toMatchObject({ created: 0, updated: 1 });
    const edited = await storage.getById('threads', record.id);
    expect(edited).toMatchObject({ title: 'My title', status: 'waiting', priority: 'urgent', notes: 'My notes', nextAction: 'Call', futureField: { keep: true }, externalState: 'closed', closedAt: null, pinned: true });
    expect(edited.refs[0].label).toBe('Renamed externally');
    expect((await sync())).toMatchObject({ created: 0, updated: 0 });
    expect((await storage.getById('threads', record.id)).updatedAt).toBe(edited.updatedAt);
    await storage.remove('threads', record.id);
    const tombstone = (await storage.getRawRecords('threads'))[record.id];
    execGh.mockResolvedValue(JSON.stringify([issue]));
    expect((await sync()).created).toBe(0);
    expect(await storage.getById('threads', record.id)).toBeNull();
    expect((await storage.getRawRecords('threads'))[record.id]).toEqual(tombstone);
  });
  it('leaves stored records untouched on failed, malformed, and empty probes', async () => {
    await sync();
    const before = await storage.getRawRecords('threads');
    for (const raw of [null, '{}', JSON.stringify([issue, { number: 99, state: 'OPEN' }]), '[]']) {
      execGh.mockResolvedValue(raw);
      if (raw === '[]') await expect(sync()).resolves.toMatchObject({ created: 0 });
      else await expect(sync()).rejects.toMatchObject({ code: 'THREAD_SYNC_FAILED' });
      expect(await storage.getRawRecords('threads')).toEqual(before);
    }
    execGh.mockRejectedValue(new Error('example transport failure'));
    await expect(sync()).rejects.toMatchObject({ code: 'THREAD_SYNC_FAILED' });
    ensureForgeReachable.mockResolvedValue({ ok: false });
    await expect(sync()).rejects.toMatchObject({ code: 'THREAD_SYNC_FAILED' });
    expect(await storage.getRawRecords('threads')).toEqual(before);
  });
  it('deduplicates runs, separates hosts, and does not create closed issues or restore detached refs', async () => {
    expect((await sync()).created).toBe(1);
    expect((await sync()).created).toBe(0);
    const record = await currentRecord();
    await storage.update('threads', record.id, { refs: [] });
    execGh.mockResolvedValue(JSON.stringify([{ ...issue, state: 'CLOSED' }, { ...issue, number: 99, state: 'CLOSED' }]));
    expect((await sync())).toMatchObject({ created: 0, updated: 1 });
    expect((await storage.getById('threads', record.id)).refs).toEqual([]);
    resolveAppForgeTarget.mockResolvedValue({ tracker: 'github', target: { forge: 'github', apiHost: 'github.com', fullName: `example/repo-${sequence}`, repoSpec: `github.com/example/repo-${sequence}` } });
    execGh.mockResolvedValue(JSON.stringify([issue]));
    expect((await sync()).created).toBe(1);
  });
  it('rejects unsupported apps before calling the forge', async () => {
    getAppById.mockResolvedValue(null);
    await expect(sync()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    getAppById.mockResolvedValue({ repoPath: '/example/repo' });
    resolveAppForgeTarget.mockResolvedValue({ tracker: 'jira', target: null });
    await expect(sync()).rejects.toMatchObject({ code: 'UNSUPPORTED_TRACKER' });
    expect(execGh).not.toHaveBeenCalled();
  });
  it('shares an in-flight request and releases the guard after a failure', async () => {
    let finish;
    execGh.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = syncGithubThreads({ appId: 'example-app' });
    expect(syncGithubThreads({ appId: 'example-app' })).toBe(first);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    finish(null);
    await expect(first).rejects.toMatchObject({ code: 'THREAD_SYNC_FAILED' });
    execGh.mockResolvedValue('[]');
    await expect(syncGithubThreads({ appId: 'example-app' })).resolves.toMatchObject({ created: 0 });
  });
});
