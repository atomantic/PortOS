import { execFileSync } from 'child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';

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
});
