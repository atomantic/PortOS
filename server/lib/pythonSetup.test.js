import { describe, it, expect, vi, beforeEach } from 'vitest';
import { posixPath } from './testHelper.js';

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
  pathPython: null,
  // Directory names under uv python root, as readdirSync would return them.
  uvPythonDirs: null,
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
  // pythonSetup composes its candidate paths with path.join/dirname, so on a
  // Windows host they arrive backslash-separated while presentPaths is seeded
  // with the POSIX spellings the tests read. Normalize the probe, not the
  // fixtures — the module's own platform is pinned via mockState.platform.
  return {
    ...actual,
    existsSync: (p) => mockState.presentPaths.has(String(p).split('\\').join('/')),
    // uv's install root is enumerated rather than listed, so the candidate
    // builder readdirs it. `null` means "uv not installed" — the common case —
    // and must throw the way the real readdirSync does so the builder swallows
    // it instead of crashing module load.
    readdirSync: () => {
      if (!mockState.uvPythonDirs) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return mockState.uvPythonDirs;
    },
  };
});

vi.mock('./childProcess.js', async () => {
  const actual = await vi.importActual('./childProcess.js');
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

// The PATH fallbacks shell out for real; stub them so a test box's own Python
// can't decide the result. safeChildProcessEnv stays real (probePythonArch uses it).
vi.mock('./processEnv.js', async (importOriginal) => ({
  ...(await importOriginal()),
  whichFirst: async () => mockState.pathPython,
  whichFirstSync: () => mockState.pathPython,
}));

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
  mockState.pathPython = null;
  mockState.uvPythonDirs = null;
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

describe('detectPythonSync', () => {
  beforeEach(resetState);

  it('returns the first present candidate without probing arch', async () => {
    mockState.presentPaths.add('/opt/anaconda3/bin/python3');
    mockState.presentPaths.add('/opt/homebrew/bin/python3');
    const { detectPythonSync } = await loadModule();
    expect(detectPythonSync()).toBe('/opt/anaconda3/bin/python3');
  });

  it('falls back to PATH when no candidate path exists — a scoop / chocolatey / custom-dir install still counts', async () => {
    mockState.platform = 'win32';
    mockState.pathPython = 'C:/tools/python311/python.exe';
    const { detectPythonSync } = await loadModule();
    expect(detectPythonSync()).toBe('C:/tools/python311/python.exe');
  });

  it('rejects the WindowsApps alias — it opens the Microsoft Store instead of building a venv', async () => {
    mockState.platform = 'win32';
    mockState.pathPython = 'C:\\Users\\example\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe';
    const { detectPythonSync } = await loadModule();
    expect(detectPythonSync()).toBeNull();
  });

  it('returns null when there is no Python anywhere', async () => {
    const { detectPythonSync } = await loadModule();
    expect(detectPythonSync()).toBeNull();
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

describe('hasMfluxTrain', () => {
  beforeEach(resetState);

  it('is false for a null/empty path', async () => {
    const { hasMfluxTrain } = await loadModule();
    expect(hasMfluxTrain(null)).toBe(false);
    expect(hasMfluxTrain('')).toBe(false);
  });

  it('is true when mflux-train sits beside the python', async () => {
    mockState.presentPaths.add('/opt/homebrew/bin/mflux-train');
    const { hasMfluxTrain } = await loadModule();
    expect(hasMfluxTrain('/opt/homebrew/bin/python3')).toBe(true);
  });

  it('is false when mflux-train is absent beside the python', async () => {
    const { hasMfluxTrain } = await loadModule();
    expect(hasMfluxTrain('/opt/homebrew/bin/python3')).toBe(false);
  });
});

describe('resolveMfluxPython', () => {
  beforeEach(resetState);
  // darwin homedir is /Users/test → dedicated venv python is
  // /Users/test/.portos/venv-mflux/bin/python3, mflux-train beside it.
  const VENV_PY = '/Users/test/.portos/venv-mflux/bin/python3';
  const VENV_TRAIN = '/Users/test/.portos/venv-mflux/bin/mflux-train';

  it('prefers the configured python when it ships mflux-train (existing --user layout)', async () => {
    mockState.presentPaths.add('/opt/homebrew/bin/mflux-train');
    mockState.presentPaths.add(VENV_TRAIN); // even when the venv also exists, configured wins
    const { resolveMfluxPython } = await loadModule();
    expect(posixPath(resolveMfluxPython('/opt/homebrew/bin/python3'))).toBe('/opt/homebrew/bin/python3');
  });

  it('falls back to the dedicated venv when the configured python lacks mflux-train', async () => {
    mockState.presentPaths.add(VENV_TRAIN);
    const { resolveMfluxPython } = await loadModule();
    expect(posixPath(resolveMfluxPython('/opt/homebrew/bin/python3'))).toBe(VENV_PY);
  });

  it('discovers the dedicated venv even when no python is configured', async () => {
    mockState.presentPaths.add(VENV_TRAIN);
    const { resolveMfluxPython } = await loadModule();
    expect(posixPath(resolveMfluxPython(null))).toBe(VENV_PY);
  });

  it('returns the configured path unchanged when neither ships mflux-train (honest "not installed")', async () => {
    const { resolveMfluxPython } = await loadModule();
    expect(posixPath(resolveMfluxPython('/opt/homebrew/bin/python3'))).toBe('/opt/homebrew/bin/python3');
  });

  it('returns null when nothing is configured and no venv exists', async () => {
    const { resolveMfluxPython } = await loadModule();
    expect(resolveMfluxPython(null)).toBeNull();
    expect(resolveMfluxPython()).toBeNull();
  });
});
describe('detectVenvBasePythonSync', () => {
  beforeEach(resetState);

  const WIN_UV = 'C:/Users/example/AppData/Roaming/uv/python';

  it('prefers a uv standalone build over conda — a conda-based venv cannot import torch', async () => {
    // Regression: on a box whose only listed Python was miniconda, every torch
    // venv the installer built died at `import torch` with
    // "WinError 1114 ... c10.dll initialization routine failed".
    mockState.platform = 'win32';
    mockState.homedir = 'C:/Users/example';
    mockState.uvPythonDirs = ['cpython-3.10-windows-x86_64-none'];
    mockState.presentPaths.add(`${WIN_UV}/cpython-3.10-windows-x86_64-none/python.exe`);
    mockState.presentPaths.add('C:/Users/example/miniconda3/python.exe');
    const { detectVenvBasePythonSync, detectPythonSync } = await loadModule();
    expect(posixPath(detectVenvBasePythonSync())).toBe(`${WIN_UV}/cpython-3.10-windows-x86_64-none/python.exe`);
    // ...and the pip-target picker is deliberately unchanged: uv Pythons are
    // PEP 668 externally-managed, so installPackages must not be sent there.
    expect(posixPath(detectPythonSync())).toBe('C:/Users/example/miniconda3/python.exe');
  });

  it('prefers the newest uv version, and 3.9 does not beat 3.10', async () => {
    mockState.platform = 'win32';
    mockState.homedir = 'C:/Users/example';
    mockState.uvPythonDirs = [
      'cpython-3.9.21-windows-x86_64-none',
      'cpython-3.13.12-windows-x86_64-none',
      'cpython-3.10.19-windows-x86_64-none',
    ];
    for (const d of mockState.uvPythonDirs) mockState.presentPaths.add(`${WIN_UV}/${d}/python.exe`);
    const { detectVenvBasePythonSync } = await loadModule();
    expect(posixPath(detectVenvBasePythonSync())).toContain('cpython-3.13.12');
  });

  it('ignores non-cpython entries under the uv root and falls through to python.org', async () => {
    mockState.platform = 'win32';
    mockState.homedir = 'C:/Users/example';
    mockState.uvPythonDirs = ['.temp', 'pypy-3.10-windows-x86_64-none'];
    mockState.presentPaths.add('C:/Users/example/AppData/Local/Programs/Python/Python312/python.exe');
    mockState.presentPaths.add('C:/Users/example/miniconda3/python.exe');
    const { detectVenvBasePythonSync } = await loadModule();
    expect(posixPath(detectVenvBasePythonSync()))
      .toBe('C:/Users/example/AppData/Local/Programs/Python/Python312/python.exe');
  });

  it('falls back to the pip-target answer when no standalone build exists — a conda venv beats no venv', async () => {
    mockState.platform = 'win32';
    mockState.homedir = 'C:/Users/example';
    mockState.uvPythonDirs = null; // uv not installed: readdir throws
    mockState.presentPaths.add('C:/Users/example/miniconda3/python.exe');
    const { detectVenvBasePythonSync } = await loadModule();
    expect(posixPath(detectVenvBasePythonSync())).toBe('C:/Users/example/miniconda3/python.exe');
  });

  it('finds uv under its Linux install root too', async () => {
    mockState.platform = 'linux';
    mockState.homedir = '/home/example';
    mockState.uvPythonDirs = ['cpython-3.12.8-linux-x86_64-gnu'];
    mockState.presentPaths.add('/home/example/.local/share/uv/python/cpython-3.12.8-linux-x86_64-gnu/bin/python3');
    mockState.presentPaths.add('/opt/miniconda3/bin/python3');
    const { detectVenvBasePythonSync } = await loadModule();
    expect(posixPath(detectVenvBasePythonSync()))
      .toBe('/home/example/.local/share/uv/python/cpython-3.12.8-linux-x86_64-gnu/bin/python3');
  });

  it('returns null when there is no Python at all', async () => {
    const { detectVenvBasePythonSync } = await loadModule();
    expect(detectVenvBasePythonSync()).toBeNull();
  });
});
