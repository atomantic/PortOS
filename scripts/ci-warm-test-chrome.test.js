import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./ci-warm-test-chrome.sh', import.meta.url));

// Runs the real script against a fake browser tree; nothing reads the host's.
function run({ layout, budget = '5' }) {
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
  if (layout === 'unreadable') chmodSync(join(install, 'chrome'), 0o000);
  const result = spawnSync('/bin/bash', [script], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, CHROME_WARM_CANDIDATES: candidates, CHROME_WARM_BUDGET_SECONDS: budget },
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

  it('never fails the job when no browser exists; the suites report that themselves', () => {
    const result = run({ layout: 'missing' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('::notice title=Chrome warm-up skipped::');
  });
});
