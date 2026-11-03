import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SoftwareTab from './SoftwareTab';
import { getSoftwareInventory, updateNodeRuntime, updateYtDlp } from '../../services/api';

vi.mock('../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn(), connected: true } }));
vi.mock('../../services/api', () => ({
  getSoftwareInventory: vi.fn(), updateNodeRuntime: vi.fn(), updatePm2Runtime: vi.fn(),
  updateYtDlp: vi.fn(), upgradeLocalLlmBackend: vi.fn(),
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
    { id: 'harness:codex', name: 'Codex CLI', group: 'Agent harnesses', state: 'missing', home: { path: '/ai/harnesses', label: 'Harnesses' } },
  ],
};

const renderTab = (path = '/settings/software') => render(<MemoryRouter initialEntries={[path]}><SoftwareTab /></MemoryRouter>);

beforeEach(() => { vi.clearAllMocks(); getSoftwareInventory.mockResolvedValue(inventory); });

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

  it('runs updates through the component homes, arming the restart watch only for restarting ones', async () => {
    updateYtDlp.mockResolvedValue({ success: true, version: '2026.02.01' });
    updateNodeRuntime.mockResolvedValue({ started: true });
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Update to 2026.02.01/ }));
    await waitFor(() => expect(updateYtDlp).toHaveBeenCalled());
    expect(captureBaseline).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Update to v26.13.0/ }));
    await waitFor(() => expect(updateNodeRuntime).toHaveBeenCalledWith('v26.13.0'));
    expect(captureBaseline).toHaveBeenCalled();
    expect(await screen.findByText(/PortOS restarts to finish/)).toBeInTheDocument();
  });

  it('shows a retryable failure instead of an empty page', async () => {
    getSoftwareInventory.mockRejectedValue(new Error('down'));
    renderTab();
    expect(await screen.findByText('Could not read installed software')).toBeInTheDocument();
  });
});
