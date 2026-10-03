import { EventEmitter } from 'node:events';
import { posix, win32 } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('chokidar', () => ({ watch: vi.fn() }));
vi.mock('./importer.js', () => ({
  processManifest: vi.fn(), processBacklog: vi.fn(), handleUnshare: vi.fn(),
  sharingEvents: { emit: vi.fn() },
}));
vi.mock('./buckets.js', () => ({
  getBucket: vi.fn(), listBuckets: vi.fn().mockResolvedValue([]),
  ensureBucketLayout: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./manifest.js', () => ({ isManifestPruning: vi.fn(), pruneBucketManifests: vi.fn() }));
vi.mock('../instanceIdentity.js', () => ({ getInstanceId: vi.fn() }));

import { watch } from 'chokidar';
import { processBacklog, processManifest, handleUnshare } from './importer.js';
import { getBucket, listBuckets, ensureBucketLayout } from './buckets.js';
import { isManifestPruning } from './manifest.js';
import { getInstanceId } from '../instanceIdentity.js';

let shutdown;
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
// Deliver a real attached listener's event and expose its completion to the test.
const deliver = (watcher, event, path) => Promise.all(watcher.listeners(event).map(listener => listener(path)));

async function loadWatcher(paths = posix, root = '/example/bucket') {
  vi.doMock('path', () => ({ join: paths.join, basename: paths.basename, sep: paths.sep }));
  getBucket.mockImplementation(async id => ({ id, name: 'Example bucket', path: root }));
  const module = await import('./watcher.js');
  shutdown = module.shutdownAllWatchers;
  return { ...module, root, paths };
}

async function attach(paths = posix, root = '/example/bucket') {
  const module = await loadWatcher(paths, root);
  return { ...module, watcher: await module.attachWatcher('bucket-example') };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  watch.mockImplementation(() => {
    const watcher = Object.assign(new EventEmitter(), { closed: false });
    watcher.close = vi.fn().mockImplementation(async () => {
      watcher.closed = true;
      watcher.removeAllListeners();
    });
    return watcher;
  });
  getInstanceId.mockReset().mockResolvedValue(null);
  listBuckets.mockReset().mockResolvedValue([]);
  ensureBucketLayout.mockReset().mockResolvedValue(undefined);
  processBacklog.mockReset().mockResolvedValue(undefined);
  processManifest.mockReset().mockResolvedValue(undefined);
  handleUnshare.mockReset().mockResolvedValue(undefined);
  isManifestPruning.mockReset().mockReturnValue(false);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  await shutdown?.();
  shutdown = null;
  vi.doUnmock('path');
  vi.restoreAllMocks();
});

describe.each([
  ['POSIX', posix, '/example/bucket'],
  ['Windows', win32, 'C:\\example\\bucket'],
])('share-bucket watcher on %s', (_label, paths, root) => {
  it('retries late assets and records, while dispatching only manifests for import and unshare', async () => {
    const { watcher } = await attach(paths, root);
    const asset = paths.join(root, 'assets', 'blobs', 'example-blob');
    const record = paths.join(root, 'records', 'universes', 'example.json');
    const manifest = paths.join(root, 'manifests', 'example-manifest.json');
    await deliver(watcher, 'add', asset);
    await deliver(watcher, 'change', record);
    expect(processBacklog).toHaveBeenCalledTimes(2);
    expect(processManifest).not.toHaveBeenCalled();
    await deliver(watcher, 'add', manifest);
    await deliver(watcher, 'change', manifest);
    expect(processManifest.mock.calls).toEqual([
      ['bucket-example', 'example-manifest.json'], ['bucket-example', 'example-manifest.json'],
    ]);
    await deliver(watcher, 'unlink', asset);
    await deliver(watcher, 'unlink', record);
    await deliver(watcher, 'unlink', paths.join(root, 'manifests-old', 'example.json'));
    expect(handleUnshare).not.toHaveBeenCalled();
    await deliver(watcher, 'unlink', manifest);
    expect(handleUnshare).toHaveBeenCalledExactlyOnceWith('bucket-example', 'example-manifest.json');
    isManifestPruning.mockReturnValue(true);
    await deliver(watcher, 'unlink', manifest);
    expect(handleUnshare).toHaveBeenCalledTimes(1);
  });
});

describe('share-bucket watcher backlog lifecycle', () => {
  it('coalesces each burst without overlapping or losing events during a follow-up scan', async () => {
    const { watcher, paths, root } = await attach();
    const first = deferred();
    const second = deferred();
    const secondStarted = deferred();
    let active = 0;
    let peak = 0;
    const scan = async pending => {
      active++;
      peak = Math.max(peak, active);
      await pending;
      active--;
    };
    processBacklog
      .mockImplementationOnce(() => scan(first.promise))
      .mockImplementationOnce(() => { secondStarted.resolve(); return scan(second.promise); })
      .mockImplementation(() => scan(Promise.resolve()));
    const event = () => deliver(watcher, 'add', paths.join(root, 'assets', 'blobs', 'example-blob'));
    const initial = event();
    const burst = [event(), event(), event()];
    expect(processBacklog).toHaveBeenCalledTimes(1);
    first.resolve();
    await secondStarted.promise;
    const late = event();
    const scansWhileFollowupRuns = processBacklog.mock.calls.length;
    second.resolve();
    await Promise.all([initial, ...burst, late]);
    expect(scansWhileFollowupRuns).toBe(2);
    expect(peak).toBe(1);
    expect(processBacklog).toHaveBeenCalledTimes(3);
    await event();
    expect(processBacklog).toHaveBeenCalledTimes(4);
  });

  it('recovers from a failed scan and lets a different bucket make progress', async () => {
    const { watcher, attachWatcher, paths, root } = await attach();
    const other = await attachWatcher('bucket-other');
    const blocked = deferred();
    processBacklog
      .mockImplementationOnce(() => blocked.promise.then(() => { throw new Error('Example scan failure'); }))
      .mockResolvedValue(undefined);
    const path = paths.join(root, 'records', 'example.json');
    const pending = deliver(watcher, 'change', path);
    const trailing = deliver(watcher, 'change', path);
    await deliver(other, 'change', path);
    expect(processBacklog.mock.calls.map(([id]) => id)).toEqual(['bucket-example', 'bucket-other']);
    blocked.resolve();
    await Promise.all([pending, trailing]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Example scan failure'));
    expect(processBacklog.mock.calls.map(([id]) => id)).toEqual(['bucket-example', 'bucket-other', 'bucket-example']);
    await deliver(watcher, 'change', path);
    expect(processBacklog).toHaveBeenCalledTimes(4);
  });

  it('bundle-sync path event with failing backlog scan does not produce unhandled rejection and subsequent scan still runs', async () => {
    const { watcher, paths, root } = await attach();
    const blocked = deferred();
    const secondStarted = deferred();
    processBacklog
      .mockImplementationOnce(() => blocked.promise.then(() => { throw new Error('Bundle sync backlog failure'); }))
      .mockImplementationOnce(() => { secondStarted.resolve(); return Promise.resolve(); });
    const assetPath = paths.join(root, 'assets', 'blobs', 'example-blob');
    const pending = deliver(watcher, 'add', assetPath);
    const trailing = deliver(watcher, 'add', assetPath);
    expect(processBacklog).toHaveBeenCalledTimes(1);
    blocked.resolve();
    await secondStarted.promise;
    await Promise.all([pending, trailing]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Bundle sync backlog failure'));
    expect(processBacklog).toHaveBeenCalledTimes(2);
  });
});

// Pause preparation before a handle exists, exposing admission/teardown races.
function pauseLayout() {
  const started = deferred();
  const layout = deferred();
  ensureBucketLayout.mockImplementationOnce(() => {
    started.resolve();
    return layout.promise;
  });
  return { started: started.promise, resume: layout.resolve };
}
const liveHandles = () => watch.mock.results.map(result => result.value).filter(watcher => !watcher.closed);

describe('share-bucket watcher attachment lifecycle', () => {
  it('serializes overlapping attachments and waits for the replaced handle to close', async () => {
    const { attachWatcher, listAttachedWatchers } = await loadWatcher();
    const layout = pauseLayout();
    const closing = deferred();
    const closeStarted = deferred();
    const old = Object.assign(new EventEmitter(), { closed: false });
    old.close = vi.fn(async () => {
      closeStarted.resolve();
      await closing.promise;
      old.closed = true;
      old.removeAllListeners();
    });
    watch.mockImplementationOnce(() => old);
    const first = attachWatcher('bucket-example');
    await layout.started;
    const second = attachWatcher('bucket-example');
    layout.resume();
    await first;
    await closeStarted.promise;
    expect(watch).toHaveBeenCalledTimes(1);
    closing.resolve();
    const current = await second;
    expect(liveHandles()).toEqual([current]);
    expect(listAttachedWatchers()).toEqual(['bucket-example']);
    await shutdown();
    expect(liveHandles()).toEqual([]);
  });

  it('detach during preparation waits for publication and closure before returning', async () => {
    const { attachWatcher, detachWatcher, listAttachedWatchers } = await loadWatcher();
    const layout = pauseLayout();
    const attaching = attachWatcher('bucket-example');
    await layout.started;
    let detached = false;
    const detaching = detachWatcher('bucket-example').then(() => { detached = true; });
    await Promise.resolve();
    expect(detached).toBe(false);
    layout.resume();
    const watcher = await attaching;
    await detaching;
    expect(watcher.closed).toBe(true);
    expect(listAttachedWatchers()).toEqual([]);
    expect(liveHandles()).toEqual([]);
  });

  it('shutdown drains overlapping admitted attachments and synchronously rejects later ones', async () => {
    const { attachWatcher, listAttachedWatchers, attachAllWatchers } = await loadWatcher();
    const layout = pauseLayout();
    const first = attachWatcher('bucket-example');
    await layout.started;
    const second = attachWatcher('bucket-example');
    let stopped = false;
    const stopping = shutdown().then(() => { stopped = true; });
    await expect(attachWatcher('bucket-late')).rejects.toThrow('watchers are shut down');
    expect(stopped).toBe(false);
    layout.resume();
    await Promise.all([first, second, stopping]);
    expect(watch).toHaveBeenCalledTimes(2);
    expect(listAttachedWatchers()).toEqual([]);
    expect(liveHandles()).toEqual([]);
    await expect(attachWatcher('bucket-late')).rejects.toThrow('watchers are shut down');
    listBuckets.mockResolvedValue([{ id: 'bucket-example', name: 'Example bucket' }]);
    await expect(attachAllWatchers()).resolves.toEqual({ attached: 1 });
    expect(liveHandles()).toHaveLength(1);
    await attachWatcher('bucket-other');
    expect(listAttachedWatchers()).toEqual(['bucket-example', 'bucket-other']);
  });

  it('explicit reinitialization waits for teardown and an older queued initialization cannot reopen admission', async () => {
    const { watcher, attachAllWatchers, attachWatcher, listAttachedWatchers } = await attach();
    const closing = deferred();
    const closeStarted = deferred();
    watcher.close.mockImplementationOnce(async () => {
      closeStarted.resolve();
      await closing.promise;
      watcher.closed = true;
      watcher.removeAllListeners();
    });
    const stopping = shutdown();
    await closeStarted.promise;
    const supersededInit = attachAllWatchers();
    const laterShutdown = shutdown();
    const freshInit = attachAllWatchers();
    expect(listBuckets).not.toHaveBeenCalled();
    await expect(attachWatcher('bucket-late')).rejects.toThrow('watchers are shut down');
    closing.resolve();
    await Promise.all([stopping, supersededInit, laterShutdown, freshInit]);
    expect(listBuckets).toHaveBeenCalledTimes(1);
    expect(liveHandles()).toEqual([]);
    await attachWatcher('bucket-example');
    expect(listAttachedWatchers()).toEqual(['bucket-example']);
  });

  it('shutdown during boot preparation closes its handles and boot cannot reopen admission', async () => {
    const { attachAllWatchers, attachWatcher, listAttachedWatchers } = await loadWatcher();
    listBuckets.mockResolvedValue([{ id: 'bucket-example', name: 'Example bucket' }]);
    const layout = pauseLayout();
    const initializing = attachAllWatchers();
    await layout.started;
    const stopping = shutdown();
    layout.resume();
    await Promise.all([initializing, stopping]);
    expect(watch).toHaveBeenCalledTimes(1);
    expect(liveHandles()).toEqual([]);
    expect(listAttachedWatchers()).toEqual([]);
    await expect(attachWatcher('bucket-late')).rejects.toThrow('watchers are shut down');
  });

  it('a failed replacement leaves no closed handle tracked and does not poison queued attachment or detach', async () => {
    const { watcher, attachWatcher, detachWatcher, listAttachedWatchers } = await attach();
    ensureBucketLayout.mockRejectedValueOnce(new Error('Example layout failure'));
    const failed = expect(attachWatcher('bucket-example')).rejects.toThrow('Example layout failure');
    const next = attachWatcher('bucket-other');
    const detaching = detachWatcher('bucket-other');
    await failed;
    const other = await next;
    await detaching;
    expect(watcher.closed).toBe(true);
    expect(other.closed).toBe(true);
    expect(listAttachedWatchers()).toEqual([]);
    expect(liveHandles()).toEqual([]);
  });

  it('failed closure retains ownership, drains other closes, and allows teardown to retry', async () => {
    const { watcher, attachWatcher, listAttachedWatchers } = await attach();
    const other = await attachWatcher('bucket-other');
    watcher.close.mockRejectedValueOnce(new Error('Example close failure'));
    await expect(shutdown()).rejects.toThrow('Failed to close share bucket watchers');
    expect(other.closed).toBe(true);
    expect(liveHandles()).toEqual([watcher]);
    expect(listAttachedWatchers()).toEqual(['bucket-example']);
    await shutdown();
    expect(liveHandles()).toEqual([]);
    expect(listAttachedWatchers()).toEqual([]);
  });
});
