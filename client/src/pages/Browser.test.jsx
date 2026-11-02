import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BrowserPage from './Browser';
import * as api from '../services/api';
import toast from '../components/ui/Toast';

const handlers = vi.hoisted(() => new Map());
vi.mock('../services/socket', () => ({ default: {
  emit: vi.fn(),
  on: vi.fn((event, handler) => {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(handler);
  }),
  off: vi.fn((event, handler) => handlers.get(event)?.delete(handler)),
} }));
import socket from '../services/socket';
vi.mock('../services/api', () => ({
  getBrowserStatus: vi.fn(), getBrowserConfig: vi.fn(), updateBrowserConfig: vi.fn(), getBrowserUpdatePreflight: vi.fn(),
  launchBrowser: vi.fn(), stopBrowser: vi.fn(), restartBrowser: vi.fn(),
  getBrowserLogs: vi.fn(), navigateBrowser: vi.fn(),
  getDirectories: vi.fn(), browserDownloadUrl: vi.fn(), deleteBrowserDownload: vi.fn()
}));
vi.mock('../components/ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

const disconnected = {
  connected: false, process: { status: 'online' }, pages: [],
  error: 'Health check returned 503', config: { headless: false }
};
const ticket = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  vi.clearAllMocks();
  for (const mock of Object.values(api)) mock.mockReset();
  api.getBrowserStatus.mockResolvedValue(disconnected);
  api.getBrowserUpdatePreflight.mockResolvedValue({ state: 'current', runningVersion: '156.0.8078.74', installedVersion: '156.0.8078.74', ticket });
  api.getBrowserLogs.mockResolvedValue({ stderr: 'Chrome binary not found' });
  api.getBrowserConfig.mockResolvedValue({ cdpPort: 5556, healthPort: 5557, cdpHost: '127.0.0.1', headless: false, autoConnect: true });
});

describe('Browser recovery', () => {
  it('warns if a restart would load an older installed browser', async () => {
    api.getBrowserUpdatePreflight.mockResolvedValue({ state: 'downgrade-risk', runningVersion: '156.0.8078.74', installedVersion: '156.0.8078.4', ticket });
    render(<BrowserPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Restart browser to reconnect' }));
    expect(await screen.findByText(/Running Chrome 156.0.8078.74; installed 156.0.8078.4/)).toBeInTheDocument();
    expect(screen.getByText(/Installed Chrome is older/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restart with older Chrome' })).toBeInTheDocument();
    expect(api.restartBrowser).not.toHaveBeenCalled();
  });

  it('exposes diagnostics and config and restores navigation after a successful restart', async () => {
    const user = userEvent.setup();
    render(<BrowserPage />);
    expect(await screen.findByText('Chrome is not reachable')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Browser' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit configuration' })).toBeInTheDocument();
    expect(screen.getByText('Health check returned 503')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show logs' }));
    expect(await screen.findByText('Chrome binary not found')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit configuration' }));
    expect(await screen.findByRole('checkbox', { name: 'Headless mode' })).toBeInTheDocument();
    api.restartBrowser.mockResolvedValue({ connected: true });
    api.getBrowserStatus.mockResolvedValue({ ...disconnected, connected: true });
    await user.click(screen.getByRole('button', { name: 'Restart browser to reconnect' }));
    expect(api.restartBrowser).not.toHaveBeenCalled();
    expect(screen.getByText(/interrupts downloads and agent connections/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.restartBrowser).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Restart browser to reconnect' }));
    await user.click(await screen.findByRole('button', { name: 'Restart browser now' }));
    expect(await screen.findByRole('textbox', { name: 'URL to open' })).toBeInTheDocument();
    expect(screen.queryByText('Chrome is not reachable')).not.toBeInTheDocument();
    expect(api.restartBrowser).toHaveBeenCalledWith({ silent: true, ticket });
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
    await userEvent.click(await screen.findByRole('button', { name: 'Restart browser now' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('not connected yet')));
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByText('Chrome is not reachable')).toBeInTheDocument();
  });

  it('reports when a restarted browser cannot be checked against the reviewed version', async () => {
    api.restartBrowser.mockResolvedValue({ connected: true, updateVerification: { state: 'unverified' } });
    render(<BrowserPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Restart browser to reconnect' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Restart browser now' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('could not be verified')));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('requires explicit acknowledgement when the fresh version check fails', async () => {
    api.getBrowserUpdatePreflight.mockRejectedValue(new Error('Unavailable'));
    api.restartBrowser.mockResolvedValue({ connected: true });
    render(<BrowserPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Restart browser to reconnect' }));
    expect(await screen.findByText(/browser version could not be verified/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Restart without version verification' }));
    expect(api.restartBrowser).toHaveBeenCalledWith({ silent: true });
  });

  it('ignores a preflight result after cancellation', async () => {
    let finish;
    api.getBrowserUpdatePreflight.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<BrowserPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Restart browser to reconnect' }));
    expect(screen.getByRole('button', { name: 'Checking browser…' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => finish({ state: 'current', ticket }));
    expect(screen.queryByRole('button', { name: 'Restart browser now' })).not.toBeInTheDocument();
    expect(api.restartBrowser).not.toHaveBeenCalled();
  });

  it('does not offer a fallback restart after host control is refused', async () => {
    api.getBrowserUpdatePreflight.mockRejectedValue(Object.assign(new Error('Host control requires an operator session.'), { code: 'HOST_CONTROL_FORBIDDEN' }));
    render(<BrowserPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Restart browser to reconnect' }));
    expect(await screen.findByText('Host control requires an operator session.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restart unavailable' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Restart without version verification' })).not.toBeInTheDocument();
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

afterEach(() => { cleanup(); handlers.clear(); vi.useRealTimers(); });

it('renders socket changes without recurring reads, preserves data on failure, and reconciles reconnect/tab show', async () => {
  vi.useFakeTimers();
  const emit = event => { for (const handler of handlers.get(event) || []) handler({}); };
  const view = render(<BrowserPage />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByText('Chrome is not reachable')).toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(api.getBrowserStatus).toHaveBeenCalledTimes(1);
  api.getBrowserStatus.mockResolvedValue({ ...disconnected, connected: true });
  await act(async () => emit('browser:changed'));
  expect(screen.getByRole('textbox', { name: 'URL to open' })).toBeInTheDocument();
  api.getBrowserStatus.mockRejectedValueOnce(new Error('Temporary failure'));
  await act(async () => emit('browser:changed'));
  expect(screen.getByRole('textbox', { name: 'URL to open' })).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('Temporary failure');
  await act(async () => emit('connect'));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(socket.emit).toHaveBeenCalledWith('browser:subscribe');
  const reads = api.getBrowserStatus.mock.calls.length;
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(api.getBrowserStatus).toHaveBeenCalledTimes(reads + 1);
  view.unmount();
  expect(socket.emit).toHaveBeenCalledWith('browser:unsubscribe');
  await act(async () => { emit('browser:changed'); await vi.advanceTimersByTimeAsync(30_000); });
  expect(api.getBrowserStatus).toHaveBeenCalledTimes(reads + 1);
});
