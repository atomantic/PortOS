import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mutable state read by the hoisted vi.mock factories below. Each test mutates
// it and then `vi.resetModules() + dynamic import` re-evaluates pythonSetup.js
// with the new platform/arch — `HOST_ARCH`, `IS_DARWIN`, and `PYTHON_CANDIDATES`
// are all computed at module-load time, so the only way to exercise both
// arm64 and x86_64 host paths is a fresh module per scenario.
const mockState = {
  arch: 'arm64',
  platform: 'darwin',
  homedir: '/Users/test',
  presentPaths: new Set(),
  archByPath: new Map(),
  execShouldFail: false,
};

vi.mock('node:os', async () => {
  const actual = await vi.importActual('node:os');
  return {
    ...actual,
    arch: () => mockState.arch,
    platform: () => mockState.platform,
    homedir: () => mockState.homedir,
  };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return { ...actual, existsSync: (p) => mockState.presentPaths.has(p) };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  const util = await vi.importActual('node:util');
  // `promisify(execFile)` uses execFile's util.promisify.custom symbol so the
  // resolved value is `{ stdout, stderr }` (not a bare string). Honor that on
  // the mock or `probePythonArch`'s `.stdout` read returns undefined.
  const fakeExecFile = () => {};
  fakeExecFile[util.promisify.custom] = (bin, args) => new Promise((resolve, reject) => {
    if (mockState.execShouldFail) {
      reject(new Error('spawn failed'));
      return;
    }
    const probeArg = args?.[1] || '';
    if (probeArg.includes('platform.machine')) {
      const a = mockState.archByPath.get(bin) ?? mockState.arch;
      resolve({ stdout: `${a}\n`, stderr: '' });
    } else {
      resolve({ stdout: '', stderr: '' });
    }
  });
  return { ...actual, execFile: fakeExecFile };
});

vi.mock('./fileUtils.js', () => ({ PATHS: { data: '/data' } }));

const loadModule = async () => {
  vi.resetModules();
  return await import('./pythonSetup.js');
};

const resetState = () => {
  mockState.arch = 'arm64';
  mockState.platform = 'darwin';
  mockState.homedir = '/Users/test';
  mockState.presentPaths = new Set();
  mockState.archByPath = new Map();
  mockState.execShouldFail = false;
};

describe('HOST_ARCH', () => {
  beforeEach(resetState);

  it('reports arm64 on Apple Silicon Node', async () => {
    mockState.arch = 'arm64';
    const { HOST_ARCH } = await loadModule();
    expect(HOST_ARCH).toBe('arm64');
  });

  it('normalizes os.arch x64 → x86_64 so the Python convention matches', async () => {
    mockState.arch = 'x64';
    const { HOST_ARCH } = await loadModule();
    expect(HOST_ARCH).toBe('x86_64');
  });
});

describe('probePythonArch', () => {
  beforeEach(resetState);

  it('returns the trimmed platform.machine() output', async () => {
    mockState.archByPath.set('/x/python3', 'arm64');
    const { probePythonArch } = await loadModule();
    await expect(probePythonArch('/x/python3')).resolves.toBe('arm64');
  });

  it('returns null when the subprocess errors', async () => {
    mockState.execShouldFail = true;
    const { probePythonArch } = await loadModule();
    await expect(probePythonArch('/missing/python3')).resolves.toBeNull();
  });
});

describe('isArchMismatch', () => {
  beforeEach(resetState);

  it('returns false on non-darwin (mlx wheels are arm64-only on macOS; other OSes are out of scope)', async () => {
    mockState.platform = 'linux';
    mockState.archByPath.set('/x/python3', 'x86_64');
    const { isArchMismatch } = await loadModule();
    await expect(isArchMismatch('/x/python3')).resolves.toBe(false);
  });

  it('returns false when interpreter arch matches HOST_ARCH on darwin', async () => {
    mockState.archByPath.set('/x/python3', 'arm64');
    const { isArchMismatch } = await loadModule();
    await expect(isArchMismatch('/x/python3')).resolves.toBe(false);
  });

  it('returns true when interpreter arch differs from HOST_ARCH on darwin', async () => {
    mockState.archByPath.set('/x/python3', 'x86_64');
    const { isArchMismatch } = await loadModule();
    await expect(isArchMismatch('/x/python3')).resolves.toBe(true);
  });

  it('returns false when the probe fails (no interpreter to compare)', async () => {
    mockState.execShouldFail = true;
    const { isArchMismatch } = await loadModule();
    await expect(isArchMismatch('/x/python3')).resolves.toBe(false);
  });
});

describe('detectPython on darwin/arm64', () => {
  beforeEach(resetState);

  it('prefers an arm64 candidate over an earlier-listed x86_64 candidate', async () => {
    // /opt/anaconda3 (index 4 in PYTHON_CANDIDATES) is listed before
    // /opt/homebrew (index 9). The arm64-preference branch must override
    // first-present-wins so mlx wheels load correctly.
    mockState.presentPaths.add('/opt/anaconda3/bin/python3');
    mockState.presentPaths.add('/opt/homebrew/bin/python3');
    mockState.archByPath.set('/opt/anaconda3/bin/python3', 'x86_64');
    mockState.archByPath.set('/opt/homebrew/bin/python3', 'arm64');
    const { detectPython } = await loadModule();
    await expect(detectPython()).resolves.toBe('/opt/homebrew/bin/python3');
  });

  it('returns the sole present candidate without paying the arch-probe cost', async () => {
    // The `present.length > 1` guard skips the parallel probe when there is
    // nothing to choose between.
    mockState.presentPaths.add('/opt/anaconda3/bin/python3');
    mockState.archByPath.set('/opt/anaconda3/bin/python3', 'x86_64');
    const { detectPython } = await loadModule();
    await expect(detectPython()).resolves.toBe('/opt/anaconda3/bin/python3');
  });

  it('falls back to the first present candidate when no candidate is arm64', async () => {
    mockState.presentPaths.add('/opt/anaconda3/bin/python3');
    mockState.presentPaths.add('/usr/local/bin/python3');
    mockState.archByPath.set('/opt/anaconda3/bin/python3', 'x86_64');
    mockState.archByPath.set('/usr/local/bin/python3', 'x86_64');
    const { detectPython } = await loadModule();
    await expect(detectPython()).resolves.toBe('/opt/anaconda3/bin/python3');
  });
});

describe('detectArm64Python', () => {
  beforeEach(resetState);

  it('returns null on non-darwin', async () => {
    mockState.platform = 'linux';
    mockState.presentPaths.add('/usr/bin/python3');
    mockState.archByPath.set('/usr/bin/python3', 'arm64');
    const { detectArm64Python } = await loadModule();
    await expect(detectArm64Python()).resolves.toBeNull();
  });

  it('returns null on Intel macs (HOST_ARCH !== arm64)', async () => {
    mockState.arch = 'x64';
    mockState.presentPaths.add('/usr/local/bin/python3');
    mockState.archByPath.set('/usr/local/bin/python3', 'x86_64');
    const { detectArm64Python } = await loadModule();
    await expect(detectArm64Python()).resolves.toBeNull();
  });

  it('returns null when no present candidate reports arm64', async () => {
    mockState.presentPaths.add('/opt/anaconda3/bin/python3');
    mockState.archByPath.set('/opt/anaconda3/bin/python3', 'x86_64');
    const { detectArm64Python } = await loadModule();
    await expect(detectArm64Python()).resolves.toBeNull();
  });

  it('returns the first arm64 candidate by PYTHON_CANDIDATES order', async () => {
    mockState.presentPaths.add('/opt/anaconda3/bin/python3');
    mockState.presentPaths.add('/opt/homebrew/bin/python3');
    mockState.presentPaths.add('/usr/local/bin/python3');
    mockState.archByPath.set('/opt/anaconda3/bin/python3', 'x86_64');
    mockState.archByPath.set('/opt/homebrew/bin/python3', 'arm64');
    mockState.archByPath.set('/usr/local/bin/python3', 'arm64');
    const { detectArm64Python } = await loadModule();
    await expect(detectArm64Python()).resolves.toBe('/opt/homebrew/bin/python3');
  });
});
