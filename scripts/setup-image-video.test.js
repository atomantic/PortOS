import { execFileSync, spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveBashBinary } from '../server/lib/bashResolver.js';
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
    const routes = source.match(/^path_routes_through\(\) \{\n(?:.*\n)*?^\}\n/m)?.[0];
    const reset = `${routes}${source.match(/^reset_universal_venv\(\) \{\n(?:.*\n)*?^\}\n/m)?.[0]}`;
    const apple = source.match(/^is_apple_silicon\(\) \{\n(?:.*\n)*?^\}\n/m)?.[0];
    const atLeast = source.match(/^python_at_least_310\(\) \{\n(?:.*\n)*?^\}\n/m)?.[0];
    expect(routes).toBeTruthy();
    expect(reset).toContain('reset_universal_venv() {');
    expect(atLeast).toBeTruthy();
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
    // Linux CI's /bin is /usr/bin and contains python3. The lipo stub reports
    // ARCHES for every binary except "recreate", so that interpreter looks like
    // a universal replacement and the reset deletes the venv under test.
    const tools = join(dir, 'tools');
    mkdirSync(tools);
    symlinkSync('/bin/bash', join(tools, 'bash'));
    symlinkSync('/bin/rm', join(tools, 'rm'));
    symlinkSync('/usr/bin/readlink', join(tools, 'readlink'));
    const recreate = join(dir, 'recreate');
    writeFileSync(recreate, `#!/bin/bash
case "$*" in
  *version_info*) [[ "\${TOO_OLD:-}" == 1 ]] && exit 1; exit 0 ;;
  *) exit 1 ;;
esac
`);
    chmodSync(recreate, 0o755);
    const run = (machine, arches, recreateArches = 'arm64', tooOld = '') => {
      const venv = join(dir, 'venv');
      rmSync(venv, { recursive: true, force: true });
      mkdirSync(join(venv, 'bin'), { recursive: true });
      writeFileSync(join(venv, 'bin', 'python3'), 'PY');
      execFileSync('bash', ['-c', `${apple}\n${atLeast}\n${reset}\nreset_universal_venv "$1" "$2"`, 'bash', venv, recreate], {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          ARCHES: arches,
          RECREATE_ARCHES: recreateArches,
          MACHINE: machine,
          TOO_OLD: tooOld,
        },
      });
      return existsSync(venv);
    };
    expect(run('arm64', 'x86_64 arm64')).toBe(false);
    expect(run('arm64', 'x86_64 arm64', 'arm64', '1')).toBe(true);
    expect(run('arm64', 'x86_64 arm64', 'x86_64')).toBe(true);
    expect(run('arm64', 'arm64')).toBe(true);
    expect(run('x86_64', 'x86_64 arm64')).toBe(true);
    const runNamed = (name, recreateArches) => {
      const venv = join(dir, 'venv');
      rmSync(venv, { recursive: true, force: true });
      mkdirSync(join(venv, 'bin'), { recursive: true });
      writeFileSync(join(venv, 'bin', 'python3'), 'PY');
      execFileSync('bash', ['-c', `${apple}\n${atLeast}\n${reset}\nreset_universal_venv "$1" "$2"`, 'bash', venv, name], {
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
    execFileSync('bash', ['-c', `${apple}\n${atLeast}\n${reset}\nreset_universal_venv "$1" "$2"`, 'bash', inside, insidePy], {
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
    execFileSync('bash', ['-c', `${apple}\n${atLeast}\n${reset}\nreset_universal_venv "$1" python3`, 'bash', namedRoot], {
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
    execFileSync('bash', ['-c', `${apple}\n${atLeast}\n${reset}\nreset_universal_venv "$1" python3`, 'bash', namedRoot], {
      env: {
        ...process.env,
        PATH: `${join(namedRoot, 'bin')}:${dir}:${tools}`,
        ARCHES: 'x86_64 arm64',
        RECREATE_ARCHES: 'arm64',
        MACHINE: 'arm64',
      },
    });
    expect(existsSync(namedRoot)).toBe(true);
    const versioned = join(dir, 'versioned-venv');
    rmSync(versioned, { recursive: true, force: true });
    mkdirSync(join(versioned, 'bin'), { recursive: true });
    writeFileSync(join(versioned, 'bin', 'python3.11'), '#!/bin/bash\nexit 0\n');
    chmodSync(join(versioned, 'bin', 'python3.11'), 0o755);
    writeFileSync(join(later, 'python3.13'), '#!/bin/bash\nexit 0\n');
    chmodSync(join(later, 'python3.13'), 0o755);
    execFileSync('bash', ['-c', `${apple}\n${atLeast}\n${reset}\nreset_universal_venv "$1" python3.11`, 'bash', versioned], {
      env: {
        ...process.env,
        PATH: `${join(versioned, 'bin')}:${later}:${dir}:${tools}`,
        ARCHES: 'x86_64 arm64',
        RECREATE_ARCHES: 'arm64',
        MACHINE: 'arm64',
      },
    });
    expect(existsSync(versioned)).toBe(true);
    const relativeHome = join(dir, 'home');
    const relativeVenv = join(relativeHome, 'venv');
    rmSync(relativeHome, { recursive: true, force: true });
    mkdirSync(join(relativeVenv, 'bin'), { recursive: true });
    writeFileSync(join(relativeVenv, 'bin', 'python3'), '#!/bin/bash\nexit 0\n');
    chmodSync(join(relativeVenv, 'bin', 'python3'), 0o755);
    execFileSync('bash', ['-c', `cd "$3"\n${apple}\n${atLeast}\n${reset}\nreset_universal_venv "$1" "$2"`, 'bash', relativeVenv, 'venv/bin/python3', relativeHome], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        ARCHES: 'x86_64 arm64',
        RECREATE_ARCHES: 'arm64',
        MACHINE: 'arm64',
      },
    });
    expect(existsSync(relativeVenv)).toBe(true);
    prepareNamed();
    writeFileSync(join(namedRoot, 'bin', 'python3'), '#!/bin/bash\necho INSIDE\n');
    chmodSync(join(namedRoot, 'bin', 'python3'), 0o755);
    writeFileSync(join(later, 'python3'), '#!/bin/bash\necho OUTSIDE\n');
    chmodSync(join(later, 'python3'), 0o755);
    const hashed = execFileSync('bash', ['-c', `set -e\n${apple}\n${atLeast}\n${reset}\npython3 >/dev/null\nreset_universal_venv "$1" python3\npython3`, 'bash', namedRoot], {
      env: {
        ...process.env,
        PATH: `${join(namedRoot, 'bin')}:${later}:${dir}:${tools}`,
        ARCHES: 'x86_64 arm64',
        RECREATE_ARCHES: 'arm64',
        MACHINE: 'arm64',
      },
      encoding: 'utf8',
    });
    expect(hashed).toContain('OUTSIDE');
    expect(hashed).not.toContain('INSIDE');
    // A replacement outside the venv that is a symlink to the venv's own
    // interpreter would dangle once the venv is deleted, whether the caller
    // named it by path or it is the later PATH match for a bare name.
    const aliases = join(dir, 'aliases');
    const runAlias = (python, pathDirs) => {
      prepareNamed();
      rmSync(aliases, { recursive: true, force: true });
      mkdirSync(aliases);
      symlinkSync(join(namedRoot, 'bin', 'python3'), join(aliases, 'python3'));
      execFileSync('bash', ['-c', `${apple}\n${atLeast}\n${reset}\nreset_universal_venv "$1" "$2"`, 'bash', namedRoot, python], {
        env: { ...process.env, PATH: pathDirs.join(':'), ARCHES: 'x86_64 arm64', RECREATE_ARCHES: 'arm64', MACHINE: 'arm64' },
      });
      return existsSync(namedRoot);
    };
    expect(runAlias(join(aliases, 'python3'), [dir, tools])).toBe(true);
    expect(runAlias('python3', [join(namedRoot, 'bin'), aliases, dir, tools])).toBe(true);
    expect(runAlias('python3', [join(namedRoot, 'bin'), aliases, later, dir, tools])).toBe(false);
    // A path that walks through a directory link inside the venv still depends
    // on the venv, even though that link resolves out of it.
    prepareNamed();
    symlinkSync(later, join(namedRoot, 'bin', 'alias'));
    execFileSync('bash', ['-c', `${apple}\n${atLeast}\n${reset}\nreset_universal_venv "$1" "$2"`, 'bash', namedRoot, join(namedRoot, 'bin', 'alias', 'python3')], {
      env: { ...process.env, PATH: [dir, tools].join(':'), ARCHES: 'x86_64 arm64', RECREATE_ARCHES: 'arm64', MACHINE: 'arm64' },
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
    const tools = join(dir, 'tools');
    mkdirSync(venvBin, { recursive: true });
    mkdirSync(outside, { recursive: true });
    mkdirSync(tools);
    // Host /bin can contain a newer python3.N than the stub. The search must
    // see only the interpreters this test creates.
    symlinkSync('/bin/bash', join(tools, 'bash'));
    const script = '#!/bin/bash\nexit 0\n';
    writeFileSync(join(venvBin, 'python3'), script);
    writeFileSync(join(outside, 'python3.12'), script);
    chmodSync(join(venvBin, 'python3'), 0o755);
    chmodSync(join(outside, 'python3.12'), 0o755);
    const run = (exclude) => execFileSync(
      'bash',
      ['-c', `${have}\n${atLeast}\n${newest}\nnewest_supported_python "$1"`, 'bash', exclude],
      {
        env: { ...process.env, PATH: `${venvBin}:${outside}:${tools}`, PYTHON_BIN: 'python3' },
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

describe('MiniMax H3 MLX hash-pinned lock', () => {
  const pinnedNames = (text) => text.split('\n').filter((l) => /^[a-z]/i.test(l)).map((l) => l.split(/ |\\/)[0]);
  const input = readFileSync(join(REPO_ROOT, 'scripts', 'requirements-minimax-h3-mlx.txt'), 'utf8');
  const lock = readFileSync(join(REPO_ROOT, 'scripts', 'requirements-minimax-h3-mlx.lock.txt'), 'utf8');

  it('locks exactly the validated input set, every package carrying sha256 hashes', () => {
    const locked = pinnedNames(lock);
    expect(locked).toEqual(pinnedNames(input));
    const blocks = lock.split(/\n(?=[a-z][^\n]*==)/i).filter((b) => /^[a-z][^\n]*==/i.test(b));
    expect(blocks).toHaveLength(locked.length);
    for (const block of blocks) expect(block).toMatch(/--hash=sha256:[0-9a-f]{64}/);
  });

  it('installs the lock with --require-hashes so nothing resolves at install time', () => {
    expect(source).toMatch(/pip sync --require-hashes --python "\$MINIMAX_H3_PY" "\$MINIMAX_H3_LOCK"/);
  });
});

describe('LTX-2.5 CUDA Install/Repair', () => {
  const shell = resolveBashBinary();
  const direct = readFileSync(join(REPO_ROOT, 'scripts/requirements-ltx25-cuda.txt'), 'utf8')
    .split(/\r?\n/).filter((line) => /^[\w.-]+==/.test(line));

  function installer(target) {
    const home = mkdtempSync(join(tmpdir(), 'portos-ltx25-install-'));
    tempVenvs.push(home);
    const log = join(home, 'commands.log');
    const stub = join(home, 'python-stub');
    writeFileSync(stub, `#!/usr/bin/env bash
printf 'python %s\\n' "$*" >> "$LOG"
if [[ "$*" == *sys.version_info* ]]; then exit "\${COMPAT_EXIT:-0}"; fi
if [[ "$*" == *DistilledPipeline* ]]; then exit "\${PROBE_EXIT:-0}"; fi
exit 0
`);
    const run = (env = {}) => execFileSync(shell, ['-c', `
set -euo pipefail
export HOME="$TEST_HOME"
uname() { if [[ "\${1:-}" == -m ]]; then echo x86_64; else echo "$TARGET"; fi; }
uv() {
  printf 'uv %s\\n' "$*" >> "$LOG"
  if [[ "$1" == venv ]]; then
    local root="\${@: -1}" layout=bin/python3
    if [[ "$TARGET" == MINGW64_NT* ]]; then layout=Scripts/python.exe; fi
    mkdir -p "$(dirname "$root/$layout")"
    cp "$STUB" "$root/$layout"
    chmod +x "$root/$layout"
  elif [[ "$1 $2" == 'pip install' ]]; then
    [[ "$*" == *'--require-hashes --only-binary :all: --no-deps'* && "$*" == *requirements-ltx25-cuda-build.lock.txt ]] || return 92
    return "\${BUILD_EXIT:-0}"
  elif [[ "$1 $2" == 'pip sync' ]]; then
    return "\${SYNC_EXIT:-0}"
  else
    echo 'Unexpected unlocked install' >&2; return 91
  fi
}
source "$1"
`, 'bash', SETUP_SCRIPT.replaceAll('\\', '/')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...Object.fromEntries(installFlags.map((flag) => [flag, '0'])),
        TEST_HOME: home.replaceAll('\\', '/'),
        PORTOS_DATA: join(home, 'data').replaceAll('\\', '/'),
        LOG: log.replaceAll('\\', '/'), STUB: stub.replaceAll('\\', '/'),
        TARGET: target === 'windows' ? 'MINGW64_NT-10.0' : 'Linux',
        PYTHON_BIN: 'true', INSTALL_LTX25_CUDA: '1',
        PORTOS_LTX25_CUDA_TORCH_INDEX: 'https://download.pytorch.org/whl/cu132',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { run, commands: () => readFileSync(log, 'utf8') };
  }

  it.each(['windows', 'linux'])('locks every %s distribution and uses that lock for fresh Install and Repair', (target) => {
    const lock = readFileSync(join(REPO_ROOT, 'scripts', `requirements-ltx25-cuda-${target}.lock.txt`), 'utf8');
    const requirements = lock.split(/\r?\n/).filter((line) => /^\w/.test(line));
    const blocks = lock.match(/^[\w.-]+(?:==| @ )[^\n]+\n(?:[ \t]+[^\n]*\n?)*/gm) ?? [];
    expect(blocks.length).toBe(requirements.length);
    for (const block of blocks) expect(block).toMatch(/--hash=sha256:[0-9a-f]{64}/);
    const pins = requirements.map((line) => line.replace(/\s*\\$/, ''));
    for (const pin of direct) expect(pins).toContain(pin);
    expect(lock).not.toMatch(/git\+/);
    expect(lock.match(/#subdirectory=packages\/ltx-/g)).toHaveLength(2);
    expect(lock).toContain('d151147788a9284cca791edc6ce898007e727fe6.tar.gz');
    const backend = readFileSync(join(REPO_ROOT, 'scripts/requirements-ltx25-cuda-build.lock.txt'), 'utf8');
    expect(backend.match(/^uv-build==[^\n]+\n(?:[ \t]+[^\n]*\n?)*/m)?.[0]).toBe(lock.match(/^uv-build==[^\n]+\n(?:[ \t]+[^\n]*\n?)*/m)?.[0]);
    expect(lock.includes('nvidia-cuda-runtime==')).toBe(target === 'linux');

    const install = installer(target);
    expect(install.run()).toContain('LTX-2.5 CUDA runtime ready');
    expect(install.run()).toContain('LTX-2.5 CUDA runtime ready');
    const commands = install.commands().split('\n');
    const syncs = commands.filter((line) => line.startsWith('uv pip'));
    expect(syncs).toHaveLength(4);
    for (const sync of syncs.filter((line) => line.startsWith('uv pip sync'))) {
      expect(sync).toContain('pip sync --require-hashes --only-binary :all:');
      expect(sync).toContain('--no-binary ltx-core,ltx-pipelines --no-build-isolation');
      expect(sync).toContain('--python ');
      expect(sync).toContain(`requirements-ltx25-cuda-${target}.lock.txt`);
    }
    expect(commands.filter((line) => line.startsWith('uv venv'))).toHaveLength(1);
    expect(install.commands()).toContain('venv --managed-python --python 3.11');
    expect(install.commands()).toContain('from ltx_pipelines.distilled import DistilledPipeline');
    expect(install.commands()).toContain('assert torch.cuda.is_available()');
    expect(install.commands()).not.toMatch(/--upgrade|git\+/);
  });

  it('rebuilds an incompatible existing interpreter before syncing during Repair', () => {
    const install = installer('windows');
    install.run();
    expect(install.run({ COMPAT_EXIT: '1' })).toContain('Rebuilding LTX-2.5 CUDA');
    expect(install.commands()).toContain('venv --clear --managed-python --python 3.11');
  });

  it.each([{ BUILD_EXIT: '41' }, { SYNC_EXIT: '42' }, { PROBE_EXIT: '43' }])('fails Install without reporting ready when sync or the CUDA probe fails (%j)', (failure) => {
    const install = installer('linux');
    let result;
    try { install.run(failure); } catch (error) { result = error; }
    expect(result).toBeDefined();
    expect(result.stdout).not.toContain('LTX-2.5 CUDA runtime ready');
    if (failure.PROBE_EXIT) expect(result.stderr).toContain('LTX-2.5 CUDA installed but its runtime probe failed');
    else expect(install.commands()).not.toContain('DistilledPipeline');
  });
});

describe('MiniMax H3 CUDA hash-pinned installation', () => {
  const section = source.slice(source.indexOf('INSTALL_MINIMAX_H3_CUDA="${'), source.indexOf('INSTALL_LTX25_CUDA="${'));
  const direct = readFileSync(join(REPO_ROOT, 'scripts', 'requirements-minimax-h3-cuda.txt'), 'utf8')
    .split(/\r?\n/).filter((line) => /^[\w.-]+==/.test(line));

  it.each(['windows', 'linux'])('hashes the complete %s set, including CUDA torch and torchao', (target) => {
    const lock = readFileSync(join(REPO_ROOT, 'scripts', `requirements-minimax-h3-cuda-${target}.lock.txt`), 'utf8');
    const requirements = lock.split(/\r?\n/).filter((line) => /^\w/.test(line));
    const blocks = lock.match(/^[\w.-]+==[^\n]+\n(?:[ \t]+[^\n]*\n?)*/gm) ?? [];
    expect(blocks.length).toBe(requirements.length);
    for (const block of blocks) expect(block).toMatch(/--hash=sha256:[0-9a-f]{64}/);
    const pins = requirements.map((line) => line.replace(/\s*\\$/, ''));
    // PEP 440 allows the Linux torchao CUDA build to satisfy its public pin.
    for (const pin of direct) expect(pins.some((locked) => locked === pin || (!pin.includes('+') && locked.split('+')[0] === pin))).toBe(true);
    expect(pins.find((pin) => pin.startsWith('torch=='))).toMatch(/\+cu126$/);
    expect(pins.find((pin) => pin.startsWith('torchao=='))).toMatch(/^torchao==0\.18\.0(?:\+cu126)?$/);
    expect(lock.includes('nvidia-cuda-runtime-cu12==')).toBe(target === 'linux');
    expect(section).not.toMatch(/pip install|--upgrade|git\+|requirements-minimax-h3-cuda\.txt/);
  });

  // Executes the public Install/Repair entry point with package tools doubled.
  // A Windows runner validates the real NVIDIA install separately; these shell
  // doubles exercise both OS selections on POSIX CI without a GPU or downloads.
  it.skipIf(process.platform === 'win32').each(['windows', 'linux'])('installs and repairs only the %s lock, and refuses failed sync/probes', (target) => {
    const dir = mkdtempSync(join(tmpdir(), 'portos-h3-install-'));
    tempVenvs.push(dir);
    const log = join(dir, 'calls');
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const executable = (name, script) => {
      writeFileSync(join(bin, name), `#!/bin/bash\nset -eu\n${script}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    executable('uname', `if [[ "$1" == -m ]]; then echo x86_64; else echo "\${TEST_OS}"; fi`);
    executable('python3', 'exit 0');
    executable('ffmpeg', 'exit 0');
    executable('ffprobe', 'exit 0');
    executable('uv', `printf '%s\\n' "$*" >> "$CALL_LOG"
if [[ "$1" == venv ]]; then
  root="\${@: -1}"
  mkdir -p "$root/$PY_LAYOUT"
  cp "$FAKE_PY" "$root/$PY_LAYOUT/$PY_NAME"
elif [[ "$1 $2" == 'pip sync' ]]; then
  [[ "$*" == *'--require-hashes --only-binary :all:'* ]]
  [[ "$*" == *"requirements-minimax-h3-cuda-$TARGET.lock.txt" ]]
  [[ "\${FAIL_SYNC:-0}" == 0 ]] || exit 41
else
  exit 42
fi`);
    const fakePy = join(dir, 'fake-python');
    writeFileSync(fakePy, `#!/bin/bash
set -eu
if [[ "$*" == *version_info* ]]; then exit "\${STALE_PYTHON:-0}"; fi
[[ "$*" == *'import torch;'* && "$*" == *'import torchao;'* && "$*" == *MiniMaxH3Transformer3DModel* && "$*" == *MiniMaxH3ImageReference* && "$*" == *'torch.cuda.is_available()'* ]] || exit 43
echo probe >> "$CALL_LOG"
exit "\${FAIL_PROBE:-0}"
`);
    chmodSync(fakePy, 0o755);
    const env = {
      ...process.env,
      ...Object.fromEntries(installFlags.map((flag) => [flag, '0'])),
      INSTALL_MINIMAX_H3_CUDA: '1', HOME: dir, PORTOS_DATA: join(dir, 'data'),
      PYTHON_BIN: 'python3', PATH: `${bin}:${process.env.PATH}`,
      PORTOS_TORCH_CUDA_INDEX: 'https://download.pytorch.org/whl/cu126',
      TARGET: target, TEST_OS: target === 'windows' ? 'MINGW64_NT' : 'Linux',
      PY_LAYOUT: target === 'windows' ? 'Scripts' : 'bin',
      PY_NAME: target === 'windows' ? 'python.exe' : 'python3', FAKE_PY: fakePy, CALL_LOG: log,
    };
    const run = (extra = {}) => {
      writeFileSync(log, '');
      const result = spawnSync('bash', [SETUP_SCRIPT], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 10000 });
      return { ...result, calls: readFileSync(log, 'utf8') };
    };
    const fresh = run();
    expect(fresh.status, fresh.stderr).toBe(0);
    expect(fresh.calls).toContain('venv --managed-python --python 3.11');
    expect(fresh.calls).toContain(`requirements-minimax-h3-cuda-${target}.lock.txt`);
    expect(fresh.stdout).toContain('MiniMax H3 CUDA runtime ready');
    const repair = run();
    expect(repair.status, repair.stderr).toBe(0);
    expect(repair.calls).not.toContain('venv ');
    expect(repair.calls).toContain('pip sync --require-hashes');
    const stale = run({ STALE_PYTHON: '1' });
    expect(stale.status, stale.stderr).toBe(0);
    expect(stale.calls).toContain('venv --clear --managed-python --python 3.11');
    const failedSync = run({ FAIL_SYNC: '1' });
    expect(failedSync.status).toBe(41);
    expect(failedSync.calls).not.toContain('probe');
    expect(failedSync.stdout).not.toContain('runtime ready');
    const failedProbe = run({ FAIL_PROBE: '1' });
    expect(failedProbe.status).toBe(1);
    expect(failedProbe.stderr).toContain('readiness check failed');
    expect(failedProbe.stdout).not.toContain('runtime ready');
    const wrongIndex = run({ PORTOS_TORCH_CUDA_INDEX: 'https://example.com/cu130' });
    expect(wrongIndex.status).toBe(1);
    expect(wrongIndex.calls).toBe('');
    expect(wrongIndex.stderr).toContain('locked to cu126');
  });
});

describe('Wan 2.2 CUDA hash-pinned installation', () => {
  const section = source.slice(source.indexOf('INSTALL_WAN22_CUDA="${'), source.indexOf('INSTALL_MUSICGEN="${'));
  const direct = readFileSync(join(REPO_ROOT, 'scripts', 'requirements-wan22-cuda.txt'), 'utf8')
    .split(/\r?\n/).filter((line) => /^[\w.-]+==/.test(line));

  it.each(['windows', 'linux'])('pins and hashes the entire %s runtime, including the CUDA torch stack', (target) => {
    const lock = readFileSync(join(REPO_ROOT, 'scripts', `requirements-wan22-cuda-${target}.lock.txt`), 'utf8');
    const requirements = lock.split(/\r?\n/).filter((line) => /^\w/.test(line));
    const blocks = lock.match(/^[\w.-]+==[^\n]+\n(?:[ \t]+[^\n]*\n?)*/gm) ?? [];
    expect(blocks.length).toBe(requirements.length);
    for (const block of blocks) expect(block).toMatch(/--hash=sha256:[0-9a-f]{64}/);
    const pins = requirements.map((line) => line.replace(/\s*\\$/, ''));
    for (const pin of direct) expect(pins).toContain(pin);
    expect(pins.find((pin) => pin.startsWith('torch=='))).toMatch(/\+cu126$/);
    expect(pins.find((pin) => pin.startsWith('torchvision=='))).toMatch(/\+cu126$/);
    expect(lock.includes('nvidia-cuda-runtime-cu12==')).toBe(target === 'linux');
  });

  it('uses only a host-selected hash lock for Install and Repair', () => {
    expect(section).toContain('requirements-wan22-cuda-windows.lock.txt');
    expect(section).toContain('requirements-wan22-cuda-linux.lock.txt');
    expect(section).toContain('pip sync --require-hashes --only-binary :all: --index-strategy unsafe-best-match --python "$WAN22_CUDA_PY" "$WAN22_CUDA_LOCK"');
    expect(section).not.toMatch(/pip install|--upgrade|requirements-wan22-cuda\.txt/);
    expect(section).toContain('uv venv --managed-python --python 3.11');
    expect(section).toContain('uv venv --clear --managed-python --python 3.11');
    expect(section).toContain("(Path(sys.base_prefix) / 'conda-meta').is_dir()");
  });
});

// Runs the real installer with uv/python stubbed: only `uv venv` and `uv pip sync`
// are allowed, so any unlocked install fails the run.
function lockedCudaInstaller(target, { flag, probe }) {
  const home = mkdtempSync(join(tmpdir(), 'portos-cuda-install-'));
  tempVenvs.push(home);
  const log = join(home, 'commands.log');
  const stub = join(home, 'python-stub');
  writeFileSync(stub, `#!/usr/bin/env bash
printf 'python %s\\n' "$*" >> "$LOG"
if [[ "$*" == *sys.version_info* ]]; then exit "\${COMPAT_EXIT:-0}"; fi
if [[ "$*" == *"$PROBE_MARKER"* ]]; then exit "\${PROBE_EXIT:-0}"; fi
exit 0
`);
  const run = (env = {}) => execFileSync(resolveBashBinary(), ['-c', `
set -euo pipefail
export HOME="$TEST_HOME"
uname() { if [[ "\${1:-}" == -m ]]; then echo x86_64; else echo "$TARGET"; fi; }
uv() {
  printf 'uv %s\\n' "$*" >> "$LOG"
  if [[ "$1" == venv ]]; then
    local root="\${@: -1}" layout=bin/python3
    if [[ "$TARGET" == MINGW64_NT* ]]; then layout=Scripts/python.exe; fi
    mkdir -p "$(dirname "$root/$layout")"
    cp "$STUB" "$root/$layout"
    chmod +x "$root/$layout"
  elif [[ "$1 $2" == 'pip sync' ]]; then
    return "\${SYNC_EXIT:-0}"
  else
    echo 'Unexpected unlocked install' >&2; return 91
  fi
}
source "$1"
`, 'bash', SETUP_SCRIPT.replaceAll('\\', '/')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...Object.fromEntries(installFlags.map((flag) => [flag, '0'])),
      TEST_HOME: home.replaceAll('\\', '/'),
      PORTOS_DATA: join(home, 'data').replaceAll('\\', '/'),
      LOG: log.replaceAll('\\', '/'), STUB: stub.replaceAll('\\', '/'),
      TARGET: target === 'windows' ? 'MINGW64_NT-10.0' : 'Linux',
      PYTHON_BIN: 'true', [flag]: '1', PROBE_MARKER: probe,
      PORTOS_TORCH_CUDA_INDEX: 'https://download.pytorch.org/whl/cu126',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { run, commands: () => readFileSync(log, 'utf8') };
}

describe('MiniMax Music 3 CUDA Install/Repair', () => {
  const direct = readFileSync(join(REPO_ROOT, 'scripts/requirements-minimax-music3-cuda.txt'), 'utf8')
    .split(/\r?\n/).filter((line) => /^[\w.-]+==/.test(line));

  const installer = (target) => lockedCudaInstaller(target, { flag: 'INSTALL_MINIMAX_MUSIC3', probe: 'ModularPipeline' });

  it.each(['windows', 'linux'])('locks every %s distribution and uses that lock for fresh Install and Repair', (target) => {
    const lock = readFileSync(join(REPO_ROOT, 'scripts', `requirements-minimax-music3-cuda-${target}.lock.txt`), 'utf8');
    const requirements = lock.split(/\r?\n/).filter((line) => /^\w/.test(line));
    const blocks = lock.match(/^[\w.-]+==[^\n]+\n(?:[ \t]+[^\n]*\n?)*/gm) ?? [];
    expect(blocks.length).toBe(requirements.length);
    for (const block of blocks) expect(block).toMatch(/--hash=sha256:[0-9a-f]{64}/);
    const pins = requirements.map((line) => line.replace(/\s*\\$/, ''));
    for (const pin of direct) expect(pins).toContain(pin);
    expect(lock).not.toMatch(/git\+|^[\w.-]+\s*@/m);
    expect(lock.includes('nvidia-cuda-runtime-cu12==')).toBe(target === 'linux');

    const install = installer(target);
    expect(install.run()).toContain('MiniMax Music 3 venv ready');
    expect(install.run()).toContain('MiniMax Music 3 venv ready');
    const commands = install.commands().split('\n');
    const syncs = commands.filter((line) => line.startsWith('uv pip'));
    expect(syncs).toHaveLength(2);
    for (const sync of syncs) {
      expect(sync).toContain('pip sync --require-hashes --only-binary :all:');
      expect(sync).toContain('--python ');
      expect(sync).toContain(`requirements-minimax-music3-cuda-${target}.lock.txt`);
    }
    expect(commands.filter((line) => line.startsWith('uv venv'))).toHaveLength(1);
    expect(install.commands()).toContain('venv --managed-python --python 3.11');
    expect(install.commands()).toContain('from diffusers.modular_pipelines.minimax_music3 import MiniMaxMusic3Blocks');
    expect(install.commands()).toContain('assert torch.cuda.is_available()');
    expect(install.commands()).not.toMatch(/pip install|--upgrade|git\+/);
  });

  it('rebuilds an incompatible existing interpreter before syncing during Repair', () => {
    const install = installer('windows');
    install.run();
    expect(install.run({ COMPAT_EXIT: '1' })).toContain('Rebuilding MiniMax Music 3 CUDA');
    expect(install.commands()).toContain('venv --clear --managed-python --python 3.11');
  });

  it.each([{ SYNC_EXIT: '42' }, { PROBE_EXIT: '43' }])('fails Install without reporting ready when sync or the CUDA probe fails (%j)', (failure) => {
    const install = installer('linux');
    let result;
    try { install.run(failure); } catch (error) { result = error; }
    expect(result).toBeDefined();
    expect(result.stdout).not.toContain('MiniMax Music 3 venv ready');
    if (failure.PROBE_EXIT) expect(result.stderr).toContain('MiniMax Music 3 CUDA installed but its runtime probe failed');
    else expect(install.commands()).not.toContain('ModularPipeline');
  });
});

describe.each([
  { runtime: 'MusicGen (MLX)', lock: 'requirements-musicgen-mlx.lock.txt', from: 'INSTALL_MUSICGEN" == "1"', to: 'INSTALL_AUDIOLDM2="${' },
  { runtime: 'MiniMax Music 3 (MLX)', lock: 'requirements-minimax-music3-mlx.lock.txt', from: 'INSTALL_MINIMAX_MUSIC3_MLX" == "1"', to: 'INSTALL_MUSCRIPTOR="${' },
])('$runtime install is hash-pinned', ({ lock: lockName, from, to }) => {
  const lock = readFileSync(join(REPO_ROOT, 'scripts', lockName), 'utf8');

  it('every locked package carries a sha256 hash and none comes from a VCS or URL source', () => {
    const blocks = lock.split(/\n(?=[a-z][^\n]*==)/i).filter((b) => /^[a-z][^\n]*==/i.test(b));
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) expect(block).toMatch(/--hash=sha256:[0-9a-f]{64}/);
    expect(lock).not.toMatch(/^[a-z][^\n]* @ /im);
  });

  it('installs from the lock with --require-hashes and resolves nothing at install time', () => {
    const section = source.slice(source.indexOf(from), source.indexOf(to));
    expect(section).toContain(`pip install --require-hashes --no-deps -r "$SCRIPT_DIR/${lockName}"`);
    expect(section).not.toMatch(/pip install --upgrade/);
  });
});

describe('MuScriptor Apple Silicon install is hash-pinned', () => {
  const lock = readFileSync(join(REPO_ROOT, 'scripts', 'requirements-muscriptor-mlx.lock.txt'), 'utf8');
  const section = source.slice(source.indexOf('INSTALL_MUSCRIPTOR" == "1"'), source.indexOf('INSTALL_FLUX2="${'));
  const [appleBranch, otherBranch] = section.split(/^  else$/m);

  it('every locked package carries a sha256 hash, none comes from a VCS or URL source, and all are arm64-macOS scoped', () => {
    const blocks = lock.split(/\n(?=[a-z][^\n]*==)/i).filter((b) => /^[a-z][^\n]*==/i.test(b));
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block).toMatch(/--hash=sha256:[0-9a-f]{64}/);
      const pin = block.split('\n')[0];
      expect(pin).toContain("sys_platform == 'darwin'");
      expect(pin).toContain("platform_machine == 'arm64'");
    }
    expect(lock).not.toMatch(/^[a-z][^\n]* @ /im);
  });

  it('Apple Silicon installs from the lock with --require-hashes and resolves nothing', () => {
    expect(appleBranch).toContain('is_apple_silicon');
    expect(appleBranch).toContain('pip install --require-hashes --no-deps -r "$SCRIPT_DIR/requirements-muscriptor-mlx.lock.txt"');
    expect(appleBranch).not.toMatch(/pip install --upgrade/);
  });

  it('refuses a Python older than the 3.11 floor the lock was compiled for', () => {
    expect(appleBranch).toContain('sys.version_info[:2] >= (3, 11)');
  });

  it('installs nothing on Linux/Windows outside the hash-pinned CUDA locks', () => {
    expect(otherBranch).not.toMatch(/pip install|--upgrade/);
  });
});

describe('AudioLDM2 Apple Silicon install is hash-pinned', () => {
  const lock = readFileSync(join(REPO_ROOT, 'scripts', 'requirements-audioldm2-mlx.lock.txt'), 'utf8');
  const section = source.slice(source.indexOf('INSTALL_AUDIOLDM2" == "1"'), source.indexOf('INSTALL_ACESTEP="${'));
  const [appleBranch, otherBranch] = section.split(/^  else$/m);

  it('every locked package carries a sha256 hash, none comes from a VCS or URL source, and all are arm64-macOS scoped', () => {
    const blocks = lock.split(/\n(?=[a-z][^\n]*==)/i).filter((b) => /^[a-z][^\n]*==/i.test(b));
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block).toMatch(/--hash=sha256:[0-9a-f]{64}/);
      const pin = block.split('\n')[0];
      expect(pin).toContain("sys_platform == 'darwin'");
      expect(pin).toContain("platform_machine == 'arm64'");
    }
    expect(lock).not.toMatch(/^[a-z][^\n]* @ /im);
  });

  it('Apple Silicon installs from the lock with --require-hashes and resolves nothing', () => {
    expect(appleBranch).toContain('is_apple_silicon');
    expect(appleBranch).toContain('pip install --require-hashes --no-deps -r "$SCRIPT_DIR/requirements-audioldm2-mlx.lock.txt"');
    expect(appleBranch).not.toMatch(/pip install --upgrade/);
  });

  it('refuses a Python older than the 3.11 floor the lock was compiled for', () => {
    expect(appleBranch).toContain('sys.version_info[:2] >= (3, 11)');
  });

  it('installs nothing on Linux/Windows outside the hash-pinned CUDA locks', () => {
    expect(otherBranch).not.toMatch(/pip install|--upgrade/);
  });
});

describe.each([
  { runtime: 'AudioLDM2', lockName: 'audioldm2', flag: 'INSTALL_AUDIOLDM2', probe: 'AudioLDM2Pipeline', probeImport: 'from diffusers import AudioLDM2Pipeline' },
  { runtime: 'MuScriptor', lockName: 'muscriptor', flag: 'INSTALL_MUSCRIPTOR', probe: 'TranscriptionModel', probeImport: 'from muscriptor import TranscriptionModel' },
])('$runtime Windows/Linux Install/Repair', ({ runtime, lockName, flag, probe, probeImport }) => {
  const direct = readFileSync(join(REPO_ROOT, `scripts/requirements-${lockName}-cuda.txt`), 'utf8')
    .split(/\r?\n/).filter((line) => /^[\w.-]+(\[[\w,-]+\])?==/.test(line))
    .map((line) => line.replace(/\[[\w,-]+\]/, ''));
  const installer = (target) => lockedCudaInstaller(target, { flag, probe });

  it.each(['windows', 'linux'])('locks every %s distribution and uses that lock for fresh Install and Repair', (target) => {
    const lock = readFileSync(join(REPO_ROOT, 'scripts', `requirements-${lockName}-cuda-${target}.lock.txt`), 'utf8');
    const requirements = lock.split(/\r?\n/).filter((line) => /^\w/.test(line));
    const blocks = lock.match(/^[\w.-]+==[^\n]+\n(?:[ \t]+[^\n]*\n?)*/gm) ?? [];
    expect(blocks.length).toBe(requirements.length);
    for (const block of blocks) expect(block).toMatch(/--hash=sha256:[0-9a-f]{64}/);
    const pins = requirements.map((line) => line.replace(/\s*\\$/, ''));
    expect(direct.length).toBeGreaterThan(0);
    for (const pin of direct) expect(pins).toContain(pin);
    expect(pins.some((pin) => pin.startsWith('hf-xet=='))).toBe(true);
    expect(lock).not.toMatch(/git\+|^[\w.-]+\s*@/m);
    expect(lock.includes('nvidia-cuda-runtime-cu12==')).toBe(target === 'linux');

    const install = installer(target);
    expect(install.run()).toContain(`${runtime} venv ready`);
    expect(install.run()).toContain(`${runtime} venv ready`);
    const commands = install.commands().split('\n');
    const syncs = commands.filter((line) => line.startsWith('uv pip'));
    expect(syncs).toHaveLength(2);
    for (const sync of syncs) {
      expect(sync).toContain('pip sync --require-hashes --only-binary :all:');
      expect(sync).toContain(`requirements-${lockName}-cuda-${target}.lock.txt`);
    }
    expect(commands.filter((line) => line.startsWith('uv venv'))).toHaveLength(1);
    expect(install.commands()).toContain('venv --managed-python --python 3.11');
    expect(install.commands()).toContain(probeImport);
    expect(install.commands()).not.toMatch(/pip install|--upgrade|git\+/);
  });

  it('rebuilds an incompatible existing interpreter before syncing during Repair', () => {
    const install = installer('linux');
    install.run();
    expect(install.run({ COMPAT_EXIT: '1' })).toContain(`Rebuilding ${runtime} CUDA`);
    expect(install.commands()).toContain('venv --clear --managed-python --python 3.11');
  });

  it.each([{ SYNC_EXIT: '42' }, { PROBE_EXIT: '43' }])('fails Install without reporting ready when sync or the probe fails (%j)', (failure) => {
    const install = installer('windows');
    let result;
    try { install.run(failure); } catch (error) { result = error; }
    expect(result).toBeDefined();
    expect(result.stdout).not.toContain(`${runtime} venv ready`);
    if (failure.PROBE_EXIT) expect(result.stderr).toContain(`${runtime} venv built but`);
    else expect(install.commands()).not.toContain(probe);
  });

  it('refuses a CUDA index the locks were not compiled for', () => {
    let result;
    try { installer('linux').run({ PORTOS_TORCH_CUDA_INDEX: 'https://download.pytorch.org/whl/cu132' }); } catch (error) { result = error; }
    expect(result?.stderr).toContain(`${runtime} CUDA is locked to cu126`);
  });
});

describe('shared mflux Apple Silicon install is hash-pinned', () => {
  const lockPath = join(REPO_ROOT, 'scripts', 'requirements-mflux-mlx.lock.txt');
  const lock = readFileSync(lockPath, 'utf8');
  const directPins = readFileSync(join(REPO_ROOT, 'scripts', 'requirements-mflux-mlx.txt'), 'utf8');
  const block = source.slice(source.indexOf('if [[ "$INSTALL_MFLUX" == "1" ]]; then'), source.indexOf('if [[ "$INSTALL_VIDEO" == "1" ]]; then'));

  // Run the real install block on "Apple Silicon" with a fake interpreter and
  // uv that record every call, so the branch logic and the mflux-only
  // requirement extraction are exercised rather than pattern-matched.
  const runBlock = ({ oldPython }) => {
    const dir = mkdtempSync(join(tmpdir(), 'portos-mflux-'));
    tempVenvs.push(dir);
    const log = join(dir, 'calls.log');
    const fakePython = join(dir, 'python3');
    writeFileSync(fakePython, `#!/bin/bash
echo "py $*" >> "${log}"
case "$*" in
  *version_info*) exit ${oldPython ? 1 : 0} ;;
  *--force-reinstall*) cp "\${@: -1}" "${log}.self-req" ;;
esac
exit 0
`);
    chmodSync(fakePython, 0o755);
    const script = `set -euo pipefail
INSTALL_MFLUX=1; PYTHON_BIN="${fakePython}"; SCRIPT_DIR="${join(REPO_ROOT, 'scripts')}"; HOME="${dir}"
is_apple_silicon() { return 0; }
have() { return 0; }
uv() { echo "uv $*" >> "${log}"; }
reset_universal_venv() { :; }
pin_venv_arm64() { :; }
probe_or_fail() { shift 2; echo "probe $*" >> "${log}"; }
${block}`;
    const result = spawnSync(resolveBashBinary(), ['-c', script], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    return {
      calls: readFileSync(log, 'utf8'),
      selfReq: existsSync(`${log}.self-req`) ? readFileSync(`${log}.self-req`, 'utf8') : null,
    };
  };

  it('every locked package carries a sha256 hash, none comes from a VCS or URL source, and all are arm64-macOS scoped', () => {
    const blocks = lock.split(/\n(?=[a-z][^\n]*==)/i).filter((b) => /^[a-z][^\n]*==/i.test(b));
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) {
      expect(b).toMatch(/--hash=sha256:[0-9a-f]{64}/);
      const pin = b.split('\n')[0];
      expect(pin).toContain("sys_platform == 'darwin'");
      expect(pin).toContain("platform_machine == 'arm64'");
    }
    expect(lock).not.toMatch(/^[a-z][^\n]* @ /im);
  });

  it('locks the validated trio the resolving path still names', () => {
    for (const name of ['MFLUX_PIN', 'MLX_PIN', 'MLX_METAL_PIN']) {
      const pin = block.match(new RegExp(`${name}='([^']+)'`))[1];
      expect(directPins).toMatch(new RegExp(`^${pin.replace(/[.]/g, '\\.')}$`, 'm'));
      expect(lock).toMatch(new RegExp(`^${pin.replace(/[.]/g, '\\.')} ;`, 'm'));
    }
  });

  it('locks Pillow 13+, the first release without the 12.x parser advisories (#15479)', () => {
    const pillow = lock.match(/^pillow==(\d+)\./m);
    expect(pillow, 'pillow must be locked').not.toBeNull();
    expect(Number(pillow[1])).toBeGreaterThanOrEqual(13);
    expect(directPins).toMatch(/^pillow==13\./m);
  });

  it('a 3.11+ PYTHON_BIN installs to the user site from the lock and probes both CLIs', () => {
    const { calls, selfReq } = runBlock({ oldPython: false });
    expect(calls).toContain(`-m pip install --user --require-hashes --no-deps --force-reinstall -r`);
    expect(calls).toContain(`-m pip install --user --require-hashes --no-deps -r ${lockPath}`);
    expect(calls).not.toMatch(/pip install --upgrade|pip install --user mflux/);
    expect(calls).toContain('from mflux.models.flux.cli.flux_generate import main; from mflux.models.common.cli.train import main');
    expect(calls).not.toMatch(/^uv /m);
    // The stale-layout flush reinstalls mflux alone, still hash-checked.
    expect(selfReq).toMatch(/^mflux==[^\n]*\\\n\s+--hash=sha256:/);
    expect(selfReq.match(/^[a-z][^\n]*==/gim)).toHaveLength(1);
  });

  it('an older PYTHON_BIN syncs the dedicated venv to the lock instead', () => {
    const { calls } = runBlock({ oldPython: true });
    expect(calls).not.toMatch(/pip install --user/);
    expect(calls).toMatch(new RegExp(`^uv pip sync --python \\S+/\\.portos/venv-mflux/bin/python3 --require-hashes ${lockPath.replace(/[.]/g, '\\.')}$`, 'm'));
    expect(calls).not.toMatch(/^uv pip install/m);
    expect(calls).toMatch(/^probe \S+venv-mflux\/bin\/python3 -c from mflux\.models\.flux\.cli\.flux_generate import main/m);
  });
});

describe('FLUX.2 Apple Silicon install is hash-pinned', () => {
  const lock = readFileSync(join(REPO_ROOT, 'scripts', 'requirements-flux2-mlx.lock.txt'), 'utf8');
  const section = source.slice(source.indexOf('INSTALL_FLUX2" == "1"'), source.indexOf('flux2 venv built but'));
  const [appleBranch, otherBranch] = section.split(/^    else$/m);

  it('every locked package carries a sha256 hash, none comes from a VCS or URL source, and all are arm64-macOS scoped', () => {
    const blocks = lock.split(/\n(?=[a-z][^\n]*==)/i).filter((b) => /^[a-z][^\n]*==/i.test(b));
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block).toMatch(/--hash=sha256:[0-9a-f]{64}/);
      const pin = block.split('\n')[0];
      expect(pin).toContain("sys_platform == 'darwin'");
      expect(pin).toContain("platform_machine == 'arm64'");
    }
    expect(lock).not.toMatch(/^[a-z][^\n]* @ /im);
  });

  it('Apple Silicon installs from the lock with --require-hashes and resolves nothing', () => {
    expect(appleBranch).toContain('if is_apple_silicon; then');
    expect(appleBranch).toContain('pip install --require-hashes --no-deps -r "$SCRIPT_DIR/requirements-flux2-mlx.lock.txt"');
    expect(appleBranch).not.toMatch(/pip install --upgrade/);
    expect(appleBranch).not.toContain('git+https');
  });

  it('refuses a Python older than the 3.11 floor the lock was compiled for', () => {
    expect(appleBranch).toContain('sys.version_info[:2] >= (3, 11)');
  });

  it('never skips the sync on Apple Silicon because an unlocked venv already imports', () => {
    const skipGuard = section.slice(section.indexOf('FLUX2_FORCE_REINSTALL:-}" != "1"'), section.indexOf('already ready'));
    expect(skipGuard).toContain('! is_apple_silicon');
  });

  it('keeps the resolving install for Linux/Windows until the CUDA lock lands', () => {
    expect(otherBranch).toMatch(/pip install --upgrade \\\n\s+"torch>=2\.5"/);
  });
});

describe('FastVideo MLX Apple Silicon install is hash-pinned', () => {
  const lock = readFileSync(join(REPO_ROOT, 'scripts', 'requirements-fastvideo-mlx.lock.txt'), 'utf8');
  const section = source.slice(source.indexOf('INSTALL_FASTVIDEO" == "1"'), source.indexOf('FastVideo MLX runtime ready'));

  it('every locked package carries a sha256 hash, none comes from a VCS or URL source, and all are arm64-macOS scoped', () => {
    const blocks = lock.split(/\n(?=[a-z][^\n]*==)/i).filter((b) => /^[a-z][^\n]*==/i.test(b));
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block).toMatch(/--hash=sha256:[0-9a-f]{64}/);
      const pin = block.split('\n')[0];
      expect(pin).toContain("sys_platform == 'darwin'");
      expect(pin).toContain("platform_machine == 'arm64'");
    }
    expect(lock).not.toMatch(/^[a-z][^\n]* @ /im);
  });

  it('installs the lock with uv pip sync --require-hashes and editable package with --no-deps', () => {
    expect(section).toContain('"$FASTVIDEO_UV" pip sync --require-hashes --python "${FASTVIDEO_PY}" "$FASTVIDEO_LOCK"');
    expect(section).toContain('"$FASTVIDEO_UV" pip install --no-deps --python "${FASTVIDEO_PY}" -e "${FASTVIDEO_DIR}"');
    expect(section).not.toContain("pip install --python \"${FASTVIDEO_PY}\" -e '.[mlx]'");
  });

  it('refuses a Python older than the 3.11 floor the lock was compiled for', () => {
    expect(section).toContain('sys.version_info[:2] >= (3, 11)');
  });
});

describe('ACE-Step Apple Silicon install is hash-pinned', () => {
  const lock = readFileSync(join(REPO_ROOT, 'scripts', 'requirements-acestep-mlx.lock.txt'), 'utf8');
  const section = source.slice(source.indexOf('INSTALL_ACESTEP" == "1"'), source.indexOf('INSTALL_ACESTEP15="${'));
  const [appleBranch, otherBranch] = section.split(/^  else$/m);

  it('every locked package carries a sha256 hash, none comes from a VCS or URL source, and all are arm64-macOS scoped', () => {
    const blocks = lock.split(/\n(?=[a-z][^\n]*==)/i).filter((b) => /^[a-z][^\n]*==/i.test(b));
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block).toMatch(/--hash=sha256:[0-9a-f]{64}/);
      const pin = block.split('\n')[0];
      expect(pin).toContain("sys_platform == 'darwin'");
      expect(pin).toContain("platform_machine == 'arm64'");
    }
    expect(lock).not.toMatch(/^[a-z][^\n]* @ /im);
  });

  it('Apple Silicon installs from the lock with --require-hashes and resolves nothing', () => {
    expect(appleBranch).toContain('is_apple_silicon');
    expect(appleBranch).toContain('pip install --require-hashes --no-deps -r "$SCRIPT_DIR/requirements-acestep-mlx.lock.txt"');
    expect(appleBranch).toContain('pip install --no-deps --no-build-isolation "${ACESTEP_DIR}"');
    expect(appleBranch).not.toMatch(/pip install --upgrade/);
  });

  it('refuses a Python older than the 3.11 floor the lock was compiled for', () => {
    expect(appleBranch).toContain('sys.version_info[:2] >= (3, 11)');
  });

  it('keeps the resolving install for Linux/Windows until the CUDA lock lands', () => {
    expect(otherBranch).toMatch(/pip install --upgrade \\\n\s+"git\+https:\/\/github\.com\/ace-step\/ACE-Step\.git"/);
  });
});

describe('ACE-Step 1.5 Apple Silicon install is hash-pinned', () => {
  const lock = readFileSync(join(REPO_ROOT, 'scripts', 'requirements-acestep15-mlx.lock.txt'), 'utf8');
  const section = source.slice(source.indexOf('INSTALL_ACESTEP15" == "1"'), source.indexOf('INSTALL_MINIMAX_MUSIC3="${'));
  const [appleBranch, otherBranch] = section.split(/^  else$/m);

  it('every locked package carries a sha256 hash, none comes from a VCS or URL source, and all are arm64-macOS scoped', () => {
    const blocks = lock.split(/\n(?=[a-z][^\n]*==)/i).filter((b) => /^[a-z][^\n]*==/i.test(b));
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block).toMatch(/--hash=sha256:[0-9a-f]{64}/);
      const pin = block.split('\n')[0];
      expect(pin).toContain("sys_platform == 'darwin'");
      expect(pin).toContain("platform_machine == 'arm64'");
    }
    expect(lock).not.toMatch(/^[a-z][^\n]* @ /im);
  });

  it('Apple Silicon installs from the lock with --require-hashes and resolves nothing', () => {
    expect(appleBranch).toContain('is_apple_silicon');
    expect(appleBranch).toContain('pip install --require-hashes --no-deps -r "$SCRIPT_DIR/requirements-acestep15-mlx.lock.txt"');
    expect(appleBranch).toContain('pip install --no-deps --no-build-isolation --ignore-requires-python "${ACESTEP15_DIR}"');
    expect(appleBranch).not.toMatch(/pip install --upgrade/);
  });

  it('refuses a Python older than the 3.11 floor the lock was compiled for', () => {
    expect(appleBranch).toContain('sys.version_info[:2] >= (3, 11)');
  });

  it('keeps the resolving install for Linux/Windows until the CUDA lock lands', () => {
    expect(otherBranch).toMatch(/pip install --upgrade --extra-index-url/);
  });
});
