import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import PersistentMindMaintainerControls from './PersistentMindMaintainerControls';
const api = vi.hoisted(() => ({ getPersistentMindMaintainer: vi.fn(), updateCosConfig: vi.fn() }));
vi.mock('../../services/api', () => api);
const initial = {
  role: { schemaVersion: 1, enabled: false, appIds: [], intervalMinutes: 60 },
  availableApps: [{ id: 'example', name: 'Example app', repository: 'example/project', granted: false, available: true }],
  apps: [], prerequisites: ['Grant createTasks separately in Persistent Mind Tools.'], instructions: 'Use deterministic checks first.',
};
beforeEach(() => { vi.clearAllMocks(); api.getPersistentMindMaintainer.mockResolvedValue(initial); });
describe('PersistentMindMaintainerControls', () => {
  it('saves only explicit role intent and gates edits until persistence completes', async () => {
    let finish;
    api.updateCosConfig.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<PersistentMindMaintainerControls />);
    fireEvent.click(await screen.findByLabelText('Enable maintainer role on this instance'));
    fireEvent.click(screen.getByLabelText(/Example app/));
    fireEvent.change(screen.getByLabelText('Check interval (minutes)'), { target: { value: '120' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save maintainer settings' }));
    expect(screen.getByRole('button', { name: 'Saving…' }).disabled).toBe(true);
    expect(screen.queryByText('Maintainer settings saved.')).toBeNull();
    const role = { schemaVersion: 1, enabled: true, appIds: ['example'], intervalMinutes: 120 };
    expect(api.updateCosConfig).toHaveBeenCalledWith({ persistentMindMaintainer: role }, { silent: true });
    api.getPersistentMindMaintainer.mockResolvedValue({ ...initial, role });
    finish({ persistentMindMaintainer: role });
    await screen.findByText('Maintainer settings saved.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save maintainer settings' }).disabled).toBe(true));
    expect(screen.getByText(/Saved role: Enabled/)).toBeTruthy();
  });
  it('retains failed edits and displays the actual saved state', async () => {
    api.updateCosConfig.mockRejectedValue(new Error('Save unavailable'));
    render(<PersistentMindMaintainerControls />);
    fireEvent.click(await screen.findByLabelText('Enable maintainer role on this instance'));
    fireEvent.click(screen.getByRole('button', { name: 'Save maintainer settings' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Save unavailable');
    expect(screen.getByLabelText('Enable maintainer role on this instance').checked).toBe(true);
    expect(screen.getByText(/Saved role: Disabled/)).toBeTruthy();
    expect(screen.queryByText('Maintainer settings saved.')).toBeNull();
  });
});
