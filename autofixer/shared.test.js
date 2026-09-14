import { describe, it, expect, beforeEach, vi } from 'vitest';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

// loadApps() reads a fixed on-disk path, so the read is faked to keep the
// fallback assertions independent of whether this install has a data/apps.json.
const readFileMock = vi.hoisted(() => vi.fn());
vi.mock('fs/promises', async (importOriginal) => ({
  ...(await importOriginal()),
  readFile: (...args) => readFileMock(...args),
}));

// execPm2's missing-binary guard is tested by faking existsSync rather than
// actually deleting PM2_BIN, which would break every other test in this file.
const existsSyncMock = vi.hoisted(() => vi.fn());
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, existsSync: (...args) => existsSyncMock(...args) };
});

// shared.js resolves the PM2 binary at import time, and Node walks node_modules
// upward from `autofixer/` — so it needs the ROOT install. CI installs only
// `server/node_modules` (`npm ci --prefix server`), which is never on that path,
// so skip there rather than fail: the autofixer only ever runs from a full
// `npm run install:all` checkout, which is where this suite has to hold.
const require = createRequire(import.meta.url);
const pm2Installed = (() => {
  try {
    require.resolve('pm2/package.json');
    return true;
  } catch {
    return false;
  }
})();
const describeShared = pm2Installed ? describe : describe.skip;
const shared = pm2Installed ? await import('./shared.js') : {};

// Default existsSync to the real filesystem; individual tests override with
// mockReturnValueOnce to simulate a missing PM2_BIN.
const actualFs = await vi.importActual('fs');
existsSyncMock.mockImplementation((...args) => actualFs.existsSync(...args));

const AUTOFIXER_SRC_DIR = dirname(fileURLToPath(import.meta.url));

describeShared('autofixer/shared — PM2 binary resolution', () => {
  // server.js and ui.js both spawn `node <PM2_BIN>` rather than `pm2`, so a PM2
  // package layout change would otherwise surface only at runtime, on the next
  // repair attempt or dashboard restart.
  it('resolves the JS entry point (not pm2.cmd) and it exists on disk', () => {
    expect(shared.PM2_BIN.endsWith(join('bin', 'pm2'))).toBe(true);
    expect(existsSync(shared.PM2_BIN)).toBe(true);
  });
});

describeShared('autofixer/shared — execPm2', () => {
  // A dangling symlink (e.g. left by a reaped worktree install) makes PM2_BIN
  // not exist on disk without require.resolve('pm2/package.json') ever
  // noticing, since that only resolves the package dir. Simulating that with
  // existsSync proves execPm2 rejects with a clean one-line message instead
  // of spawning `node <missing-file>` and surfacing an opaque multi-line
  // MODULE_NOT_FOUND dump.
  it('rejects with a one-line message when PM2_BIN is missing, without spawning', async () => {
    existsSyncMock.mockReturnValueOnce(false);
    await expect(shared.execPm2(['jlist'])).rejects.toThrow(`PM2 binary not found at ${shared.PM2_BIN} — run "npm install" in the repo root`);
  });
});

describeShared('autofixer/shared — data paths', () => {
  // Both PM2 processes must agree on one data/ directory; resolving from this
  // module's own location is what guarantees that. Spelled as a dirname climb
  // rather than a '..' path literal so the repo-wide test-data isolation guard
  // (server/lib/testDataIsolation.guards.test.js) doesn't read this string-only
  // comparison as a suite that addresses the live data/ tree — nothing here
  // touches the filesystem.
  it('anchors every path to the package-sibling data/ directory', () => {
    expect(shared.DATA_DIR).toBe(join(dirname(AUTOFIXER_SRC_DIR), 'data'));
    expect(shared.APPS_FILE).toBe(join(shared.DATA_DIR, 'apps.json'));
    expect(shared.AUTOFIXER_DIR).toBe(join(shared.DATA_DIR, 'autofixer'));
    expect(shared.INDEX_FILE).toBe(join(shared.AUTOFIXER_DIR, 'index.json'));
  });
});

describeShared('autofixer/shared — loadApps', () => {
  beforeEach(() => {
    readFileMock.mockReset();
  });

  it('returns [] when the apps file is missing', async () => {
    readFileMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    await expect(shared.loadApps()).resolves.toEqual([]);
  });

  it('returns [] when the apps file has no apps key', async () => {
    readFileMock.mockResolvedValue('{}');
    await expect(shared.loadApps()).resolves.toEqual([]);
  });

  it('flattens the apps map into records carrying their id', async () => {
    readFileMock.mockResolvedValue(JSON.stringify({
      apps: { 'example-app': { pm2ProcessNames: ['example-api'], repoPath: '/srv/example' } },
    }));
    await expect(shared.loadApps()).resolves.toEqual([
      { id: 'example-app', pm2ProcessNames: ['example-api'], repoPath: '/srv/example' },
    ]);
  });
});
