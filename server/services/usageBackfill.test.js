import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/fileUtils.js', () => ({
  atomicWrite: vi.fn(),
  PATHS: { runs: '/example/runs' },
  readJSONFile: vi.fn().mockResolvedValue(null)
}));

vi.mock('./usage.js', () => ({
  applyHistoricalUsageCorrections: vi.fn().mockResolvedValue({
    corrected: 1,
    correctedRunIds: ['run-example-1']
  }),
  getReconciledUsageRunIds: vi.fn().mockReturnValue(['run-live']),
  getSiblingReconciledUsageRunIds: vi.fn().mockReturnValue(['run-siblings-done'])
}));

vi.mock('./providers.js', () => ({
  listProviders: vi.fn().mockResolvedValue([
    { id: 'grok-cli', type: 'cli', command: 'grok', enabled: true, defaultModel: 'example-grok-model' }
  ])
}));

const {
  __resetHistoricalUsageBackfillForTests,
  getHistoricalUsageBackfillStatus,
  startHistoricalUsageBackfill
} = await import('./usageBackfill.js');

class FakeWorker extends EventEmitter {
  static instances = [];

  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    FakeWorker.instances.push(this);
  }

  unref() {}
}

beforeEach(() => {
  FakeWorker.instances = [];
  __resetHistoricalUsageBackfillForTests();
});

describe('historical usage backfill job', () => {
  it('runs scanning off-thread and exposes progress through status', async () => {
    const started = await startHistoricalUsageBackfill({
      runsDir: '/example/runs',
      home: '/example/home',
      WorkerClass: FakeWorker
    });
    expect(started.status).toBe('running');
    expect(FakeWorker.instances).toHaveLength(1);
    const worker = FakeWorker.instances[0];
    expect(worker.options.workerData).toMatchObject({
      runsDir: '/example/runs',
      home: '/example/home',
      reconciledRunIds: ['run-live'],
      // The sibling pass has its own marker so it can run on a run whose own
      // transcript was reconciled long ago (#5831).
      siblingReconciledRunIds: ['run-siblings-done']
    });
    // The provider list is resolved on THIS thread: the worker never has an
    // initialized toolkit, so a worker-side lookup would find no provider to
    // attribute a nested session to.
    expect(worker.options.workerData.providers).toHaveLength(1);

    worker.emit('message', { type: 'progress', progress: { processed: 2, total: 5, found: 1 } });
    await vi.waitFor(() => expect(getHistoricalUsageBackfillStatus()).toMatchObject({
      status: 'running',
      processed: 2,
      total: 5,
      found: 1
    }));

    worker.emit('message', {
      type: 'complete',
      result: {
        processed: 5,
        total: 5,
        corrections: [{ runId: 'run-example-1', metadataPath: '/example/metadata.json' }]
      }
    });
    await vi.waitFor(() => expect(getHistoricalUsageBackfillStatus()).toMatchObject({
      status: 'complete',
      corrected: 1,
      processed: 5,
      total: 5
    }));
  });
});
