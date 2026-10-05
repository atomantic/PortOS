import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
const fixture = vi.hoisted(() => ({ status: null, refresh: vi.fn(), begin: vi.fn(), resume: vi.fn() }));
vi.mock('../../hooks/useMaintenance.js', () => ({ useMaintenance: () => fixture }));
vi.mock('../../services/apiSystem.js', () => ({ beginMaintenance: fixture.begin, resumeMaintenance: fixture.resume }));
import MaintenancePanel from './MaintenancePanel.jsx';

beforeEach(() => {
  fixture.status = { state: 'normal', blockers: [] };
  fixture.refresh.mockReset().mockResolvedValue(undefined);
  fixture.begin.mockReset().mockResolvedValue(undefined);
  fixture.resume.mockReset().mockResolvedValue(undefined);
});

describe('maintenance controls', () => {
  it('requests a hold with the entered reason and refreshes confirmed status', async () => {
    render(<MaintenancePanel />);
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: '  Service work  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enter maintenance' }));
    await waitFor(() => expect(fixture.refresh).toHaveBeenCalledTimes(1));
    expect(fixture.begin).toHaveBeenCalledWith('Service work', { silent: true });
    expect(screen.getByRole('status')).toHaveTextContent('Normal');
  });

  it('sends the displayed hold identity and exposes a stale resume refusal', async () => {
    const hold = { id: '00000000-0000-4000-8000-000000000001', revision: 4, owner: 'Operator', reason: 'Work', requestedAt: '2026-10-04T12:00:00.000Z' };
    fixture.status = { state: 'draining', hold, blockers: [] };
    fixture.resume.mockRejectedValueOnce(new Error('This maintenance hold changed.'));
    render(<MaintenancePanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Resume previous policies' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('hold changed');
    expect(fixture.resume).toHaveBeenCalledWith(hold, { silent: true });
    expect(screen.getByRole('status')).toHaveTextContent('Draining');
  });

  it('disables mutations while readiness is unknown', () => {
    fixture.status = { state: 'unknown' };
    render(<MaintenancePanel />);
    expect(screen.getByRole('button', { name: 'Enter maintenance' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Readiness unknown');
    expect(fixture.begin).not.toHaveBeenCalled();
  });
});
