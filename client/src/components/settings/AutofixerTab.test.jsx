import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AutofixerTab } from './AutofixerTab';
import { getSettings, updateSettings } from '../../services/apiSystem.js';
vi.mock('../../services/apiSystem.js', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));
vi.mock('../FeatureProviderPicker', () => ({ default: () => null }));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn() } }));
import toast from '../ui/Toast';
afterEach(() => { cleanup(); vi.resetAllMocks(); });
describe('Autofixer promotion settings', () => {
  it('loads saved settings and saves the edited promotion options', async () => {
    getSettings.mockResolvedValue({ autofixer: { autoPromote: true, verifyCommand: 'npm test' } });
    updateSettings.mockResolvedValue({ autofixer: { autoPromote: false, verifyCommand: '' } });
    render(<AutofixerTab />);
    await waitFor(() => expect(screen.getByLabelText('Apply fixes automatically')).toBeChecked());
    expect(screen.getByLabelText('Verify command')).toHaveValue('npm test');
    fireEvent.click(screen.getByLabelText('Apply fixes automatically'));
    fireEvent.change(screen.getByLabelText('Verify command'), { target: { value: '' } });
    fireEvent.click(screen.getByText('Save promotion settings'));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ autofixer: { autoPromote: false, verifyCommand: '' } }, { silent: true }));
    expect(toast.success).toHaveBeenCalledWith('Autofixer promotion settings saved');
  });
  it('keeps controls disabled when settings cannot load', async () => {
    getSettings.mockRejectedValue(new Error('unavailable'));
    render(<AutofixerTab />);
    await screen.findByRole('alert');
    expect(screen.getByText('Save promotion settings')).toBeDisabled();
    getSettings.mockResolvedValue({ autofixer: { autoPromote: false } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('Save promotion settings')).toBeDisabled());
    expect(getSettings).toHaveBeenCalledTimes(2);
    expect(updateSettings).not.toHaveBeenCalled();
  });
  it('shows loading feedback and only enables save after an edit', async () => {
    let resolveSettings;
    getSettings.mockReturnValue(new Promise(resolve => { resolveSettings = resolve; }));
    render(<AutofixerTab />);
    expect(screen.getByText('Loading Autofixer settings')).toBeInTheDocument();
    resolveSettings({ autofixer: {} });
    await waitFor(() => expect(screen.getByText('Save promotion settings')).toBeDisabled());
    fireEvent.change(screen.getByLabelText('Verify command'), { target: { value: 'npm test' } });
    expect(screen.getByText('Save promotion settings')).toBeEnabled();
  });
});
