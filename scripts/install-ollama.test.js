import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./install-ollama.sh', import.meta.url));

// Execute the real shell flow with an isolated PATH: no network, sudo, or real
// package manager can run. The fake package manager makes zstd discoverable.
function run({ installed = false, manager = 'apt-get', uid = '0', fail = false, curlFails = false, missingAfter = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ollama-install-'));
  const log = join(dir, 'calls');
  const bin = (name, body) => writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  bin('id', `echo ${uid}`);
  bin('curl', `echo curl >> '${log}'\n${curlFails ? 'exit 22' : "echo 'echo upstream'"}`);
  bin('sh', `/bin/sh "$@"`);
  bin('sudo', `echo "sudo $*" >> '${log}'\nshift\n"$@"`);
  if (installed) bin('zstd', 'exit 0');
  if (manager) bin(manager, `echo "${manager} $*" >> '${log}'\n${fail ? 'exit 1' : missingAfter ? ':' : `echo '#!/bin/bash' > '${dir}/zstd'\n/bin/chmod +x '${dir}/zstd'`}`);
  const result = spawnSync('/bin/bash', [script], { env: { PATH: dir }, encoding: 'utf8' });
  const calls = readFileSync(log, { encoding: 'utf8', flag: 'a+' });
  rmSync(dir, { recursive: true, force: true });
  return { ...result, calls };
}

describe.skipIf(process.platform === 'win32')('Linux Ollama installation', () => {
  it('runs upstream directly when zstd is already installed', () => {
    const result = run({ installed: true });
    expect(result.status).toBe(0);
    expect(result.calls).toBe('curl\n');
    expect(result.stdout).toContain('upstream');
  });

  it.each([
    ['apt-get', 'install -y zstd'], ['dnf', 'install -y zstd'],
    ['yum', 'install -y zstd'], ['pacman', '-S --noconfirm zstd'],
  ])('installs the prerequisite with %s before upstream runs', (manager, args) => {
    const result = run({ manager });
    expect(result.status).toBe(0);
    expect(result.calls).toBe(`${manager} ${args}\ncurl\n`);
  });

  it('uses non-interactive sudo for non-root installs', () => {
    const result = run({ uid: '1000' });
    expect(result.status).toBe(0);
    expect(result.calls).toContain('sudo -n apt-get install -y zstd');
  });

  it.each([
    [{ fail: true }, 'Run: sudo apt-get install -y zstd'],
    [{ manager: null }, 'Install zstd with your package manager'],
    [{ missingAfter: true }, 'zstd is still missing from PATH'],
  ])('stops before upstream cleanup when prerequisites fail: %j', (options, message) => {
    const result = run(options);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(result.calls).not.toContain('curl');
  });

  it('does not report success when the upstream download fails', () => {
    expect(run({ installed: true, curlFails: true }).status).toBe(22);
  });
});
