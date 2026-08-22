import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The sweep's only two collaborators: the report (what to measure) and the
// single-model runner (measure it). Both are mocked so the queue's own behavior
// — order, cancellation, failure isolation — is what's under test.
// The restore stops and starts the daemon, so it takes the same machine-wide
// claim a measurement does — otherwise it can bounce llama-server underneath a
// reading somebody started the moment Stop re-enabled the button.
const claimHeavyLocalJob = vi.fn(async () => ({ ok: true, release: vi.fn(async () => {}) }));
vi.mock('../lib/heavyJobClaim.js', () => ({ claimHeavyLocalJob: (...args) => claimHeavyLocalJob(...args) }));

vi.mock('./localModelAssessments.js', () => ({
  getAssessmentReport: vi.fn(),
  runAssessment: vi.fn(),
  // A sweep may only drive a runtime it can reset AND put back. llama.cpp can;
  // the default here mirrors that so the tests exercise the real gate.
  isTuningSweepable: vi.fn((backend) => backend === 'llama'),
  captureLaunchState: vi.fn(async () => ({ model: '/models/example.gguf' })),
  restoreLaunchState: vi.fn(async () => ({ restored: true, reason: null })),
}));

import {
  captureLaunchState, getAssessmentReport, isTuningSweepable, restoreLaunchState, runAssessment,
} from './localModelAssessments.js';
import { startSweep, getSweepStatus, cancelSweep, __resetSweep } from './localModelAssessmentSweep.js';
// Not mocked: the grid is pure catalog data, and asserting the queue against the
// real one is what proves the service runs the configurations it advertises.
import { tuningGridFor } from '../lib/localModelTuning.js';

// Let the detached loop run to completion. The sweep deliberately does NOT
// return a promise for its own queue (the HTTP handler must return immediately),
// so a test has to drain the microtask queue instead.
const settle = async () => { for (let i = 0; i < 50; i += 1) await Promise.resolve(); };

const report = ({ unassessed = [], assessments = [], uninstalled = [] } = {}) => ({
  unassessed, assessments, uninstalled,
});

const measured = (verdict = 'fits', meanTokensPerSecond = 42) => ({
  verdict, performance: { meanTokensPerSecond, meanCharsPerSecond: 170 },
});

beforeEach(() => {
  vi.clearAllMocks();
  claimHeavyLocalJob.mockResolvedValue({ ok: true, release: vi.fn(async () => {}) });
  isTuningSweepable.mockImplementation((backend) => backend === 'llama');
  captureLaunchState.mockResolvedValue({ model: '/models/example.gguf' });
  restoreLaunchState.mockResolvedValue({ restored: true, reason: null });
  __resetSweep();
});
afterEach(() => __resetSweep());

describe('startSweep', () => {
  it('measures every unmeasured model in order and records what each produced', async () => {
    getAssessmentReport.mockResolvedValue(report({
      unassessed: [{ backend: 'ollama', modelId: 'a' }, { backend: 'ollama', modelId: 'b' }],
    }));
    runAssessment.mockResolvedValue(measured());

    const started = await startSweep({ scope: 'unmeasured' });
    expect(started.status).toBe('running');
    expect(started.total).toBe(2);

    await settle();
    const status = getSweepStatus();
    expect(status.status).toBe('complete');
    expect(status.results.map((r) => r.modelId)).toEqual(['a', 'b']);
    expect(status.results[0].meanTokensPerSecond).toBe(42);
    // Sequential by design — two models at once would measure the contention.
    expect(runAssessment).toHaveBeenCalledTimes(2);
  });

  it('passes each target\'s recorded tuning through, so a re-measure reproduces it', async () => {
    getAssessmentReport.mockResolvedValue(report({
      assessments: [{
        backend: 'llama', modelId: 'tuned', tuningKey: 'ctx=8192', tuningLabel: '8k',
        tuning: { contextSize: 8192 }, staleness: { stale: true },
      }],
    }));
    runAssessment.mockResolvedValue(measured());

    await startSweep({ scope: 'stale' });
    await settle();
    expect(runAssessment).toHaveBeenCalledWith(expect.objectContaining({
      backend: 'llama', modelId: 'tuned', tuning: { contextSize: 8192 },
    }));
  });

  // The point of an overnight run is that it gets through the list. One model
  // that throws must not abandon the rest of the queue.
  it('records a failed model as a result and keeps going', async () => {
    getAssessmentReport.mockResolvedValue(report({
      unassessed: [{ backend: 'ollama', modelId: 'broken' }, { backend: 'ollama', modelId: 'fine' }],
    }));
    runAssessment
      .mockRejectedValueOnce(new Error('backend refused the model'))
      .mockResolvedValueOnce(measured());

    await startSweep({ scope: 'unmeasured' });
    await settle();
    const status = getSweepStatus();
    expect(status.status).toBe('complete');
    expect(status.results[0]).toMatchObject({ modelId: 'broken', error: 'backend refused the model', verdict: null });
    expect(status.results[1]).toMatchObject({ modelId: 'fine', verdict: 'fits' });
  });

  it('never queues a model that is no longer installed', async () => {
    getAssessmentReport.mockResolvedValue(report({
      assessments: [
        { backend: 'ollama', modelId: 'gone', tuningKey: '', tuning: {}, staleness: { stale: true } },
        { backend: 'ollama', modelId: 'here', tuningKey: '', tuning: {}, staleness: { stale: true } },
      ],
      uninstalled: [{ backend: 'ollama', modelId: 'gone' }],
    }));
    runAssessment.mockResolvedValue(measured());

    const started = await startSweep({ scope: 'stale' });
    expect(started.total).toBe(1);
    await settle();
    expect(runAssessment).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'here' }));
  });

  // A refused start has to SAY so — a silent no-op would leave the page waiting
  // for progress that never arrives.
  it('refuses a second sweep while one is running', async () => {
    getAssessmentReport.mockResolvedValue(report({ unassessed: [{ backend: 'ollama', modelId: 'a' }] }));
    // Never resolves: the first sweep stays in flight for the duration.
    runAssessment.mockImplementation(() => new Promise(() => {}));

    await startSweep({ scope: 'unmeasured' });
    const second = await startSweep({ scope: 'unmeasured' });
    expect(second.rejected).toBe('a sweep is already running');
  });

  // The "already running" check and the slot claim must not be split by the
  // report await: two requests landing in that window would each publish a
  // `sweep` and launch a detached loop, so two overnight queues would measure the
  // same models against each other with only the second one's status visible.
  it('refuses a second sweep that arrives while the first is still reading the report', async () => {
    let releaseReport;
    getAssessmentReport.mockImplementationOnce(() => new Promise((resolve) => { releaseReport = resolve; }));
    runAssessment.mockResolvedValue(measured());

    const first = startSweep({ scope: 'unmeasured' });
    // Arrives before the report resolves — the first sweep object does not exist yet.
    const second = await startSweep({ scope: 'unmeasured' });
    expect(second.rejected).toBe('a sweep is already running');

    releaseReport(report({ unassessed: [{ backend: 'ollama', modelId: 'a' }] }));
    expect((await first).status).toBe('running');
    await settle();
    expect(runAssessment).toHaveBeenCalledTimes(1);
  });

  // A refused start must free the slot again, or one empty scope wedges the
  // feature until the process restarts.
  it('frees the slot when the start is refused', async () => {
    getAssessmentReport.mockResolvedValueOnce(report());
    expect((await startSweep({ scope: 'all' })).rejected).toBe('nothing to measure for that scope');

    getAssessmentReport.mockResolvedValue(report({ unassessed: [{ backend: 'ollama', modelId: 'a' }] }));
    runAssessment.mockResolvedValue(measured());
    expect((await startSweep({ scope: 'unmeasured' })).status).toBe('running');
  });

  it('refuses a scope that covers nothing', async () => {
    getAssessmentReport.mockResolvedValue(report());
    const result = await startSweep({ scope: 'all' });
    expect(result.rejected).toBe('nothing to measure for that scope');
    expect(runAssessment).not.toHaveBeenCalled();
  });

  it('emits start and per-model progress frames under the sweep scope', async () => {
    getAssessmentReport.mockResolvedValue(report({ unassessed: [{ backend: 'ollama', modelId: 'a' }] }));
    runAssessment.mockResolvedValue(measured());
    const frames = [];

    await startSweep({ scope: 'unmeasured', onProgress: (f) => frames.push(f) });
    await settle();
    expect(frames.map((f) => f.event)).toEqual(['start', 'model-start', 'complete']);
    expect(frames.every((f) => f.scope === 'assessment-sweep')).toBe(true);
  });

  it('survives a progress listener that throws', async () => {
    getAssessmentReport.mockResolvedValue(report({ unassessed: [{ backend: 'ollama', modelId: 'a' }] }));
    runAssessment.mockResolvedValue(measured());

    await startSweep({ scope: 'unmeasured', onProgress: () => { throw new Error('socket closed'); } });
    await settle();
    expect(getSweepStatus().status).toBe('complete');
  });
});

describe('cancelSweep', () => {
  it('stops the queue and keeps what was already measured', async () => {
    getAssessmentReport.mockResolvedValue(report({
      unassessed: [{ backend: 'ollama', modelId: 'a' }, { backend: 'ollama', modelId: 'b' }],
    }));
    // First model lands; the second reports itself cancelled, as runAssessment
    // does when it sees the abort signal.
    runAssessment
      .mockResolvedValueOnce(measured())
      .mockResolvedValueOnce({ cancelled: true });

    await startSweep({ scope: 'unmeasured' });
    await Promise.resolve();
    cancelSweep();
    await settle();

    const status = getSweepStatus();
    expect(status.status).toBe('cancelled');
    // The abandoned model is NOT a result — recording it would make a stopped
    // sweep look like it measured what it gave up on.
    expect(status.results.map((r) => r.modelId)).toEqual(['a']);
  });

  it('is a no-op when nothing is running', () => {
    expect(cancelSweep().status).toBe('idle');
  });

  // Cancelling frees the slot immediately, so a replacement sweep can start
  // while the abandoned one is still unwinding its last model. That loop must
  // not write its results (or its terminal frame) into the new queue.
  // A cancelled sweep is not finished with the machine: its last measurement is
  // still aborting, and a tuning sweep still has a launch configuration to put
  // back. A replacement started on top of that would be measuring through the
  // old sweep's relaunch.
  it('refuses a replacement while the cancelled sweep is still winding down', async () => {
    getAssessmentReport.mockResolvedValue(report({ unassessed: [{ backend: 'ollama', modelId: 'slow' }] }));
    let releaseFirst;
    runAssessment.mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve; }));

    await startSweep({ scope: 'unmeasured' });
    cancelSweep();

    const refused = await startSweep({ scope: 'unmeasured' });
    expect(refused.rejected).toMatch(/winding down/);

    releaseFirst(measured('fits', 9));
    await settle();
  });

  it('lets the next sweep start once the cancelled one has finished winding down', async () => {
    getAssessmentReport.mockResolvedValue(report({ unassessed: [{ backend: 'ollama', modelId: 'slow' }] }));
    let releaseFirst;
    runAssessment.mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve; }));

    await startSweep({ scope: 'unmeasured' });
    cancelSweep();
    releaseFirst({ cancelled: true });
    await settle();

    getAssessmentReport.mockResolvedValue(report({ unassessed: [{ backend: 'ollama', modelId: 'second' }] }));
    runAssessment.mockResolvedValue(measured());
    const started = await startSweep({ scope: 'unmeasured' });

    expect(started.rejected).toBeUndefined();
    await settle();
    expect(getSweepStatus().results.map((r) => r.modelId)).toEqual(['second']);
  });
});

describe('getSweepStatus', () => {
  it('reports idle before anything has been started', () => {
    expect(getSweepStatus()).toMatchObject({ status: 'idle', total: 0, completed: 0, current: null, results: [] });
  });

  it('never exposes the abort controller', async () => {
    getAssessmentReport.mockResolvedValue(report({ unassessed: [{ backend: 'ollama', modelId: 'a' }] }));
    runAssessment.mockImplementation(() => new Promise(() => {}));
    await startSweep({ scope: 'unmeasured' });
    expect(getSweepStatus().controller).toBeUndefined();
  });
});

describe('startSweep — the tuning dimension', () => {
  // The llama.cpp grid the service derives: backend defaults plus one variant
  // per sweepable knob. Asserted against the real catalog rather than a fixture,
  // because "the queue is the grid" is exactly the claim under test.
  const llamaGrid = tuningGridFor('llama');

  const onlyTarget = () => getAssessmentReport.mockResolvedValue(
    report({ unassessed: [{ backend: 'llama', modelId: 'target' }] })
  );

  it('measures one named model once per tuning, baseline first', async () => {
    onlyTarget();
    runAssessment.mockResolvedValue(measured());

    const started = await startSweep({ backend: 'llama', modelId: 'target', tunings: true });
    expect(started.total).toBe(llamaGrid.length);
    expect(started.mode).toBe('tunings');
    expect(started.target).toEqual({ backend: 'llama', modelId: 'target' });

    await settle();
    expect(runAssessment.mock.calls.map((c) => c[0].tuning)).toEqual(llamaGrid.map((v) => v.tuning));
    // Every variant is the same model, so the label is the only thing that
    // distinguishes one store record from the next.
    expect(getSweepStatus().results.map((r) => r.tuningLabel)).toEqual(llamaGrid.map((v) => v.label));
  });

  // A separate store record per variant is what `compareTunings` groups on — two
  // variants sharing a key would overwrite each other and leave nothing to rank.
  it('gives every variant a distinct tuning, so each lands as its own record', async () => {
    onlyTarget();
    runAssessment.mockResolvedValue(measured());

    await startSweep({ backend: 'llama', modelId: 'target', tunings: true });
    await settle();
    const keys = runAssessment.mock.calls.map((c) => JSON.stringify(c[0].tuning));
    expect(new Set(keys).size).toBe(keys.length);
  });

  // The grid is a domain decision, not a request parameter: a caller that could
  // hand one over could ask for an arbitrary batch of provider calls, and the
  // count the consent gate named would stop being the count that runs.
  it('derives the grid itself rather than accepting one', async () => {
    onlyTarget();
    runAssessment.mockResolvedValue(measured());

    await startSweep({ backend: 'llama', modelId: 'target', tunings: [{ ubatchSize: 99999 }] });
    await settle();
    expect(runAssessment.mock.calls.map((c) => c[0].tuning)).toEqual(llamaGrid.map((v) => v.tuning));
  });

  // Queuing a grid against a model that is not there would burn one doomed
  // measurement per variant and report the sweep as failed, not as a bad request.
  it('refuses a model no runtime has installed', async () => {
    getAssessmentReport.mockResolvedValue(report({ unassessed: [{ backend: 'llama', modelId: 'other' }] }));

    const result = await startSweep({ backend: 'llama', modelId: 'ghost', tunings: true });
    expect(result.rejected).toMatch(/not installed/);
    expect(runAssessment).not.toHaveBeenCalled();
  });

  // Naming a model leaves the scope nothing to decide. Without that, "sweep THIS
  // model" would silently do nothing whenever the model fell outside the scope —
  // and an already-measured model falls outside 'unmeasured' by definition.
  it('sweeps a named model the scope would have excluded', async () => {
    getAssessmentReport.mockResolvedValue(report({
      assessments: [{ backend: 'llama', modelId: 'measured-before', staleness: { stale: false } }],
    }));
    runAssessment.mockResolvedValue(measured());

    const started = await startSweep({ scope: 'unmeasured', backend: 'llama', modelId: 'measured-before', tunings: true });
    expect(started.total).toBe(llamaGrid.length);
  });

  // A model with two stored tunings is still ONE model to cross with the grid;
  // measuring each variant twice would put the same configuration on both sides
  // of the comparison table.
  it('crosses the grid once for a model that holds several stored tunings', async () => {
    getAssessmentReport.mockResolvedValue(report({
      assessments: [
        { backend: 'llama', modelId: 'target', tuningKey: '', tuning: {} },
        { backend: 'llama', modelId: 'target', tuningKey: 'flashAttn=true', tuning: { flashAttn: true } },
      ],
    }));
    runAssessment.mockResolvedValue(measured());

    const started = await startSweep({ backend: 'llama', modelId: 'target', tunings: true });
    expect(started.total).toBe(llamaGrid.length);
  });

  // A runtime PortOS cannot pass flags to yields the baseline alone — one
  // measurement with nothing to compare it to.
  it('refuses a runtime with no sweepable knob instead of measuring the baseline alone', async () => {
    isTuningSweepable.mockReturnValue(true);
    getAssessmentReport.mockResolvedValue(report({ unassessed: [{ backend: 'mtplx', modelId: 'target' }] }));

    const result = await startSweep({ backend: 'mtplx', modelId: 'target', tunings: true });
    expect(result.rejected).toMatch(/no tuning knobs/);
    expect(runAssessment).not.toHaveBeenCalled();
  });

  // A runtime whose knobs survive the sweep would leave them set for good AND
  // measure every later "backend defaults" reading under them — a comparison
  // that reads as valid and is not (#4763).
  it('refuses a runtime it cannot reset and put back', async () => {
    getAssessmentReport.mockResolvedValue(report({ unassessed: [{ backend: 'ollama', modelId: 'target' }] }));

    const result = await startSweep({ backend: 'ollama', modelId: 'target', tunings: true });
    expect(result.rejected).toMatch(/put the runtime back/);
    expect(runAssessment).not.toHaveBeenCalled();
    expect(getAssessmentReport).not.toHaveBeenCalled();
  });

  // Each variant's launch line has to be exactly that variant's knobs, and the
  // baseline's none of them — that is what the manager's reset does, and a
  // sweep that did not ask for it would measure accumulating launch lines.
  it('asks for a complete tuning on every variant, so none can accumulate', async () => {
    onlyTarget();
    runAssessment.mockResolvedValue(measured());

    await startSweep({ backend: 'llama', modelId: 'target', tunings: true });
    await settle();
    for (const [args] of runAssessment.mock.calls) expect(args.resetTuning).toBe(true);
  });

  // A plain endpoint model sweep re-measures each model under the tuning it
  // already carries. Endpoint runtimes have no sweep-safe reset/restore path.
  it('does not reset an endpoint model sweep', async () => {
    getAssessmentReport.mockResolvedValue(report({ unassessed: [{ backend: 'ollama', modelId: 'a' }] }));
    runAssessment.mockResolvedValue(measured());

    await startSweep({ scope: 'unmeasured' });
    await settle();
    expect(runAssessment.mock.calls[0][0].resetTuning).toBe(false);
    expect(captureLaunchState).not.toHaveBeenCalled();
  });

  it('resets each llama model to its recorded tuning and restores the daemon afterwards', async () => {
    getAssessmentReport.mockResolvedValue(report({
      unassessed: [
        { backend: 'llama', modelId: 'model-a' },
        { backend: 'llama', modelId: 'model-b' },
      ],
    }));
    runAssessment.mockResolvedValue(measured());

    await startSweep({ scope: 'unmeasured' });
    await settle();

    expect(captureLaunchState).toHaveBeenCalledWith('llama');
    expect(runAssessment.mock.calls.map(([args]) => args.resetTuning)).toEqual([true, true]);
    expect(restoreLaunchState).toHaveBeenCalledWith('llama', { model: '/models/example.gguf' });
  });

  // The running daemon is the only record of the launch flags the user chose, so
  // a sweep that rewrote it has to put it back — however the queue ended.
  it('captures the launch configuration first and restores it when the queue ends', async () => {
    onlyTarget();
    runAssessment.mockResolvedValue(measured());

    await startSweep({ backend: 'llama', modelId: 'target', tunings: true });
    expect(captureLaunchState).toHaveBeenCalledWith('llama');
    await settle();
    expect(restoreLaunchState).toHaveBeenCalledWith('llama', { model: '/models/example.gguf' });
  });

  it('restores the launch configuration after a cancelled sweep too', async () => {
    onlyTarget();
    runAssessment.mockImplementationOnce(() => { cancelSweep(); return Promise.resolve({ cancelled: true }); });

    await startSweep({ backend: 'llama', modelId: 'target', tunings: true });
    await settle();
    expect(restoreLaunchState).toHaveBeenCalledWith('llama', { model: '/models/example.gguf' });
  });

  // A restore that throws must not take the process down or leave the page
  // waiting on a sweep that never reports finished.
  it('finishes the sweep even when the restore fails', async () => {
    onlyTarget();
    runAssessment.mockResolvedValue(measured());
    restoreLaunchState.mockRejectedValue(new Error('llama-server would not come back'));

    await startSweep({ backend: 'llama', modelId: 'target', tunings: true });
    await settle();
    expect(getSweepStatus().status).toBe('complete');
  });

  // A tuning sweep varies the configuration of ONE model, so without a model
  // there is nothing to hold constant.
  it('refuses a tuning sweep with no model to sweep', async () => {
    getAssessmentReport.mockResolvedValue(report({ unassessed: [{ backend: 'llama', modelId: 'a' }] }));

    const result = await startSweep({ scope: 'all', tunings: true });
    expect(result.rejected).toMatch(/needs a model/);
    expect(getAssessmentReport).not.toHaveBeenCalled();
  });

  // The queue is shared, so cancelling a tuning sweep has to behave exactly as
  // cancelling a model sweep does — stop after the measurement in flight, keep
  // what already landed.
  it('stops after the in-flight variant when cancelled mid-sweep', async () => {
    onlyTarget();
    runAssessment
      .mockResolvedValueOnce(measured())
      .mockImplementationOnce(() => { cancelSweep(); return Promise.resolve({ cancelled: true }); });

    await startSweep({ backend: 'llama', modelId: 'target', tunings: true });
    await settle();
    const status = getSweepStatus();
    expect(status.status).toBe('cancelled');
    expect(status.results).toHaveLength(1);
    expect(runAssessment).toHaveBeenCalledTimes(2);
  });

  // Every step of a tuning sweep names the same model, so a frame without the
  // label reads as one measurement repeating.
  it('names the tuning in each progress frame', async () => {
    onlyTarget();
    runAssessment.mockResolvedValue(measured());
    const frames = [];

    await startSweep({ backend: 'llama', modelId: 'target', tunings: true, onProgress: (f) => frames.push(f) });
    await settle();
    const starts = frames.filter((f) => f.event === 'model-start');
    expect(starts.map((f) => f.tuningLabel)).toEqual(llamaGrid.map((v) => v.label));
    expect(starts[1].message).toContain(llamaGrid[1].label);
  });

  // The report already refuses to RANK a reading whose tuning never reached the
  // daemon. The sweep's own results list said nothing, so a variant that failed
  // to launch read as a clean measurement of the tuning it was labelled with —
  // the exact row a tuning sweep is opened for.
  it('carries an unapplied tuning through to the result, not just to the store', async () => {
    onlyTarget();
    runAssessment.mockResolvedValue({
      ...measured(),
      tuningApplied: false,
      tuningNotApplied: 'llama-server rejected that tuning',
    });

    await startSweep({ backend: 'llama', modelId: 'target', tunings: true });
    await settle();
    expect(getSweepStatus().results[0]).toMatchObject({
      tuningApplied: false,
      tuningNotApplied: 'llama-server rejected that tuning',
    });
  });

  // Nothing to capture means llama-server is stopped or someone else started it.
  // PortOS cannot put a tuning on its launch line, so every variant would record
  // "tuning not applied" and the comparison would rank configurations that never
  // ran — minutes of GPU for an answer that is not one.
  it('refuses when there is no launch configuration to vary', async () => {
    onlyTarget();
    captureLaunchState.mockResolvedValue(null);

    const result = await startSweep({ backend: 'llama', modelId: 'target', tunings: true });
    expect(result.rejected).toMatch(/start it from the LLMs page/);
    expect(runAssessment).not.toHaveBeenCalled();
  });

  // A restore stops and starts the daemon, which is exactly the disruption the
  // machine-wide claim exists to keep away from a measurement — and by then
  // `runAssessment` has released it and the page has re-enabled Measure.
  it('holds the machine-wide claim while it puts the launch configuration back', async () => {
    onlyTarget();
    runAssessment.mockResolvedValue(measured());
    const release = vi.fn(async () => {});
    claimHeavyLocalJob.mockResolvedValue({ ok: true, release });

    await startSweep({ backend: 'llama', modelId: 'target', tunings: true });
    await settle();
    expect(claimHeavyLocalJob).toHaveBeenCalledWith(expect.objectContaining({ kind: 'local-model assessment' }));
    expect(release).toHaveBeenCalled();
  });

  // A claim it cannot get is not a reason to skip: the daemon would stay on the
  // sweep's last variant, which is the thing the restore exists to prevent.
  it('restores anyway when the claim cannot be had', async () => {
    onlyTarget();
    runAssessment.mockResolvedValue(measured());
    claimHeavyLocalJob.mockResolvedValue({ ok: false, message: 'busy' });

    await startSweep({ backend: 'llama', modelId: 'target', tunings: true });
    await settle();
    expect(restoreLaunchState).toHaveBeenCalledWith('llama', { model: '/models/example.gguf' });
  });

  // A model sweep captured nothing, so there is nothing to put back and no
  // reason to take the machine for it.
  it('claims nothing when there is nothing to restore', async () => {
    getAssessmentReport.mockResolvedValue(report({ unassessed: [{ backend: 'ollama', modelId: 'a' }] }));
    runAssessment.mockResolvedValue(measured());

    await startSweep({ scope: 'unmeasured' });
    await settle();
    expect(claimHeavyLocalJob).not.toHaveBeenCalled();
  });

  // `settled` outlasts `status`: the page keeps its per-model actions disabled
  // while a stopped sweep is still aborting and still restoring.
  it('reports itself unsettled until the queue and the restore are both done', async () => {
    onlyTarget();
    let releaseRun;
    runAssessment.mockImplementationOnce(() => new Promise((resolve) => { releaseRun = resolve; }));

    await startSweep({ backend: 'llama', modelId: 'target', tunings: true });
    cancelSweep();
    expect(getSweepStatus().status).toBe('cancelled');
    expect(getSweepStatus().settled).toBe(false);

    releaseRun({ cancelled: true });
    await settle();
    expect(getSweepStatus().settled).toBe(true);
  });

  // The measurements all landed, so the sweep did not fail — but the runtime is
  // now serving the last variant's launch line, and nothing else on the page
  // would say so.
  it('reports a restore that did not happen without calling the sweep failed', async () => {
    onlyTarget();
    runAssessment.mockResolvedValue(measured());
    restoreLaunchState.mockResolvedValue({ restored: false, reason: 'llama-server is no longer PortOS-managed' });

    await startSweep({ backend: 'llama', modelId: 'target', tunings: true });
    await settle();
    const status = getSweepStatus();
    expect(status.status).toBe('complete');
    expect(status.error).toBeNull();
    expect(status.restoreError).toMatch(/no longer PortOS-managed/);
  });

  it('reports a restore that threw', async () => {
    onlyTarget();
    runAssessment.mockResolvedValue(measured());
    restoreLaunchState.mockRejectedValue(new Error('llama-server would not come back'));

    await startSweep({ backend: 'llama', modelId: 'target', tunings: true });
    await settle();
    expect(getSweepStatus().restoreError).toMatch(/would not come back/);
  });

  // A model sweep captured nothing, so "not restored" is the honest no-op — not
  // something to alarm the user about.
  it('does not report a restore failure for a sweep that captured nothing', async () => {
    getAssessmentReport.mockResolvedValue(report({ unassessed: [{ backend: 'ollama', modelId: 'a' }] }));
    runAssessment.mockResolvedValue(measured());

    await startSweep({ scope: 'unmeasured' });
    await settle();
    expect(getSweepStatus().restoreError).toBeNull();
  });

  it('reports the model sweep as mode "models" with no named target', async () => {
    getAssessmentReport.mockResolvedValue(report({ unassessed: [{ backend: 'ollama', modelId: 'a' }] }));
    runAssessment.mockResolvedValue(measured());

    const started = await startSweep({ scope: 'unmeasured' });
    expect(started.mode).toBe('models');
    expect(started.target).toBeNull();
    expect(started.scope).toBe('unmeasured');
  });

  // A tuning sweep of one named model never consulted the scope, so reporting
  // one would tell the page it measured a set it never looked at.
  it('reports no scope for a sweep of one named model', async () => {
    onlyTarget();
    runAssessment.mockResolvedValue(measured());

    const started = await startSweep({ scope: 'all', backend: 'llama', modelId: 'target', tunings: true });
    expect(started.scope).toBeNull();
  });
});
