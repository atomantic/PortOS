import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('./setup-pixal3d-mps.sh', import.meta.url));
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it.each(['txt', 'lock.txt'])('keeps the required CLI and native dependencies in the Pixal3D Metal %s manifest', extension => {
  const requirements = readFileSync(new URL(`./ml/requirements/requirements-pixal3d-mps.${extension}`, import.meta.url), 'utf8');
  expect(requirements).not.toMatch(/^imageio(?:-ffmpeg)?==/m);
  expect(requirements).toMatch(/^einops==/m);
  expect(requirements).toMatch(/^kornia==/m);
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pixal install '));
  roots.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const executable = (name, source) => writeFileSync(join(bin, name), source, { mode: 0o755 });
  executable('uname', '#!/bin/sh\nif [ "$1" = -s ]; then echo Darwin; else echo arm64; fi\n');
  executable('git', `#!/bin/sh
if [ "$1" = archive ]; then
  if [ -n "$NATIVE_ARCHIVE" ]; then exec cat "$NATIVE_ARCHIVE"; fi
  exec tar -cf - -T /dev/null
fi
echo 0be9e69a729432323dfb60a418801e5e9e7a1437
`);
  executable('xcrun', '#!/bin/sh\nexit 0\n');
  executable('python', `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.RECORD, JSON.stringify(args) + String.fromCharCode(10));
if (args[0] === '-m' && args[1] === 'venv') {
  fs.rmSync('.venv', {recursive:true, force:true});
  fs.mkdirSync('.venv/bin', {recursive:true});
  fs.copyFileSync(process.argv[1], '.venv/bin/python');
  fs.chmodSync('.venv/bin/python', 0o755);
}
if (args[2] === 'download' && process.env.MOGE_ARCHIVE) {
  fs.copyFileSync(process.env.MOGE_ARCHIVE, args.at(-1) + '/synthetic-revision');
}
let pythonArgs;
if (args[0] === '-' && args[3]?.endsWith('/patch-moge-metadata.py') && process.env.MOGE_ARCHIVE) pythonArgs = args;
if (process.env.NATIVE_ARCHIVE) {
  if (args[0] === '-' && args[1] === '.venv/portos-source') pythonArgs = args;
  if (args.includes('-e') && args.at(-1).endsWith('/mtlgemm')) pythonArgs = [args.at(-1) + '/setup.py'];
}
if (pythonArgs && process.env.REAL_PYTHON) {
  const result = require('node:child_process').spawnSync(process.env.REAL_PYTHON, pythonArgs, {
    input: pythonArgs[0] === '-' ? fs.readFileSync(0) : undefined,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
if (process.env.FAIL_LOCK === '1' && args.some(a => a.endsWith('requirements-pixal3d-mps.lock.txt'))) process.exit(1);
`);
  mkdirSync(join(root, '.venv'));
  writeFileSync(join(root, '.venv', 'old-python-3.10'), 'stale native ABI');
  mkdirSync(join(root, 'extern', 'mtlmesh'), { recursive: true });
  writeFileSync(join(root, 'extern', 'mtlmesh', 'setup.py'), 'stale native source');
  writeFileSync(join(root, 'model.safetensors'), 'synthetic retained asset');
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, PYTHON_BIN: join(bin, 'python'), RECORD: join(root, 'commands.jsonl') };
  const run = (extra = {}) => execFileSync('bash', [script], { cwd: root, env: { ...env, ...extra }, stdio: 'pipe' });
  const calls = () => readFileSync(env.RECORD, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { root, run, calls };
}

describe.skipIf(process.platform === 'win32')('Pixal3D Metal install/Repair boundary', () => {
  it('accepts an explicit interpreter command from PATH', () => {
    const f = fixture();
    f.run({ PYTHON_BIN: 'python' });
    expect(f.calls().some(args => args[1] === 'venv')).toBe(true);
  });

  it('refuses a linked environment before clearing its shared target', () => {
    const f = fixture();
    const shared = join(f.root, 'shared');
    mkdirSync(shared);
    writeFileSync(join(shared, 'keep.txt'), 'shared environment');
    rmSync(join(f.root, '.venv'), { recursive: true });
    symlinkSync(shared, join(f.root, '.venv'), 'dir');
    expect(() => f.run()).toThrow(/symlinked Pixal3D environment/);
    expect(f.calls().some(args => args[1] === 'venv')).toBe(false);
    expect(readFileSync(join(shared, 'keep.txt'), 'utf8')).toBe('shared environment');
  });

  it('replaces an old interpreter, locks before native builds and keeps model assets', () => {
    const f = fixture();
    f.run();
    const calls = f.calls();
    expect(calls[1]).toEqual(['-m', 'venv', '--clear', '.venv']);
    const installs = calls.filter(args => args[0] === '-m' && args[1] === 'pip');
    expect(installs).toHaveLength(11);
    expect(installs[0]).toEqual(expect.arrayContaining(['--require-hashes', '--no-deps', '--only-binary', ':all:']));
    expect(installs[0].at(-1)).toMatch(/requirements-pixal3d-mps\.lock\.txt$/);
    expect(installs[1]).toEqual(expect.arrayContaining(['--require-hashes', '--no-deps', '--no-build-isolation']));
    expect(installs[1].at(-1)).toMatch(/sources-without-moge\.txt$/);
    expect(installs[2]).toEqual(expect.arrayContaining(['download', '--require-hashes', '--no-deps', '--no-build-isolation']));
    expect(installs[2]).toEqual(expect.arrayContaining([expect.stringMatching(/moge-requirement\.txt$/)]));
    expect(installs[3]).toEqual(expect.arrayContaining(['--no-deps', '--no-build-isolation', '--no-cache-dir']));
    expect(installs[3].at(-1)).toBe('.venv/moge-src/pkg');
    expect(installs.slice(4, 10).map(args => args.at(-1))).toEqual(
      ['mtlmesh', 'mtlgemm', 'mtlbvh', 'mtldiffrast', 'o_voxel', 'natten-mps']
        .map(name => `.venv/portos-source/extern/${name}`),
    );
    for (const args of installs.slice(4, 10)) expect(args).toEqual(expect.arrayContaining(['--no-deps', '--no-build-isolation', '--no-cache-dir']));
    expect(installs[10]).toEqual(['-m', 'pip', 'check']);
    expect(existsSync(join(f.root, '.venv', 'old-python-3.10'))).toBe(false);
    expect(readFileSync(join(f.root, 'extern', 'mtlmesh', 'setup.py'), 'utf8')).toBe('stale native source');
    expect(readFileSync(join(f.root, 'model.safetensors'), 'utf8')).toBe('synthetic retained asset');
  });

  it('seeds FlexGEMM tuning on Install and keeps measured tuning on Repair', () => {
    const f = fixture();
    const source = join(f.root, 'pinned-source');
    const bundled = '{"bundled":{}}\n';
    for (const pkg of ['mtlmesh', 'mtlgemm', 'mtlbvh', 'mtldiffrast', 'o_voxel']) {
      const dir = join(source, 'extern', pkg);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'setup.py'), 'flags = "-std=c++17"\n');
    }
    // Model the two pinned setup.py hooks without importing or compiling Metal.
    const cacheHook = quote => `    os.makedirs(os.path.expanduser("~/.flex_gemm"), exist_ok=True)
    cache_src = os.path.join(ROOT, "autotune_cache.json")
    if os.path.exists(cache_src):
        shutil.copyfile(cache_src, os.path.expanduser(${quote}~/.flex_gemm/autotune_cache.json${quote}))
`;
    const mtlGemm = join(source, 'extern', 'mtlgemm');
    writeFileSync(join(mtlGemm, 'setup.py'), `import os, shutil
ROOT = os.path.dirname(os.path.abspath(__file__))
flags = "-std=c++17"
if True:
${cacheHook('"')}else:
${cacheHook("'")}`);
    writeFileSync(join(mtlGemm, 'autotune_cache.json'), bundled);
    const archive = join(f.root, 'native.tar');
    execFileSync('tar', ['-cf', archive, '-C', source, 'extern']);
    const home = join(f.root, 'home');
    mkdirSync(join(home, '.flex_gemm'), { recursive: true });
    const sharedCache = join(home, '.flex_gemm', 'autotune_cache.json');
    const shared = Buffer.from('{"shared":{}}\n');
    const measured = Buffer.from('{"measured":{}}\n');
    writeFileSync(sharedCache, shared);
    const localCache = join(f.root, 'autotune_cache.json');
    const env = {
      HOME: home,
      REAL_PYTHON: 'python3',
      NATIVE_ARCHIVE: archive,
      FLEX_GEMM_AUTOTUNE_CACHE_PATH: sharedCache,
    };
    rmSync(join(f.root, '.venv'), { recursive: true });
    f.run(env);
    expect(readFileSync(localCache, 'utf8')).toBe(bundled);
    expect(readFileSync(sharedCache)).toEqual(shared);

    writeFileSync(localCache, measured);
    f.run(env);
    expect(readFileSync(localCache)).toEqual(measured);
    expect(readFileSync(sharedCache)).toEqual(shared);
  });

  it('stages an extensionless MoGe archive and aligns its metadata with the locked CLI runtime', () => {
    const f = fixture();
    const sourceRoot = join(f.root, 'moge-source');
    mkdirSync(sourceRoot);
    const source = [
      'utils3d @ git+https://github.com/EasternJournalist/utils3d.git@3fab839f0be9931dac7c8488eb0e1600c236e183',
      'pipeline @ git+https://github.com/EasternJournalist/pipeline.git@866f059d2a05cde05e4a52211ec5051fd5f276d6',
      '    "gradio",',
      '"opencv-python"',
      '',
    ].join('\n');
    writeFileSync(join(sourceRoot, 'pyproject.toml'), source);
    const archive = join(f.root, 'archive.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', f.root, 'moge-source']);
    const python = ['python3.13', 'python3'].find((name) => {
      try { execFileSync(name, ['-c', 'print(1)'], { stdio: 'pipe' }); return true; } catch { return false; }
    });
    f.run({ REAL_PYTHON: python, MOGE_ARCHIVE: archive });
    const patched = readFileSync(join(f.root, '.venv', 'moge-src', 'pkg', 'pyproject.toml'), 'utf8');
    expect(patched).toContain('utils3d==1.3');
    expect(patched).toContain('pipeline==1.0.0');
    expect(patched).toContain('"opencv-python-headless"');
    expect(patched).not.toContain('gradio');
    expect(patched).not.toContain('"opencv-python"');
  });

  it('does not build sources or native packages after a failed wheel lock install', () => {
    const f = fixture();
    expect(() => f.run({ FAIL_LOCK: '1' })).toThrow();
    expect(f.calls().filter(args => args[1] === 'pip')).toHaveLength(1);
  });
});
