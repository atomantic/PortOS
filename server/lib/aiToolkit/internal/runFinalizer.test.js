import { afterEach, describe, expect, it, vi } from 'vitest';
const { write, read } = vi.hoisted(() => ({ write: vi.fn(), read: vi.fn() }));
vi.mock('./atomicWrite.js', () => ({ atomicWrite: write }));
vi.mock('fs/promises', () => ({ readFile: read }));
import { createRunFinalizer } from './runFinalizer.js';
afterEach(() => { write.mockReset(); read.mockReset(); });
const fixture = (hooks = {}, extra = {}) => {
  let settled = false;
  const failed = vi.fn(); const complete = vi.fn();
  read.mockResolvedValue('{}'); write.mockResolvedValue();
  const finalizer = createRunFinalizer({ runId: 'example', provider: { id: 'example' }, startTime: Date.now(),
    activeRuns: new Map(), lifecycle: { markSettled: () => { if (settled) return false; settled = true; return true; } },
    outputPath: 'output', metadataPath: 'metadata', getOutput: () => 'thought', getReasoning: () => '',
    hooks, onComplete: complete, onPersistenceFailure: failed, consumeActiveStop: () => false,
    safeJsonParse: JSON.parse, safeSettle: fn => fn(), stallTimeout: 10, absoluteTimeout: 20, ...extra });
  return { finalizer, failed, complete };
};
describe('authoritative API finalization evidence', () => {
  it.each(['success', 'canceled', 'timeout'])('reports failed output persistence for %s', async type => {
    const { finalizer, failed, complete } = fixture();
    write.mockImplementation(async path => { if (path === 'output') throw new Error('write failed'); });
    await finalizer.finalize({ type, bound: 'stall' });
    expect(failed).toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it('holds settlement until asynchronous output hooks have finished', async () => {
    let release; const waiting = new Promise(resolve => { release = resolve; });
    const { finalizer, complete } = fixture({ onRunCompleted: () => waiting });
    const finishing = finalizer.finalize({ type: 'success' });
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    let done = false; finalizer.settled().then(() => { done = true; });
    await Promise.resolve(); expect(done).toBe(false);
    release(); await finishing; expect(done).toBe(true);
  });
  it('settles callbacks once without writing when publication admission is refused', async () => {
    const onRunFailed = vi.fn();
    const { finalizer, failed, complete } = fixture({ onRunFailed }, { withAssetPublication: async () => { throw new Error('busy'); } });
    await expect(finalizer.finalize({ type: 'success' })).resolves.toBe(true);
    expect(write).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalled();
    expect(onRunFailed).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0]).toMatchObject({ success: false });
  });
});
