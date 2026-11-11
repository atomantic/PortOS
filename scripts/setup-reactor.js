#!/usr/bin/env node
// Invoked automatically on the first authorized render, never at server boot.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { REACTOR_SETUP_ERRORS } from './lib/reactorSetupErrors.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const data = process.env.PORTOS_REACTOR_DATA || join(root, 'data');
const venv = join(data, 'venvs', 'reactor');
const windows = process.platform === 'win32';
const python = join(venv, windows ? 'Scripts/python.exe' : 'bin/python');
// 0.13.4 is the floor for the compromised-CA and wheel-extraction advisories.
const version = '0.13.7';
// Official uv release digests; verify the archive before executing its binary.
const targets = {
  'darwin-arm64': ['aarch64-apple-darwin', '81b811b57e4624df7ed3aac148e0359100d9962f3d9dce00aec533dc2e086731'],
  'darwin-x64': ['x86_64-apple-darwin', '20c47e4c1f630b8abaff8c291fa9b9aa300fef92c4fbff95adf198b55287cda7'],
  'linux-arm64': ['aarch64-unknown-linux-gnu', '71279f8d3c67241e807b9d8db872d1bf541579fb9f08b7d1eb1682196d1e57dc'],
  'linux-x64': ['x86_64-unknown-linux-gnu', 'c5221ff41b7892bfc223543883600125f6a47fe845093e0f5bdff4f359196d83'],
  'win32-x64': ['x86_64-pc-windows-msvc', '0cdc5b38fe5a8168ed6a25814f5ba43c21d313dd3187314fccb37b7cec46e021'],
};
const env = { ...process.env, UV_PYTHON_INSTALL_DIR: join(data, 'venvs', 'reactor-python'), UV_NO_PROGRESS: '1' };
function setupError(code) {
  return Object.assign(new Error(REACTOR_SETUP_ERRORS[code]), { code });
}
function run(code, executable, args, timeout = 450_000) {
  const result = spawnSync(executable, args, { env, stdio: 'ignore', shell: false, windowsHide: true, timeout, killSignal: 'SIGKILL' });
  if (result.error || result.status !== 0) throw setupError(code);
}
async function setup() {
  const target = targets[`${process.platform}-${process.arch}`];
  if (!target) throw setupError(26);
  const [triple, digest] = target;
  const directory = join(data, 'venvs', `reactor-uv-${version}`);
  const archive = join(directory, windows ? 'uv.zip' : 'uv.tar.gz');
  await mkdir(directory, { recursive: true });
  const cached = await readFile(archive).catch(() => null);
  let bytes = cached;
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== digest) {
    const response = await fetch(`https://github.com/astral-sh/uv/releases/download/${version}/uv-${triple}.${windows ? 'zip' : 'tar.gz'}`, { signal: AbortSignal.timeout(120_000) }).catch(() => { throw setupError(20); });
    if (!response.ok) throw setupError(20);
    bytes = Buffer.from(await response.arrayBuffer().catch(() => { throw setupError(20); }));
    if (createHash('sha256').update(bytes).digest('hex') !== digest) throw setupError(21);
    await writeFile(archive, bytes);
  }
  run(22, 'tar', ['-xf', archive, '-C', directory], 30_000);
  const uv = join(directory, ...(windows ? ['uv.exe'] : [`uv-${triple}`, 'uv']));
  // An interrupted installation is repaired in place; no system Python or pip changes.
  run(23, uv, ['venv', '--python', '3.12', '--managed-python', '--allow-existing', venv]);
  // The lock is the complete closure: no install-time resolution, every file hash-checked.
  run(24, uv, ['pip', 'install', '--reinstall-package', 'reactor-sdk', '--python', python, '--only-binary', ':all:', '--require-hashes', '--no-deps', '-r', join(root, 'scripts', 'requirements-reactor.lock.txt')]);
  run(25, python, ['-c', 'from reactor_sdk import Reactor; Reactor("reactor/fast-h3")'], 15_000);
  console.log('✅ Reactor runtime ready');
}
setup().catch((error) => {
  const code = Number.isInteger(error.code) && Object.hasOwn(REACTOR_SETUP_ERRORS, error.code) ? error.code : 1;
  console.error(`❌ ${REACTOR_SETUP_ERRORS[code] || 'Reactor runtime preparation failed; check network access and disk space, then retry the render'}`);
  process.exitCode = code;
});
