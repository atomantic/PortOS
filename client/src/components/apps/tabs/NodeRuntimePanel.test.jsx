import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NodeRuntimePanel from './NodeRuntimePanel';

const api = vi.hoisted(() => ({
  getNodeRuntimeStatus: vi.fn(),
  updateNodeRuntime: vi.fn(),
  updatePm2Runtime: vi.fn(),
  repairNodeStartup: vi.fn(),
}));
vi.mock('../../../services/api', () => api);
const clipboard = vi.hoisted(() => ({ copyToClipboard: vi.fn() }));
vi.mock('../../../lib/clipboard', () => clipboard);
vi.mock('../../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
afterEach(cleanup);

const status = (overrides = {}) => ({
  node: { version: 'v26.0.0', execPath: '/opt/homebrew/bin/node', source: 'homebrew', pinned: null, supportedRange: '>=26.0.0', inSupportedRange: true },
  nvm: { dir: '/home/example/.nvm', defaultVersion: 'v26.12.1', installed: ['v26.12.1'] },
  releases: {
    securityUpdate: true,
    offers: [
      { version: 'v26.12.1', label: 'Latest 26.x', lts: null, date: '2026-10-21' },
      { version: 'v27.1.0', label: 'Latest release', lts: null, date: '2026-10-20' },
    ],
  },
  releasesError: null,
  pm2: { shipped: '7.0.4', latest: '7.0.4', daemon: { pm2Version: '7.0.4', nodeVersion: '26.0.0' }, cli: '7.0.4', cliBehind: false, daemonStale: false },
  startup: null,
  canUpdate: true,
  blockedReason: null,
  job: null,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  api.updateNodeRuntime.mockResolvedValue({ started: true, restart: true });
});

describe('NodeRuntimePanel', () => {
  it('launches the update for the picked release through the Update tab', async () => {
    api.getNodeRuntimeStatus.mockResolvedValue(status());
    const onLaunch = vi.fn((call) => call());
    render(<NodeRuntimePanel onLaunch={onLaunch} />);

    expect(await screen.findByText('Security update')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/v27\.1\.0/));
    await userEvent.click(screen.getByRole('button', { name: 'Update Node to v27.1.0 and restart' }));

    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect(api.updateNodeRuntime).toHaveBeenCalledWith('v27.1.0');
  });

  it('shows why an install cannot update instead of a button', async () => {
    api.getNodeRuntimeStatus.mockResolvedValue(status({ canUpdate: false, blockedReason: 'nvm is not installed.' }));
    render(<NodeRuntimePanel onLaunch={vi.fn()} />);
    expect(await screen.findByText('nvm is not installed.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Update Node/ })).toBeNull();
  });

  it('offers the pm2 refresh and the start-on-boot command only when they are behind', async () => {
    api.getNodeRuntimeStatus.mockResolvedValue(status({
      releases: { securityUpdate: false, offers: [] },
      pm2: { shipped: '7.0.4', latest: '7.0.4', daemon: { pm2Version: '7.0.4', nodeVersion: '26.10.0' }, cli: '7.0.4', cliBehind: false, daemonStale: true },
      startup: { system: 'systemd', configured: true, current: false, fixable: false, command: 'sudo env PATH=$PATH:/x/bin /x/bin/pm2 startup systemd -u example --hp /home/example' },
    }));
    render(<NodeRuntimePanel onLaunch={vi.fn()} />);

    expect(await screen.findByRole('button', { name: 'Update pm2 to 7.0.4 and restart' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Copy start-on-boot command' }));
    expect(clipboard.copyToClipboard).toHaveBeenCalledWith(expect.stringContaining('pm2 startup systemd'), 'Command copied');
  });

  it('repoints a macOS boot script in place instead of asking for sudo', async () => {
    api.getNodeRuntimeStatus.mockResolvedValue(status({
      node: { ...status().node, pinned: '/home/example/.nvm/versions/node/v26.12.1/bin/node' },
      releases: { securityUpdate: false, offers: [] },
      startup: { system: 'launchd', configured: true, current: false, fixable: true, command: 'sudo …' },
    }));
    api.repairNodeStartup.mockResolvedValue({ fixed: true });
    render(<NodeRuntimePanel onLaunch={vi.fn()} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Use PortOS’s Node at boot' }));
    expect(api.repairNodeStartup).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Needs your password/)).toBeNull();
  });
});
