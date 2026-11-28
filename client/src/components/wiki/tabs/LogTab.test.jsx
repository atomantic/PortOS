import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/apiNotes.js', () => ({
  getNote: vi.fn(),
}));

import { getNote } from '../../../services/apiNotes.js';
import LogTab from './LogTab.jsx';

const LOG_NOTES = [{ path: 'wiki/log.md' }];
const logNote = (title) => ({ body: `## [2026-01-01] ingest | ${title}\n` });

describe('LogTab', () => {
  it('keeps the current vault log when the previous vault answers late', async () => {
    let resolveA;
    getNote.mockImplementation((vaultId) => (vaultId === 'vault-a'
      ? new Promise((resolve) => { resolveA = resolve; })
      : Promise.resolve(logNote('Vault B entry'))));

    const { rerender } = render(<LogTab vaultId="vault-a" allNotes={LOG_NOTES} />);
    rerender(<LogTab vaultId="vault-b" allNotes={LOG_NOTES} />);
    expect(await screen.findByText('Vault B entry')).toBeInTheDocument();

    await act(async () => { resolveA(logNote('Vault A entry')); });
    expect(screen.getByText('Vault B entry')).toBeInTheDocument();
    expect(screen.queryByText('Vault A entry')).toBeNull();
  });

  it('offers Retry when an existing log cannot be read instead of claiming there is none', async () => {
    getNote.mockReset().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(logNote('Recovered entry'));
    render(<LogTab vaultId="vault-a" allNotes={LOG_NOTES} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the activity log');
    expect(screen.queryByText('No activity log found')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Recovered entry')).toBeInTheDocument();
  });

  it('uses an h2 heading and bordered 44px Refresh button', async () => {
    getNote.mockReset().mockResolvedValue(logNote('Entry one'));
    render(<LogTab vaultId="vault-a" allNotes={LOG_NOTES} />);
    expect(await screen.findByRole('heading', { level: 2, name: 'Activity Log' })).toBeInTheDocument();
    const refresh = screen.getByRole('button', { name: 'Refresh' });
    expect(refresh).toHaveAttribute('type', 'button');
    expect(refresh.className).toContain('min-h-[44px]');
    expect(refresh.className).toContain('border-port-border');
  });
});
