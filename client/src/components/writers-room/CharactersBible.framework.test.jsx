import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../services/apiWritersRoom', () => ({
  listWritersRoomCharacters: vi.fn(),
  createWritersRoomCharacter: vi.fn(),
  updateWritersRoomCharacter: vi.fn(),
  deleteWritersRoomCharacter: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import CharactersBible from './CharactersBible';
import {
  listWritersRoomCharacters,
  updateWritersRoomCharacter,
} from '../../services/apiWritersRoom';

// Obviously-fake fixture — never a record from a live instance.
const CHARACTER = {
  id: 'wr-char-1',
  name: 'Wren Calloway',
  aliases: [],
  role: 'protagonist',
  physicalDescription: 'Short, silver hair, sharp eyes.',
  personality: '',
  background: '',
  notes: '',
  motivations: '',
  ghost: 'Left behind at the relay station at nine.',
  wound: '',
  lie: '',
  need: '',
  want: '',
  arcType: null,
  secrets: [],
  source: 'user',
};

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); });

describe('CharactersBible — narrative framework editing (#6417)', () => {
  it('edits the belief and the internal need, then shows them after a reload', async () => {
    const LIE = 'I only matter while I am useful.';
    const NEED = 'Being wanted is not the same as being needed.';
    const saved = { ...CHARACTER, lie: LIE, need: NEED };
    listWritersRoomCharacters.mockResolvedValue([CHARACTER]);
    updateWritersRoomCharacter.mockResolvedValue(saved);

    const { unmount } = render(<CharactersBible workId="wr-work-1" />);
    await screen.findByText('Wren Calloway');

    await userEvent.click(screen.getByRole('button', { name: 'Edit Wren Calloway' }));
    await userEvent.type(screen.getByLabelText(/^Lie/), LIE);
    await userEvent.type(screen.getByLabelText(/^Need/), NEED);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateWritersRoomCharacter).toHaveBeenCalled());
    const [workId, characterId, payload] = updateWritersRoomCharacter.mock.calls[0];
    expect(workId).toBe('wr-work-1');
    expect(characterId).toBe('wr-char-1');
    expect(payload).toMatchObject({ lie: LIE, need: NEED });
    // Untouched framework fields ride along as their empty value so the server
    // sees an explicit state, and the authored Ghost is preserved verbatim.
    expect(payload.ghost).toBe(CHARACTER.ghost);
    expect(payload.arcType).toBeNull();
    expect(payload.secrets).toEqual([]);

    // Reload: a fresh mount refetches and renders what the server persisted.
    unmount();
    listWritersRoomCharacters.mockResolvedValue([saved]);
    render(<CharactersBible workId="wr-work-1" />);

    await screen.findByText(NEED);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Wren Calloway' }));
    expect(screen.getByLabelText(/^Lie/)).toHaveValue(LIE);
    expect(screen.getByLabelText(/^Need/)).toHaveValue(NEED);
  });

  it('sends an arc type and one secret per line, and clears them back to empty', async () => {
    listWritersRoomCharacters.mockResolvedValue([CHARACTER]);
    updateWritersRoomCharacter.mockImplementation(async (_w, _id, patch) => ({ ...CHARACTER, ...patch }));

    render(<CharactersBible workId="wr-work-1" />);
    await screen.findByText('Wren Calloway');

    await userEvent.click(screen.getByRole('button', { name: 'Edit Wren Calloway' }));
    await userEvent.selectOptions(screen.getByLabelText('Arc type'), 'positive');
    await userEvent.type(screen.getByLabelText(/^Secrets/), 'Sold the license\nCannot read the old charts');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateWritersRoomCharacter).toHaveBeenCalledTimes(1));
    expect(updateWritersRoomCharacter.mock.calls[0][2]).toMatchObject({
      arcType: 'positive',
      secrets: ['Sold the license', 'Cannot read the old charts'],
    });

    await userEvent.click(screen.getByRole('button', { name: 'Edit Wren Calloway' }));
    await userEvent.selectOptions(screen.getByLabelText('Arc type'), '');
    await userEvent.clear(screen.getByLabelText(/^Secrets/));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateWritersRoomCharacter).toHaveBeenCalledTimes(2));
    // A cleared select/list is `null` / `[]` — present and empty, which is how
    // the server tells a deliberate clear from an untouched field.
    expect(updateWritersRoomCharacter.mock.calls[1][2]).toMatchObject({ arcType: null, secrets: [] });
  });
});
