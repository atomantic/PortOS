import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub the conductor so the runner test exercises the SSE lifecycle, not the
// LLM/record work.
const conductor = {
  generateStep: vi.fn(),
  refineStep: vi.fn(),
};
vi.mock('./storyBuilder.js', () => conductor);

const { startStepRun, isStepRunActive, attachClient, __testing } = await import('./storyBuilderRunner.js');

// Minimal SSE `res` double: captures written frames + close.
function fakeRes() {
  const writes = [];
  return {
    writes,
    frames: () => writes
      .filter((w) => w.startsWith('data: '))
      .map((w) => JSON.parse(w.slice(6).trim())),
    writeHead: vi.fn(),
    write: vi.fn((s) => writes.push(s)),
    end: vi.fn(),
    req: { on: vi.fn() },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  __testing.runs.clear();
});

describe('storyBuilderRunner', () => {
  it('streams start → progress → complete and clears the run', async () => {
    conductor.generateStep.mockImplementation(async (_id, _step, { onProgress }) => {
      // Yield first so the client attaches (after the kickoff returns) before
      // the progress/complete frames broadcast — mirrors the real HTTP flow
      // where the GET /progress lands after the POST and the `start` frame.
      await Promise.resolve();
      onProgress?.({ label: 'Planning…', phase: 'generate' });
      await Promise.resolve();
      return { providerId: 'p1', model: 'm1' };
    });

    const { runId, alreadyRunning } = startStepRun('stb-1', 'plotArc', { op: 'generate', providerId: 'p1' });
    expect(alreadyRunning).toBe(false);
    expect(isStepRunActive('stb-1', 'plotArc')).toBe(true);

    const res = fakeRes();
    expect(attachClient('stb-1', 'plotArc', res)).toBe(true);

    await flush();
    const types = res.frames().map((f) => f.type);
    expect(types).toContain('start');
    expect(types).toContain('progress');
    expect(types).toContain('complete');
    const complete = res.frames().find((f) => f.type === 'complete');
    expect(complete.runId).toBe(runId);
    expect(complete.providerId).toBe('p1');
    // generateStep was called with the forwarded option (op stripped off).
    expect(conductor.generateStep).toHaveBeenCalledWith('stb-1', 'plotArc', expect.objectContaining({ providerId: 'p1' }));
    expect(conductor.generateStep.mock.calls[0][2].op).toBeUndefined();
  });

  it('coalesces a second start for the same step onto the in-flight run', async () => {
    let resolve;
    conductor.generateStep.mockImplementation(() => new Promise((r) => { resolve = () => r({}); }));
    const first = startStepRun('stb-1', 'idea', { op: 'generate' });
    const second = startStepRun('stb-1', 'idea', { op: 'generate' });
    expect(second.alreadyRunning).toBe(true);
    expect(second.runId).toBe(first.runId);
    expect(conductor.generateStep).toHaveBeenCalledTimes(1);
    resolve();
    await flush();
  });

  it('flags a conflict when a different-op request collides with an in-flight run', async () => {
    let resolve;
    conductor.generateStep.mockImplementation(() => new Promise((r) => { resolve = () => r({}); }));
    startStepRun('stb-1', 'plotArc', { op: 'generate' });
    // A refine click lands on the same step while the generate is in flight: it
    // must report `conflict` + the live op so the client refuses to bind its
    // "Refined" handler to the generate's terminal frame.
    const collision = startStepRun('stb-1', 'plotArc', { op: 'refine', feedback: 'x' });
    expect(collision.alreadyRunning).toBe(true);
    expect(collision.conflict).toBe(true);
    expect(collision.op).toBe('generate');
    expect(conductor.refineStep).not.toHaveBeenCalled();
    resolve();
    await flush();
  });

  it('flags a conflict when a refine of a DIFFERENT target collides, but re-attaches the same one', async () => {
    let resolve;
    conductor.refineStep.mockImplementation(() => new Promise((r) => { resolve = () => r({}); }));
    const first = startStepRun('stb-1', 'characters', { op: 'refine', entryId: 'char-A' });
    // Same target + op → same work → safe re-attach (no conflict, same runId).
    const same = startStepRun('stb-1', 'characters', { op: 'refine', entryId: 'char-A' });
    expect(same.alreadyRunning).toBe(true);
    expect(same.conflict).toBeUndefined();
    expect(same.runId).toBe(first.runId);
    // Different target → different work → conflict, must not bind onto char-A's run.
    const other = startStepRun('stb-1', 'characters', { op: 'refine', entryId: 'char-B' });
    expect(other.conflict).toBe(true);
    expect(conductor.refineStep).toHaveBeenCalledTimes(1);
    resolve();
    await flush();
  });

  it('surfaces a refine failure as an error frame', async () => {
    conductor.refineStep.mockRejectedValue(new Error('LLM down'));
    startStepRun('stb-2', 'universeAesthetic', { op: 'refine', feedback: 'tighter' });
    const res = fakeRes();
    attachClient('stb-2', 'universeAesthetic', res);
    await flush();
    const err = res.frames().find((f) => f.type === 'error');
    expect(err).toBeTruthy();
    expect(err.error).toContain('LLM down');
    expect(conductor.refineStep).toHaveBeenCalledWith('stb-2', 'universeAesthetic', expect.objectContaining({ feedback: 'tighter' }));
  });

  it('starts a fresh run (not a stale coalesce) for a kickoff during the replay grace window', async () => {
    // First run completes synchronously; its record lingers in `runs` for the
    // closeJobAfterDelay grace window (done: true). A second kickoff in that
    // window must run real work, not coalesce onto the finished record.
    conductor.generateStep.mockResolvedValue({ providerId: 'p1' });
    const first = startStepRun('stb-1', 'idea', { op: 'generate' });
    await flush(); // first run reaches its terminal frame + marks done
    expect(conductor.generateStep).toHaveBeenCalledTimes(1);

    const second = startStepRun('stb-1', 'idea', { op: 'generate' });
    expect(second.alreadyRunning).toBe(false);
    expect(second.runId).not.toBe(first.runId);
    await flush();
    expect(conductor.generateStep).toHaveBeenCalledTimes(2);
  });

  it('attachClient returns false when no run is active for the step', () => {
    const res = fakeRes();
    expect(attachClient('stb-none', 'idea', res)).toBe(false);
  });
});
