import { describe, expect, it } from 'vitest';
import { posix } from 'path';
import { __testing } from './nodeRuntime.js';

const { getStartupStatus, globalPm2Status, resolveNvm, rewriteLaunchAgent, summarizeNodeReleases } = __testing;

// Shape of https://nodejs.org/dist/index.json entries (only the fields read).
const release = (version, { lts = false, security = false, date = '2026-10-01' } = {}) => ({ version, lts, security, date });

const INDEX = [
  release('v26.12.1', { security: true, date: '2026-10-21' }),
  release('v26.12.0'),
  release('v26.0.0'),
  release('v25.9.0', { security: true }), // odd line PortOS does not support
  release('v24.22.1', { lts: 'Krypton', security: true }),
  release('v24.22.0', { lts: 'Krypton' }),
  release('v22.22.3', { lts: 'Jod' }),
];

describe('summarizeNodeReleases', () => {
  it('offers the line patch first, then the newest LTS, flagging a pending security fix', () => {
    const summary = summarizeNodeReleases(INDEX, 'v24.22.0');
    expect(summary.offers.map((offer) => [offer.version, offer.label])).toEqual([
      ['v24.22.1', 'Latest 24.x'],
      ['v26.12.1', 'Latest release'],
    ]);
    expect(summary.securityUpdate).toBe(true);
    expect(summary.latestSecurity.version).toBe('v24.22.1');
    expect(summary.securityVerified).toBe(true);
    expect(summary.latestLts.version).toBe('v24.22.1');
  });

  it('never offers an unsupported line or a downgrade', () => {
    const summary = summarizeNodeReleases(INDEX, 'v26.0.0');
    expect(summary.offers.map((offer) => offer.version)).toEqual(['v26.12.1']);
    expect(summary.offers.some((offer) => offer.version.startsWith('v25.'))).toBe(false);
    // The LTS is older than what runs, so it is reported but not offered.
    expect(summary.latestLts.version).toBe('v24.22.1');
  });

  it('reads as current with nothing to offer on the newest release', () => {
    const summary = summarizeNodeReleases(INDEX, 'v26.12.1');
    expect(summary.offers).toEqual([]);
    expect(summary.securityUpdate).toBe(false);
  });

  it('does not call a newer non-security patch a security update', () => {
    expect(summarizeNodeReleases(INDEX, 'v22.22.2').securityUpdate).toBe(false);
  });

  it('does not claim security metadata was verified if a newer release omits it', () => {
    const summary = summarizeNodeReleases([{ version: 'v26.14.0', lts: false }], 'v26.13.0');
    expect(summary.securityVerified).toBe(false);
  });
});

describe('resolveNvm', () => {
  it('finds Homebrew’s nvm.sh when NVM_DIR holds only versions and aliases', () => {
    const present = new Set(['/home/example/.nvm', '/opt/homebrew/opt/nvm/nvm.sh']);
    expect(resolveNvm({ env: {}, home: '/home/example', exists: (path) => present.has(path) }))
      .toEqual({ dir: '/home/example/.nvm', script: '/opt/homebrew/opt/nvm/nvm.sh' });
  });

  it('reports no nvm when neither the directory nor a loader exists', () => {
    expect(resolveNvm({ env: {}, home: '/home/example', exists: () => false })).toBeNull();
    expect(resolveNvm({ env: {}, home: '/home/example', exists: (path) => path === '/home/example/.nvm' })).toBeNull();
  });
});

it('distinguishes a missing global pm2 CLI from an unreadable installation', () => {
  const node = '/example/node/bin/node';
  const readError = (code) => () => { throw Object.assign(new Error(code), { code }); };
  expect(globalPm2Status(node, { isWindows: false, readText: () => '{"version":"7.1.0"}' })).toEqual({ state: 'available', version: '7.1.0' });
  expect(globalPm2Status(node, { isWindows: false, readText: readError('ENOENT') })).toEqual({ state: 'missing', version: null });
  expect(globalPm2Status(node, { isWindows: false, readText: readError('EACCES') })).toEqual({ state: 'unverified', version: null });
  expect(globalPm2Status(node, { isWindows: false, readText: () => '{broken' })).toEqual({ state: 'unverified', version: null });
});

describe('getStartupStatus', () => {
  const nodeBinary = '/home/example/.nvm/versions/node/v26.12.1/bin/node';
  const binDir = '/home/example/.nvm/versions/node/v26.12.1/bin';

  it('flags a boot script that still launches an older Node and gives the sudo command', () => {
    const status = getStartupStatus({
      nodeBinary, platform: 'darwin', home: '/Users/example', user: 'example',
      readText: (file) => (file === posix.join('/Users/example', 'Library', 'LaunchAgents', 'pm2.example.plist')
        ? '<string>/Users/example/.nvm/versions/node/v24.14.1/bin</string>' : null),
    });
    expect(status).toMatchObject({ system: 'launchd', configured: true, current: false, fixable: true });
    expect(status.command).toBe(`sudo env PATH=$PATH:${binDir} ${posix.join(binDir, 'pm2')} startup launchd -u example --hp /Users/example`);
  });

  it('repoints every nvm Node path in a LaunchAgent, and refuses what it cannot safely rewrite', () => {
    const agent = '<string>/Users/example/.nvm/versions/node/v24.14.1/bin/pm2</string><string>PATH=/Users/example/.nvm/versions/node/v24.14.1/bin:/usr/bin</string>';
    expect(rewriteLaunchAgent(agent, binDir)).toBe(agent.replaceAll('v24.14.1', 'v26.12.1'));
    // A Homebrew target, or an agent with no nvm path, is left to `pm2 startup`.
    expect(rewriteLaunchAgent(agent, '/opt/homebrew/bin')).toBeNull();
    expect(rewriteLaunchAgent('<string>/opt/homebrew/bin/pm2</string>', binDir)).toBeNull();
  });

  it('reads a boot script on the pinned Node as current, and a missing one as unconfigured', () => {
    const current = getStartupStatus({ nodeBinary, platform: 'linux', home: '/home/example', user: 'example', readText: () => `PATH=${binDir}` });
    expect(current).toMatchObject({ system: 'systemd', configured: true, current: true });
    const missing = getStartupStatus({ nodeBinary, platform: 'linux', home: '/home/example', user: 'example', readText: () => null });
    expect(missing).toMatchObject({ configured: false, current: null });
  });

  it('names Homebrew’s global pm2, not the Cellar keg, for a Homebrew node', () => {
    const status = getStartupStatus({
      nodeBinary: '/opt/homebrew/Cellar/node/26.0.0/bin/node', platform: 'darwin', home: '/Users/example', user: 'example',
      readText: () => '<string>/opt/homebrew/bin/pm2</string>',
    });
    expect(status.current).toBe(true);
    expect(status.command).toContain(' /opt/homebrew/bin/pm2 startup launchd');
  });

  it('stays silent where PortOS cannot generate a boot script', () => {
    expect(getStartupStatus({ nodeBinary, platform: 'win32', user: 'example' })).toBeNull();
  });
});
