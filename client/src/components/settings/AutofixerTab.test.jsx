import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AutofixerTab } from './AutofixerTab';
import { getSettings, updateSettings } from '../../services/api';
vi.mock('../../services/api', () => ({ getSettings: vi.fn(), updateSettings: vi.fn() }));
vi.mock('../FeatureProviderPicker', () => ({ default: () => null }));
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
  });
  it('keeps controls disabled when settings cannot load', async () => {
    getSettings.mockRejectedValue(new Error('unavailable'));
    render(<AutofixerTab />);
    await screen.findByRole('alert');
    expect(screen.getByText('Save promotion settings')).toBeDisabled();
    expect(updateSettings).not.toHaveBeenCalled();
  });
});
