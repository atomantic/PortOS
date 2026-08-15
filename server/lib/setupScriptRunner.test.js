import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { pinPlatform } from './testHelper.js';

// Mock the collaborators so the behavior under test is observable without
// launching bash, probing the filesystem for a Python, or firing a real kill.
const spawnMock = vi.fn();
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: (...a) => spawnMock(...a) };
});
vi.mock('./bashResolver.js', async (importOriginal) => ({
  ...(await importOriginal()),          // real toBashPath — its output is asserted below
  resolveBashBinary: () => 'C:/Program Files/Git/bin/bash.exe',
}));
const detectPythonSyncMock = vi.fn();
vi.mock('./pythonSetup.js', () => ({
  detectVenvBasePythonSync: (...a) => detectPythonSyncMock(...a),
}));
const killProcessTreeMock = vi.fn();
vi.mock('./bufferedSpawn.js', () => ({
  killProcessTree: (...a) => killProcessTreeMock(...a),
}));

const REAL_PLATFORM = process.platform;

/**
 * Import a fresh copy of the module with `process.platform` pinned. The Windows
 * branches are the whole point of this module, so they have to be exercised
 * from a macOS/Linux runner too — and the module reads the platform once at
 * load, so each platform needs its own module instance.
 */
async function loadFor(platform) {
  pinPlatform(platform); // restored by the afterEach below, however often it runs
  vi.resetModules();
  return import('./setupScriptRunner.js');
}

function makeFakeChild({ pid = 4321, killed = false } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = killed;
  child.kill = vi.fn();
  return child;
}

// Capture the pristine descriptor once per test: loadFor() pins as a side
// effect and can run more than once in a case, so the restore has to come from
// before any of those pins, not from the last one.
let restorePlatform = () => {};

beforeEach(() => {
  restorePlatform = pinPlatform(process.platform);
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => makeFakeChild());
  detectPythonSyncMock.mockReset();
  detectPythonSyncMock.mockReturnValue(null);
  killProcessTreeMock.mockReset();
  delete process.env.PYTHON_BIN;
});

afterEach(() => {
  restorePlatform();
  delete process.env.PYTHON_BIN;
});

describe('spawnSetupScript', () => {
  it('runs the bundled installer under the resolved bash, with a path bash can open', async () => {
    const { spawnSetupScript, SETUP_IMAGE_VIDEO_SCRIPT } = await loadFor('win32');
    spawnSetupScript({ INSTALL_MINIMAX_H3_CUDA: '1' });
    const [bin, argv, opts] = spawnMock.mock.calls[0];
    // Never a bare `bash` (PM2 may resolve that to WSL) and never a backslash
    // path (bash reads those as escapes and exits 127).
    expect(bin).toBe('C:/Program Files/Git/bin/bash.exe');
    expect(argv).toEqual([SETUP_IMAGE_VIDEO_SCRIPT.replace(/\\/g, '/')]);
    expect(argv[0]).toMatch(/\/scripts\/setup-image-video\.sh$/);
    expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(opts.env.INSTALL_MINIMAX_H3_CUDA).toBe('1');
  });

  it('on Windows presets PYTHON_BIN — the script defaults to `python3`, which is absent or a Store stub there', async () => {
    detectPythonSyncMock.mockReturnValue('C:\\Users\\example\\AppData\\Local\\Programs\\Python\\Python312\\python.exe');
    const { spawnSetupScript } = await loadFor('win32');
    spawnSetupScript({ INSTALL_MINIMAX_H3_CUDA: '1' });
    // Forward slashes here too: bash's `command -v` reads this as a path.
    expect(spawnMock.mock.calls[0][2].env.PYTHON_BIN)
      .toBe('C:/Users/example/AppData/Local/Programs/Python/Python312/python.exe');
  });

  it('leaves PYTHON_BIN unset when no interpreter is found, so the script reports its own missing-Python error', async () => {
    detectPythonSyncMock.mockReturnValue(null);
    const { spawnSetupScript } = await loadFor('win32');
    spawnSetupScript({});
    expect(spawnMock.mock.calls[0][2].env.PYTHON_BIN).toBeUndefined();
  });

  it('never overrides an explicit PYTHON_BIN — from the caller or the environment', async () => {
    detectPythonSyncMock.mockReturnValue('C:/detected/python.exe');
    const { spawnSetupScript } = await loadFor('win32');

    spawnSetupScript({ PYTHON_BIN: 'C:/caller/python.exe' });
    expect(spawnMock.mock.calls[0][2].env.PYTHON_BIN).toBe('C:/caller/python.exe');

    process.env.PYTHON_BIN = 'C:/env/python.exe';
    spawnSetupScript({});
    expect(spawnMock.mock.calls[1][2].env.PYTHON_BIN).toBe('C:/env/python.exe');
    // Neither call had to look for one — the explicit value short-circuits.
    expect(detectPythonSyncMock).not.toHaveBeenCalled();
  });

  it('does not touch PYTHON_BIN off Windows — `python3` is the right default there', async () => {
    detectPythonSyncMock.mockReturnValue('/opt/homebrew/bin/python3');
    const { spawnSetupScript } = await loadFor('darwin');
    spawnSetupScript({});
    expect(spawnMock.mock.calls[0][2].env.PYTHON_BIN).toBeUndefined();
    expect(detectPythonSyncMock).not.toHaveBeenCalled();
  });

  it('detaches on POSIX (so a cancel can signal the group) but not on Windows', async () => {
    const posix = await loadFor('darwin');
    posix.spawnSetupScript({});
    expect(spawnMock.mock.calls[0][2].detached).toBe(true);

    const win = await loadFor('win32');
    win.spawnSetupScript({});
    const opts = spawnMock.mock.calls[1][2];
    expect(opts.detached).toBe(false);
    expect(opts.windowsHide).toBe(true);
  });
});

describe('stopSetupScript', () => {
  it('tree-kills with the process-group flag, so uv / pip / git die with bash', async () => {
    const { stopSetupScript } = await loadFor(REAL_PLATFORM);
    const child = makeFakeChild();
    stopSetupScript(child);
    expect(killProcessTreeMock).toHaveBeenCalledWith(child, 'SIGTERM', { processGroup: true });
  });

  it('no-ops on a child that was never spawned or is already killed', async () => {
    const { stopSetupScript } = await loadFor(REAL_PLATFORM);
    const noPid = makeFakeChild();
    noPid.pid = undefined; // spawn() failed — nothing to signal
    stopSetupScript(null);
    stopSetupScript(makeFakeChild({ killed: true }));
    stopSetupScript(noPid);
    expect(killProcessTreeMock).not.toHaveBeenCalled();
  });
});
