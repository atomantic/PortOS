import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PY_SUBPROCESS_TIMEOUT_MS, PY_TEST_TIMEOUT_MS, resolveTestPython } from '../server/lib/testHelper.js';

const python = resolveTestPython();
const script = fileURLToPath(new URL('./setup-trellis2-mps.py', import.meta.url));
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// Exercise the actual setup workflow and archive checks; only network and process
// execution are faked. A resolver fallback or source build after a failed lock is a regression.
const DRIVER = String.raw`
import contextlib, hashlib, importlib.util, io, json, os, pathlib, subprocess, sys, tarfile
from types import SimpleNamespace
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('installer', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
root = pathlib.Path(sys.argv[2]); mode = sys.argv[3]
scripts = root / 'scripts'; scripts.mkdir()
m.SCRIPTS = scripts
(scripts / 'requirements-trellis2-mps.lock.txt').write_text('synthetic lock')
runtime = root / 'runtime'; runtime.mkdir()
(runtime / 'weights.bin').write_text('retained weights')
(runtime / '.venv').mkdir()
(runtime / '.venv' / 'legacy-python').write_text('old ABI')
original = json.loads((pathlib.Path(sys.argv[1]).parent / 'trellis2-mps-profile.json').read_text())
archives = {}
for source in original['sources']:
    files = {'placeholder': b'data'}
    name = source['name']
    if name in ('mtlbvh', 'mtldiffrast', 'mtlmesh', 'mtlgemm'): files['setup.py'] = b'-std=c++17'
    if name == 'trellis2-apple': files['o-voxel/setup.py'] = b'-std=c++17'
    if name == 'trellis-mac': files['generate.py'] = b'pinned source'
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode='w:gz') as tar:
        for path, body in files.items():
            info = tarfile.TarInfo('archive-root/' + path); info.size = len(body)
            tar.addfile(info, io.BytesIO(body))
    archives[source['url']] = data.getvalue()
    source['sha256'] = hashlib.sha256(data.getvalue()).hexdigest()
if mode == 'bad-hash': original['sources'][0]['sha256'] = '0' * 64
(scripts / 'trellis2-mps-profile.json').write_text(json.dumps(original))
calls = []
def fake_run(args, **kwargs):
    calls.append(args)
    if args[:2] == ['xcodebuild', '-version']:
        return SimpleNamespace(stdout='Xcode 25.1\n' if mode == 'old-xcode' else 'Xcode 27.2\n')
    if args[0] == 'xcrun':
        if mode == 'missing-metal': raise subprocess.CalledProcessError(1, args)
        return SimpleNamespace(stdout='Apple metal version 32023.922\n')
    if args[1:3] == ['-m', 'venv']:
        import shutil
        shutil.rmtree(runtime / '.venv'); (runtime / '.venv').mkdir()
        if mode == 'failed-venv': raise subprocess.CalledProcessError(1, args)
    if '-r' in args and mode == 'failed-lock': raise subprocess.CalledProcessError(1, args)
    if '-e' in args and mode == 'failed-native': raise subprocess.CalledProcessError(1, args)
    return SimpleNamespace(stdout='{}\n')
error = None
with patch.object(m.sys, 'platform', 'darwin'), patch.object(m.sys, 'version_info', (3, 12) if mode == 'old-python' else (3, 13)), patch.object(m.platform, 'machine', return_value='x86_64' if mode == 'wrong-arch' else 'arm64'), patch.object(m.platform, 'mac_ver', return_value=('25.0' if mode == 'old-macos' else '27.2.1', ('', '', ''), '')), patch.object(m.subprocess, 'run', side_effect=fake_run), patch.object(m, 'urlopen', side_effect=lambda url, **kw: io.BytesIO(archives[url])), contextlib.redirect_stdout(io.StringIO()):
    try: m.install(runtime)
    except (SystemExit, subprocess.CalledProcessError) as exc: error = str(exc)
source = runtime / '.venv' / 'portos-source'
print(json.dumps({'error': error, 'calls': calls,
    'legacy': (runtime / '.venv' / 'legacy-python').exists(),
    'weights': (runtime / 'weights.bin').read_text(),
    'pinned': (source / 'generate.py').read_text() if (source / 'generate.py').exists() else None,
    'record': (runtime / '.venv' / 'portos-profile.json').exists(),
    'installing': (runtime / 'portos-installing').exists(),
    'eigen': (source / 'deps/trellis2-apple/o-voxel/third_party/eigen/placeholder').exists()}))
`;

function run(mode = 'success') {
  const root = mkdtempSync(join(tmpdir(), 'trellis setup '));
  roots.push(root);
  return JSON.parse(execFileSync(python, ['-c', DRIVER, script, root, mode], {
    encoding: 'utf8', timeout: PY_SUBPROCESS_TIMEOUT_MS,
  }));
}

describe.skipIf(!python)('TRELLIS.2 Metal Install/Repair boundary', () => {
  it('rebuilds the interpreter from verified inputs, keeps weights and records native verification', () => {
    const result = run();
    expect(result).toMatchObject({ error: null, legacy: false, weights: 'retained weights', pinned: 'pinned source', record: true, installing: false, eigen: true });
    const installs = result.calls.filter(args => args.includes('install'));
    expect(installs).toHaveLength(7);
    expect(installs[0]).toEqual(expect.arrayContaining(['--force-reinstall', '--require-hashes', '--no-deps', '--only-binary', ':all:']));
    expect(installs[0].at(-1)).toMatch(/requirements-trellis2-mps\.lock\.txt$/);
    expect(installs.slice(1).map(args => args.at(-1).replaceAll('\\', '/').split('/deps/')[1])).toEqual([
      'utils3d', 'mtlbvh', 'mtldiffrast', 'mtlmesh', 'mtlgemm', 'trellis2-apple/o-voxel',
    ]);
    for (const args of installs.slice(1)) {
      expect(args).toEqual(expect.arrayContaining(['--no-index', '--no-deps', '--no-build-isolation', '--no-cache-dir']));
    }
    expect(result.calls.some(args => args.some(arg => arg.endsWith('setup.sh')))).toBe(false);
  }, PY_TEST_TIMEOUT_MS);

  it.each(['old-python', 'wrong-arch', 'old-macos', 'old-xcode', 'missing-metal', 'bad-hash'])(
    'rejects %s before changing the existing runtime', mode => {
      const result = run(mode);
      expect(result.error).toBeTruthy();
      expect(result.legacy).toBe(true);
      expect(result.weights).toBe('retained weights');
      expect(result.calls.some(args => args.includes('venv'))).toBe(false);
    }, PY_TEST_TIMEOUT_MS,
  );

  it.each(['failed-venv', 'failed-lock', 'failed-native'])('never falls back after %s', mode => {
    const result = run(mode);
    expect(result.error).toBeTruthy();
    expect(result.record).toBe(false);
    expect(result.installing).toBe(true);
    const installs = result.calls.filter(args => args.includes('install'));
    expect(installs).toHaveLength({ 'failed-venv': 0, 'failed-lock': 1, 'failed-native': 2 }[mode]);
    expect(result.weights).toBe('retained weights');
  }, PY_TEST_TIMEOUT_MS);
});
