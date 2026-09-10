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
import { getBucket } from './buckets.js';
import { isManifestPruning } from './manifest.js';

let shutdown;
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
// Deliver a real attached listener's event and expose its completion to the test.
const deliver = (watcher, event, path) => Promise.all(watcher.listeners(event).map(listener => listener(path)));

async function attach(paths = posix, root = '/example/bucket') {
  vi.doMock('path', () => ({ join: paths.join, basename: paths.basename, sep: paths.sep }));
  getBucket.mockImplementation(async id => ({ id, name: 'Example bucket', path: root }));
  const module = await import('./watcher.js');
  shutdown = module.shutdownAllWatchers;
  return { watcher: await module.attachWatcher('bucket-example'), attachWatcher: module.attachWatcher, root, paths };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  watch.mockImplementation(() => Object.assign(new EventEmitter(), { close: vi.fn().mockResolvedValue(undefined) }));
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
});
