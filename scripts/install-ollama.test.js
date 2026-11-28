import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, symlinkSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./install-ollama.sh', import.meta.url));

const ARCHIVE = 'fake-archive-bytes';
const sha = (text) => createHash('sha256').update(text).digest('hex');

// Execute the real shell flow with an isolated PATH: no network, sudo, or real
// package manager can run. The fake package manager makes zstd discoverable;
// the fake curl serves a canned archive + sha256sum.txt.
function run({ installed = false, manager = 'apt-get', uid = '0', fail = false, staleAptIndex = false, missingAfter = false,
  arch = 'x86_64', curlFails = false, digest = sha(ARCHIVE), noEntry = false, version } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ollama-install-'));
  const prefix = join(dir, 'prefix');
  const log = join(dir, 'calls');
  const bin = (name, body) => writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  for (const tool of ['mktemp', 'rm', 'grep', 'head', 'mkdir', 'cat', 'cut']) {
    const real = ['/bin', '/usr/bin'].map((d) => join(d, tool)).find((p) => existsSync(p));
    if (real) symlinkSync(real, join(dir, tool));
  }
  const asset = `ollama-linux-${arch === 'aarch64' ? 'arm64' : 'amd64'}.tar.zst`;
  bin('id', `echo ${uid}`);
  bin('uname', `echo ${arch}`);
  bin('curl', `echo "curl $*" >> '${log}'
${curlFails ? 'exit 22' : ''}
out=''
url=''
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    --connect-timeout|--max-time|--speed-time|--speed-limit|--retry|--retry-delay) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  *sha256sum.txt) ${noEntry ? `echo '${digest}  other.tgz'` : `echo '${digest}  ${asset}'`} > "$out" ;;
  *) printf '%s' '${ARCHIVE}' > "$out" ;;
esac`);
  bin('sha256sum', `# fake GNU sha256sum --check built on shasum
read -r want name < "$3"
got=$(/usr/bin/shasum -a 256 "$name" | cut -d' ' -f1)
[ "$want" = "$got" ]`);
  bin('tar', `echo "tar $*" >> '${log}'`);
  bin('sudo', `echo "sudo $*" >> '${log}'\nshift\n"$@"`);
  if (installed) bin('zstd', 'exit 0');
  if (manager) {
    const managerBody = staleAptIndex
      ? `echo "${manager} $*" >> '${log}'
if [ "$1" = "update" ]; then
  echo updated > '${dir}/apt-updated'
  exit 0
fi
if [ ! -f '${dir}/apt-updated' ]; then
  exit 100
fi
echo '#!/bin/bash' > '${dir}/zstd'
/bin/chmod +x '${dir}/zstd'`
      : `echo "${manager} $*" >> '${log}'\n${fail ? 'exit 1' : missingAfter ? ':' : `echo '#!/bin/bash' > '${dir}/zstd'\n/bin/chmod +x '${dir}/zstd'`}`;
    bin(manager, managerBody);
  }
  const env = { PATH: dir, OLLAMA_INSTALL_PREFIX: prefix, ...(version ? { OLLAMA_VERSION: version } : {}) };
  const result = spawnSync('/bin/bash', [script], { env, encoding: 'utf8' });
  const calls = readFileSync(log, { encoding: 'utf8', flag: 'a+' });
  const prefixCreated = existsSync(prefix);
  rmSync(dir, { recursive: true, force: true });
  return { ...result, calls, prefixCreated };
}

describe.skipIf(process.platform === 'win32')('Linux Ollama installation', () => {
  it('verifies the checksum, then extracts the release archive', () => {
    const result = run({ installed: true });
    expect(result.status).toBe(0);
    expect(result.calls).toContain('releases/latest/download/ollama-linux-amd64.tar.zst');
    expect(result.calls).toMatch(/tar --zstd -xf \S+ollama-linux-amd64\.tar\.zst -C \S+prefix\n$/);
    expect(result.prefixCreated).toBe(true);
  });

  it('selects the arm64 asset and honours a pinned version', () => {
    const result = run({ installed: true, arch: 'aarch64', version: 'v0.0.1' });
    expect(result.status).toBe(0);
    expect(result.calls).toContain('releases/download/v0.0.1/ollama-linux-arm64.tar.zst');
  });

  it('never pipes the remote installer into a shell', () => {
    const src = readFileSync(script, 'utf8');
    expect(src).not.toMatch(/ollama\.com\/install\.sh/);
    expect(src).not.toMatch(/\|\s*(ba)?sh\b/);
  });

  it.each([
    ['digest mismatch', { digest: sha('tampered') }, 'SHA-256 mismatch'],
    ['missing checksum entry', { noEntry: true }, 'no entry for'],
  ])('rejects %s before extracting or touching the prefix', (_n, options, message) => {
    const result = run({ installed: true, ...options });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(result.calls).not.toContain('tar ');
    expect(result.prefixCreated).toBe(false);
  });

  it('rejects an unsupported architecture without downloading', () => {
    const result = run({ installed: true, arch: 'riscv64' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Unsupported architecture');
    expect(result.calls).toBe('');
  });

  it.each([
    ['apt-get', 'install -y zstd'], ['dnf', 'install -y zstd'],
    ['yum', 'install -y zstd'], ['pacman', '-S --noconfirm zstd'],
  ])('installs the prerequisite with %s before downloading', (manager, args) => {
    const result = run({ manager });
    expect(result.status).toBe(0);
    expect(result.calls.startsWith(`${manager} ${args}\ncurl `)).toBe(true);
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
  ])('stops before downloading when prerequisites fail: %j', (options, message) => {
    const result = run(options);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(result.calls).not.toContain('curl');
  });

  it('does not report success when the download fails', () => {
    const result = run({ installed: true, curlFails: true });
    expect(result.status).toBe(22);
    expect(result.prefixCreated).toBe(false);
  });

  it('bounds and retries curl downloads for both the archive and checksum file', () => {
    const result = run({ installed: true });
    expect(result.status).toBe(0);
    const curlLines = result.calls.split('\n').filter((line) => line.startsWith('curl '));
    expect(curlLines).toHaveLength(2);
    expect(curlLines[0]).toContain('--connect-timeout 15');
    expect(curlLines[0]).toContain('--speed-time 60');
    expect(curlLines[0]).toContain('--speed-limit 1024');
    expect(curlLines[0]).toContain('--retry 3');
    expect(curlLines[1]).toContain('--connect-timeout 15');
    expect(curlLines[1]).toContain('--max-time 60');
    expect(curlLines[1]).toContain('--retry 3');
  });

  it('refreshes stale APT indexes once and retries zstd install on failure', () => {
    const result = run({ manager: 'apt-get', staleAptIndex: true });
    expect(result.status).toBe(0);
    expect(result.calls).toContain('apt-get install -y zstd\napt-get update\napt-get install -y zstd\ncurl ');
  });
});
