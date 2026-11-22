import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import HomebrewUpgrades from './HomebrewUpgrades';
import { getHomebrewStatus, holdHomebrewPackages, repairHomebrewFallout, upgradeHomebrewPackages } from '../../services/apiSystem.js';

const listeners = vi.hoisted(() => new Map());
vi.mock('../../services/socket', () => ({ default: {
  on: vi.fn((name, handler) => listeners.set(name, [...(listeners.get(name) || []), handler])),
  off: vi.fn(), connected: true,
} }));
const fire = (name, payload) => (listeners.get(name) || []).forEach((handler) => handler(payload));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('../ui/Toast', () => ({ default: toast }));
vi.mock('../../services/apiSystem.js', () => ({
  getHomebrewStatus: vi.fn(), upgradeHomebrewPackages: vi.fn(), repairHomebrewFallout: vi.fn(), holdHomebrewPackages: vi.fn(),
}));

const status = {
  supported: true,
  checkedAt: '2026-11-21T18:00:00Z',
  job: null,
  lastRun: null,
  problems: [{ id: 'postgres-extensions', label: 'pgvector does not load in PortOS\'s database', detail: 'could not access file "$libdir/vector"', repair: 'Repair runs the database setup.' }],
  packages: [
    { name: 'pgvector', kind: 'formula', installed: '0.8.1', current: '0.8.7_1', risk: 'breaking', reasons: ['0.8.7_1 no longer supports postgresql@17.'], checks: [] },
    { name: 'ffmpeg', kind: 'formula', installed: '8.0', current: '8.0.1', risk: 'caution', reasons: ['Media features use this ffmpeg.'], checks: [] },
    { name: 'wget', kind: 'formula', installed: '1.24', current: '1.25', risk: 'safe', reasons: [], checks: [] },
  ],
};

beforeEach(() => { vi.clearAllMocks(); listeners.clear(); getHomebrewStatus.mockResolvedValue(status); });

describe('Settings › Software › Homebrew', () => {
  it('renders nothing where Homebrew is unsupported', async () => {
    getHomebrewStatus.mockResolvedValue({ supported: false, reason: 'The Homebrew upgrade manager runs on macOS.' });
    const { container } = render(<HomebrewUpgrades />);
    await waitFor(() => expect(getHomebrewStatus).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('leaves a breaking upgrade unticked and asks before upgrading it', async () => {
    upgradeHomebrewPackages.mockRejectedValueOnce(Object.assign(new Error('pgvector: drops postgresql@17'), { code: 'HOMEBREW_UPGRADE_RISK' }));
    upgradeHomebrewPackages.mockResolvedValueOnce({ started: true, kind: 'upgrade', names: ['pgvector', 'ffmpeg', 'wget'] });
    render(<HomebrewUpgrades />);
    expect(await screen.findByLabelText('pgvector')).not.toBeChecked();
    expect(screen.getByLabelText('ffmpeg')).toBeChecked();
    expect(screen.getByText('Breaks PortOS')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('pgvector'));
    fireEvent.click(screen.getByRole('button', { name: /Upgrade 3/ }));
    expect(await screen.findByText('pgvector: drops postgresql@17')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Go ahead anyway' }));
    await waitFor(() => expect(upgradeHomebrewPackages).toHaveBeenLastCalledWith(['pgvector', 'ffmpeg', 'wget'], expect.objectContaining({ acknowledgeRisk: true })));
    act(() => fire('software:homebrew', { step: 'complete', status: 'done', message: 'Upgraded 3; all checks pass' }));
    expect(toast.success).toHaveBeenCalledWith('Upgraded 3; all checks pass');
    expect(screen.getByText('Upgraded 3; all checks pass')).toBeInTheDocument();
  });

  it('offers Repair for a problem found now and Hold for a risky formula', async () => {
    repairHomebrewFallout.mockResolvedValue({ started: true, kind: 'repair', names: [] });
    holdHomebrewPackages.mockResolvedValue({ names: ['pgvector'], held: true });
    render(<HomebrewUpgrades />);
    expect(await screen.findByText(/pgvector does not load/)).toBeInTheDocument();
    const holds = screen.getAllByRole('button', { name: 'Hold' });
    expect(holds).toHaveLength(2);
    fireEvent.click(holds[0]);
    await waitFor(() => expect(holdHomebrewPackages).toHaveBeenCalledWith(['pgvector'], true));
    fireEvent.click(screen.getByRole('button', { name: 'Repair' }));
    await waitFor(() => expect(repairHomebrewFallout).toHaveBeenCalled());
    // While the job runs, nothing else can start.
    expect(screen.getByRole('button', { name: /Upgrade 2/ })).toBeDisabled();
  });
});
