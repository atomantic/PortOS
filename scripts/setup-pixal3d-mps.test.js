import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('./setup-pixal3d-mps.sh', import.meta.url));
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pixal install '));
  roots.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const executable = (name, source) => writeFileSync(join(bin, name), source, { mode: 0o755 });
  executable('uname', '#!/bin/sh\nif [ "$1" = -s ]; then echo Darwin; else echo arm64; fi\n');
  executable('git', '#!/bin/sh\nif [ "$1" = archive ]; then exec tar -cf - -T /dev/null; fi\necho 0be9e69a729432323dfb60a418801e5e9e7a1437\n');
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
    expect(installs).toHaveLength(8);
    expect(installs[0]).toEqual(expect.arrayContaining(['--require-hashes', '--no-deps', '--only-binary', ':all:']));
    expect(installs[0].at(-1)).toMatch(/requirements-pixal3d-mps\.lock\.txt$/);
    expect(installs[1]).toEqual(expect.arrayContaining(['--require-hashes', '--no-deps', '--no-build-isolation']));
    expect(installs[1].at(-1)).toMatch(/requirements-pixal3d-mps-sources\.lock\.txt$/);
    expect(installs.slice(2).map(args => args.at(-1))).toEqual(
      ['mtlmesh', 'mtlgemm', 'mtlbvh', 'mtldiffrast', 'o_voxel', 'natten-mps']
        .map(name => `.venv/portos-source/extern/${name}`),
    );
    for (const args of installs.slice(2)) expect(args).toEqual(expect.arrayContaining(['--no-deps', '--no-build-isolation', '--no-cache-dir']));
    expect(existsSync(join(f.root, '.venv', 'old-python-3.10'))).toBe(false);
    expect(readFileSync(join(f.root, 'extern', 'mtlmesh', 'setup.py'), 'utf8')).toBe('stale native source');
    expect(readFileSync(join(f.root, 'model.safetensors'), 'utf8')).toBe('synthetic retained asset');
  });

  it('does not build sources or native packages after a failed wheel lock install', () => {
    const f = fixture();
    expect(() => f.run({ FAIL_LOCK: '1' })).toThrow();
    expect(f.calls().filter(args => args[1] === 'pip')).toHaveLength(1);
  });
});
