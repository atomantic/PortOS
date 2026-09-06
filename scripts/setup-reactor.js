#!/usr/bin/env node
// Invoked automatically on the first authorized render, never at server boot.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const data = process.env.PORTOS_REACTOR_DATA || join(root, 'data');
const venv = join(data, 'venvs', 'reactor');
const windows = process.platform === 'win32';
const python = join(venv, windows ? 'Scripts/python.exe' : 'bin/python');
const version = '0.12.10';
// Official uv release digests; verify the archive before executing its binary.
const targets = {
  'darwin-arm64': ['aarch64-apple-darwin', '51c6170e8e3a01cef9f33b94f582b7b81ac65046f55d40afb35f9cff5a68c179'],
  'darwin-x64': ['x86_64-apple-darwin', '5296d5aa2b9143360405eea866f8ef4d5dc8986b164eb0dc35e8f876a9304d30'],
  'linux-arm64': ['aarch64-unknown-linux-gnu', '9ff6b9d4665edcdd3a88dcc73cd1eb641754deb927f14e8c62ebfde6bf4f5f5e'],
  'linux-x64': ['x86_64-unknown-linux-gnu', '173d95a0c32d18c896c46ba6fafbf3cf9c14ab74b033f81b76c883ef492a976b'],
  'win32-x64': ['x86_64-pc-windows-msvc', 'f65744f94072152b1f86ba2aace4d01f1124d9a8ecb235805039e3718c36cac2'],
};
const env = { ...process.env, UV_PYTHON_INSTALL_DIR: join(data, 'venvs', 'reactor-python'), UV_NO_PROGRESS: '1' };
function run(executable, args, timeout = 450_000) {
  const result = spawnSync(executable, args, { env, stdio: 'ignore', shell: false, windowsHide: true, timeout, killSignal: 'SIGKILL' });
  if (result.error || result.status !== 0) throw new Error('Reactor runtime preparation failed; check network access and available disk space, then retry the render');
}
async function setup() {
  const target = targets[`${process.platform}-${process.arch}`];
  if (!target) throw new Error('Reactor runtime is not supported on this operating system/architecture');
  const [triple, digest] = target;
  const directory = join(data, 'venvs', `reactor-uv-${version}`);
  const archive = join(directory, windows ? 'uv.zip' : 'uv.tar.gz');
  await mkdir(directory, { recursive: true });
  const cached = await readFile(archive).catch(() => null);
  let bytes = cached;
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== digest) {
    const response = await fetch(`https://github.com/astral-sh/uv/releases/download/${version}/uv-${triple}.${windows ? 'zip' : 'tar.gz'}`, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error('Could not download the Reactor runtime manager; retry the render when network access is restored');
    bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('Reactor runtime download failed integrity verification');
    await writeFile(archive, bytes);
  }
  run('tar', ['-xf', archive, '-C', directory], 30_000);
  const uv = join(directory, ...(windows ? ['uv.exe'] : [`uv-${triple}`, 'uv']));
  // An interrupted installation is repaired in place; no system Python or pip changes.
  run(uv, ['venv', '--python', '3.12', '--managed-python', '--allow-existing', venv]);
  run(uv, ['pip', 'install', '--reinstall-package', 'reactor-sdk', '--python', python, '--only-binary', ':all:', '-r', join(root, 'scripts', 'requirements-reactor.txt')]);
  run(python, ['-c', 'from reactor_sdk import Reactor; Reactor("reactor/fast-h3")'], 15_000);
  console.log('✅ Reactor runtime ready');
}
setup().catch((error) => { console.error(`❌ ${error.message}`); process.exitCode = 1; });
