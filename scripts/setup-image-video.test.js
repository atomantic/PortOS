import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
const pythonRequiredHelper = source.match(/^python_required\(\) \{\n(?:.*\n)*?^\}\n/m)?.[0];
const tempVenvs = [];
const installFlags = [
  'INSTALL_MFLUX', 'INSTALL_VIDEO', 'INSTALL_LTX2', 'INSTALL_LTX25',
  'INSTALL_LTX25_CUDA', 'INSTALL_FASTVIDEO', 'INSTALL_WAN22', 'INSTALL_WAN22_CUDA', 'INSTALL_MINIMAX_H3',
  'INSTALL_MERERUN', 'INSTALL_MINIMAX_H3_CUDA', 'INSTALL_MUSICGEN',
  'INSTALL_AUDIOLDM2', 'INSTALL_ACESTEP', 'INSTALL_ACESTEP15',
  'INSTALL_MINIMAX_MUSIC3', 'INSTALL_MINIMAX_MUSIC3_MLX',
  'INSTALL_MUSCRIPTOR', 'INSTALL_FLUX2',
];

it('tells UI-driven BYOV installs that no manual Python configuration is needed', () => {
  expect(source).toContain('PortOS auto-discovers the requested runtime; no Python path or other manual configuration is needed.');
});

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

function pythonRequired(env = {}) {
  const installEnv = Object.fromEntries(installFlags.map((name) => [name, env[name] ?? '0']));
  const assignments = Object.entries(installEnv)
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
    .join('\n');
  const result = execFileSync(
    'bash',
    ['-c', `${assignments}\n${pythonRequiredHelper}\npython_required && echo yes || echo no`],
    { encoding: 'utf8', env: process.env },
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

  it.skipIf(process.platform === 'win32')('requires no Python only for an explicit mere.run-only install', () => {
    expect(pythonRequiredHelper).toBeTruthy();
    expect(pythonRequired({ INSTALL_MERERUN: '1' })).toBe(false);
    expect(pythonRequired({ INSTALL_MERERUN: '1', INSTALL_LTX25: '1' })).toBe(true);
    expect(pythonRequired({ INSTALL_MERERUN: '1', INSTALL_LTX25_CUDA: '1' })).toBe(true);
    expect(pythonRequired({ INSTALL_MERERUN: '1', INSTALL_WAN22_CUDA: '1' })).toBe(true);
    expect(pythonRequired({ INSTALL_MERERUN: '0' })).toBe(true);
  });

  it('requires both ffmpeg tools before reporting a mere.run install ready', () => {
    const strictGate = source.match(
      /if \[\[ "\$INSTALL_MERERUN" == "1" \]\]; then\n  MISSING_REF2VA_TOOLS=\(\)\n(?:.*\n)*?^fi$/m,
    )?.[0];
    expect(strictGate).toContain('for command_name in ffmpeg ffprobe');
    expect(strictGate).toContain('exit 1');
    expect(source).toContain('not required for this mere.run-only install');
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
    ['LTX-2.5 CUDA', 'LTX25_CUDA_VENV', 'LTX25_CUDA_PY'],
    ['Wan 2.2 CUDA', 'WAN22_CUDA_VENV', 'WAN22_CUDA_PY'],
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

  it('pins LTX-2.5 CUDA to Lightricks Desktop\'s validated Windows torch stack', () => {
    expect(source).toContain('https://download.pytorch.org/whl/cu128');
    expect(source).toContain('"torch==2.10.0" "torchaudio==2.10.0" "torchvision==0.25.0"');
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

  it.skipIf(process.platform === 'win32')('treats Rosetta (uname x86_64, hw.optional.arm64=1) as Apple Silicon', () => {
    const helper = source.match(/^is_apple_silicon\(\) \{\n(?:.*\n)*?^\}\n/m)?.[0];
    expect(helper).toBeTruthy();
    expect(source).not.toMatch(/uname -m"\) != "arm64"/);
    expect(source).not.toMatch(/uname -m"\) == "arm64"/);
    expect(source).toMatch(/PORTOS_SETUP_NATIVE=1 exec \/usr\/bin\/arch -arm64 \/bin\/bash "\$0" "\$@"/);
    expect(helper).not.toContain('pin_venv_arm64');
    for (const root of [
      '$MFLUX_VENV', '${LTX2_DIR}/.venv', '${LTX25_DIR}/.venv', '${FASTVIDEO_DIR}/.venv',
      '${WAN22_DIR}/.venv', '${MINIMAX_H3_DIR}/.venv', '$MUSICGEN_VENV', '$AUDIOLDM2_VENV',
      '$ACESTEP_VENV', '$ACESTEP15_VENV', '$MINIMAX_MUSIC3_VENV', '$MINIMAX_MUSIC3_MLX_VENV',
      '$MUSCRIPTOR_VENV', '$FLUX2_VENV', '$MINIMAX_H3_CUDA_VENV', '$LTX25_CUDA_VENV',
      '$WAN22_CUDA_VENV',
    ]) {
      expect(source).toContain(`reset_universal_venv "${root}"`);
      expect(source).toContain(`pin_venv_arm64 "${root}"`);
    }

    const probe = ({ system, machine, arm64Bit }) => {
      const dir = mkdtempSync(join(tmpdir(), 'portos-hwprobe-'));
      tempVenvs.push(dir);
      const uname = join(dir, 'uname');
      const sysctl = join(dir, 'sysctl');
      writeFileSync(uname, `#!/bin/bash
case "$1" in
  -s) printf '%s\\n' '${system}' ;;
  -m) printf '%s\\n' '${machine}' ;;
  *) exit 1 ;;
esac
`);
      writeFileSync(sysctl, `#!/bin/bash
if [[ "$1" == "-n" && "$2" == "hw.optional.arm64" ]]; then
  printf '%s\\n' '${arm64Bit}'
  exit 0
fi
exit 1
`);
      chmodSync(uname, 0o755);
      chmodSync(sysctl, 0o755);
      return execFileSync('bash', ['-c', `${helper}\nis_apple_silicon && echo yes || echo no`], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      }).trim();
    };

    expect(probe({ system: 'Darwin', machine: 'arm64', arm64Bit: '0' })).toBe('yes');
    expect(probe({ system: 'Darwin', machine: 'x86_64', arm64Bit: '1' })).toBe('yes');
    expect(probe({ system: 'Darwin', machine: 'x86_64', arm64Bit: '0' })).toBe('no');
    expect(probe({ system: 'Linux', machine: 'x86_64', arm64Bit: '1' })).toBe('no');
  });

  it.skipIf(process.platform === 'win32')('replaces a universal venv interpreter with an arm64 copy and leaves its target alone', () => {
    const pin = source.match(/^pin_venv_arm64\(\) \{\n(?:.*\n)*?^\}\n/m)?.[0];
    const apple = source.match(/^is_apple_silicon\(\) \{\n(?:.*\n)*?^\}\n/m)?.[0];
    expect(pin).toBeTruthy();
    const dir = mkdtempSync(join(tmpdir(), 'portos-lipo-'));
    tempVenvs.push(dir);
    const uname = join(dir, 'uname');
    const lipo = join(dir, 'lipo');
    const venv = join(dir, 'venv');
    const outside = join(dir, 'outside-python');
    mkdirSync(join(venv, 'bin'), { recursive: true });
    writeFileSync(outside, 'ORIGINAL');
    writeFileSync(uname, `#!/bin/bash
case "$1" in
  -s) printf '%s\\n' 'Darwin' ;;
  -m) printf '%s\\n' "$MACHINE" ;;
  *) exit 1 ;;
esac
`);
    writeFileSync(lipo, `#!/bin/bash
if [[ "$1" == "-archs" ]]; then
  case "$2" in
    *.so|*.dylib) printf '%s\\n' "\${SO_ARCHES:-arm64}" ;;
    *) printf '%s\\n' "$ARCHES" ;;
  esac
  exit 0
fi
if [[ "$1" == "-thin" && "$2" == "arm64" && "$4" == "-output" ]]; then
  printf '%s\\n' 'THIN' > "$5"
  printf '%s\\n' thin >> "$LOG"
  exit 0
fi
exit 1
`);
    chmodSync(uname, 0o755);
    chmodSync(lipo, 0o755);
    const run = (machine, arches, soArches = '') => {
      const link = join(venv, 'bin', 'python3');
      rmSync(link, { force: true });
      rmSync(join(venv, 'lib'), { recursive: true, force: true });
      writeFileSync(outside, 'ORIGINAL');
      execFileSync('ln', ['-s', outside, link]);
      if (soArches) {
        mkdirSync(join(venv, 'lib'), { recursive: true });
        writeFileSync(join(venv, 'lib', 'ext.so'), 'SO');
      }
      const log = join(dir, `lipo-${machine}.log`);
      writeFileSync(log, '');
      execFileSync('bash', ['-c', `${apple}\n${pin}\npin_venv_arm64 "$1"`, 'bash', venv], {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          ARCHES: arches,
          SO_ARCHES: soArches,
          LOG: log,
          MACHINE: machine,
        },
      });
      return { body: readFileSync(link, 'utf8'), target: readFileSync(outside, 'utf8'), log: readFileSync(log, 'utf8') };
    };
    const universal = run('arm64', 'x86_64 arm64');
    expect(universal.body).toBe('THIN\n');
    expect(universal.target).toBe('ORIGINAL');
    expect(universal.log).toContain('thin');
    const intelWheels = run('arm64', 'x86_64 arm64', 'x86_64');
    expect(intelWheels.body).toBe('ORIGINAL');
    expect(intelWheels.log).toBe('');
    const already = run('arm64', 'arm64');
    expect(already.body).toBe('ORIGINAL');
    expect(already.log).toBe('');
    const translated = run('x86_64', 'x86_64 arm64');
    expect(translated.body).toBe('ORIGINAL');
    expect(translated.log).toBe('');
  });

  it.skipIf(process.platform === 'win32')('deletes a universal venv before reinstall and keeps an arm64-only one', () => {
    const reset = source.match(/^reset_universal_venv\(\) \{\n(?:.*\n)*?^\}\n/m)?.[0];
    const apple = source.match(/^is_apple_silicon\(\) \{\n(?:.*\n)*?^\}\n/m)?.[0];
    expect(reset).toBeTruthy();
    const dir = mkdtempSync(join(tmpdir(), 'portos-reset-venv-'));
    tempVenvs.push(dir);
    const uname = join(dir, 'uname');
    const lipo = join(dir, 'lipo');
    const sysctl = join(dir, 'sysctl');
    writeFileSync(uname, `#!/bin/bash
case "$1" in
  -s) printf '%s\\n' 'Darwin' ;;
  -m) printf '%s\\n' "$MACHINE" ;;
  *) exit 1 ;;
esac
`);
    writeFileSync(lipo, `#!/bin/bash
if [[ "$1" == "-archs" ]]; then
  case "$(basename "$2")" in
    recreate) printf '%s\\n' "$RECREATE_ARCHES" ;;
    *) printf '%s\\n' "$ARCHES" ;;
  esac
  exit 0
fi
exit 1
`);
    writeFileSync(sysctl, `#!/bin/bash
printf '%s\\n' '0'
`);
    chmodSync(uname, 0o755);
    chmodSync(lipo, 0o755);
    chmodSync(sysctl, 0o755);
    const recreate = join(dir, 'recreate');
    writeFileSync(recreate, '#!/bin/bash\nexit 1\n');
    chmodSync(recreate, 0o755);
    const run = (machine, arches, recreateArches = 'arm64') => {
      const venv = join(dir, 'venv');
      rmSync(venv, { recursive: true, force: true });
      mkdirSync(join(venv, 'bin'), { recursive: true });
      writeFileSync(join(venv, 'bin', 'python3'), 'PY');
      execFileSync('bash', ['-c', `${apple}\n${reset}\nreset_universal_venv "$1" "$2"`, 'bash', venv, recreate], {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          ARCHES: arches,
          RECREATE_ARCHES: recreateArches,
          MACHINE: machine,
        },
      });
      return existsSync(venv);
    };
    expect(run('arm64', 'x86_64 arm64')).toBe(false);
    expect(run('arm64', 'x86_64 arm64', 'x86_64')).toBe(true);
    expect(run('arm64', 'arm64')).toBe(true);
    expect(run('x86_64', 'x86_64 arm64')).toBe(true);
    const runNamed = (name, recreateArches) => {
      const venv = join(dir, 'venv');
      rmSync(venv, { recursive: true, force: true });
      mkdirSync(join(venv, 'bin'), { recursive: true });
      writeFileSync(join(venv, 'bin', 'python3'), 'PY');
      execFileSync('bash', ['-c', `${apple}\n${reset}\nreset_universal_venv "$1" "$2"`, 'bash', venv, name], {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          ARCHES: 'x86_64 arm64',
          RECREATE_ARCHES: recreateArches,
          MACHINE: 'arm64',
        },
      });
      return existsSync(venv);
    };
    // PYTHON_BIN defaults to the command name python3. [[ -x python3 ]] does
    // not search PATH, so a bare name must still reach the arm64 check.
    expect(runNamed('recreate', 'arm64')).toBe(false);
    expect(runNamed('recreate', 'x86_64')).toBe(true);
    expect(runNamed('missing-python', 'arm64')).toBe(true);
    const inside = join(dir, 'venv');
    rmSync(inside, { recursive: true, force: true });
    mkdirSync(join(inside, 'bin'), { recursive: true });
    const insidePy = join(inside, 'bin', 'python3');
    writeFileSync(insidePy, '#!/bin/bash\nexit 0\n');
    chmodSync(insidePy, 0o755);
    execFileSync('bash', ['-c', `${apple}\n${reset}\nreset_universal_venv "$1" "$2"`, 'bash', inside, insidePy], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        ARCHES: 'x86_64 arm64',
        RECREATE_ARCHES: 'arm64',
        MACHINE: 'arm64',
      },
    });
    expect(existsSync(inside)).toBe(true);
    const namedRoot = join(dir, 'named-venv');
    const later = join(dir, 'later-python');
    const prepareNamed = () => {
      rmSync(namedRoot, { recursive: true, force: true });
      mkdirSync(join(namedRoot, 'bin'), { recursive: true });
      mkdirSync(later, { recursive: true });
      writeFileSync(join(namedRoot, 'bin', 'python3'), '#!/bin/bash\nexit 0\n');
      chmodSync(join(namedRoot, 'bin', 'python3'), 0o755);
      writeFileSync(join(later, 'python3'), '#!/bin/bash\nexit 0\n');
      chmodSync(join(later, 'python3'), 0o755);
    };
    prepareNamed();
    execFileSync('bash', ['-c', `${apple}\n${reset}\nreset_universal_venv "$1" python3`, 'bash', namedRoot], {
      env: {
        ...process.env,
        PATH: `${join(namedRoot, 'bin')}:${later}:${dir}:${process.env.PATH}`,
        ARCHES: 'x86_64 arm64',
        RECREATE_ARCHES: 'arm64',
        MACHINE: 'arm64',
      },
    });
    expect(existsSync(namedRoot)).toBe(false);
    prepareNamed();
    execFileSync('bash', ['-c', `${apple}\n${reset}\nreset_universal_venv "$1" python3`, 'bash', namedRoot], {
      env: {
        ...process.env,
        PATH: `${join(namedRoot, 'bin')}:${dir}:/bin`,
        ARCHES: 'x86_64 arm64',
        RECREATE_ARCHES: 'arm64',
        MACHINE: 'arm64',
      },
    });
    expect(existsSync(namedRoot)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('does not choose a python inside the venv it may delete', () => {
    const newest = source.match(/^newest_supported_python\(\) \{\n(?:.*\n)*?^\}\n/m)?.[0];
    const atLeast = source.match(/^python_at_least_310\(\) \{\n(?:.*\n)*?^\}\n/m)?.[0];
    const have = source.match(/^have\(\) \{.*\}\n/m)?.[0];
    expect(newest).toBeTruthy();
    expect(atLeast).toBeTruthy();
    expect(have).toBeTruthy();
    const dir = mkdtempSync(join(tmpdir(), 'portos-newest-py-'));
    tempVenvs.push(dir);
    const venvBin = join(dir, 'venv', 'bin');
    const outside = join(dir, 'outside');
    mkdirSync(venvBin, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const script = '#!/bin/bash\nexit 0\n';
    writeFileSync(join(venvBin, 'python3'), script);
    writeFileSync(join(outside, 'python3.12'), script);
    chmodSync(join(venvBin, 'python3'), 0o755);
    chmodSync(join(outside, 'python3.12'), 0o755);
    const run = (exclude) => execFileSync(
      'bash',
      ['-c', `${have}\n${atLeast}\n${newest}\nnewest_supported_python "$1"`, 'bash', exclude],
      {
        env: { ...process.env, PATH: `${venvBin}:${outside}:/bin:/usr/bin`, PYTHON_BIN: 'python3' },
        encoding: 'utf8',
      },
    );
    expect(run('').trim()).toBe(join(venvBin, 'python3'));
    expect(run(join(dir, 'venv')).trim()).toBe(join(outside, 'python3.12'));
  });

  it.skipIf(process.platform === 'win32')('points a thinned framework interpreter at its original library', () => {
    const pin = source.match(/^pin_venv_arm64\(\) \{\n(?:.*\n)*?^\}\n/m)?.[0];
    const apple = source.match(/^is_apple_silicon\(\) \{\n(?:.*\n)*?^\}\n/m)?.[0];
    expect(pin).toContain('install_name_tool');
    const dir = mkdtempSync(join(tmpdir(), 'portos-framework-pin-'));
    tempVenvs.push(dir);
    const uname = join(dir, 'uname');
    const lipo = join(dir, 'lipo');
    const otool = join(dir, 'otool');
    const installName = join(dir, 'install_name_tool');
    const codesign = join(dir, 'codesign');
    writeFileSync(uname, `#!/bin/bash
case "$1" in
  -s) printf '%s\\n' 'Darwin' ;;
  -m) printf '%s\\n' 'arm64' ;;
  *) exit 1 ;;
esac
`);
    writeFileSync(lipo, `#!/bin/bash
if [[ "$1" == "-archs" ]]; then
  printf '%s\\n' 'x86_64 arm64'
  exit 0
fi
if [[ "$1" == "-thin" && "$2" == "arm64" && "$4" == "-output" ]]; then
  printf '%s\\n' 'THIN' > "$5"
  exit 0
fi
exit 1
`);
    writeFileSync(otool, `#!/bin/bash
printf '%s\\n' "$1:"
printf '%s\\n' '    @executable_path/../Python3 (compatibility version 3.9.0, current version 3.9.0)'
`);
    writeFileSync(installName, `#!/bin/bash
printf '%s\\n' "$*" >> "$LOG"
exit 0
`);
    writeFileSync(codesign, `#!/bin/bash
printf '%s\\n' codesign >> "$LOG"
exit 0
`);
    for (const bin of [uname, lipo, otool, installName, codesign]) chmodSync(bin, 0o755);
    const framework = join(dir, 'framework');
    const venv = join(dir, 'venv');
    mkdirSync(join(framework, 'bin'), { recursive: true });
    mkdirSync(join(venv, 'bin'), { recursive: true });
    const origin = join(framework, 'bin', 'python3.9');
    const library = join(framework, 'Python3');
    writeFileSync(origin, 'FRAMEWORK');
    writeFileSync(library, 'LIB');
    const link = join(venv, 'bin', 'python3');
    execFileSync('ln', ['-s', origin, link]);
    const log = join(dir, 'tool.log');
    writeFileSync(log, '');
    execFileSync('bash', ['-c', `${apple}\n${pin}\npin_venv_arm64 "$1"`, 'bash', venv], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LOG: log },
    });
    expect(readFileSync(link, 'utf8')).toBe('THIN\n');
    expect(readFileSync(origin, 'utf8')).toBe('FRAMEWORK');
    expect(readFileSync(log, 'utf8')).toContain(`-change @executable_path/../Python3 ${library}`);
    rmSync(library);
    execFileSync('ln', ['-sfn', origin, link]);
    writeFileSync(log, '');
    execFileSync('bash', ['-c', `${apple}\n${pin}\npin_venv_arm64 "$1"`, 'bash', venv], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LOG: log },
    });
    expect(readFileSync(link, 'utf8')).toBe('FRAMEWORK');
    expect(readFileSync(log, 'utf8')).toBe('');
  });

  it('captures diagnostics for every aborting install probe', () => {
    const abortProbeBlocks = shellIfBlocks(source)
      .filter((block) => block.includes('2>/dev/null') && /\bexit 1\b/.test(block));

    expect(abortProbeBlocks).toEqual([]);
  });
});

// `uv pip install` picks its target interpreter from VIRTUAL_ENV, then
// CONDA_PREFIX, and only then the cwd's .venv. On a machine whose login shell
// activates conda, PortOS inherits CONDA_PREFIX through PM2 and hands it to the
// installer — so a `uv pip install` that relies on cwd discovery installs into
// the user's conda base environment (downgrading torch/transformers/gradio
// there) and leaves the runtime venv empty. The import probe then fails with
// "No module named 'fastvideo'" pointing at a venv nothing was ever written to.
// `uv sync` is not affected: it always resolves the project's own .venv.
describe('uv installs target their own venv, not an inherited one', () => {
  it('passes --python to every uv pip install', () => {
    // Every other install in this script runs `<interpreter> -m pip install`,
    // which names its target outright. A bare `pip install` subcommand is uv's,
    // and only uv's needs --python.
    const undirected = source
      .split('\n')
      .filter((line) => /\bpip\s+install\b/.test(line))
      .filter((line) => !/^\s*(#|echo\b)/.test(line) && !line.includes('"Try:'))
      .filter((line) => !/-m\s+pip\s+install\b/.test(line))
      .filter((line) => !line.includes('--python'));

    expect(undirected).toEqual([]);
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
