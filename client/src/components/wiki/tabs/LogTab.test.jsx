import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/api', () => ({ getNote: vi.fn() }));

import * as api from '../../../services/api';
import LogTab from './LogTab.jsx';

const LOG_NOTES = [{ path: 'wiki/log.md' }];
const logNote = (title) => ({ body: `## [2026-01-01] ingest | ${title}\n` });

describe('LogTab', () => {
  it('keeps the current vault log when the previous vault answers late', async () => {
    let resolveA;
    api.getNote.mockImplementation((vaultId) => (vaultId === 'vault-a'
      ? new Promise((resolve) => { resolveA = resolve; })
      : Promise.resolve(logNote('Vault B entry'))));

    const { rerender } = render(<LogTab vaultId="vault-a" allNotes={LOG_NOTES} />);
    rerender(<LogTab vaultId="vault-b" allNotes={LOG_NOTES} />);
    expect(await screen.findByText('Vault B entry')).toBeInTheDocument();

    await act(async () => { resolveA(logNote('Vault A entry')); });
    expect(screen.getByText('Vault B entry')).toBeInTheDocument();
    expect(screen.queryByText('Vault A entry')).toBeNull();
  });
});
