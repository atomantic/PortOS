import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../services/apiSprites.js', () => ({ importSprites: vi.fn() }));
const getApps = vi.fn();
vi.mock('../../services/apiApps.js', () => ({ getApps: (...a) => getApps(...a) }));

import ImportPanel from './ImportPanel';

const openPanel = async () => {
  render(<ImportPanel onImported={() => {}} />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Import/ })); });
};

beforeEach(() => vi.clearAllMocks());

describe('ImportPanel source apps', () => {
  it('shows a load error with Retry when the app list cannot be read, then recovers', async () => {
    getApps.mockRejectedValueOnce(new Error('Server unavailable'));
    await openPanel();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load managed apps — Server unavailable');

    getApps.mockResolvedValueOnce([
      { id: 'game', name: 'Example Game', repoPath: '/repos/example-game' },
      { id: 'archived', name: 'Old Game', repoPath: '/repos/old', archived: true },
    ]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('option', { name: /Example Game/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Old Game/ })).toBeNull();
  });
});
