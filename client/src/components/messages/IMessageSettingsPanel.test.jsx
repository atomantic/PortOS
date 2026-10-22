import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  checkImessageSetup: vi.fn(),
  getImessageStatus: vi.fn(),
  getSettings: vi.fn(),
  syncImessage: vi.fn(),
  updateSettings: vi.fn(),
}));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }));
const clipboard = vi.hoisted(() => ({ copyToClipboard: vi.fn() }));

vi.mock('../../services/api', () => api);
vi.mock('../ui/Toast', () => ({ default: toast }));
vi.mock('../../lib/clipboard', () => clipboard);

const { IMessageSettingsPanel } = await import('./IMessageSettingsPanel');

const NODE = '/Users/example/.nvm/versions/node/v26.12.1/bin/node';
const SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';

beforeEach(() => {
  vi.clearAllMocks();
  api.getSettings.mockResolvedValue({ imessage: { enabled: false, intervalMinutes: 30 } });
  api.getImessageStatus.mockResolvedValue({ state: {} });
});

describe('IMessageSettingsPanel Full Disk Access', () => {
  it('names the binary to grant, links the settings pane, and rechecks in place', async () => {
    api.syncImessage.mockResolvedValue({
      ok: false,
      error: 'unable to open database file',
      fullDiskAccessRequired: true,
      fullDiskAccess: { launchedBy: 'launchd', paths: [NODE], settingsUrl: SETTINGS_URL },
    });
    api.checkImessageSetup.mockResolvedValue({ ok: true, dbPath: '~/Library/Messages/chat.db', messageCount: 5 });
    render(<MemoryRouter><IMessageSettingsPanel /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: /Sync now/ }));
    expect(await screen.findByText(NODE)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Open Full Disk Access settings/ }).getAttribute('href')).toBe(SETTINGS_URL);
    expect(screen.getByText(/Changing Node versions needs a new grant/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: `Copy ${NODE}` }));
    expect(clipboard.copyToClipboard).toHaveBeenCalledWith(NODE, 'Path copied');

    fireEvent.click(screen.getByRole('button', { name: /Recheck/ }));
    await waitFor(() => expect(screen.getByText('Setup OK')).toBeTruthy());
    expect(api.checkImessageSetup).toHaveBeenCalledTimes(1);
  });
});
