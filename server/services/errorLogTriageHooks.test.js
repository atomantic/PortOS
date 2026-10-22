import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./errorLogTriage.js', async (importOriginal) => ({
  ...(await importOriginal()),
  runErrorLogTriage: vi.fn(),
}));
vi.mock('./taskSchedule.js', () => ({ getTaskInterval: vi.fn() }));

const { runErrorLogTriage } = await import('./errorLogTriage.js');
const { getTaskInterval } = await import('./taskSchedule.js');
const { getTaskInputHook } = await import('./taskTypeHooks.js');

describe('error-log-triage input hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('runs the pass with the saved caps and provider pins, then skips the coordinator agent', async () => {
    getTaskInterval.mockResolvedValue({ providerId: 'p1', model: 'm1', effort: 'high', taskMetadata: { triageMaxInvestigations: 1 } });
    runErrorLogTriage.mockResolvedValue({ entries: 4, fingerprints: 2, comments: 1, regressions: 0, investigations: 1, lookupFailures: 0, deferred: 0 });
    const hook = await getTaskInputHook('error-log-triage');

    const result = await hook({ app: { id: null, name: 'PortOS' }, taskType: 'error-log-triage' });

    expect(runErrorLogTriage).toHaveBeenCalledWith({
      params: { triageMaxInvestigations: 1 },
      job: { providerId: 'p1', model: 'm1', effort: 'high' },
    });
    expect(result).toEqual({ skip: { reason: '4 new stderr entries in 2 fingerprint(s), 1 evidence comment(s), 1 investigation(s) queued' } });
  });

  it('refuses an app-scoped dispatch without reading any log', async () => {
    const hook = await getTaskInputHook('error-log-triage');
    expect(await hook({ app: { id: 'app-1', name: 'Example' } })).toEqual({ skip: { reason: 'install-wide-only' } });
    expect(runErrorLogTriage).not.toHaveBeenCalled();
  });
});
