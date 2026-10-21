import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../../services/api', () => ({
  listTimeCapsuleSnapshots: vi.fn(),
}));

import TimeCapsuleTab from './TimeCapsuleTab';
import * as api from '../../../services/api';

beforeEach(() => vi.clearAllMocks());

describe('TimeCapsuleTab failed reads stay distinct from an empty archive (#12783)', () => {
  it('shows a retryable error, not "No snapshots yet", when the list read fails', async () => {
    const user = userEvent.setup();
    api.listTimeCapsuleSnapshots
      .mockRejectedValueOnce(new Error('archive offline'))
      .mockResolvedValueOnce([{ id: 's1', label: 'Example Snapshot', createdAt: '2026-01-01T00:00:00.000Z', sizeBytes: 10, counts: {} }]);
    render(<TimeCapsuleTab />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load time capsule snapshots — archive offline');
    expect(screen.queryByText('No snapshots yet')).not.toBeInTheDocument();
    expect(screen.queryByText(/snapshots? archived/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('1 snapshot archived')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the empty copy for a genuinely empty archive', async () => {
    api.listTimeCapsuleSnapshots.mockResolvedValue([]);
    render(<TimeCapsuleTab />);

    expect(await screen.findByText('No snapshots yet')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
