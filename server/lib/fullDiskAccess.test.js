import { describe, it, expect } from 'vitest';
import { fullDiskAccessDetails, FULL_DISK_ACCESS_SETTINGS_URL } from './fullDiskAccess.js';

const describeFullDiskAccessTarget = async (options) => (await fullDiskAccessDetails(options)).fullDiskAccess;

const NODE = '/Users/example/.nvm/versions/node/v26.12.1/bin/node';

// Fake process table: pid → { ppid, comm }.
const reader = (table) => async (pid) => table[pid] ?? null;

describe('fullDiskAccessDetails', () => {
  it('names the node binary when a pm2 LaunchAgent (launchd) owns the server', async () => {
    const target = await describeFullDiskAccessTarget({
      execPath: NODE,
      pid: 300,
      platform: 'darwin',
      readProcess: reader({ 300: { ppid: 200, comm: NODE }, 200: { ppid: 1, comm: NODE } }),
    });
    expect(target).toMatchObject({ launchedBy: 'launchd', paths: [NODE], settingsUrl: FULL_DISK_ACCESS_SETTINGS_URL });
  });

  it('puts the exact path in the remediation text', async () => {
    const { remediation } = await fullDiskAccessDetails({ execPath: NODE, platform: 'linux' });
    expect(remediation).toContain(`Add ${NODE} to System Settings`);
  });

  it('also names a pm2 daemon running on a different node binary', async () => {
    const daemon = '/opt/homebrew/Cellar/node/26.0.0/bin/node';
    const target = await describeFullDiskAccessTarget({
      execPath: NODE,
      pid: 300,
      platform: 'darwin',
      readProcess: reader({ 300: { ppid: 200, comm: NODE }, 200: { ppid: 1, comm: daemon } }),
    });
    expect(target.paths).toEqual([NODE, daemon]);
  });

  it('names the terminal app when one started the server', async () => {
    const target = await describeFullDiskAccessTarget({
      execPath: NODE,
      pid: 400,
      platform: 'darwin',
      readProcess: reader({
        400: { ppid: 350, comm: NODE },
        350: { ppid: 340, comm: '/bin/zsh' },
        340: { ppid: 1, comm: '/Applications/iTerm.app/Contents/MacOS/iTerm2' },
      }),
    });
    expect(target).toMatchObject({ launchedBy: 'app', paths: ['/Applications/iTerm.app'], hostApp: 'iTerm' });
  });

  it('falls back to the server binary off macOS or when ps fails', async () => {
    const failing = async () => { throw new Error('ps missing'); };
    const target = await describeFullDiskAccessTarget({ execPath: NODE, pid: 1, platform: 'darwin', readProcess: failing });
    expect(target.paths).toEqual([NODE]);
    const linux = await describeFullDiskAccessTarget({ execPath: NODE, platform: 'linux', readProcess: failing });
    expect(linux.paths).toEqual([NODE]);
  });
});
