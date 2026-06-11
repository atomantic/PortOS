/**
 * Tests for queueBacklog coalescing in server/services/sharing/watcher.js
 *
 * The coalescing contract: a flood of concurrent queueBacklog(bucketId) calls
 * must collapse to at most one in-flight scan + one queued follow-up. When the
 * in-flight finishes, the queued run executes. All calls that arrive while a
 * scan is running share the same queued Promise, so processBacklog is never
 * called more than twice regardless of flood size.
 *
 * Testing strategy: mock importer.processBacklog with a controlled promise so
 * we can pause and resume the in-flight scan and count calls precisely.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock chokidar so attaching a watcher doesn't require real fs events.
vi.mock('chokidar', () => ({
  watch: vi.fn(() => ({
    on: vi.fn().mockReturnThis(),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Mock all the collaborators watcher.js pulls in.
vi.mock('./importer.js', () => ({
  processManifest: vi.fn().mockResolvedValue(undefined),
  processBacklog: vi.fn(),
  handleUnshare: vi.fn().mockResolvedValue(undefined),
  sharingEvents: { emit: vi.fn(), on: vi.fn() },
}));

vi.mock('./buckets.js', () => ({
  getBucket: vi.fn(),
  listBuckets: vi.fn().mockResolvedValue([]),
  ensureBucketLayout: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./manifest.js', () => ({
  isManifestPruning: vi.fn().mockReturnValue(false),
  pruneBucketManifests: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../instances.js', () => ({
  getInstanceId: vi.fn().mockResolvedValue('test-instance'),
  getPeers: vi.fn().mockResolvedValue([]),
}));

import { processBacklog } from './importer.js';
import {
  __queueBacklogForTests as queueBacklog,
  __backlogQueuesForTests as backlogQueues,
} from './watcher.js';

// Helper: create a deferred Promise so we can control when processBacklog resolves.
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('watcher — queueBacklog coalescing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear any residual queue state from other tests.
    backlogQueues.clear();
  });

  afterEach(() => {
    backlogQueues.clear();
  });

  it('calls processBacklog once when there is no in-flight scan', async () => {
    processBacklog.mockResolvedValue(undefined);

    await queueBacklog('bucket-1');

    expect(processBacklog).toHaveBeenCalledTimes(1);
    expect(processBacklog).toHaveBeenCalledWith('bucket-1');
    // Queue slot is cleaned up after the run.
    expect(backlogQueues.has('bucket-1')).toBe(false);
  });

  it('coalesces a flood of calls to at most two processBacklog invocations', async () => {
    // First scan is in-flight — hold it with a deferred.
    const d = deferred();
    processBacklog.mockReturnValueOnce(d.promise).mockResolvedValue(undefined);

    // Fire the first call (in-flight).
    const p1 = queueBacklog('bucket-flood');
    // Fire many more calls while the first scan is still running.
    const p2 = queueBacklog('bucket-flood');
    const p3 = queueBacklog('bucket-flood');
    const p4 = queueBacklog('bucket-flood');
    const p5 = queueBacklog('bucket-flood');

    // While in-flight, processBacklog should have been called exactly once.
    expect(processBacklog).toHaveBeenCalledTimes(1);

    // Release the first scan.
    d.resolve();
    await Promise.all([p1, p2, p3, p4, p5]);

    // After the in-flight scan completes, exactly one queued follow-up should
    // have fired — total calls is 2 (in-flight + one queued).
    expect(processBacklog).toHaveBeenCalledTimes(2);
    // Queue is fully drained.
    expect(backlogQueues.has('bucket-flood')).toBe(false);
  });

  it('all queued calls receive the same Promise (coalescing, not duplication)', async () => {
    const d = deferred();
    processBacklog.mockReturnValueOnce(d.promise).mockResolvedValue(undefined);

    // Start first in-flight call.
    queueBacklog('bucket-coalesce');
    // All subsequent calls while in-flight must return the SAME Promise.
    const q1 = queueBacklog('bucket-coalesce');
    const q2 = queueBacklog('bucket-coalesce');
    const q3 = queueBacklog('bucket-coalesce');

    // q1, q2, q3 are the queued promises — they must be the same reference.
    expect(q1).toBe(q2);
    expect(q2).toBe(q3);

    d.resolve();
    await Promise.all([q1, q2, q3]);
  });

  it('uses separate queue slots for different bucket ids', async () => {
    processBacklog.mockResolvedValue(undefined);

    await Promise.all([
      queueBacklog('bucket-A'),
      queueBacklog('bucket-B'),
    ]);

    // Each bucket is handled independently.
    expect(processBacklog).toHaveBeenCalledWith('bucket-A');
    expect(processBacklog).toHaveBeenCalledWith('bucket-B');
    // Both queue slots are cleaned up.
    expect(backlogQueues.has('bucket-A')).toBe(false);
    expect(backlogQueues.has('bucket-B')).toBe(false);
  });

  it('continues to accept new scans after the queue drains', async () => {
    processBacklog.mockResolvedValue(undefined);

    await queueBacklog('bucket-seq');
    expect(processBacklog).toHaveBeenCalledTimes(1);
    expect(backlogQueues.has('bucket-seq')).toBe(false);

    // A second call after draining should start a fresh in-flight scan.
    await queueBacklog('bucket-seq');
    expect(processBacklog).toHaveBeenCalledTimes(2);
  });

  it('swallows processBacklog errors without unhandled rejection', async () => {
    processBacklog.mockRejectedValue(new Error('scan failed'));

    // Should not throw — errors are caught inside queueBacklog.
    await expect(queueBacklog('bucket-err')).resolves.toBeUndefined();
    expect(backlogQueues.has('bucket-err')).toBe(false);
  });
});
