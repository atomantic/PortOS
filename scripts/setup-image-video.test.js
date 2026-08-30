import { execFileSync } from 'child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';
import { BYOV_RUNTIME_INFO } from '../server/services/videoGen/runtimes.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SETUP_SCRIPT = join(REPO_ROOT, 'scripts', 'setup-image-video.sh');
const source = readFileSync(SETUP_SCRIPT, 'utf8');
const helper = source.match(/^venv_python\(\) \{\n(?:.*\n)*?^\}\n/m)?.[0];
const existsHelper = source.match(/^venv_exists\(\) \{.*\}\n/m)?.[0];
const tempVenvs = [];

afterEach(() => {
  while (tempVenvs.length) rmSync(tempVenvs.pop(), { recursive: true, force: true });
});

function createVenv(layout) {
  const venv = mkdtempSync(join(tmpdir(), 'portos-venv-python-'));
  const interpreter = join(venv, layout === 'posix' ? 'bin/python3' : 'Scripts/python.exe');
  mkdirSync(dirname(interpreter), { recursive: true });
  writeFileSync(interpreter, '');
  chmodSync(interpreter, 0o755);
  tempVenvs.push(venv);
  return { venv, interpreter };
}

function resolveVenvPython(venv) {
  return execFileSync('bash', ['-c', `${helper}\nvenv_python "$1"`, 'bash', venv], {
    encoding: 'utf8',
  }).trim();
}

function venvExists(venv) {
  const result = execFileSync(
    'bash',
    ['-c', `${existsHelper}\nvenv_exists "$1" && echo yes || echo no`, 'bash', venv],
    { encoding: 'utf8' }
  ).trim();
  return result === 'yes';
}

function shellIfBlocks(text) {
  const blocks = [];
  const stack = [];

  for (const line of text.split('\n')) {
    stack.forEach((block) => block.lines.push(line));

    if (/^[ \t]*if\b/.test(line)) {
      stack.push({
        abortProbe: /^[ \t]*if[ \t]+!/.test(line),
        lines: [line],
      });
    }

    if (/^[ \t]*fi\b/.test(line)) {
      const block = stack.pop();
      if (block?.abortProbe) blocks.push(block.lines.join('\n'));
    }
  }

  return blocks;
}

describe('setup-image-video venv layout handling (issue #4200)', () => {
  it('defines the shared venv interpreter resolver', () => {
    expect(helper).toBeTruthy();
  });

  it('defines the shared venv-exists predicate', () => {
    expect(existsHelper).toBeTruthy();
  });

  // Windows CI runs Node directly; these bash-execution checks are POSIX-only,
  // while the portable structural guard below still covers every platform.
  it.skipIf(process.platform === 'win32')('passes Bash syntax validation', () => {
    expect(() => execFileSync('bash', ['-n', SETUP_SCRIPT])).not.toThrow();
  });

  it.skipIf(process.platform === 'win32')('resolves a POSIX venv interpreter', () => {
    const { venv, interpreter } = createVenv('posix');
    expect(resolveVenvPython(venv)).toBe(interpreter);
  });

  it.skipIf(process.platform === 'win32')('resolves a Windows venv interpreter', () => {
    const { venv, interpreter } = createVenv('windows');
    expect(resolveVenvPython(venv)).toBe(interpreter);
  });

  it.skipIf(process.platform === 'win32')('venv_exists is true for either layout, false for neither', () => {
    expect(venvExists(createVenv('posix').venv)).toBe(true);
    expect(venvExists(createVenv('windows').venv)).toBe(true);
    const empty = mkdtempSync(join(tmpdir(), 'portos-venv-python-'));
    tempVenvs.push(empty);
    expect(venvExists(empty)).toBe(false);
  });

  it.each([
    ['MiniMax H3 CUDA', 'MINIMAX_H3_CUDA_VENV', 'MINIMAX_H3_CUDA_PY'],
    ['AudioLDM2', 'AUDIOLDM2_VENV', 'AUDIOLDM2_PY'],
    ['ACE-Step', 'ACESTEP_VENV', 'ACESTEP_PY'],
    ['MiniMax Music 3', 'MINIMAX_MUSIC3_VENV', 'MINIMAX_MUSIC3_PY'],
    ['MiniMax Music 3 MLX', 'MINIMAX_MUSIC3_MLX_VENV', 'MINIMAX_MUSIC3_MLX_PY'],
    ['MuScriptor', 'MUSCRIPTOR_VENV', 'MUSCRIPTOR_PY'],
    ['FLUX.2', 'FLUX2_VENV', 'FLUX2_PY'],
  ])('%s reuses an existing Windows venv and resolves it with the helper', (_name, venv, python) => {
    expect(source).toContain(`if ! venv_exists "$${venv}"; then`);
    expect(source).toContain(`${python}="$(venv_python "$${venv}")"`);
  });

  it('has no call site that hardcodes a venv interpreter path outside the shared helpers', () => {
    // A literal "$SOMETHING_VENV/bin/python3" assignment outside the helper
    // definitions means a call site bypassed venv_python() and reintroduced
    // the POSIX-only bug this file guards against — EXCEPT for venvs that are
    // gated behind is_macos and can never be created by Windows Python, which
    // legitimately hardcode the POSIX path: mflux (uv-managed, Apple Silicon
    // only) and MusicGen (MLX runtime, is_macos-gated).
    const macosOnlyVenvExemptions = ['MFLUX_VENV', 'MUSICGEN_VENV'];
    const body = macosOnlyVenvExemptions
      .reduce((text, name) => text.replaceAll(`\${${name}}`, '').replaceAll(`$${name}`, ''), source)
      .replace(helper, '')
      .replace(existsHelper, '');
    expect(body).not.toMatch(/\$\{?\w+_VENV\}?\/bin\/python3/);
  });

  it('captures diagnostics for every aborting install probe', () => {
    const abortProbeBlocks = shellIfBlocks(source)
      .filter((block) => block.includes('2>/dev/null') && /\bexit 1\b/.test(block));

    expect(abortProbeBlocks).toEqual([]);
  });
});

describe('setup-image-video clone/fetch progress reporting', () => {
  // The runtime installer streams the script's stdout AND stderr to the Video
  // Gen install modal, splitting on bare \r so progress redraws surface as log
  // lines. git only writes that progress when stderr is a TTY, which it never
  // is under the installer — so a clone without --progress prints its "Cloning
  // into ..." line and then nothing at all until it finishes. On FastVideo
  // (~434MB) that is a ~10 minute silent gap the UI cannot distinguish from a
  // hung install.
  it('passes --progress to every clone', () => {
    const silentClones = source
      .split('\n')
      .filter((line) => /^\s*git clone\b/.test(line) && !line.includes('--progress'));

    expect(silentClones).toEqual([]);
  });

  it('passes --progress to every fetch that is not deliberately quiet', () => {
    const silentFetches = source
      .split('\n')
      .filter((line) => /\bgit\b.*\bfetch\b/.test(line) && !/^\s*#/.test(line))
      .filter((line) => !line.includes('--progress') && !line.includes('--quiet'));

    expect(silentFetches).toEqual([]);
  });
});

// The pin the installer checks out and the revision the server verifies a
// checkout against are the SAME fact written in two languages. When they drift,
// every install silently provisions a runtime the server then reports as stale —
// and for LTX-2.5 the drifted revision is also the one whose sampler nobody read
// for the i2v frame-one anchor (#5422).
describe('pinned runtime revisions', () => {
  const pinned = Object.values(BYOV_RUNTIME_INFO)
    .filter((info) => info.pinEnvVar && info.expectedRevision);

  it('covers every runtime the registry pins', () => {
    expect(pinned.map((info) => info.id).sort()).toEqual(
      expect.arrayContaining(['ltx25', 'minimax_h3', 'wan22']));
  });

  it.each(pinned.map((info) => [info.id, info]))(
    'installs %s at the revision the registry verifies', (_id, info) => {
      const shellDefault = source.match(
        new RegExp(`^\\s*${info.pinEnvVar}="\\$\\{${info.pinEnvVar}:-([^}"]+)\\}"`, 'm'),
      )?.[1];
      expect(shellDefault).toBe(info.expectedRevision);
    });
});
