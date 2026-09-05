#!/usr/bin/env node
// Explicit install only: the cloud adapter never installs dependencies at boot.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const venv = join(root, 'data', 'venvs', 'reactor');
const bootstrap = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const python = join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
for (const [executable, args] of [
  [bootstrap, ['-m', 'venv', venv]],
  [python, ['-m', 'pip', 'install', '-r', join(root, 'scripts', 'requirements-reactor.txt')]],
]) {
  const result = spawnSync(executable, args, { stdio: 'inherit', shell: false });
  if (result.error || result.status !== 0) {
    console.error('❌ Reactor SDK setup failed. Install Python 3.11+ and retry.');
    process.exit(1);
  }
}
console.log('✅ Reactor SDK installed. Video generation also requires ffmpeg on PATH.');
