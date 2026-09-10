import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BrowserPage from './Browser';
import * as api from '../services/api';
import toast from '../components/ui/Toast';

vi.mock('../services/api', () => ({
  getBrowserStatus: vi.fn(), getBrowserConfig: vi.fn(), updateBrowserConfig: vi.fn(),
  launchBrowser: vi.fn(), stopBrowser: vi.fn(), restartBrowser: vi.fn(),
  getBrowserLogs: vi.fn(), navigateBrowser: vi.fn(),
  getDirectories: vi.fn(), browserDownloadUrl: vi.fn(), deleteBrowserDownload: vi.fn()
}));
vi.mock('../components/ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

const disconnected = {
  connected: false, process: { status: 'online' }, pages: [],
  error: 'Health check returned 503', config: { headless: false }
};

beforeEach(() => {
  vi.resetAllMocks();
  api.getBrowserStatus.mockResolvedValue(disconnected);
  api.getBrowserLogs.mockResolvedValue({ stderr: 'Chrome binary not found' });
  api.getBrowserConfig.mockResolvedValue({ cdpPort: 5556, healthPort: 5557, cdpHost: '127.0.0.1', headless: false, autoConnect: true });
});

describe('Browser recovery', () => {
  it('exposes diagnostics and config and restores navigation after a successful restart', async () => {
    const user = userEvent.setup();
    render(<BrowserPage />);
    expect(await screen.findByText('Chrome is not reachable')).toBeInTheDocument();
    expect(screen.getByText('Health check returned 503')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show logs' }));
    expect(await screen.findByText('Chrome binary not found')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit configuration' }));
    expect(await screen.findByRole('checkbox', { name: 'Headless mode' })).toBeInTheDocument();
    api.restartBrowser.mockResolvedValue({ connected: true });
    api.getBrowserStatus.mockResolvedValue({ ...disconnected, connected: true });
    await user.click(screen.getByRole('button', { name: 'Restart browser to reconnect' }));
    expect(await screen.findByRole('textbox', { name: 'URL to open' })).toBeInTheDocument();
    expect(screen.queryByText('Chrome is not reachable')).not.toBeInTheDocument();
    expect(api.restartBrowser).toHaveBeenCalledWith({ silent: true });
  });

  it('picks a browser executable, derives its bundle, and saves cleared defaults', async () => {
    const user = userEvent.setup();
    const chromePath = '/Applications/Chromium.app/Contents/MacOS/Chromium';
    api.getDirectories.mockResolvedValue({
      currentPath: '/Applications/Chromium.app/Contents/MacOS',
      parentPath: '/Applications/Chromium.app/Contents',
      directories: [], files: [{ name: 'Chromium', path: chromePath }],
    });
    api.updateBrowserConfig.mockImplementation(async config => config);
    render(<BrowserPage />);
    await user.click(await screen.findByRole('button', { name: 'Edit configuration' }));
    await user.click(await screen.findByRole('button', { name: 'Browse Chrome binary' }));
    await user.click(await screen.findByRole('button', { name: 'Chromium' }));
    expect(screen.getByLabelText(/Chrome binary path/)).toHaveValue(chromePath);
    expect(screen.getByRole('textbox', { name: /macOS app bundle/ })).toHaveValue('/Applications/Chromium.app');
    expect(api.getDirectories).toHaveBeenCalledWith(null, { includeFiles: true });
    await user.click(screen.getByRole('button', { name: 'Save Config' }));
    expect(api.updateBrowserConfig).toHaveBeenLastCalledWith(expect.objectContaining({ chromePath, macAppBundle: '/Applications/Chromium.app' }), { silent: true });
    await user.clear(screen.getByLabelText(/Chrome binary path/));
    await user.click(screen.getByRole('button', { name: 'Save Config' }));
    expect(api.updateBrowserConfig).toHaveBeenLastCalledWith(expect.objectContaining({ chromePath: '', macAppBundle: null }), { silent: true });
  });

  it('keeps recovery available and avoids a success toast when restarting does not connect', async () => {
    api.restartBrowser.mockResolvedValue({ connected: false });
    render(<BrowserPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Restart browser to reconnect' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('not connected yet')));
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByText('Chrome is not reachable')).toBeInTheDocument();
  });

  it('allows a failed initial status request to be retried without offering a blind launch', async () => {
    api.getBrowserStatus.mockRejectedValueOnce(new Error('Offline'));
    render(<BrowserPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Offline');
    expect(screen.getByRole('button', { name: 'Launch' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Chrome is not reachable')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
