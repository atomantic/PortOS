import { execFileSync } from '../server/lib/childProcess.js';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PY_SUBPROCESS_TIMEOUT_MS, PY_TEST_TIMEOUT_MS, resolveTestPython } from '../server/lib/testHelper.js';

const python = resolveTestPython();
const script = fileURLToPath(new URL('./setup-pixal3d-cuda.py', import.meta.url));

// Real Install/Repair orchestration with tiny source archives and fake processes.
const boundary = String.raw`
import hashlib, importlib.util, io, json, pathlib, subprocess, sys, tarfile, tempfile
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('pixal', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
actual = json.loads(pathlib.Path(sys.argv[1]).with_name('pixal3d-cuda-profile.json').read_text())
with tempfile.TemporaryDirectory() as directory:
    temp = pathlib.Path(directory)
    m.SCRIPTS = m.cuda.SCRIPTS = temp / 'scripts'
    m.SCRIPTS.mkdir()
    for name in ['requirements-pixal3d-cuda.lock.txt', 'requirements-pixal3d-cuda-build.lock.txt']:
        (m.SCRIPTS / name).write_text('fixture==1 --hash=sha256:' + 'a' * 64)
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode='w:bz2') as archive:
        item = tarfile.TarInfo('bin/micromamba')
        item.size = 4
        archive.addfile(item, io.BytesIO(b'fake'))
    bootstrap = data.getvalue()
    data = io.BytesIO()
    feature = '''for layer in self.model.layer: pass
            import torch.hub
"valeoai/NAF", "naf", pretrained=True, device=device, trust_repo=True
                hr_features = self.naf_model(
                    image_for_naf, lr_features_bchw, self.naf_target_size
                )'''
    files = {
        'trellis2/modules/image_feature_extractor.py': 'for layer in self.model.layer: pass',
        'Pixal3D/pixal3d/trainers/flow_matching/mixins/image_conditioned_proj.py': feature,
        'deps/MoGe/pyproject.toml': '    "gradio",\n"opencv-python"\n"utils3d @ git+https://github.com/EasternJournalist/utils3d.git@3fab839f0be9931dac7c8488eb0e1600c236e183"\n"pipeline @ git+https://github.com/EasternJournalist/pipeline.git@866f059d2a05cde05e4a52211ec5051fd5f276d6"',
        'deps/natten/csrc/CMakeLists.txt': 'set(CXX_STD "17" CACHE STRING "C++ standard")\n-std=c++17',
    }
    with tarfile.open(fileobj=data, mode='w:gz') as archive:
        for path, text in files.items():
            item = tarfile.TarInfo('fixture/' + path)
            content = text.encode()
            item.size = len(content)
            archive.addfile(item, io.BytesIO(content))
    source = data.getvalue()
    profile = {**actual, 'condaArtifacts': [],
        'micromamba': {'url': 'https://fixture.invalid/tool', 'sha256': hashlib.sha256(bootstrap).hexdigest()},
        'sources': [{'name': 'source', 'destination': '.', 'url': 'https://fixture.invalid/source',
                     'sha256': hashlib.sha256(source).hexdigest()}]}
    (m.SCRIPTS / 'pixal3d-cuda-profile.json').write_text(json.dumps(profile))
    root = temp / 'runtime'
    root.mkdir()
    (root / 'weights.bin').write_bytes(b'retained weights')
    calls = []
    fail_natten = False
    fail_required = False
    def run(args, **kwargs):
        args = [str(arg) for arg in args]
        calls.append((args, dict(kwargs.get('env', {}))))
        if 'create' in args:
            prefix = pathlib.Path(args[args.index('--prefix') + 1])
            (prefix / 'bin').mkdir(parents=True)
            (prefix / 'bin/python').write_text('fake interpreter')
        if '--no-index' in args:
            if (fail_natten and args[-1].endswith('/natten')) or (fail_required and args[-1].endswith('/MoGe')):
                raise subprocess.CalledProcessError(1, args)
        return subprocess.CompletedProcess(args, 0, stdout='{}\n')
    with patch.object(m.cuda, 'preflight', return_value={}), \
         patch.object(m.cuda, 'urlopen', side_effect=lambda url, **kw: io.BytesIO(bootstrap if url.endswith('/tool') else source)), \
         patch.object(m.cuda, 'run', side_effect=run):
        for fail_natten in [False, True]:
            m.install(root, temp / 'cuda')
            assert (root / 'weights.bin').read_bytes() == b'retained weights'
            assert (root / '.conda/portos-profile.json').is_file()
            assert not (root / 'portos-installing').exists()
            installed = root / '.conda/portos-source'
            changed = (installed / 'Pixal3D/pixal3d/trainers/flow_matching/mixins/image_conditioned_proj.py').read_text()
            assert 'source="local"' in changed and 'valeoai/NAF' not in changed
            assert 'F.interpolate' in changed and 'find_spec("natten")' in changed
            assert 'self.model.model.layer' in changed
            assert '-std=c++20' in (installed / 'deps/natten/csrc/CMakeLists.txt').read_text()
            assert 'git+' not in (installed / 'deps/MoGe/pyproject.toml').read_text()
        assert any('uninstall' in args and args[-1] == 'natten' for args, env in calls)
        for args, env in calls:
            if 'install' in args:
                assert '--no-deps' in args
                assert '--require-hashes' in args or ('--no-index' in args and '--no-build-isolation' in args)
            assert env['NATTEN_CUDA_ARCH'] == '8.6'
            assert 'HF_TOKEN' not in env and 'PORTOS_API_TOKEN' not in env
        fail_required = True
        try:
            m.install(root, temp / 'cuda')
            raise AssertionError('required build failure accepted')
        except subprocess.CalledProcessError:
            pass
        assert (root / 'portos-installing').is_file()
        assert not (root / '.conda/portos-profile.json').exists()
        assert (root / 'weights.bin').is_file()

    for system, release in [('win32', 'fixture'), ('linux', '6.6-microsoft-standard-WSL2')]:
        with patch.object(m.cuda.sys, 'platform', system), \
             patch.object(m.cuda.platform, 'machine', return_value='x86_64'), \
             patch.object(m.cuda.platform, 'release', return_value=release), \
             patch.object(m.cuda, 'run') as process, patch.object(m.cuda, 'urlopen') as network:
            unsupported = temp / 'unsupported'
            try:
                m.install(unsupported, temp / 'cuda')
                raise AssertionError('unsupported host accepted')
            except SystemExit as error:
                assert 'Linux' in str(error)
            assert not unsupported.exists()
            process.assert_not_called()
            network.assert_not_called()
print('Pixal3D boundary passed')
`;

describe.skipIf(!python)('Pixal3D CUDA Install/Repair', () => {
  it('keeps weights, pins native builds, supports NATTEN fallback and refuses unsupported hosts', () => {
    expect(execFileSync(python, ['-c', boundary, script], {
      timeout: PY_SUBPROCESS_TIMEOUT_MS, encoding: 'utf8',
    })).toContain('Pixal3D boundary passed');
  }, PY_TEST_TIMEOUT_MS);
});
