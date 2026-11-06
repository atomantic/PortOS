import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SoftwareTab from './SoftwareTab';
import { getSoftwareInventory, installManagedBlender, updateNodeRuntime, updatePm2Runtime, updateYtDlp } from '../../services/api';

const listeners = vi.hoisted(() => new Map());
vi.mock('../../services/socket', () => ({ default: {
  on: vi.fn((name, handler) => listeners.set(name, [...(listeners.get(name) || []), handler])),
  off: vi.fn(), connected: true,
} }));
const fire = (name, payload) => (listeners.get(name) || []).forEach((handler) => handler(payload));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('../ui/Toast', () => ({ default: toast }));
vi.mock('../../services/api', () => ({
  getSoftwareInventory: vi.fn(), updateNodeRuntime: vi.fn(), updatePm2Runtime: vi.fn(),
  updateYtDlp: vi.fn(), upgradeLocalLlmBackend: vi.fn(), installManagedBlender: vi.fn(),
}));
const captureBaseline = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../hooks/usePortosRestartWatch', () => ({ usePortosRestartWatch: () => ({ captureBaseline }) }));

const inventory = {
  groups: ['Runtime', 'Agent harnesses', 'Media tools'],
  checkedAt: '2026-11-03T21:00:00Z',
  components: [
    { id: 'node', name: 'Node.js', group: 'Runtime', state: 'security', version: 'v26.12.1', latest: 'v26.13.0',
      home: { path: '/apps/portos/update', label: 'PortOS update' },
      action: { kind: 'node-update', label: 'Update to v26.13.0', version: 'v26.13.0', restarts: true } },
    { id: 'yt-dlp', name: 'yt-dlp', group: 'Media tools', state: 'update', version: '2026.01.01', latest: '2026.02.01',
      home: { path: '/devtools/video-download', label: 'Video download' }, action: { kind: 'ytdlp-update', label: 'Update to 2026.02.01', restarts: false } },
    { id: 'pm2', name: 'pm2', group: 'Runtime', state: 'attention', version: '7.0.0', latest: '7.1.0',
      action: { kind: 'pm2-sync', label: 'Sync terminal pm2', restarts: false } },
    { id: 'blender', name: 'Blender', group: 'Media tools', state: 'attention', version: '4.3.2', latest: '5.2.3',
      action: { kind: 'blender-install', label: 'Install Blender 5.2.3', restarts: false } },
    { id: 'harness:codex', name: 'Codex CLI', group: 'Agent harnesses', state: 'missing', home: { path: '/ai/harnesses', label: 'Harnesses' } },
  ],
};

const renderTab = (path = '/settings/software') => render(<MemoryRouter initialEntries={[path]}><SoftwareTab /></MemoryRouter>);

beforeEach(() => { vi.clearAllMocks(); listeners.clear(); getSoftwareInventory.mockResolvedValue(inventory); });

describe('Settings › Software', () => {
  it('groups installed components with versions and home links, hiding not-installed rows until asked', async () => {
    renderTab();
    expect(await screen.findByText('Node.js')).toBeInTheDocument();
    expect(screen.getByText('Security update')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Video download/ })).toHaveAttribute('href', '/devtools/video-download');
    expect(screen.queryByText('Codex CLI')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 not installed' }));
    expect(await screen.findByText('Codex CLI')).toBeInTheDocument();
  });

  it('does not point a current row at an older cached latest', async () => {
    getSoftwareInventory.mockResolvedValue({ groups: ['Local AI'], checkedAt: null, components: [
      { id: 'ollama', name: 'Ollama', group: 'Local AI', state: 'current', version: '0.40.15', latest: '0.40.14' },
    ] });
    renderTab();
    expect(await screen.findByText('0.40.15')).toBeInTheDocument();
    expect(screen.queryByText('0.40.14')).toBeNull();
  });

  it('runs updates through the component homes, arming the restart watch only for restarting ones', async () => {
    updateYtDlp.mockResolvedValue({ success: true, version: '2026.02.01' });
    updateNodeRuntime.mockResolvedValue({ started: true });
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Update to 2026.02.01/ }));
    await waitFor(() => expect(updateYtDlp).toHaveBeenCalled());
    expect(captureBaseline).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Update to v26.13.0/ }));
    await waitFor(() => expect(updateNodeRuntime).toHaveBeenCalledWith('v26.13.0', { silent: true, acknowledgeBusy: false }));
    expect(captureBaseline).toHaveBeenCalled();
    expect(await screen.findByText(/PortOS restarts to finish/)).toBeInTheDocument();
  });

  it('reports a background pm2 job only when it finishes, and its failure instead of success', async () => {
    updatePm2Runtime.mockResolvedValue({ started: true, restart: false });
    renderTab();
    const sync = await screen.findByRole('button', { name: /Sync terminal pm2/ });
    fireEvent.click(sync);
    await waitFor(() => expect(updatePm2Runtime).toHaveBeenCalled());
    await waitFor(() => expect(sync).toBeDisabled());
    expect(toast.success).not.toHaveBeenCalled();
    await act(async () => fire('portos:node-runtime:changed', { reason: 'pm2-cli' }));
    expect(toast.success).not.toHaveBeenCalled();
    await act(async () => fire('portos:node-runtime:changed', { reason: 'job-finished', kind: 'pm2-update' }));
    expect(toast.success).toHaveBeenCalledWith('pm2 updated');
    await waitFor(() => expect(sync).not.toBeDisabled());

    fireEvent.click(sync);
    await waitFor(() => expect(sync).toBeDisabled());
    await act(async () => fire('portos:update:error', { message: 'npm failed', step: 'pm2-update' }));
    await act(async () => fire('portos:node-runtime:changed', { reason: 'job-finished', kind: 'pm2-update' }));
    expect(toast.error).toHaveBeenCalledWith('pm2 update failed: npm failed');
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it('settles a pm2 job whose failure arrives before the start response', async () => {
    let respond;
    updatePm2Runtime.mockReturnValue(new Promise((resolve) => { respond = resolve; }));
    renderTab();
    const sync = await screen.findByRole('button', { name: /Sync terminal pm2/ });
    fireEvent.click(sync);
    await waitFor(() => expect(updatePm2Runtime).toHaveBeenCalled());
    await act(async () => fire('portos:update:error', { message: 'npm failed', step: 'pm2-update' }));
    await act(async () => fire('portos:node-runtime:changed', { reason: 'job-finished', kind: 'pm2-update' }));
    expect(toast.error).not.toHaveBeenCalled();
    await act(async () => respond({ started: true, restart: false }));
    expect(toast.error).toHaveBeenCalledWith('pm2 update failed: npm failed');
    expect(toast.success).not.toHaveBeenCalled();
    await waitFor(() => expect(sync).not.toBeDisabled());
  });

  it('ignores unrelated update errors and clears a job whose events were lost once the inventory shows it idle', async () => {
    updatePm2Runtime.mockResolvedValue({ started: true, restart: false });
    const busy = { ...inventory, components: inventory.components.map((row) => (row.id === 'pm2' ? { ...row, busy: 'pm2 update running' } : row)) };
    renderTab();
    const sync = await screen.findByRole('button', { name: /Sync terminal pm2/ });
    getSoftwareInventory.mockResolvedValue(busy);
    fireEvent.click(sync);
    await waitFor(() => expect(screen.getByText('pm2 update running')).toBeInTheDocument());
    await act(async () => fire('portos:update:error', { message: 'git pull failed', step: 'git-pull' }));
    expect(toast.error).not.toHaveBeenCalled();
    getSoftwareInventory.mockResolvedValue(inventory);
    await act(async () => fire('review:queue:changed'));
    await waitFor(() => expect(screen.getByRole('button', { name: /Sync terminal pm2/ })).not.toBeDisabled());
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('offers the owner override when PortOS is busy, and shows Blender install progress until it finishes', async () => {
    installManagedBlender
      .mockRejectedValueOnce(Object.assign(new Error('PortOS is busy (1 video render).'), { code: 'SYSTEM_BUSY' }))
      .mockResolvedValueOnce({ started: true, version: '5.2.3' });
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Install Blender 5.2.3/ }));
    expect(await screen.findByText('PortOS is busy (1 video render).')).toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Update anyway' }));
    await waitFor(() => expect(installManagedBlender).toHaveBeenLastCalledWith({ silent: true, acknowledgeBusy: true }));
    await act(async () => fire('software:blender', { step: 'download', status: 'running', message: 'Downloading Blender… 40%' }));
    expect(screen.getByText('Downloading Blender… 40%')).toBeInTheDocument();
    await act(async () => fire('software:blender', { step: 'complete', status: 'done', message: 'done' }));
    await act(async () => fire('software:changed', { reason: 'blender' }));
    expect(toast.success).toHaveBeenCalledWith('Blender updated');
    expect(screen.queryByText('Downloading Blender… 40%')).not.toBeInTheDocument();
  });

  it('shows a retryable failure instead of an empty page', async () => {
    getSoftwareInventory.mockRejectedValue(new Error('down'));
    renderTab();
    expect(await screen.findByText('Could not read installed software')).toBeInTheDocument();
  });
});
