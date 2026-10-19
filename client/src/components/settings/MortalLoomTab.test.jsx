import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getMortalLoomStatus: vi.fn(),
  importMortalLoom: vi.fn(),
}));
vi.mock('../../services/api', () => api);
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import MortalLoomTab from './MortalLoomTab.jsx';

beforeEach(() => Object.values(api).forEach((fn) => fn.mockReset()));

describe('MortalLoomTab', () => {
  it('blocks Save and Import after a failed settings read, then shows stored values on Retry', async () => {
    api.getSettings.mockRejectedValueOnce(new Error('offline'));
    api.getMortalLoomStatus.mockResolvedValue({ exists: true, defaultPath: '/default' });

    render(<MortalLoomTab />);

    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(screen.getByRole('button', { name: /Save/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Import from MortalLoom/ })).toBeDisabled();
    expect(api.updateSettings).not.toHaveBeenCalled();

    api.getSettings.mockResolvedValue({ mortalloom: { enabled: true, path: '/custom/ml.json' } });
    fireEvent.click(retry);

    await waitFor(() => expect(screen.getByLabelText('iCloud file path')).toHaveValue('/custom/ml.json'));
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.getByRole('button', { name: /Save/ })).toBeEnabled();
  });
});
