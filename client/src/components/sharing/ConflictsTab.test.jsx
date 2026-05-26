import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../services/api', () => ({
  listConflicts: vi.fn(),
  resolveConflict: vi.fn(),
  deleteConflict: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../ui/InlineDiff', () => ({ default: ({ oldText, newText }) => <div data-testid="diff">{oldText}|{newText}</div> }));

import * as api from '../../services/api';
import ConflictsTab from './ConflictsTab';

const entry = {
  id: 'entry-1',
  recordKind: 'universe',
  recordId: 'u-123456789012',
  detectedAt: '2026-05-25T10:00:00Z',
  source: { via: 'push', peerId: 'peer-abc' },
  diffSummary: [
    { field: 'starterPrompt', localValue: 'my local', remoteValue: 'their remote', changed: 'both' },
    { field: 'logline', localValue: 'mine', remoteValue: 'theirs', changed: 'both' },
  ],
  status: 'pending',
};

beforeEach(() => {
  vi.clearAllMocks();
  api.listConflicts.mockResolvedValue({ conflicts: [entry] });
});

describe('ConflictsTab', () => {
  it('lists pending conflicts', async () => {
    render(<ConflictsTab />);
    await waitFor(() => expect(screen.getByText(/2 field\(s\)/)).toBeInTheDocument());
    expect(screen.getByText(/via push/)).toBeInTheDocument();
  });

  it('restore-all resolves the whole entry', async () => {
    api.resolveConflict.mockResolvedValue({ status: 'resolved' });
    const user = userEvent.setup();
    render(<ConflictsTab />);
    await waitFor(() => expect(screen.getByText(/2 field\(s\)/)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Restore mine/ }));
    await waitFor(() => expect(api.resolveConflict).toHaveBeenCalledWith('entry-1', { action: 'restore-all' }, expect.anything()));
  });

  it('merge-fields sends only the selected fields', async () => {
    api.resolveConflict.mockResolvedValue({ status: 'resolved' });
    const user = userEvent.setup();
    render(<ConflictsTab />);
    await waitFor(() => expect(screen.getByText(/2 field\(s\)/)).toBeInTheDocument());

    // Expand the entry, select one field, merge.
    await user.click(screen.getByText(/u-123456789012/));
    const checkboxes = await screen.findAllByRole('checkbox');
    await user.click(checkboxes[0]); // starterPrompt
    await user.click(screen.getByRole('button', { name: /Merge 1 selected field/ }));
    await waitFor(() => expect(api.resolveConflict).toHaveBeenCalledWith('entry-1', { action: 'merge-fields', fields: ['starterPrompt'] }, expect.anything()));
  });

  it('discard keeps the synced version', async () => {
    api.resolveConflict.mockResolvedValue({ status: 'resolved' });
    const user = userEvent.setup();
    render(<ConflictsTab />);
    await waitFor(() => expect(screen.getByText(/2 field\(s\)/)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Discard/ }));
    await waitFor(() => expect(api.resolveConflict).toHaveBeenCalledWith('entry-1', { action: 'discard' }, expect.anything()));
  });
});
