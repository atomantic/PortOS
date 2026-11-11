import { execFileSync } from '../server/lib/childProcess.js';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PY_SUBPROCESS_TIMEOUT_MS, PY_TEST_TIMEOUT_MS, resolveTestPython } from '../server/lib/testHelper.js';

const python = resolveTestPython();
const script = fileURLToPath(new URL('./setup-trellis2-cuda.py', import.meta.url));
const auditScript = fileURLToPath(new URL('./audit-trellis2-cuda.py', import.meta.url));

// Exercise the real install workflow with fake external processes and tiny archives.
// Catches repair deleting weights, setup-time solving, unsupported-host mutation,
// accepting changed source bytes, and publishing completion after a build failure.
const boundary = String.raw`
import hashlib, importlib.util, io, json, pathlib, subprocess, sys, tarfile, tempfile
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('installer', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

with tempfile.TemporaryDirectory() as directory:
    temporary = pathlib.Path(directory)
    m.SCRIPTS = temporary / 'scripts'
    m.SCRIPTS.mkdir()
    actual = json.loads(pathlib.Path(sys.argv[1]).with_name('trellis2-cuda-profile.json').read_text())
    for lock in ['requirements-trellis2-cuda.lock.txt', 'requirements-trellis2-cuda-build.lock.txt']:
        (m.SCRIPTS / lock).write_text('fixture==1 --hash=sha256:' + 'a' * 64)
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode='w:bz2') as archive:
        member = tarfile.TarInfo('bin/micromamba')
        member.size = 4
        archive.addfile(member, io.BytesIO(b'fake'))
    bootstrap = data.getvalue()
    data = io.BytesIO()
    flags = '["-std=c++17",\n' + ''.join('# "-D' + flag + '",\n' for flag in actual['flashAttentionDefines']) + ']\n'
    # Upstream repeats the backward switch in its CUDA and ROCm build blocks.
    build_text = 'cuda_flags = ' + flags + 'rocm_flags = [\n# "-DFLASHATTENTION_DISABLE_BACKWARD",\n]\n'
    with tarfile.open(fileobj=data, mode='w:gz') as archive:
        member = tarfile.TarInfo('fixture/deps/flash-attention/setup.py')
        content = build_text.encode()
        member.size = len(content)
        archive.addfile(member, io.BytesIO(content))
        member = tarfile.TarInfo('fixture/deps/nvdiffrec/setup.py')
        content = b"ld_flags = ['-lcuda', '-lnvrtc']\n"
        member.size = len(content)
        archive.addfile(member, io.BytesIO(content))
        member = tarfile.TarInfo('fixture/trellis2/modules/image_feature_extractor.py')
        content = b'for layer in self.model.layer: pass\n'
        member.size = len(content)
        archive.addfile(member, io.BytesIO(content))
    source_archive = data.getvalue()
    profile = {**actual, 'condaArtifacts': [], 'sources': [],
               'micromamba': {'url': 'https://fixture.invalid/tool', 'sha256': hashlib.sha256(bootstrap).hexdigest()}}
    profile['sources'] = [{'name': 'source', 'destination': '.',
                           'url': 'https://fixture.invalid/source', 'sha256': hashlib.sha256(source_archive).hexdigest()}]
    (m.SCRIPTS / 'trellis2-cuda-profile.json').write_text(json.dumps(profile))
    root = temporary / 'runtime'
    root.mkdir()
    (root / 'weights.safetensors').write_bytes(b'retain these model weights')
    calls = []
    fail_build = False

    def fake_run(args, **kwargs):
        args = [str(a) for a in args]
        calls.append((args, kwargs))
        if 'create' in args:
            prefix = pathlib.Path(args[args.index('--prefix') + 1])
            (prefix / 'bin').mkdir(parents=True)
            (prefix / 'bin/python').write_text('fake interpreter')
        if fail_build and '--no-index' in args:
            raise subprocess.CalledProcessError(1, args)
        return subprocess.CompletedProcess(args, 0, stdout='{}\n')

    with patch.object(m, 'preflight', return_value={'cuda': 'fixture'}), \
         patch.object(m, 'urlopen', side_effect=lambda url, **k: io.BytesIO(bootstrap if url.endswith('/tool') else source_archive)), \
         patch.object(m, 'run', side_effect=fake_run):
        for repair in [False, True]:
            if repair:
                (root / '.conda/stale-module.so').write_text('old ABI')
            m.install(root, temporary / 'cuda')
            assert (root / 'weights.safetensors').read_bytes() == b'retain these model weights'
            assert (root / '.conda/portos-profile.json').is_file()
            assert not (root / '.conda/stale-module.so').exists()
            assert not (root / 'portos-installing').exists()
            built = (root / '.conda/portos-source/deps/flash-attention/setup.py').read_text()
            assert '-std=c++20' in built and '-std=c++17' not in built
            assert all('# "-D' + flag not in built for flag in actual['flashAttentionDefines'])
            feature = (root / '.conda/portos-source/trellis2/modules/image_feature_extractor.py').read_text()
            assert 'self.model.model.layer' in feature and 'self.model.layer' not in feature
            link = (root / '.conda/portos-source/deps/nvdiffrec/setup.py').read_text()
            assert 'stubs' in link and "'-lcuda'" in link and '-lnvrtc' not in link
        creates = [a for a, k in calls if 'create' in a]
        assert len(creates) == 2
        assert all('--offline' in a and '--file' in a for a in creates)
        installs = [a for a, k in calls if 'install' in a]
        locked = [a for a in installs if '--require-hashes' in a]
        native = [a for a in installs if '--no-index' in a]
        assert len(locked) == 4 and len(native) == 14
        assert all('--no-deps' in a and '--only-binary' in a for a in locked)
        assert all('--no-deps' in a and '--no-build-isolation' in a for a in native)
        assert all(k['env']['FLASH_ATTENTION_FORCE_BUILD'] == 'TRUE' for a, k in calls)
        assert all('PORTOS_API_TOKEN' not in k['env'] and 'HF_TOKEN' not in k['env'] for a, k in calls)
        fail_build = True
        try:
            m.install(root, temporary / 'cuda')
            raise AssertionError('failed build accepted')
        except subprocess.CalledProcessError:
            pass
        assert (root / 'portos-installing').exists()
        assert not (root / '.conda/portos-profile.json').exists()
        assert (root / 'weights.safetensors').is_file()

    # Hash failures preserve an existing interpreter and do not start a rebuild.
    (root / '.conda/old-python').write_text('keep until artifacts are verified')
    with patch.object(m, 'preflight', return_value={}), \
         patch.object(m, 'urlopen', return_value=io.BytesIO(b'changed bytes')):
        (root / '.portos-downloads/micromamba.tar.bz2').unlink()
        try:
            m.install(root, temporary / 'cuda')
            raise AssertionError('changed archive accepted')
        except SystemExit as error:
            assert 'SHA-256 mismatch' in str(error)
    assert (root / '.conda/old-python').is_file()

    with patch.object(m.sys, 'platform', 'win32'), patch.object(m, 'run') as process, \
         patch.object(m, 'urlopen') as network:
        unsupported = temporary / 'unsupported'
        try:
            m.install(unsupported, temporary / 'cuda')
            raise AssertionError('unsupported profile accepted')
        except SystemExit as error:
            assert 'Linux x86_64' in str(error)
        assert not unsupported.exists()
        process.assert_not_called()
        network.assert_not_called()

    # The native profile preflight, unlike render compatibility, is deliberately narrow.
    cuda = temporary / 'cuda'
    (cuda / 'include').mkdir(parents=True)
    (cuda / 'include/cuda.h').write_text('fixture header')
    (cuda / 'lib64/stubs').mkdir(parents=True)
    (cuda / 'lib64/stubs/libcuda.so').write_bytes(b'fixture library')
    for gpu in ['8.9, 24576, fixture-driver', '8.6, 12288, fixture-driver']:
        with patch.object(m.sys, 'platform', 'linux'), \
             patch.object(m.platform, 'machine', return_value='x86_64'), \
             patch.object(m.platform, 'libc_ver', return_value=('glibc', '2.35')), \
             patch.object(m, 'output', side_effect=['Cuda V12.6.85', '11.3.0', gpu]), \
             patch.object(m, 'urlopen') as network:
            unsupported = temporary / 'wrong-gpu'
            try:
                m.install(unsupported, temporary / 'cuda')
                raise AssertionError('unsupported GPU accepted')
            except SystemExit as error:
                assert '8.6' in str(error)
            assert not unsupported.exists()
            network.assert_not_called()
print('boundary passed')
`;

describe.skipIf(!python)('TRELLIS.2 CUDA Install/Repair boundary', () => {
  it('keeps assets, uses locked artifacts and refuses unsupported or failed setup', () => {
    const result = execFileSync(python, ['-c', boundary, script], { timeout: PY_SUBPROCESS_TIMEOUT_MS, encoding: 'utf8' });
    expect(result).toContain('boundary passed');
  }, PY_TEST_TIMEOUT_MS);

  it('audits direct CUDA wheels, Conda and source revisions and refuses advisory or incomplete results', () => {
    const code = String.raw`
import contextlib, importlib.util, io, json, sys
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('audit', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
def respond(request, **kwargs):
    queries = json.loads(request.data)['queries']
    assert {'package': {'ecosystem': 'PyPI', 'name': 'torch'}, 'version': '2.14.1'} in queries
    assert any('pkg:conda/conda-forge/python@3.11.16?' in q.get('package', {}).get('purl', '') for q in queries)
    assert {'commit': '49774b31c8d1172a5b28f72e9aed0f322bf4ccba'} in queries
    results = [{} for q in queries]
    if mode == 'findings': results[0] = {'vulns': [{'id': 'MAL-test-fixture'}]}
    if mode == 'incomplete': results.pop()
    return io.BytesIO(json.dumps({'results': results}).encode())
for mode in ['clean', 'findings', 'incomplete']:
    with patch.object(m, 'urlopen', side_effect=respond), contextlib.redirect_stdout(io.StringIO()):
        if mode == 'incomplete':
            try:
                m.main()
                raise AssertionError('incomplete audit accepted')
            except SystemExit as error:
                assert 'unresolved' in str(error)
        else:
            assert m.main() == (0 if mode == 'clean' else 1)
print('audit boundary passed')
`;
    expect(execFileSync(python, ['-c', code, auditScript], { timeout: PY_SUBPROCESS_TIMEOUT_MS, encoding: 'utf8' }))
      .toContain('audit boundary passed');
  }, PY_TEST_TIMEOUT_MS);
});
