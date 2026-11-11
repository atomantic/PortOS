"""Provision the reviewed Blender profile. Run explicitly from the PortOS checkout."""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile
from urllib.request import urlopen

SCRIPTS = Path(__file__).resolve().parent


def run(args, **kwargs):
    return subprocess.run([str(arg) for arg in args], check=True, text=True, **kwargs)


def select_profile(profiles):
    machine = platform.machine()
    if platform.system() == 'Darwin':
        # Rosetta must select native arm64 artifacts, like the server platform probe.
        arm = machine == 'arm64' or run(['/usr/sbin/sysctl', '-n', 'hw.optional.arm64'],
                                       capture_output=True).stdout.strip() == '1'
        if arm:
            return profiles['macos-arm64']
    elif platform.system() == 'Linux' and machine == 'x86_64':
        libc, version = platform.libc_ver()
        if libc == 'glibc' and tuple(map(int, version.split('.'))) >= (2, 28):
            return profiles['linux-x64']
    raise SystemExit('No reviewed rigging profile for this target. Requires Apple Silicon macOS or Linux x86_64 with glibc 2.28+. No floating fallback is permitted.')


def fetch(artifact, destination):
    with urlopen(artifact['url'], timeout=120) as response, destination.open('wb') as stream:
        shutil.copyfileobj(response, stream)
    with destination.open('rb') as stream:
        hasher = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            hasher.update(chunk)
        digest = hasher.hexdigest()
    if digest != artifact['sha256']:
        raise SystemExit('Conda artifact SHA-256 mismatch: ' + destination.name)
    return destination


def install():
    profile = json.loads((SCRIPTS / 'rigging-profile.json').read_text())
    target = select_profile(profile['profiles'])
    # conda is the environment manager, never a dependency solver in this path.
    conda = shutil.which('conda')
    if not conda:
        raise SystemExit('Install Conda before provisioning the reviewed rigging environment.')
    environments = json.loads(run([conda, 'env', 'list', '--json'], capture_output=True).stdout)['envs']
    if any(Path(prefix).name == 'rigging' for prefix in environments):
        raise SystemExit('The rigging environment already exists. Preserve any custom work, then explicitly remove it with conda env remove -n rigging before reprovisioning.')
    # Isolated pip ignores ambient indexes, constraints and user configuration.
    env = {key: value for key, value in os.environ.items() if key not in {'PYTHONPATH', 'PYTHONHOME'}}
    env['PYTHONNOUSERSITE'] = '1'
    with tempfile.TemporaryDirectory(prefix='portos-rigging-') as temporary:
        downloads = Path(temporary)
        artifacts = [(a, fetch(a, downloads / a['url'].rsplit('/', 1)[-1]))
                     for a in target['condaArtifacts']]
        explicit = downloads / 'explicit.txt'
        explicit.write_text('@EXPLICIT\n' + '\n'.join(path.as_uri() + '#' + a['md5']
                                                    for a, path in artifacts) + '\n')
        run([conda, 'create', '--yes', '--offline', '--name', 'rigging', '--file', explicit], env=env)
        python = [conda, 'run', '--no-capture-output', '-n', 'rigging', 'python']
        try:
            run(python + ['-m', 'pip', '--isolated', 'install', '--disable-pip-version-check',
                          '--require-hashes', '--no-deps', '--only-binary', ':all:',
                          '--index-url', 'https://pypi.org/simple', '-r', SCRIPTS / target['requirements']], env=env)
            run(python + ['-m', 'pip', '--isolated', 'check'], env=env)
            run(python + ['-c', "import bpy, sys; assert sys.version_info[:3] == " + repr(tuple(map(int, profile['python'].split('.'))))
                          + "; assert bpy.app.version_string == '" + profile['bpy'] + "'; print('Blender import/version probe passed.')"], env=env)
        except BaseException:
            # Only this invocation's successfully created env may be removed.
            run([conda, 'env', 'remove', '--yes', '--name', 'rigging'], env=env)
            raise
    print('Reviewed rigging profile installed. Import success does not establish render or GPU correctness.')


if __name__ == '__main__':
    install()
