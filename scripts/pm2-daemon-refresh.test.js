import { describe, expect, it } from 'vitest';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { daemonEntryFromArgv, daemonNeedsRefresh } from './pm2-daemon-refresh.js';

// A path that really exists in this checkout, so realpath resolution in the
// comparison exercises the same branch it takes during an update.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OURS = join(ROOT, 'node_modules', 'pm2', 'lib', 'Daemon.js');
const VERSION = '7.0.4';

const report = (overrides = {}) => ({
  pm2_version: VERSION,
  argv: ['/usr/local/bin/node', OURS],
  ...overrides,
});

const check = (overrides) =>
  daemonNeedsRefresh({
    report: report(overrides),
    expectedEntry: OURS,
    expectedVersion: VERSION,
  });

describe('daemonEntryFromArgv', () => {
  it('finds the Daemon.js entry in a real argv array', () => {
    expect(daemonEntryFromArgv(['/usr/bin/node', OURS])).toBe(OURS);
  });

  it('accepts the comma-joined string an older daemon may report', () => {
    expect(daemonEntryFromArgv(`/usr/bin/node,${OURS}`)).toBe(OURS);
  });

  it('returns null when argv carries no Daemon.js entry', () => {
    expect(daemonEntryFromArgv(['/usr/bin/node', '/somewhere/else.js'])).toBeNull();
    expect(daemonEntryFromArgv(undefined)).toBeNull();
  });
});

describe('daemonNeedsRefresh', () => {
  it('skips the reload when the daemon already runs this checkout of pm2', () => {
    // The whole point: co-located apps on the shared daemon are not restarted.
    expect(check()).toEqual({ needed: false, reason: expect.any(String) });
  });

  it('reloads when the daemon runs from another project\'s pm2 install', () => {
    // The MODULE_NOT_FOUND case — a stale ProcessContainerFork.js path.
    expect(check({ argv: ['/usr/bin/node', '/other/project/node_modules/pm2/lib/Daemon.js'] }).needed).toBe(true);
  });

  it('reloads when the pulled update bumped pm2 under a running daemon', () => {
    expect(check({ pm2_version: '6.0.0' }).needed).toBe(true);
  });

  it('reloads when the daemon reports nothing usable', () => {
    // Fails open: an unreadable daemon must not skip a reload it may need.
    expect(daemonNeedsRefresh({ report: null, expectedEntry: OURS, expectedVersion: VERSION }).needed).toBe(true);
    expect(check({ argv: [] }).needed).toBe(true);
  });

  it('treats a differently-spelled path to the same file as a match', () => {
    const spelled = join(ROOT, 'node_modules', 'pm2', 'lib', '..', 'lib', 'Daemon.js');
    expect(check({ argv: ['/usr/bin/node', spelled] }).needed).toBe(false);
  });
});
