import { usageBackfillEvents } from './usageBackfillEvents.js';
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

vi.mock('./grokUsageBackfill.js', () => ({
  applyGrokUsageRepair: vi.fn(async () => ({
    added: 0, turns: 0, images: 0, videos: 0, backedUp: false, note: null, backupDir: null,
  })),
}));

vi.mock('./agyUsageBackfill.js', () => ({
  applyAgyUsageRepair: vi.fn(async () => ({
    added: 0, images: 0, backedUp: false, note: null, backupDir: null,
  })),
}));

const {
  __resetHistoricalUsageBackfillForTests,
  getHistoricalUsageBackfillStatus,
  startHistoricalUsageBackfill,
  startCodexUsagePreview,
  cancelCodexUsagePreview
} = await import('./usageBackfill.js');
const { applyGrokUsageRepair } = await import('./grokUsageBackfill.js');
const { applyAgyUsageRepair } = await import('./agyUsageBackfill.js');

class FakeWorker extends EventEmitter {
  static instances = [];

  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    FakeWorker.instances.push(this);
  }

  unref() {}
  terminate() { this.emit('exit', 1); return Promise.resolve(1); }
}

beforeEach(() => {
  usageBackfillEvents.removeAllListeners();
  FakeWorker.instances = [];
  __resetHistoricalUsageBackfillForTests();
  applyGrokUsageRepair.mockReset();
  applyGrokUsageRepair.mockResolvedValue({
    added: 0, turns: 0, images: 0, videos: 0, backedUp: false, note: null, backupDir: null,
  });
});

describe('historical usage backfill job', () => {
  it('runs scanning off-thread and exposes progress through status', async () => {
    const updates = [];
    usageBackfillEvents.on('updated', () => updates.push(getHistoricalUsageBackfillStatus()));
    const started = await startHistoricalUsageBackfill({
      runsDir: '/example/runs',
      home: '/example/home',
      WorkerClass: FakeWorker
    });
    expect(started.status).toBe('running');
    expect(updates).toHaveLength(1);
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

    expect(updates.at(-1)).toMatchObject({ status: 'running', processed: 2 });
    const { applyHistoricalUsageCorrections } = await import('./usage.js');
    let finishWrite;
    applyHistoricalUsageCorrections.mockImplementationOnce(() => new Promise(resolve => { finishWrite = resolve; }));
    worker.emit('message', {
      type: 'complete',
      result: {
        processed: 5,
        total: 5,
        corrections: [{ runId: 'run-example-1', metadataPath: '/example/metadata.json' }]
      }
    });
    await vi.waitFor(() => expect(finishWrite).toBeTypeOf('function'));
    expect(updates.at(-1).status).toBe('running');
    finishWrite({ corrected: 1, correctedRunIds: ['run-example-1'] });
    await vi.waitFor(() => expect(getHistoricalUsageBackfillStatus()).toMatchObject({
      status: 'complete',
      corrected: 1,
      processed: 5,
      total: 5
    }));
    expect(updates.at(-1)).toMatchObject({ status: 'complete', corrected: 1 });
  });
});

it('notifies clients when the worker fails', async () => {
  const updated = vi.fn();
  usageBackfillEvents.on('updated', updated);
  await startHistoricalUsageBackfill({ WorkerClass: FakeWorker, providers: [] });
  updated.mockClear();
  FakeWorker.instances[0].emit('error', new Error('Example worker failure'));
  await vi.waitFor(() => expect(getHistoricalUsageBackfillStatus()).toMatchObject({
    status: 'error',
    error: 'Example worker failure',
    grok: { added: 0 },
  }));
  expect(updated).toHaveBeenCalledWith({});
  expect(applyGrokUsageRepair).toHaveBeenCalledTimes(1);
  expect(applyAgyUsageRepair).toHaveBeenCalledTimes(1);
});

it('puts the Grok repair on the reconcile result and runs it once', async () => {
  applyGrokUsageRepair.mockResolvedValue({
    added: 3,
    turns: 1,
    images: 2,
    videos: 0,
    backedUp: true,
    note: 'Long-context premiums were not added because no Grok usage scan has run yet.',
    backupDir: '/tmp/grok-usage-backup',
  });
  await startHistoricalUsageBackfill({ WorkerClass: FakeWorker, providers: [] });
  FakeWorker.instances[0].emit('message', {
    type: 'complete',
    result: { processed: 1, total: 1, corrections: [] },
  });
  await vi.waitFor(() => expect(getHistoricalUsageBackfillStatus()).toMatchObject({
    status: 'complete',
    corrected: 1,
    grok: {
      added: 3,
      turns: 1,
      images: 2,
      videos: 0,
      backedUp: true,
      note: 'Long-context premiums were not added because no Grok usage scan has run yet.',
    },
  }));
  expect(getHistoricalUsageBackfillStatus().grok.backupDir).toBeUndefined();
  expect(applyGrokUsageRepair).toHaveBeenCalledTimes(1);
  expect(applyAgyUsageRepair).toHaveBeenCalledTimes(1);
});

it('keeps a transcript failure from dropping a Grok repair that already landed', async () => {
  applyGrokUsageRepair.mockResolvedValue({
    added: 1, turns: 0, images: 1, videos: 0, backedUp: true, note: null, backupDir: '/tmp/backup',
  });
  await startHistoricalUsageBackfill({ WorkerClass: FakeWorker, providers: [] });
  FakeWorker.instances[0].emit('error', new Error('Example worker failure'));
  await vi.waitFor(() => expect(getHistoricalUsageBackfillStatus()).toMatchObject({
    status: 'error',
    error: 'Example worker failure',
    grok: { added: 1, images: 1, backedUp: true },
  }));
});


describe('read-only Codex preview job', () => {
  it('separates preview completion from every repair callback and guards cancellation by job id', async () => {
    const { applyHistoricalUsageCorrections } = await import('./usage.js');
    applyHistoricalUsageCorrections.mockClear();
    const started = startCodexUsagePreview({ from: '2026-10-01', to: '2026-10-31', home: '/example/home', WorkerClass: FakeWorker });
    const worker = FakeWorker.instances[0];
    expect(worker.options.workerData).toEqual({ mode: 'preview', from: '2026-10-01', to: '2026-10-31', home: '/example/home' });
    expect(await startHistoricalUsageBackfill({ WorkerClass: FakeWorker })).toMatchObject({ id: started.id, mode: 'preview' });
    expect(startCodexUsagePreview({ WorkerClass: FakeWorker }).id).toBe(started.id);
    expect((await cancelCodexUsagePreview('stale-id')).status).toBe('running');
    const result = { coverage: { complete: false }, ledgerOverlap: 'unknown', missingUsage: null };
    worker.emit('message', { type: 'complete', result });
    worker.emit('exit', 0);
    expect(getHistoricalUsageBackfillStatus()).toMatchObject({ status: 'complete', preview: result });
    expect(applyHistoricalUsageCorrections).not.toHaveBeenCalled();
    expect(applyGrokUsageRepair).not.toHaveBeenCalled();
    expect(applyAgyUsageRepair).not.toHaveBeenCalled();

    const next = startCodexUsagePreview({ from: '2026-10-01', to: '2026-10-31', WorkerClass: FakeWorker });
    expect((await cancelCodexUsagePreview(next.id)).status).toBe('cancelled');
    FakeWorker.instances[1].emit('message', { type: 'complete', result });
    worker.emit('error', new Error('private path must not escape'));
    expect(getHistoricalUsageBackfillStatus().status).toBe('cancelled');
    const retry = startCodexUsagePreview({ from: '2026-10-01', to: '2026-10-31', WorkerClass: FakeWorker });
    expect(retry.id).not.toBe(next.id);
    FakeWorker.instances[2].emit('exit', 1);
    expect(getHistoricalUsageBackfillStatus().status).toBe('error');
    expect(getHistoricalUsageBackfillStatus().preview).toBeUndefined();
  });
});


it('previews synthetic archived sources in the real worker without ledger writes', async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = await mkdtemp(join(tmpdir(), 'portos-preview-example-'));
  const directory = join(home, '.codex', 'archived_sessions');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'example.jsonl');
  const source = [
    { type: 'session_meta', payload: { id: 'example-session', model: 'example-model', cwd: '/private/example-workspace' } },
    { timestamp: '2026-10-02T10:00:00Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 20 } } } },
    { type: 'response_item', payload: { text: 'private transcript must not escape' } }
  ].map(line => JSON.stringify(line)).join('\n');
  await writeFile(path, source);
  const { atomicWrite } = await import('../lib/fileUtils.js');
  atomicWrite.mockClear();
  try {
    startCodexUsagePreview({ from: '2026-10-01', to: '2026-10-31', home });
    await vi.waitFor(() => expect(getHistoricalUsageBackfillStatus().status).toBe('complete'), { timeout: 10_000 });
    const status = getHistoricalUsageBackfillStatus();
    expect(status.preview).toMatchObject({ coverage: { complete: true, resolvedSessions: 1 }, totals: { tokensOut: 20 }, ledgerOverlap: 'unknown', missingUsage: null });
    expect(JSON.stringify(status)).not.toMatch(/private|example-session|example.jsonl/);
    expect(atomicWrite).not.toHaveBeenCalled();
    expect(await readFile(path, 'utf8')).toBe(source);
  } finally {
    await cancelCodexUsagePreview(getHistoricalUsageBackfillStatus().id);
    await rm(home, { recursive: true, force: true });
  }
}, 15_000);
