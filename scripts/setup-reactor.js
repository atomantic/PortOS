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
  'darwin-arm64': ['aarch64-apple-darwin', '60fbd5c8a1ed681845eea28d9d622fcde03c51e91a43465b64a1e17db1ed3472'],
  'darwin-x64': ['x86_64-apple-darwin', '63ba17fdda55ad1a230d4b37fc6017ffa10c23688c83818bd3bfdf914c652a02'],
  'linux-arm64': ['aarch64-unknown-linux-gnu', '229e194255c7958d86d56e8790d969a6f74736592133f0dfd0076f754c642c1d'],
  'linux-x64': ['x86_64-unknown-linux-gnu', 'f29c3e94ffabd7e6f3ba521dba169a9b7ec12100bf3257087f0f24f6123f3645'],
  'win32-x64': ['x86_64-pc-windows-msvc', 'a2a8820d5eea32f08ef467ef3b7f66883a9b076d5737a2fc2fbb5f458d1bb50f'],
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
