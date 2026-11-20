/**
 * generateVideo.lifecycle.test.js
 *
 * Split from local.test.js (#16214); shared mocks live in local.testFixtures.js.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { join } from 'path';

// vi.mock factories are hoisted above imports; the shared fixtures module is
// loaded the same way so its state objects outlive vi.resetModules().
const fx = await vi.hoisted(() => import('./local.testFixtures.js'));
const { heavyClaimRelease, heavyClaimHandoff, MOCK_PATHS, isLtx2Python, probeState, fsState } = fx;

vi.mock('os', async (importOriginal) => fx.osFactory(importOriginal));
vi.mock('../../lib/heavyJobClaim.js', () => fx.heavyJobClaimFactory());
vi.mock('../localMemory.js', async (importOriginal) => fx.localMemoryFactory(importOriginal));
vi.mock('../../lib/fileUtils.js', () => fx.fileUtilsFactory());
vi.mock('../settings.js', () => fx.settingsFactory());
vi.mock('../../lib/mediaModels.js', async () => fx.mediaModelsFactory());
vi.mock('../../lib/sseUtils.js', () => fx.sseUtilsFactory());
vi.mock('../../lib/ffmpeg.js', async () => fx.ffmpegFactory());
vi.mock('./extendSplice.js', () => fx.extendSpliceFactory());
vi.mock('../../lib/lipsyncAlign.js', () => fx.lipsyncAlignFactory());
vi.mock('../hfToken.js', () => fx.hfTokenFactory());
vi.mock('../../lib/hfCache.js', async (original) => fx.hfCacheFactory(original));
vi.mock('fs', () => fx.fsFactory());
vi.mock('../../lib/frameQuality.js', async (importOriginal) => fx.frameQualityFactory(importOriginal));
vi.mock('./runtimes.js', async (importOriginal) => fx.runtimesFactory(importOriginal));
vi.mock('../loras.js', () => fx.lorasFactory());
vi.mock('../loraEffectProbe.js', () => fx.loraEffectProbeFactory());
vi.mock('./ensureWeights.js', async (importOriginal) => fx.ensureWeightsFactory(importOriginal));
vi.mock('../../lib/childProcess.js', () => fx.childProcessFactory());
vi.mock('../../lib/detachedSpawn.js', () => fx.detachedSpawnFactory());
vi.mock('fs/promises', () => fx.fsPromisesMock);

// ─── module under test ───────────────────────────────────────────────────────
let generateVideo;
let videoGenEvents;

beforeEach(async () => {
  vi.resetModules();
  fx.resetFsPromisesReadFile();
  ({ generateVideo } = await import('./local.js'));
  ({ videoGenEvents } = await import('./events.js'));
});

afterEach(async () => {
  await fx.resetSharedMocks();
});

describe('generateVideo — panel-side completion watchdog', () => {
  // The fake-timer tests below advance a fixed number of ticks, which only
  // covers generateVideo's lazy `import()`s (loraStages, history, peer-sync, ...)
  // once they are loaded. In the monolithic suite earlier tests did that; run one
  // real render up front so each test here starts from the same warm state.
  beforeAll(async () => {
    const { generateVideo: warmGenerate } = await import('./local.js');
    const { videoGenEvents: warmEvents } = await import('./events.js');
    await fx.renderToTerminal(warmGenerate, warmEvents, {
      jobId: 'watchdog-warmup',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'warm the lazy imports',
      width: 512, height: 512, numFrames: 25, fps: 24,
      mode: 'text',
    });
    await fx.resetSharedMocks();
  });

  // Build a fake child that does NOT auto-exit, exposing handles to its stdout
  // 'data' listener and 'close' handler so the test can drive completion
  // detection + the grace-timer escalation deterministically.
  function makeHangingProc() {
    const listeners = {};
    let stdoutData = null;
    const proc = {
      pid: 4242,
      exitCode: null, // stays null — the child never exits on its own
      signalCode: null,
      killed: false,
      stdout: { on: vi.fn((event, fn) => { if (event === 'data') stdoutData = fn; }) },
      stderr: { on: vi.fn() },
      on(event, fn) { listeners[event] = fn; return proc; },
      off(event, fn) { if (listeners[event] === fn) delete listeners[event]; return proc; },
      kill: vi.fn((signal) => { proc.killed = true; proc.signalCode = signal; }),
    };
    return {
      proc,
      emitStdout: (text) => stdoutData?.(Buffer.from(text)),
      fireClose: (code, signal) => listeners.close?.(code, signal),
    };
  }

  beforeEach(async () => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.VIDEOGEN_COMPLETION_WATCHDOG_MS;
  });

  it('SIGKILLs a child that prints the result JSON but never exits, after the grace window', async () => {
    process.env.VIDEOGEN_COMPLETION_WATCHDOG_MS = '40000';
    // re-import so the module-level grace constant picks up the env override
    vi.resetModules();
    ({ generateVideo } = await import('./local.js'));

    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const hang = makeHangingProc();
    vi.mocked(spawnDetached).mockImplementationOnce(async () => hang.proc);

    generateVideo({
      jobId: 'watchdog-json-hang',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'render and hang',
      width: 512, height: 512, numFrames: 25, fps: 24,
      mode: 'text',
    });

    // Let generateVideo run far enough to register stdout/close handlers.
    await vi.advanceTimersByTimeAsync(0);

    // The render finishes its real work and emits the result JSON, then hangs.
    hang.emitStdout('{"video_path": "/data/videos/out.mp4"}\n');
    expect(hang.proc.kill).not.toHaveBeenCalled();

    // Just before the grace window, still no kill.
    await vi.advanceTimersByTimeAsync(39999);
    expect(hang.proc.kill).not.toHaveBeenCalled();

    // Past the grace window — the watchdog escalates to SIGKILL.
    await vi.advanceTimersByTimeAsync(2);
    expect(hang.proc.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('SIGKILLs a child that prints the muxing-done line but never exits', async () => {
    process.env.VIDEOGEN_COMPLETION_WATCHDOG_MS = '40000';
    vi.resetModules();
    ({ generateVideo } = await import('./local.js'));

    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const hang = makeHangingProc();
    vi.mocked(spawnDetached).mockImplementationOnce(async () => hang.proc);

    generateVideo({
      jobId: 'watchdog-mux-hang',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'mux and hang',
      width: 512, height: 512, numFrames: 25, fps: 24,
      mode: 'text',
    });
    await vi.advanceTimersByTimeAsync(0);

    hang.emitStdout('[Decoding video + audio + muxing] done in 3.2s\n');
    await vi.advanceTimersByTimeAsync(40001);
    expect(hang.proc.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('reports completed (not failed) when the watchdog SIGKILL fires after a real render finished', async () => {
    process.env.VIDEOGEN_COMPLETION_WATCHDOG_MS = '40000';
    vi.resetModules();
    ({ generateVideo } = await import('./local.js'));
    ({ videoGenEvents } = await import('./events.js'));

    // The output file exists + is non-empty (fs mock already returns true/size 1000),
    // so the watchdog-killed render must be treated as a success.
    const { existsSync, statSync } = await import('fs');
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(statSync).mockReturnValue({ size: 1000 });

    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const hang = makeHangingProc();
    vi.mocked(spawnDetached).mockImplementationOnce(async () => hang.proc);

    const events = [];
    const onCompleted = (e) => events.push(['completed', e]);
    const onFailed = (e) => events.push(['failed', e]);
    videoGenEvents.on('completed', onCompleted);
    videoGenEvents.on('failed', onFailed);

    generateVideo({
      jobId: 'watchdog-success-recover',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'render then teardown-hang',
      width: 512, height: 512, numFrames: 25, fps: 24,
      mode: 'text',
    });
    await vi.advanceTimersByTimeAsync(0);

    // Render emits its result JSON, then hangs in teardown.
    hang.emitStdout('{"video_path": "/data/videos/out.mp4"}\n');
    // Watchdog fires the SIGKILL past the grace window.
    await vi.advanceTimersByTimeAsync(40001);
    expect(hang.proc.kill).toHaveBeenCalledWith('SIGKILL');
    // The OS delivers the kill → 'close' fires with signal SIGKILL.
    hang.fireClose(null, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(0);

    videoGenEvents.off('completed', onCompleted);
    videoGenEvents.off('failed', onFailed);

    const kinds = events.map(([k]) => k);
    expect(kinds).toContain('completed');
    expect(kinds).not.toContain('failed');
  });

  it('still reports failed when a SIGKILL arrives without a completion marker (real OOM kill)', async () => {
    process.env.VIDEOGEN_COMPLETION_WATCHDOG_MS = '40000';
    vi.resetModules();
    ({ generateVideo } = await import('./local.js'));
    ({ videoGenEvents } = await import('./events.js'));

    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const hang = makeHangingProc();
    vi.mocked(spawnDetached).mockImplementationOnce(async () => hang.proc);

    const events = [];
    const onCompleted = (e) => events.push(['completed', e]);
    const onFailed = (e) => events.push(['failed', e]);
    videoGenEvents.on('completed', onCompleted);
    videoGenEvents.on('failed', onFailed);

    generateVideo({
      jobId: 'watchdog-oom-kill',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'oom before completion',
      width: 512, height: 512, numFrames: 25, fps: 24,
      mode: 'text',
    });
    await vi.advanceTimersByTimeAsync(0);

    // No completion marker ever seen — the kernel OOM-kills the child mid-render.
    hang.fireClose(null, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(0);

    videoGenEvents.off('completed', onCompleted);
    videoGenEvents.off('failed', onFailed);

    const kinds = events.map(([k]) => k);
    expect(kinds).toContain('failed');
    expect(kinds).not.toContain('completed');
  });

  it('does NOT SIGKILL when the child exits cleanly after completion (timer is cleared on close)', async () => {
    process.env.VIDEOGEN_COMPLETION_WATCHDOG_MS = '40000';
    vi.resetModules();
    ({ generateVideo } = await import('./local.js'));

    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const hang = makeHangingProc();
    vi.mocked(spawnDetached).mockImplementationOnce(async () => hang.proc);

    generateVideo({
      jobId: 'watchdog-clean-exit',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'render and exit',
      width: 512, height: 512, numFrames: 25, fps: 24,
      mode: 'text',
    });
    await vi.advanceTimersByTimeAsync(0);

    // Completion marker arms the watchdog…
    hang.emitStdout('{"video_path": "/data/videos/out.mp4"}\n');
    // …but the child then exits cleanly well within the grace window.
    hang.proc.exitCode = 0;
    hang.fireClose(0, null);
    await vi.advanceTimersByTimeAsync(0);

    // Advancing past the grace window must NOT trigger a SIGKILL — the close
    // handler cleared the timer.
    await vi.advanceTimersByTimeAsync(60000);
    expect(hang.proc.kill).not.toHaveBeenCalled();
  });

  it('allows a render to continue without a completion marker', async () => {
    process.env.VIDEOGEN_COMPLETION_WATCHDOG_MS = '40000';
    vi.resetModules();
    ({ generateVideo } = await import('./local.js'));

    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const hang = makeHangingProc();
    vi.mocked(spawnDetached).mockImplementationOnce(async () => hang.proc);

    generateVideo({
      jobId: 'watchdog-no-marker',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'progress only',
      width: 512, height: 512, numFrames: 25, fps: 24,
      mode: 'text',
    });
    await vi.advanceTimersByTimeAsync(0);

    // A render may be silent for an extended period before it exits. The
    // completion watchdog is not armed until a completion marker is seen, and
    // there is no separate idle timeout that can terminate this render.
    await vi.advanceTimersByTimeAsync(120000);
    expect(hang.proc.kill).not.toHaveBeenCalled();
  });
});

// ── one-shot prompt-encode relaunch after a Metal watchdog abort (#4589) ─────
// A real Metal abort can't be produced here, so the child is driven directly:
// the marker lines and the abort banner are pushed onto its stderr, then it is
// closed on SIGABRT exactly as the OS would. What is under test is the decision
// generateVideo makes from that wreckage — relaunch or fail — plus the argv the
// relaunch carries.
describe('generateVideo — Gemma prompt-encode watchdog relaunch', () => {
  const TIMEOUT_ABORT = 'libc++abi: terminating due to uncaught exception of type std::runtime_error: [METAL] Command buffer execution failed: Caused GPU Timeout Error (00000002:kIOGPUCommandBufferCallbackErrorTimeout)';
  const INTERACTIVITY_ABORT = 'libc++abi: terminating due to uncaught exception: [METAL] Command buffer execution failed: (00000004:kIOGPUCommandBufferCallbackErrorImpactingInteractivity)';
  const OOM_ABORT = '[METAL] Command buffer execution failed: (00000008:kIOGPUCommandBufferCallbackErrorOutOfMemory)';

  // A child whose stderr and terminal signal the test drives by hand. The
  // shared makeProc() closes itself on exit 0, which is the opposite of every
  // case here.
  const makeDrivenProc = (pid, { failWiring = false } = {}) => {
    const listeners = {};
    const onData = {};
    const proc = {
      pid,
      exitCode: null,
      signalCode: null,
      killed: false,
      stdout: {
        on: vi.fn((event, fn) => {
          if (failWiring) throw new Error('stdout stream vanished');
          onData[`stdout:${event}`] = fn;
        }),
      },
      stderr: { on: vi.fn((event, fn) => { onData[`stderr:${event}`] = fn; }) },
      on(event, fn) { listeners[event] = fn; return proc; },
      off(event, fn) { if (listeners[event] === fn) delete listeners[event]; return proc; },
      kill: vi.fn(),
    };
    return {
      proc,
      // Full wiring — the stdout reader goes on with the real terminal handler,
      // and only there. The pre-handoff buffer's output listeners are marked
      // separately, so this stays false across the handoff window even though
      // the child's output and exit can no longer be lost.
      isWired: () => typeof onData['stdout:data'] === 'function' && !onData['stdout:data'].__earlyBuffer,
      stderr: (text) => onData['stderr:data']?.(Buffer.from(`${text}\n`)),
      close: async (code, signal) => {
        proc.exitCode = code;
        proc.signalCode = signal;
        await listeners.close?.(code, signal);
      },
      abort: async (signal = 'SIGABRT') => {
        proc.signalCode = signal;
        await listeners.close?.(null, signal);
      },
      finish: async () => {
        proc.exitCode = 0;
        await listeners.close?.(0, null);
      },
    };
  };

  let restorePlatform = () => {};
  let restoreArch = () => {};
  let failures;
  let onFailed;

  beforeEach(async () => {
    // The command-buffer watchdog is a macOS construct and generateVideo gates
    // the relaunch on the real platform, so pin it — otherwise this whole
    // describe would silently assert "never relaunches" on Windows CI.
    // Pinned inside the hook, never at module scope: local.js is already
    // imported by then.
    const { pinPlatform, pinArch } = await import('../../lib/testHelper.js');
    restorePlatform = pinPlatform('darwin');
    restoreArch = pinArch('arm64');
    failures = [];
    onFailed = (payload) => failures.push(payload);
    videoGenEvents.on('failed', onFailed);
  });

  afterEach(() => {
    videoGenEvents.off('failed', onFailed);
    restorePlatform();
    restoreArch();
  });

  const startRender = async (jobId, children) => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();
    for (const child of children) spawnMock.mockResolvedValueOnce(child.proc);
    await generateVideo({
      jobId,
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'a lighthouse in fog',
      width: 512,
      height: 512,
      numFrames: 25,
      fps: 24,
      seed: 987654,
    });
    return spawnMock;
  };

  const ltx2Calls = (spawnMock) => spawnMock.mock.calls.filter(([bin]) => isLtx2Python(bin));
  const flagValue = (args, flag) => args[args.indexOf(flag) + 1];

  it.each([
    ['the classic timeout signature', TIMEOUT_ABORT],
    ['the impacting-interactivity signature newer macOS reports', INTERACTIVITY_ABORT],
  ])('relaunches once with smaller command buffers, prompt untouched, on %s', async (_label, abort) => {
    const first = makeDrivenProc(101);
    const second = makeDrivenProc(102);
    const spawnMock = await startRender(`pe-${abort.length}`, [first, second]);

    first.stderr('STAGE:encode-prompt');
    first.stderr(abort);
    await first.abort();

    const calls = ltx2Calls(spawnMock);
    expect(calls).toHaveLength(2);
    const [firstArgs, retryArgs] = calls.map(([, args]) => args);
    // Recovery never shortens the encoder sequence (the encoder would drop the
    // START of the prompt): the args are byte-identical and only the env differs.
    expect(retryArgs).toEqual(firstArgs);
    expect(retryArgs).not.toContain('--gemma-max-length');
    expect(calls[0][2].env.MLX_MAX_OPS_PER_BUFFER).toBeUndefined();
    expect(calls[1][2].env).toMatchObject({ MLX_MAX_OPS_PER_BUFFER: '4', MLX_MAX_MB_PER_BUFFER: '16' });
    // Same render, smaller command buffers: seed and output must survive verbatim
    // or the relaunch silently produces a different clip than the user asked for.
    expect(flagValue(retryArgs, '--seed')).toBe(flagValue(firstArgs, '--seed'));
    expect(flagValue(retryArgs, '--seed')).toBe('987654');
    expect(flagValue(retryArgs, '--output')).toBe(flagValue(firstArgs, '--output'));
    expect(flagValue(retryArgs, '--prompt')).toBe(flagValue(firstArgs, '--prompt'));
    // The aborted child must not surface as a terminal failure — the job is
    // still running, on its replacement child.
    expect(failures).toHaveLength(0);

    await second.finish();
  });

  // After the encode finished, a shorter prompt cannot help — but smaller MLX
  // command buffers can. Same abort, one extra marker line: the relaunch carries
  // the buffer caps in its env and NOT the Gemma flag.
  it('relaunches once with smaller MLX command buffers when the abort lands after the prompt encode', async () => {
    const first = makeDrivenProc(103);
    const second = makeDrivenProc(109);
    const spawnMock = await startRender('pe-after-encode', [first, second]);

    first.stderr('STAGE:encode-prompt');
    first.stderr('STAGE:encode-prompt-done');
    first.stderr(TIMEOUT_ABORT);
    await first.abort();

    const calls = ltx2Calls(spawnMock);
    expect(calls).toHaveLength(2);
    expect(calls[1][1]).not.toContain('--gemma-max-length');
    expect(calls[0][2].env.MLX_MAX_OPS_PER_BUFFER).toBeUndefined();
    expect(calls[1][2].env).toMatchObject({ MLX_MAX_OPS_PER_BUFFER: '4', MLX_MAX_MB_PER_BUFFER: '16' });
    expect(failures).toHaveLength(0);

    // A second abort at the short setting surfaces the normal error.
    second.stderr(TIMEOUT_ABORT);
    await second.abort();
    expect(ltx2Calls(spawnMock)).toHaveLength(2);
    expect(failures).toHaveLength(1);
    expect(failures[0].error).toMatch(/SIGABRT/);
  });

  it('spends one relaunch per job — a buffer retry is not followed by a prompt-encode retry', async () => {
    const first = makeDrivenProc(112);
    const second = makeDrivenProc(113);
    const spawnMock = await startRender('pe-buffer-then-encode', [first, second]);

    first.stderr('STAGE:encode-prompt-done');
    first.stderr(TIMEOUT_ABORT);
    await first.abort();
    expect(ltx2Calls(spawnMock)).toHaveLength(2);

    second.stderr('STAGE:encode-prompt');
    second.stderr(TIMEOUT_ABORT);
    await second.abort();

    expect(ltx2Calls(spawnMock)).toHaveLength(2);
    expect(failures).toHaveLength(1);
  });

  it('does not use smaller command buffers off Apple silicon', async () => {
    restoreArch();
    const { pinArch } = await import('../../lib/testHelper.js');
    restoreArch = pinArch('x64');
    const first = makeDrivenProc(110);
    const spawnMock = await startRender('pe-x64', [first]);

    first.stderr('STAGE:encode-prompt-done');
    first.stderr(TIMEOUT_ABORT);
    await first.abort();

    expect(ltx2Calls(spawnMock)).toHaveLength(1);
    expect(failures).toHaveLength(1);
  });

  it('does not use smaller command buffers on an out-of-memory abort after the encode', async () => {
    const first = makeDrivenProc(111);
    const spawnMock = await startRender('pe-oom-after-encode', [first]);

    first.stderr('STAGE:encode-prompt-done');
    first.stderr(OOM_ABORT);
    await first.abort();

    expect(ltx2Calls(spawnMock)).toHaveLength(1);
    expect(failures).toHaveLength(1);
  });

  // An OOM abort is not a watchdog timeout: a shorter prompt does not fix it,
  // and relaunching burns another model load on a machine already out of room.
  it('does not relaunch on an out-of-memory abort inside the encoder', async () => {
    const first = makeDrivenProc(104);
    const spawnMock = await startRender('pe-oom', [first]);

    first.stderr('STAGE:encode-prompt');
    first.stderr(OOM_ABORT);
    await first.abort();

    expect(ltx2Calls(spawnMock)).toHaveLength(1);
    expect(failures).toHaveLength(1);
  });

  it('relaunches at most once — a second abort at the smaller setting fails the job', async () => {
    const first = makeDrivenProc(105);
    const second = makeDrivenProc(106);
    const spawnMock = await startRender('pe-twice', [first, second]);

    first.stderr('STAGE:encode-prompt');
    first.stderr(TIMEOUT_ABORT);
    await first.abort();
    expect(ltx2Calls(spawnMock)).toHaveLength(2);

    second.stderr('STAGE:encode-prompt');
    second.stderr(TIMEOUT_ABORT);
    await second.abort();

    expect(ltx2Calls(spawnMock)).toHaveLength(2);
    expect(failures).toHaveLength(1);
  });

  it('never relaunches off macOS, where the command-buffer watchdog does not exist', async () => {
    restorePlatform();
    const { pinPlatform } = await import('../../lib/testHelper.js');
    restorePlatform = pinPlatform('win32');
    const first = makeDrivenProc(107);
    const spawnMock = await startRender('pe-win32', [first]);

    first.stderr('STAGE:encode-prompt');
    first.stderr(TIMEOUT_ABORT);
    await first.abort();

    expect(ltx2Calls(spawnMock)).toHaveLength(1);
    expect(failures).toHaveLength(1);
  });

  // A cancel is answered by SIGTERM, so the child normally dies on a signal the
  // classifier already ignores — but a cancel that RACES an abort already in
  // flight still arrives as SIGABRT. Relaunching there would restart the render
  // the user just stopped.
  it('does not relaunch a child PortOS killed on purpose, even on SIGABRT', async () => {
    const first = makeDrivenProc(108);
    const spawnMock = await startRender('pe-killed', [first]);

    first.stderr('STAGE:encode-prompt');
    first.stderr(TIMEOUT_ABORT);
    // What killWithEscalation() leaves behind on the handle when cancel() fires.
    first.proc.killed = true;
    await first.abort();

    expect(ltx2Calls(spawnMock)).toHaveLength(1);
    expect(failures).toHaveLength(1);
  });

  // The relaunch clears activeProcess before it awaits the replacement spawn, so
  // for that window cancel() has nothing to kill and reports false. The epoch
  // check is the only thing that notices — without it the replacement child runs
  // to completion after the user asked to stop.
  it('abandons the replacement child when a cancel lands during the relaunch spawn', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const { cancel } = await import('./local.js');
    const spawnMock = vi.mocked(spawnDetached);
    const first = makeDrivenProc(109);
    const second = makeDrivenProc(110);
    spawnMock.mockClear();
    spawnMock.mockResolvedValueOnce(first.proc);
    // Cancel from INSIDE the spawn await — the exact window activeProcess is null.
    spawnMock.mockImplementationOnce(async () => {
      cancel();
      return second.proc;
    });
    await generateVideo({
      jobId: 'pe-cancel-race',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'a lighthouse in fog',
      width: 512,
      height: 512,
      numFrames: 25,
      fps: 24,
      seed: 987654,
    });

    first.stderr('STAGE:encode-prompt');
    first.stderr(TIMEOUT_ABORT);
    await first.abort();

    // The replacement was spawned, then stopped rather than left running…
    expect(ltx2Calls(spawnMock)).toHaveLength(2);
    expect(second.proc.kill).toHaveBeenCalledWith('SIGTERM');
    // …and the job still reports a terminal failure instead of hanging.
    expect(failures).toHaveLength(1);
  });

  // Before activeProcess is set, cancel() has no child to signal; the epoch
  // taken at render entry is what delivers it once the spawn resolves.
  it('stops the first child when a cancel lands during its spawn await', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const { cancel } = await import('./local.js');
    const spawnMock = vi.mocked(spawnDetached);
    const first = makeDrivenProc(113);
    spawnMock.mockClear();
    spawnMock.mockImplementationOnce(async () => {
      expect(cancel()).toBe('pending');
      return first.proc;
    });
    await generateVideo({
      jobId: 'cancel-during-first-spawn',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'a lighthouse in fog',
      width: 512,
      height: 512,
      numFrames: 25,
      fps: 24,
      seed: 987654,
    });

    expect(first.proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  // A replacement child that never gets its close listener can never report a
  // terminal event, so it must not be left running.
  it('stops the replacement child when wiring it throws', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    const first = makeDrivenProc(111);
    const second = makeDrivenProc(112, { failWiring: true });
    spawnMock.mockClear();
    spawnMock.mockResolvedValueOnce(first.proc).mockResolvedValueOnce(second.proc);
    await generateVideo({
      jobId: 'pe-wire-throws',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'a lighthouse in fog',
      width: 512,
      height: 512,
      numFrames: 25,
      fps: 24,
      seed: 987654,
    });

    first.stderr('STAGE:encode-prompt');
    first.stderr(TIMEOUT_ABORT);
    await first.abort();

    expect(second.proc.kill).toHaveBeenCalledWith('SIGTERM');
    // The job still ends, reporting the abort that started all this.
    expect(failures).toHaveLength(1);
  });

  // The replacement must not be reachable by cancel() until it is wired: an
  // unwired child killed mid-handoff emits its exit into the void and strands the
  // job `running`, and its close handler could otherwise release the accelerator
  // claim while the handoff is still in flight — which would then rewrite the
  // claim file with a dead PID and wedge every later render.
  it('finishes the claim handoff before the replacement child is trackable', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    const first = makeDrivenProc(113);
    const second = makeDrivenProc(114);
    spawnMock.mockClear();
    spawnMock.mockResolvedValueOnce(first.proc).mockResolvedValueOnce(second.proc);
    await generateVideo({
      jobId: 'pe-wire-order',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'a lighthouse in fog',
      width: 512,
      height: 512,
      numFrames: 25,
      fps: 24,
      seed: 987654,
    });
    // Sampled from inside the handoff — the window where a wired-and-tracked
    // child could run its close handler against the in-flight claim write.
    let wiredDuringHandoff = null;
    heavyClaimHandoff.mockImplementationOnce(async (pid) => {
      if (pid === 114) wiredDuringHandoff = second.isWired();
    });

    first.stderr('STAGE:encode-prompt');
    first.stderr(TIMEOUT_ABORT);
    await first.abort();

    expect(wiredDuringHandoff).toBe(false);
    // …and the wiring does land right after, so the replacement can finalize.
    expect(second.isWired()).toBe(true);
    await second.finish();
    expect(failures).toHaveLength(0);
  });

  // The cancel window does not close when the spawn resolves — the handoff is
  // awaited too, and activeProcess is still null across it, so cancel() again
  // leaves nothing behind but the epoch bump.
  it('abandons the replacement child when a cancel lands during the claim handoff', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const { cancel } = await import('./local.js');
    const spawnMock = vi.mocked(spawnDetached);
    const first = makeDrivenProc(115);
    const second = makeDrivenProc(116);
    spawnMock.mockClear();
    spawnMock.mockResolvedValueOnce(first.proc).mockResolvedValueOnce(second.proc);
    await generateVideo({
      jobId: 'pe-cancel-handoff',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'a lighthouse in fog',
      width: 512,
      height: 512,
      numFrames: 25,
      fps: 24,
      seed: 987654,
    });
    heavyClaimHandoff.mockImplementationOnce(async (pid) => {
      if (pid === 116) cancel();
    });

    first.stderr('STAGE:encode-prompt');
    first.stderr(TIMEOUT_ABORT);
    await first.abort();

    expect(second.proc.kill).toHaveBeenCalledWith('SIGTERM');
    // Never wired, so it could not have reported anything — the job's terminal
    // event has to come from the original abort instead.
    expect(second.isWired()).toBe(false);
    expect(failures).toHaveLength(1);
  });

  // The claim handoff yields to the event loop, so a replacement that dies in
  // that window emits its 'close' before anything is listening. Nothing would
  // ever reap it: the job would sit `running` forever, still holding the
  // accelerator claim, with no terminal SSE or queue event.
  it('reaps a replacement child that died before its listener was attached', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    const first = makeDrivenProc(117);
    const second = makeDrivenProc(118);
    spawnMock.mockClear();
    spawnMock.mockResolvedValueOnce(first.proc).mockResolvedValueOnce(second.proc);
    await generateVideo({
      jobId: 'pe-early-death',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'a lighthouse in fog',
      width: 512,
      height: 512,
      numFrames: 25,
      fps: 24,
      seed: 987654,
    });
    // Dies during the handoff, and its close() fires into the void — modelled by
    // setting the exit state without invoking any listener.
    heavyClaimHandoff.mockImplementationOnce(async (pid) => {
      if (pid === 118) second.proc.exitCode = 3;
    });

    first.stderr('STAGE:encode-prompt');
    first.stderr(TIMEOUT_ABORT);
    await first.abort();

    expect(failures).toHaveLength(1);
    expect(failures[0].error).toMatch(/Exit code 3/);
    expect(heavyClaimRelease).toHaveBeenCalled();

    // …and the real 'close' arriving late — carrying that same exit status —
    // is absorbed rather than re-running the whole teardown and reporting the
    // job as failed a second time.
    await second.close(3, null);
    expect(failures).toHaveLength(1);
    expect(heavyClaimRelease).toHaveBeenCalledTimes(1);
  });
});

// ── the first render child vs the accelerator handoff (#4617) ────────────────
// Between `spawnDetached` resolving and the render child's real listeners going
// on sits the machine-claim handoff — an await on real file I/O. A child that
// dies inside that window emits with nobody subscribed: a lost 'close' leaves
// the job `running` forever while still holding the accelerator claim (every
// later render then 409s), and a lost 'error' is worse, since an EventEmitter
// with no 'error' listener throws and takes the server down with it.
describe('generateVideo — first render child dies during the accelerator handoff', () => {
  // A child that never exits on its own, so the test decides exactly when — and
  // from where — its terminal event fires.
  const makeSilentProc = (pid, { failWiring = false } = {}) => {
    const listeners = {};
    const proc = {
      pid,
      exitCode: null,
      signalCode: null,
      killed: false,
      stdout: { on: vi.fn(() => { if (failWiring) throw new Error('stdout stream vanished'); }) },
      stderr: { on: vi.fn() },
      on(event, fn) { listeners[event] = fn; return proc; },
      off(event, fn) { if (listeners[event] === fn) delete listeners[event]; return proc; },
      kill: vi.fn(),
    };
    return {
      proc,
      close: (code, signal) => {
        proc.exitCode = code;
        proc.signalCode = signal;
        return listeners.close?.(code, signal);
      },
      // A spawn-side failure (no `sh`, no PID recorded) — the handle reports it
      // as 'error' and never populates exitCode, so nothing but a listener can
      // observe it.
      error: (err) => listeners.error?.(err),
    };
  };

  let failures;
  let onFailed;

  beforeEach(() => {
    failures = [];
    onFailed = (payload) => failures.push(payload);
    videoGenEvents.on('failed', onFailed);
  });

  afterEach(() => {
    videoGenEvents.off('failed', onFailed);
  });

  const render = async (jobId, child, duringHandoff) => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    vi.mocked(spawnDetached).mockClear();
    vi.mocked(spawnDetached).mockResolvedValueOnce(child.proc);
    heavyClaimHandoff.mockImplementationOnce(async () => duringHandoff());
    return generateVideo({
      jobId,
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'a lighthouse in fog',
      width: 512,
      height: 512,
      numFrames: 25,
      fps: 24,
      seed: 987654,
    });
  };

  it('reports the exit and hands the accelerator claim back when the close lands unsubscribed', async () => {
    const child = makeSilentProc(201);
    await render('first-child-close-in-handoff', child, () => child.close(3, null));

    expect(failures).toHaveLength(1);
    expect(failures[0].error).toMatch(/Exit code 3/);
    expect(heavyClaimRelease).toHaveBeenCalled();

    // …and the real 'close' arriving late carries the same status through a
    // handler that already ran, so the job must not fail (or release) twice.
    await child.close(3, null);
    expect(failures).toHaveLength(1);
    expect(heavyClaimRelease).toHaveBeenCalledTimes(1);
  });

  it('reports a spawn error raised in the same window, which no exit status records', async () => {
    const child = makeSilentProc(undefined);
    await render('first-child-error-in-handoff', child, () => child.error(new Error('detached spawn produced no PID')));

    // exitCode/signalCode stay null on a spawn failure — only a subscriber sees it.
    expect(child.proc.exitCode).toBeNull();
    expect(failures).toHaveLength(1);
    expect(failures[0].error).toMatch(/produced no PID/);
    expect(heavyClaimRelease).toHaveBeenCalled();
  });

  it('stops the child and releases the claim when the handoff itself throws', async () => {
    const child = makeSilentProc(203);
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    vi.mocked(spawnDetached).mockClear();
    vi.mocked(spawnDetached).mockResolvedValueOnce(child.proc);
    heavyClaimHandoff.mockImplementationOnce(async () => { throw new Error('claim file vanished'); });

    await expect(generateVideo({
      jobId: 'first-child-handoff-throws',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'a lighthouse in fog',
      width: 512,
      height: 512,
      numFrames: 25,
      fps: 24,
      seed: 987654,
    })).rejects.toThrow('claim file vanished');

    // Never wired, so it could never report anything — it must not be left
    // running, and the claim it may already have been handed has to come back.
    expect(child.proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(heavyClaimRelease).toHaveBeenCalled();
    // …and the job converges instead of sitting `running` in the jobs map with
    // its staged temp files, which is the same stranding #4617 is about.
    expect(failures).toHaveLength(1);
    expect(failures[0].error).toMatch(/claim file vanished/);
  });

  it('stops the child and fails the job when the wiring itself throws', async () => {
    const child = makeSilentProc(204, { failWiring: true });
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    vi.mocked(spawnDetached).mockClear();
    vi.mocked(spawnDetached).mockResolvedValueOnce(child.proc);

    await expect(generateVideo({
      jobId: 'first-child-wiring-throws',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'a lighthouse in fog',
      width: 512,
      height: 512,
      numFrames: 25,
      fps: 24,
      seed: 987654,
    })).rejects.toThrow('stdout stream vanished');

    expect(child.proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(heavyClaimRelease).toHaveBeenCalled();
    expect(failures).toHaveLength(1);
  });
});

// ── verified post-completion native teardown abort (#6501) ───────────────────
// The MiniMax H3 MLX runner can finish its render, mux the clip, print the
// `emit_result` completion contract from scripts/ml/_minimax_h3_common.py, and THEN
// abort inside native interpreter teardown. The clip on disk is complete; only
// the interpreter died. A real abort can't be produced here, so the child is
// driven directly — the result line goes onto its stdout and it is closed on
// SIGABRT exactly as the OS would. What is under test is the decision
// generateVideo makes from that wreckage, and every way it must still say
// "failed" instead.
describe('generateVideo — post-completion native teardown abort', () => {
  const NUM_FRAMES = 124;
  const FPS = 24;
  let restorePlatform = () => {};
  let completed;
  let failed;

  beforeEach(async () => {
    // MLX is Apple-Silicon only and the recovery is gated on the real platform,
    // so pin it — otherwise this whole describe would silently assert "never
    // recovers" on Windows CI. Pinned in the hook, never at module scope.
    const { pinPlatform } = await import('../../lib/testHelper.js');
    restorePlatform = pinPlatform('darwin');
    probeState.frames = NUM_FRAMES;
    probeState.durationSeconds = NUM_FRAMES / FPS;
    completed = vi.fn();
    failed = vi.fn();
    videoGenEvents.on('completed', completed);
    videoGenEvents.on('failed', failed);
  });

  afterEach(() => {
    videoGenEvents.off('completed', completed);
    videoGenEvents.off('failed', failed);
    restorePlatform();
  });

  const makeChild = async () => {
    const { EventEmitter } = await import('node:events');
    const proc = Object.assign(new EventEmitter(), {
      pid: 4321,
      exitCode: null,
      signalCode: null,
      killed: false,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn((signal) => { proc.killed = true; proc.signalCode = signal; }),
    });
    return proc;
  };

  // Starts a render against a child the caller then drives by hand.
  const startRender = async ({ jobId, modelId = 'minimax_h3_8bit', numFrames = NUM_FRAMES, batchSize = 1 }) => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const proc = await makeChild();
    vi.mocked(spawnDetached).mockResolvedValueOnce(proc);
    await generateVideo({
      jobId,
      prompt: 'a fox watches the rain',
      modelId,
      width: 1344, height: 768, numFrames, fps: FPS, mode: 'text',
      displaySleep: false,
      ...(batchSize > 1 ? { batchSize, seed: 0 } : {}),
    });
    return proc;
  };

  const emitResult = (proc, payload) => proc.stdout.emit('data', Buffer.from(`${JSON.stringify(payload)}\n`));

  const closeChild = async (proc, code, signal) => {
    proc.exitCode = code;
    proc.signalCode = signal;
    proc.emit('close', code, signal);
  };

  it('keeps the verified render when the child aborts in teardown after reporting it done', async () => {
    const jobId = 'h3-teardown-recover';
    const proc = await startRender({ jobId });

    emitResult(proc, { video_path: join(MOCK_PATHS.videos, `${jobId}.mp4`) });
    await closeChild(proc, null, 'SIGABRT');

    await vi.waitFor(() => expect(completed).toHaveBeenCalledTimes(1));
    // Exactly one terminal event, and it is NOT the 'failed' the media queue
    // counts toward its repeated-failure hold.
    expect(failed).not.toHaveBeenCalled();
    expect(completed.mock.calls[0][0]).toMatchObject({ generationId: jobId });

    // One concise teardown warning that names the fault and nothing about this
    // machine — no filesystem path, no host identity.
    const { broadcastSse } = await import('../../lib/sseUtils.js');
    const warnings = vi.mocked(broadcastSse).mock.calls
      .map(([, frame]) => frame)
      .filter((frame) => frame?.type === 'status' && /native teardown/i.test(frame.message || ''));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).not.toContain(MOCK_PATHS.videos);
  });

  // Each of these is a bypass probe: the SAME SIGABRT close, with exactly one
  // element of the evidence chain broken. Every one must stay a failure.
  it.each([
    ['no completion result was ever reported (a pre-completion crash)', {
      report: () => {},
    }],
    ['the reported result names some other file', {
      report: (proc) => emitResult(proc, { video_path: join(MOCK_PATHS.videos, 'someone-elses.mp4') }),
    }],
    ['the completion evidence is only a progress sentence', {
      report: (proc) => proc.stdout.emit('data', Buffer.from('[Decoding video + audio + muxing] done in 3.2s\n')),
    }],
    ['the output on disk predates this render', {
      setup: () => { fsState.mtimeMs = Date.now() - 3_600_000; },
    }],
    ['the output is truncated to a fraction of the requested frames', {
      setup: () => { probeState.frames = 40; },
    }],
    ['the output runs short of the requested duration', {
      setup: () => { probeState.durationSeconds = 2; },
    }],
    ['the frame probe could not answer', {
      setup: () => { probeState.frames = null; },
    }],
    ['the duration probe could not answer', {
      setup: () => { probeState.durationSeconds = null; },
    }],
  ])('still fails when %s', async (_label, { setup, report }) => {
    setup?.();
    const jobId = 'h3-teardown-reject';
    const proc = await startRender({ jobId });

    if (report) report(proc);
    else emitResult(proc, { video_path: join(MOCK_PATHS.videos, `${jobId}.mp4`) });
    await closeChild(proc, null, 'SIGABRT');

    await vi.waitFor(() => expect(failed).toHaveBeenCalledTimes(1));
    expect(completed).not.toHaveBeenCalled();
  });

  it('still fails a cancellation that raced an in-flight abort', async () => {
    const jobId = 'h3-teardown-cancel';
    const proc = await startRender({ jobId });

    emitResult(proc, { video_path: join(MOCK_PATHS.videos, `${jobId}.mp4`) });
    // What cancel() leaves behind: PortOS asked this child to die. A death we
    // caused is never a spontaneous teardown abort to recover from, whatever
    // signal it finally lands on.
    proc.kill('SIGTERM');
    await closeChild(proc, null, 'SIGABRT');

    await vi.waitFor(() => expect(failed).toHaveBeenCalledTimes(1));
    expect(completed).not.toHaveBeenCalled();
  });

  it('still fails an ordinary nonzero exit that follows a completion result', async () => {
    const jobId = 'h3-teardown-exit1';
    const proc = await startRender({ jobId });

    emitResult(proc, { video_path: join(MOCK_PATHS.videos, `${jobId}.mp4`) });
    await closeChild(proc, 1, null);

    await vi.waitFor(() => expect(failed).toHaveBeenCalledTimes(1));
    expect(completed).not.toHaveBeenCalled();
  });

  it('does not extend the recovery to another runtime that aborts the same way', async () => {
    probeState.frames = 25;
    probeState.durationSeconds = 25 / FPS;
    const jobId = 'ltx-teardown-abort';
    const proc = await startRender({ jobId, modelId: 'ltx2_unified', numFrames: 25 });

    emitResult(proc, { video_path: join(MOCK_PATHS.videos, `${jobId}.mp4`) });
    await closeChild(proc, null, 'SIGABRT');

    await vi.waitFor(() => expect(failed).toHaveBeenCalledTimes(1));
    expect(completed).not.toHaveBeenCalled();
  });

  it('recovers a warm batch only once every output is accepted and finalized', async () => {
    const { planVideoBatch } = await import('./batch.js');
    const jobId = 'h3-teardown-batch-full';
    const batch = planVideoBatch({ jobId, batchSize: 2, seed: 0 });
    const proc = await startRender({ jobId, batchSize: 2 });

    for (const item of batch) {
      emitResult(proc, { video_path: join(MOCK_PATHS.videos, item.filename), batch_index: item.index, seed: item.seed });
    }
    const { atomicWrite } = await import('../../lib/fileUtils.js');
    await vi.waitFor(() => expect(vi.mocked(atomicWrite).mock.calls.length).toBeGreaterThanOrEqual(2));
    await closeChild(proc, null, 'SIGABRT');

    await vi.waitFor(() => expect(completed).toHaveBeenCalledTimes(1));
    expect(failed).not.toHaveBeenCalled();
    expect(completed.mock.calls[0][0].results).toHaveLength(2);
  });

  it('leaves a partial warm batch failed, with the results it already saved', async () => {
    const { planVideoBatch } = await import('./batch.js');
    const jobId = 'h3-teardown-batch-partial';
    const batch = planVideoBatch({ jobId, batchSize: 2, seed: 0 });
    const proc = await startRender({ jobId, batchSize: 2 });

    emitResult(proc, { video_path: join(MOCK_PATHS.videos, batch[0].filename), batch_index: 0, seed: batch[0].seed });
    const { atomicWrite } = await import('../../lib/fileUtils.js');
    await vi.waitFor(() => expect(vi.mocked(atomicWrite).mock.calls.length).toBeGreaterThanOrEqual(1));
    await closeChild(proc, null, 'SIGABRT');

    await vi.waitFor(() => expect(failed).toHaveBeenCalledTimes(1));
    expect(completed).not.toHaveBeenCalled();
    expect(failed.mock.calls[0][0].results).toHaveLength(1);
  });
});
