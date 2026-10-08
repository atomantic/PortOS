import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./ci-warm-test-chrome.sh', import.meta.url));

// Runs the real script against a fake browser tree; nothing reads the host's.
function run({ layout, budget = '5', failure, timeoutAvailable = true }) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-warm-chrome-'));
  const install = join(dir, 'opt/chrome');
  mkdirSync(install, { recursive: true });
  let candidates = join(dir, 'missing');
  if (layout !== 'missing') {
    writeFileSync(join(install, 'chrome'), 'x'.repeat(2 * 1048576));
    writeFileSync(join(install, 'resources.pak'), 'y'.repeat(1048576));
    mkdirSync(join(install, 'locales'));
    writeFileSync(join(install, 'locales/en.pak'), 'z'.repeat(1048576));
    // The runner exposes the browser as a symlink into its install directory.
    candidates = join(dir, 'google-chrome');
    symlinkSync(join(install, 'chrome'), candidates);
  }
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const fake = (name, body) => writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  // Model GNU timeout's interface without sleeping or depending on its presence
  // on a developer's macOS. The deadline arm returns its actual failure status.
  if (timeoutAvailable) fake('timeout', failure === 'deadline' ? 'exit 124' : 'shift 2; exec "$@"');
  if (failure === 'read') fake('cat', 'printf partial; echo "private browser path" >&2; exit 1');
  if (failure === 'traversal') fake('find', 'printf "%s\\0" "$CHROME_WARM_TEST_FILE"; echo "private browser path" >&2; exit 1');
  const result = spawnSync('/bin/bash', [script], {
    encoding: 'utf8',
    timeout: 10000, // Fixture subprocess backstop; no production sleeps.
    env: {
      PATH: timeoutAvailable ? `${bin}:${process.env.PATH}` : bin,
      CHROME_WARM_CANDIDATES: candidates,
      CHROME_WARM_BUDGET_SECONDS: budget,
      CHROME_WARM_TEST_FILE: join(install, 'chrome'),
    },
  });
  rmSync(dir, { recursive: true, force: true });
  return result;
}

describe.skipIf(process.platform === 'win32')('CI Chrome page-cache warm-up', () => {
  it('reads the whole install tree the symlinked browser lives in and reports size and time', () => {
    const result = run({ layout: 'installed' });
    expect(result.status).toBe(0);
    // 2 + 1 + 1 MiB across the binary, a resource and a nested locale file.
    expect(result.stdout).toMatch(/^🔥 Warmed the Chrome install into the page cache: 4 MiB in \d+ms$/m);
  });

  it.each(['read', 'traversal'])('reports an incomplete warm-up when %s fails after emitting bytes', failure => {
    const result = run({ layout: 'installed', failure });
    expect(result.status).toBe(0); // Acceptance still runs; only warm-up is optional.
    expect(result.stdout).toContain('::warning title=Chrome warm-up incomplete::');
    expect(result.stdout).not.toContain('Warmed the Chrome install');
    expect(result.stdout).not.toContain('private browser path');
    expect(result.stderr).toBe('');
  });

  it('reports the deadline result without claiming completion or retrying', () => {
    const result = run({ layout: 'installed', failure: 'deadline' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('exit 124, budget 5s');
    expect(result.stdout).not.toContain('Warmed the Chrome install');
    expect(result.stderr).toBe('');
  });

  it('leaves the browser cold when a bounded read is unavailable', () => {
    const result = run({ layout: 'installed', timeoutAvailable: false });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('::notice title=Chrome warm-up skipped::');
    expect(result.stdout).not.toContain('Warmed the Chrome install');
    expect(result.stderr).toBe('');
  });

  it('never fails the job when no browser exists; the suites report that themselves', () => {
    const result = run({ layout: 'missing' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('::notice title=Chrome warm-up skipped::');
  });
});
