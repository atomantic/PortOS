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

describe('setup-image-video venv layout handling (issue #4200)', () => {
  it('defines the shared venv interpreter resolver', () => {
    expect(helper).toBeTruthy();
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

  it.each([
    ['MiniMax H3 CUDA', 'MINIMAX_H3_CUDA_VENV', 'MINIMAX_H3_CUDA_PY'],
    ['AudioLDM2', 'AUDIOLDM2_VENV', 'AUDIOLDM2_PY'],
    ['ACE-Step', 'ACESTEP_VENV', 'ACESTEP_PY'],
    ['MiniMax Music 3', 'MINIMAX_MUSIC3_VENV', 'MINIMAX_MUSIC3_PY'],
    ['MuScriptor', 'MUSCRIPTOR_VENV', 'MUSCRIPTOR_PY'],
    ['FLUX.2', 'FLUX2_VENV', 'FLUX2_PY'],
  ])('%s reuses an existing Windows venv and resolves it with the helper', (_name, venv, python) => {
    expect(source).toContain(`if [[ ! -x "$${venv}/bin/python3" && ! -x "$${venv}/Scripts/python.exe" ]]; then`);
    expect(source).toContain(`${python}="$(venv_python "$${venv}")"`);
  });
});
