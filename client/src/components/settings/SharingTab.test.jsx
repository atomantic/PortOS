import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../services/api', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }),
}));

import { getSettings, updateSettings } from '../../services/api';
import { SharingTab } from './SharingTab';

const strictToggle = () => screen.getByLabelText(/Enforce per-peer sharing settings/i);

beforeEach(() => {
  vi.clearAllMocks();
  getSettings.mockResolvedValue({ sharingDisplayName: '', sharingBio: '' });
  updateSettings.mockResolvedValue({});
});

describe('SharingTab — federation pull authorization (#3659)', () => {
  it('defaults the strict-pull toggle off when the setting is absent', async () => {
    render(<SharingTab />);
    await waitFor(() => expect(strictToggle()).toBeInTheDocument());
    expect(strictToggle().checked).toBe(false);
  });

  it('reflects the persisted setting', async () => {
    getSettings.mockResolvedValue({ federation: { strictPullAuthorization: true } });
    render(<SharingTab />);
    await waitFor(() => expect(strictToggle().checked).toBe(true));
  });

  it('carries the rest of the federation slice forward on save (shallow top-level merge)', async () => {
    getSettings.mockResolvedValue({ federation: { strictPullAuthorization: false, somethingElse: 'keep-me' } });
    render(<SharingTab />);
    await waitFor(() => expect(strictToggle()).toBeInTheDocument());
    fireEvent.click(strictToggle());
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      federation: { strictPullAuthorization: true, somethingElse: 'keep-me' },
    }));
    await waitFor(() => expect(strictToggle().checked).toBe(true));
  });

  it('leaves the toggle unchanged when the save fails', async () => {
    updateSettings.mockRejectedValue(new Error('nope'));
    render(<SharingTab />);
    await waitFor(() => expect(strictToggle()).toBeInTheDocument());
    fireEvent.click(strictToggle());
    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    await waitFor(() => expect(strictToggle().checked).toBe(false));
  });
});
