"""Install/Repair the locked TRELLIS.2 Metal profile without resolving dependencies."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
from urllib.request import urlopen

SCRIPTS = Path(__file__).resolve().parent


def run(args, **kwargs):
    return subprocess.run([str(arg) for arg in args], check=True, text=True, **kwargs)


def tool_output(args, help_text):
    try:
        return run(args, capture_output=True).stdout
    except (OSError, subprocess.CalledProcessError) as error:
        raise SystemExit(help_text) from error


def preflight(profile):
    if sys.platform != 'darwin' or platform.machine() != 'arm64':
        raise SystemExit('TRELLIS.2 Metal requires native Apple Silicon macOS.')
    if '.'.join(map(str, sys.version_info[:2])) != profile['python']:
        raise SystemExit('TRELLIS.2 Metal requires Python ' + profile['python'] + '.')
    if int(platform.mac_ver()[0].split('.')[0]) < profile['minimumMacOS']:
        raise SystemExit('TRELLIS.2 Metal requires macOS 26 or later.')
    xcode = tool_output(['xcodebuild', '-version'], 'TRELLIS.2 Metal requires full Xcode 26 or later.')
    if not xcode.startswith('Xcode ') or int(xcode.split()[1].split('.')[0]) < profile['minimumXcode']:
        raise SystemExit('TRELLIS.2 Metal requires full Xcode 26 or later.')
    metal_help = 'Install the Xcode Metal Toolchain before running TRELLIS.2 setup.'
    metal = tool_output(['xcrun', '-sdk', 'macosx', 'metal', '--version'], metal_help)
    if not metal.startswith('Apple metal version '):
        raise SystemExit(metal_help)
    return {'xcode': xcode.strip(), 'metal': metal.splitlines()[0],
            'macOS': platform.mac_ver()[0], 'python': platform.python_version()}


def fetch_source(source, directory):
    print('[setup] Verifying source: ' + source['name'], flush=True)
    archive = directory / (source['name'] + '.tar.gz')
    with urlopen(source['url'], timeout=120) as response, archive.open('wb') as output:
        shutil.copyfileobj(response, output)
    with archive.open('rb') as data:
        digest = hashlib.file_digest(data, 'sha256').hexdigest()
    if digest != source['sha256']:
        raise SystemExit('Source hash mismatch: ' + source['name'])
    return archive


def unpack(archive, destination):
    # Python's data filter refuses traversal and links escaping the extraction root.
    with tempfile.TemporaryDirectory(dir=destination.parent) as staging:
        with tarfile.open(archive) as source:
            source.extractall(staging, filter='data')
        entries = list(Path(staging).iterdir())
        if len(entries) != 1 or not entries[0].is_dir():
            raise SystemExit('Expected one source archive root.')
        shutil.copytree(entries[0], destination, dirs_exist_ok=True)


VERIFY = """
import importlib.metadata as metadata, json, torch, torchvision
import mtlbvh, mtldiffrast, cumesh, flex_gemm, o_voxel._C, o_voxel.postprocess
assert torch.__version__.split('+')[0] == '2.15.0'
assert torchvision.__version__.split('+')[0] == '0.29.2'
assert torch.backends.mps.is_available(), 'MPS is unavailable'
assert o_voxel.postprocess._BACKEND == 'metal', 'Metal baker is unavailable'
assert o_voxel.postprocess._HAS_DR, 'Metal rasterizer is unavailable'
assert o_voxel.postprocess._HAS_FLEX_GEMM, 'Metal sparse sampling is unavailable'
print(json.dumps({d.metadata['Name']: d.version for d in metadata.distributions()}))
"""


def install(root):
    profile = json.loads((SCRIPTS / 'trellis2-mps-profile.json').read_text())
    toolchain = preflight(profile)  # No runtime mutation before compatibility is known.
    root = Path(root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    lock = SCRIPTS / 'requirements-trellis2-mps.lock.txt'
    # Fetch and verify every source before replacing an existing interpreter.
    with tempfile.TemporaryDirectory(prefix='portos-trellis-', dir=root) as downloads:
        archives = [(s, fetch_source(s, Path(downloads))) for s in profile['sources']]
        venv = root / '.venv'
        run([sys.executable, '-m', 'venv', '--clear', venv])
        installing = venv / 'portos-installing'
        installing.write_text(profile['id'] + '\n')
        python = venv / 'bin' / 'python3'
        compiler_overrides = {'CFLAGS', 'CXXFLAGS', 'CPPFLAGS', 'LDFLAGS', 'ARCHFLAGS',
                              'CC', 'CXX', 'LDSHARED', 'SDKROOT', 'BUILD_TARGET'}
        env = {key: value for key, value in os.environ.items()
               if not key.startswith(('PIP_', 'PYTHON', 'UV_')) and key not in compiler_overrides}
        env.update(PIP_CONFIG_FILE=os.devnull, PYTHONNOUSERSITE='1',
                   MACOSX_DEPLOYMENT_TARGET='26.0', MAX_JOBS='4')
        run([python, '-m', 'pip', '--isolated', 'install', '--disable-pip-version-check',
             '--force-reinstall', '--require-hashes', '--no-deps', '--only-binary', ':all:',
             '--index-url', 'https://pypi.org/simple', '-r', lock], env=env)
        source = venv / 'portos-source'
        source.mkdir()
        for item, archive in archives:
            destination = source / item['destination']
            destination.parent.mkdir(parents=True, exist_ok=True)
            unpack(archive, destination)
        packages = ['utils3d', 'mtlbvh', 'mtldiffrast', 'mtlmesh', 'mtlgemm', 'trellis2-apple/o-voxel']
        for package in packages:
            directory = source / 'deps' / package
            setup = directory / 'setup.py'
            if setup.exists():
                text = setup.read_text()
                if '-std=c++17' not in text:
                    raise SystemExit('Unexpected native build flags: ' + package)
                setup.write_text(text.replace('-std=c++17', '-std=c++20'))
            if package == 'mtlgemm':
                # Its metadata hooks otherwise overwrite the user's global autotune cache.
                text = setup.read_text()
                text = text.replace('os.path.expanduser("~/.flex_gemm', 'os.path.join(ROOT, ".portos-autotune')
                text = text.replace("os.path.expanduser('~/.flex_gemm", "os.path.join(ROOT, '.portos-autotune")
                setup.write_text(text)
            build_env = {**env, 'BUILD_TARGET': 'cpu' if package.endswith('o-voxel') else 'metal'}
            # Source/build requirements already exist in the wheel closure. No resolver or fallback.
            run([python, '-m', 'pip', '--isolated', 'install', '--disable-pip-version-check',
                 '--no-index', '--no-deps', '--no-build-isolation', '--no-cache-dir', '-e', directory],
                env=build_env)
        run([python, source / 'patches' / 'mps_compat.py'], cwd=source, env=env)
        run([python, SCRIPTS.parent / 'server/services/imageTo3d/trellis2RestoreFillHoles.py', source], env=env)
        inventory = json.loads(run([python, '-c', VERIFY], env=env, capture_output=True).stdout.splitlines()[-1])
        run([python, '-m', 'pip', '--isolated', 'check'], env=env)
        record = {**profile, 'toolchain': toolchain, 'installed': inventory,
                  'wheelLockSha256': hashlib.sha256(lock.read_bytes()).hexdigest()}
        (venv / 'portos-profile.json').write_text(json.dumps(record, indent=2) + '\n')
        installing.unlink()
        print('[setup] TRELLIS.2 Metal native imports and locked profile verified.', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', help='Existing TRELLIS.2 runtime directory; models are retained')
    install(parser.parse_args().root)


if __name__ == '__main__':
    main()
