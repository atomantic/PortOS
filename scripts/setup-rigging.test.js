import { execFileSync } from '../server/lib/childProcess.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PY_SUBPROCESS_TIMEOUT_MS, resolveTestPython } from '../server/lib/testHelper.js';
import { RIGGING_RUNTIME, RIGGING_INSTALL_COMMAND, resolveRiggingPython } from '../server/services/rigging/runtime.js';

const scripts = fileURLToPath(new URL('.', import.meta.url));
const profile = JSON.parse(readFileSync(`${scripts}rigging-profile.json`, 'utf8'));
const python = resolveTestPython();

// Uniquely exercises the provisioning boundary: real file downloads/hash checks,
// offline explicit Conda input, hash-only pip install, and the final real-import command.
const fixture = String.raw`
import hashlib, importlib.util, json, pathlib, subprocess, sys, tempfile
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location('setup', sys.argv[1] + 'setup-rigging.py')
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)
case = sys.argv[2]
calls = []
s.platform.system = lambda: 'Linux' if case in ['linux', 'unsupported', 'musl'] else 'Darwin'
s.platform.machine = lambda: 'aarch64' if case == 'unsupported' else ('x86_64' if case in ['linux', 'musl', 'rosetta', 'intel'] else 'arm64')
s.platform.libc_ver = lambda: ('musl', '1.2.5') if case == 'musl' else ('glibc', '2.28')
s.shutil.which = lambda _: '/fake/conda'
def run(args, **kwargs):
    args = list(map(str, args))
    calls.append(args)
    if args[0] == '/usr/sbin/sysctl':
        return SimpleNamespace(stdout='0' if case == 'intel' else '1')
    if args[1:3] == ['env', 'list']:
        return SimpleNamespace(stdout=json.dumps({'envs': ['/fake/envs/rigging'] if case == 'existing' else []}))
    if len(args) > 1 and args[1] == 'create':
        explicit = pathlib.Path(args[-1]).read_text()
        assert explicit.startswith('@EXPLICIT\nfile:')
        assert '#0123456789abcdef0123456789abcdef' in explicit
        assert '--offline' in args
    if case == 'install-failed' and 'install' in args:
        raise subprocess.CalledProcessError(1, args)
    return SimpleNamespace(stdout='')
s.run = run
with tempfile.TemporaryDirectory() as temporary:
    root = pathlib.Path(temporary)
    s.Path.home = classmethod(lambda cls: root)
    s.SCRIPTS = root
    p = json.loads(pathlib.Path(sys.argv[1] + 'rigging-profile.json').read_text())
    if case == 'unregistered':
        (root / '.portos/envs/rigging').mkdir(parents=True)
        (root / '.portos/envs/rigging/custom.txt').write_text('preserve custom work')
    artifact = root / 'python.conda'
    artifact.write_bytes(b'reviewed artifact')
    for target in p['profiles'].values():
        target['condaArtifacts'] = [{'url': artifact.as_uri(), 'sha256': '0'*64 if case == 'tamper' else hashlib.sha256(artifact.read_bytes()).hexdigest(), 'md5': '0123456789abcdef0123456789abcdef'}]
    (root / 'rigging-profile.json').write_text(json.dumps(p))
    try:
        s.install()
        result = {'ok': True}
    except (SystemExit, OSError, subprocess.CalledProcessError) as error:
        result = {'ok': False, 'reason': str(error)}
    result['home'] = str(root)
    result['prefix'] = str(root / '.portos/envs/rigging')
    result['python'] = str(root / '.portos/envs/rigging/bin/python')
    result['prefixExists'] = (root / '.portos/envs/rigging').exists()
    result['preserved'] = (root / '.portos/envs/rigging/custom.txt').is_file()
    result['calls'] = calls
    print(json.dumps(result))
`;
const provision = (target) => {
  const stdout = execFileSync(python, ['-c', fixture, scripts, target], { encoding: 'utf8', timeout: PY_SUBPROCESS_TIMEOUT_MS });
  return JSON.parse(stdout.trim().split('\n').at(-1));
};

describe('reviewed rigging provisioning', () => {
  it.skipIf(!python).each(['macos', 'rosetta', 'linux'])('installs only the complete reviewed closure on %s', (target) => {
    const result = provision(target);
    expect(result.ok).toBe(true);
    const creation = result.calls.find((args) => args.includes('create'));
    expect(creation[creation.indexOf('--prefix') + 1]).toBe(result.prefix);
    expect(resolveRiggingPython({ home: result.home, env: { CONDA_ENVS_PATH: '/unrelated/envs' }, exists: (path) => path === result.python })).toBe(result.python);
    const install = result.calls.find((args) => args.includes('install'));
    expect(install).toEqual(expect.arrayContaining(['--isolated', '--require-hashes', '--no-deps', '--only-binary', ':all:']));
    expect(install.at(-1)).toContain(target === 'linux' ? 'requirements-rigging-linux-x64.lock.txt' : 'requirements-rigging-macos-arm64.lock.txt');
    expect(result.calls.at(-1).at(-1)).toContain('import bpy');
    expect(result.calls.at(-1).at(-1)).toContain('(3, 13, 18)');
  });

  it.skipIf(!python).each(['unsupported', 'musl', 'intel', 'existing', 'tamper', 'unregistered'])('refuses %s before creating or installing an environment', (target) => {
    const result = provision(target);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/No reviewed|already exists|File exists|SHA-256 mismatch/);
    expect(result.calls.some((args) => args.includes('create') || args.includes('install'))).toBe(false);
    if (target === 'unregistered') expect(result.preserved).toBe(true);
  });

  it.skipIf(!python)('removes only the environment this invocation created when package installation fails', () => {
    const result = provision('install-failed');
    expect(result.ok).toBe(false);
    expect(result.prefixExists).toBe(false);
    expect(result.calls.some((args) => args.includes('remove'))).toBe(false);
  });

  it('keeps source, descriptor, ABI, interpreter artifacts and target locks in parity', () => {
    expect(profile.bpy).toBe(RIGGING_RUNTIME.moduleVersion);
    expect(profile.python.startsWith(`${RIGGING_RUNTIME.pythonVersion}.`)).toBe(true);
    expect(RIGGING_INSTALL_COMMAND).toBe('python3 scripts/setup-rigging.py');
    expect(readFileSync(`${scripts}requirements-rigging.txt`, 'utf8')).toContain(`bpy==${profile.bpy}`);
    for (const target of Object.values(profile.profiles)) {
      expect(target.condaArtifacts.find((a) => a.name === 'python').version).toBe(profile.python);
      for (const artifact of target.condaArtifacts) {
        expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(Date.parse(artifact.uploadedAt)).toBeLessThan(Date.parse(profile.registryCutoff));
      }
      const lock = readFileSync(`${scripts}${target.requirements}`, 'utf8');
      expect(lock).toContain(`bpy==${profile.bpy}`);
      expect(lock).toContain(`--exclude-newer ${profile.registryCutoff}`);
      const requirements = lock.split(/\n(?=[a-z])/).filter((entry) => /^[\w-]+==/.test(entry));
      expect(requirements.length).toBeGreaterThan(1);
      expect(requirements.every((entry) => /--hash=sha256:[a-f0-9]{64}/.test(entry))).toBe(true);
    }
  });
});

it.skipIf(!python)('audits the entire registry inventory and refuses MAL findings or incomplete OSV results', () => {
  const audit = String.raw`
import contextlib, importlib.util, io, json, sys
spec = importlib.util.spec_from_file_location('audit', sys.argv[1] + 'audit-rigging.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
for mode in ['clean', 'malware', 'incomplete', 'paginated-malware', 'pagination-error']:
    def response(request, **kwargs):
        payload = json.loads(request.data)
        if 'page_token' in payload:
            assert payload['page_token'] == 'next-page'
            page = {'error': 'unavailable'} if mode == 'pagination-error' else {'vulns': [{'id': 'MAL-2099-EXAMPLE'}]}
            return io.BytesIO(json.dumps(page).encode())
        queries = payload['queries']
        assert len(queries) == 49
        assert any(q.get('package', {}).get('purl', '').startswith('pkg:conda/') for q in queries)
        assert any(q.get('package', {}).get('name') == 'bpy' for q in queries)
        results = [{} for q in queries]
        if mode == 'malware':
            results[0] = {'vulns': [{'id': 'MAL-2099-EXAMPLE'}]}
        if mode == 'incomplete':
            results.pop()
        if mode in ['paginated-malware', 'pagination-error']:
            results[0] = {'next_page_token': 'next-page'}
        return io.BytesIO(json.dumps({'results': results}).encode())
    audit.urlopen = response
    capture = io.StringIO()
    try:
        with contextlib.redirect_stdout(capture):
            code = audit.main()
        assert code == (1 if mode in ['malware', 'paginated-malware'] else 0)
        if mode in ['malware', 'paginated-malware']:
            assert 'MAL-2099-EXAMPLE' in capture.getvalue()
    except SystemExit as error:
        assert mode in ['incomplete', 'pagination-error'] and 'unresolved' in str(error)
print('ok')
`;
  expect(execFileSync(python, ['-c', audit, scripts], { encoding: 'utf8', timeout: PY_SUBPROCESS_TIMEOUT_MS }).trim()).toBe('ok');
});
