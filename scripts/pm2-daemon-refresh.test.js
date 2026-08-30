import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { daemonEntryFromArgv, daemonNeedsRefresh, redactPaths } from './pm2-daemon-refresh.js';

// A real file on disk, because the path comparison realpath()s both sides — a
// fixture that doesn't exist would silently take the literal-spelling fallback
// and stop exercising the normalization. Deliberately NOT the repo's own
// node_modules/pm2: CI installs only the server workspace (`npm ci --prefix
// server`), so root node_modules is absent there.
const FIXTURE_DIR = mkdtempSync(join(tmpdir(), 'pm2-daemon-refresh-'));
const OURS = join(FIXTURE_DIR, 'lib', 'Daemon.js');
mkdirSync(join(FIXTURE_DIR, 'lib'), { recursive: true });
writeFileSync(OURS, '// fixture\n');

afterAll(() => rmSync(FIXTURE_DIR, { recursive: true, force: true }));

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

  it('strips the whitespace a comma-joined argv leaves on later parts', () => {
    // realpath() rejects ' /path/Daemon.js', so an untrimmed return would compare
    // as a mismatch and force the daemon reload this whole probe exists to avoid.
    expect(daemonEntryFromArgv(`/usr/bin/node, ${OURS}`)).toBe(OURS);
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

  it("reloads when the daemon runs from another project's pm2 install", () => {
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
    const spelled = join(FIXTURE_DIR, 'lib', '..', 'lib', 'Daemon.js');
    expect(check({ argv: ['/usr/bin/node', spelled] }).needed).toBe(false);
  });
});

describe('redactPaths', () => {
  it('strips the home directory so the OS username never reaches update.log', () => {
    // update.sh appends this to data/update.log, which backup snapshots sweep up.
    const message = `ENOENT: no such file, open '${join(homedir(), 'somewhere', 'package.json')}'`;
    const redacted = redactPaths(message);
    expect(redacted).not.toContain(homedir());
    // join(), not a forward-slash literal — the separator is a backslash on Windows.
    expect(redacted).toContain(join('~', 'somewhere', 'package.json'));
  });

  it('keeps the diagnostic parts of the message intact', () => {
    expect(redactPaths('pm2 getReport timed out after 15000ms')).toBe('pm2 getReport timed out after 15000ms');
  });

  it('survives a missing message', () => {
    expect(redactPaths(undefined)).toBe('');
  });
});
