"""Install/Repair the locked Linux x86_64 TRELLIS.2 CUDA profile."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from urllib.request import urlopen

SCRIPTS = Path(__file__).resolve().parent


def run(args, **kwargs):
    return subprocess.run([str(arg) for arg in args], check=True, text=True, **kwargs)


def output(args):
    try:
        return run(args, capture_output=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError) as error:
        raise SystemExit('Required CUDA profile tool is unavailable: ' + str(args[0])) from error


def preflight(profile, cuda):
    # Refuse before creating directories, fetching artifacts or modifying an install.
    if sys.platform != 'linux' or platform.machine() != 'x86_64':
        raise SystemExit('TRELLIS.2 CUDA requires Linux x86_64 (including WSL2).')
    if not hasattr(tarfile, 'data_filter'):
        raise SystemExit('Update the bootstrap Python to a security-patched build with tarfile.data_filter.')
    libc, version = platform.libc_ver()
    if libc != 'glibc' or tuple(map(int, version.split('.'))) < (2, 28):
        raise SystemExit('TRELLIS.2 CUDA requires glibc 2.28 or later.')
    nvcc = output([cuda / 'bin/nvcc', '--version'])
    if not re.search(r'\bV' + re.escape(profile['cudaToolkit']) + r'\b', nvcc):
        raise SystemExit('TRELLIS.2 CUDA requires CUDA toolkit ' + profile['cudaToolkit'] + '.')
    compiler = output(['/usr/bin/g++-11', '-dumpfullversion'])
    if compiler != profile['gcc']:
        raise SystemExit('TRELLIS.2 CUDA requires GCC/G++ ' + profile['gcc'] + '.')
    gpu = output(['nvidia-smi', '--query-gpu=compute_cap,memory.total,driver_version',
                  '--format=csv,noheader,nounits']).splitlines()[0]
    capability, memory, driver = [part.strip() for part in gpu.split(',')]
    if capability not in profile['computeCapabilities'] or int(memory) < profile['minimumVramMiB']:
        raise SystemExit('This profile requires compute capability 8.6 and at least 24 GiB VRAM.')
    return {'cuda': nvcc, 'gcc': compiler, 'glibc': version,
            'computeCapability': capability, 'vramMiB': int(memory), 'driver': driver}


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def fetch(artifact, destination):
    if destination.exists() and digest(destination) == artifact['sha256']:
        return destination
    with urlopen(artifact['url'], timeout=120) as response, destination.open('wb') as stream:
        shutil.copyfileobj(response, stream)
    if digest(destination) != artifact['sha256']:
        raise SystemExit('Artifact SHA-256 mismatch: ' + destination.name)
    return destination


def unpack(archive, destination):
    with tempfile.TemporaryDirectory(dir=destination.parent) as temporary:
        with tarfile.open(archive) as source:
            source.extractall(temporary, filter='data')
        entries = list(Path(temporary).iterdir())
        if len(entries) != 1 or not entries[0].is_dir():
            raise SystemExit('Expected one source archive root.')
        shutil.copytree(entries[0], destination, dirs_exist_ok=True)


def patch_build(directory, package, standard):
    setup = directory / 'setup.py'
    if not setup.exists():
        return
    text = setup.read_text()
    # Patched Torch headers require C++20. GCC 11.3 and nvcc 12.6 support it.
    text = text.replace('-std=c++17', '-std=' + standard)
    if package == 'FlexGEMM':
        # Metadata/build hooks must not overwrite the operator's autotune cache.
        text = text.replace('os.path.expanduser("~/.flex_gemm', 'os.path.join(ROOT, ".portos-autotune')
    setup.write_text(text)


VERIFY = """
import importlib.metadata as metadata, json, torch, torchvision
import flash_attn, flash_attn_2_cuda, _nvdiffrast_c
import nvdiffrec_render.renderutils._C, cumesh._C, cumesh._cubvh
import flex_gemm.kernels.cuda, o_voxel._C, o_voxel.postprocess
from trellis2.pipelines import Trellis2ImageTo3DPipeline
assert torch.__version__ == '2.14.1+cu126'
assert torchvision.__version__ == '0.29.1+cu126'
assert torch.version.cuda == '12.6'
assert torch.cuda.is_available(), 'CUDA is unavailable'
assert torch.cuda.get_device_capability(0) == (8, 6)
q = torch.randn(1, 16, 2, 32, device='cuda', dtype=torch.float16)
assert torch.isfinite(flash_attn.flash_attn_func(q, q, q)).all()
print(json.dumps({d.metadata['Name']: d.version for d in metadata.distributions()}))
"""


def install(root, cuda):
    profile = json.loads((SCRIPTS / 'trellis2-cuda-profile.json').read_text())
    toolchain = preflight(profile, cuda)
    root = Path(root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    prefix = root / '.conda'
    if prefix.is_symlink():
        raise SystemExit('Refusing to rebuild a symlinked private Conda environment.')
    downloads = root / '.portos-downloads'
    downloads.mkdir(exist_ok=True)
    print('[setup] Verifying immutable Conda and source artifacts.', flush=True)
    bootstrap = fetch(profile['micromamba'], downloads / 'micromamba.tar.bz2')
    conda = [(a, fetch(a, downloads / a['url'].rsplit('/', 1)[-1])) for a in profile['condaArtifacts']]
    sources = [(s, fetch(s, downloads / (s['name'] + '.tar.gz'))) for s in profile['sources']]
    micromamba = downloads / 'micromamba'
    with tarfile.open(bootstrap) as archive:
        with archive.extractfile('bin/micromamba') as source, micromamba.open('wb') as target:
            shutil.copyfileobj(source, target)
    micromamba.chmod(0o755)
    explicit = downloads / 'conda-explicit.txt'
    explicit.write_text('@EXPLICIT\n' + '\n'.join(path.as_uri() + '#' + a['md5'] for a, path in conda) + '\n')
    # Build hooks need no model/provider/PortOS credentials or user-site settings.
    network = {'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'LANG', 'LC_ALL', 'TMPDIR'}
    env = {key: value for key, value in os.environ.items() if key in network}
    home = root / '.portos-build-home'
    home.mkdir(exist_ok=True)
    env.update(HOME=str(home), PATH='/usr/bin:/bin')
    env.update(PIP_CONFIG_FILE=os.devnull, PYTHONNOUSERSITE='1', CUDA_HOME=str(cuda),
               CC='/usr/bin/gcc-11', CXX='/usr/bin/g++-11', BUILD_TARGET='cuda',
               MAMBA_ROOT_PREFIX=str(root / '.mamba'))
    env.update(profile['buildFlags'])
    installing = root / 'portos-installing'
    installing.write_text(profile['id'] + '\n')
    if prefix.exists():
        shutil.rmtree(prefix)
    # An explicit local artifact list has no dependency solver or registry fallback.
    run([micromamba, 'create', '--no-rc', '--no-env', '--offline', '--yes', '--always-copy',
         '--prefix', prefix, '--file', explicit], env=env)
    python = prefix / 'bin/python'
    env['PATH'] = str(prefix / 'bin') + os.pathsep + str(cuda / 'bin') + os.pathsep + '/usr/bin:/bin'
    locks = ['requirements-trellis2-cuda.lock.txt', 'requirements-trellis2-cuda-build.lock.txt']
    for name in locks:
        run([python, '-m', 'pip', '--isolated', 'install', '--disable-pip-version-check',
             '--force-reinstall', '--require-hashes', '--no-deps', '--only-binary', ':all:',
             '--index-url', 'https://pypi.org/simple', '-r', SCRIPTS / name], env=env)
    source_root = prefix / 'portos-source'
    source_root.mkdir()
    for item, archive in sources:
        destination = source_root / item['destination']
        destination.parent.mkdir(parents=True, exist_ok=True)
        unpack(archive, destination)
    packages = ['utils3d', 'flash-attention', 'nvdiffrast', 'nvdiffrec', 'CuMesh', 'FlexGEMM', '../o-voxel']
    for package in packages:
        directory = source_root / 'deps' / package
        patch_build(directory, package, profile['buildFlags']['CXX_STANDARD'])
        print('[setup] Building ' + package, flush=True)
        run([python, '-m', 'pip', '--isolated', 'install', '--disable-pip-version-check',
             '--no-index', '--no-deps', '--no-build-isolation', '--no-cache-dir', directory],
            cwd=directory, env=env)
    env['PYTHONPATH'] = str(source_root)
    inventory = json.loads(run([python, '-c', VERIFY], env=env, capture_output=True).stdout.splitlines()[-1])
    run([python, '-m', 'pip', '--isolated', 'check'], env=env)
    record = {**profile, 'toolchain': toolchain, 'installed': inventory,
              'lockSha256': {name: digest(SCRIPTS / name) for name in locks}}
    (prefix / 'portos-profile.json').write_text(json.dumps(record, indent=2) + '\n')
    installing.unlink()
    print('[setup] TRELLIS.2 CUDA native imports and locked profile verified.', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', help='Runtime directory; weights outside .conda are retained')
    parser.add_argument('--cuda-home', type=Path, default=Path('/usr/local/cuda-12.6'))
    args = parser.parse_args()
    install(args.root, args.cuda_home)


if __name__ == '__main__':
    main()
