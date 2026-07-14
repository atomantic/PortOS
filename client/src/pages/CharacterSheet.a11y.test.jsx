import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Accessibility-focused coverage for the Character Sheet name-edit control
// (issue #2391): the view-mode trigger must be a labeled, keyboard-operable
// button, and the edit input must support Enter (commit) and Escape (cancel)
// without accidental form submission.

const get = vi.fn();
const put = vi.fn();

vi.mock('../services/api', () => ({
  default: { get: (...a) => get(...a), post: vi.fn(), put: (...a) => put(...a) },
  generateAvatar: vi.fn(() => Promise.resolve({})),
}));

vi.mock('../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));

vi.mock('../components/ui/Toast', () => ({
  default: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import CharacterSheet from './CharacterSheet';

const CHAR = {
  name: 'Aragorn',
  class: 'Ranger',
  level: 5,
  hp: 40,
  maxHp: 40,
  xp: 6500,
  avatarPath: null,
  events: [],
};

const renderSheet = () => render(
  <MemoryRouter>
    <CharacterSheet />
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue({ ...CHAR });
  put.mockImplementation((_path, body) => Promise.resolve({ ...CHAR, ...body }));
});

const findNameTrigger = () =>
  screen.findByRole('button', { name: /edit character name/i });

describe('CharacterSheet name editing accessibility', () => {
  it('exposes the name as a labeled, keyboard-focusable button', async () => {
    renderSheet();
    const trigger = await findNameTrigger();
    // A real <button> is focusable and keyboard-operable by default.
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger).toHaveAttribute('type', 'button');
    expect(trigger).toHaveTextContent('Aragorn');
  });

  it('reveals a labeled input when the trigger is activated', async () => {
    renderSheet();
    const trigger = await findNameTrigger();
    fireEvent.click(trigger);
    const input = screen.getByLabelText('Character name');
    expect(input).toHaveValue('Aragorn');
  });

  it('commits the edit on Enter without accidental form submission', async () => {
    renderSheet();
    fireEvent.click(await findNameTrigger());
    const input = screen.getByLabelText('Character name');
    fireEvent.change(input, { target: { value: 'Strider' } });

    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(put).toHaveBeenCalledWith('/character', { name: 'Strider' }, { silent: true }));
    // Back to the button view with the new name.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /edit character name/i }))
        .toHaveTextContent('Strider'),
    );
  });

  it('blocks reopening the editor while a prior name-save PUT is in flight (#2409)', async () => {
    // Hold the first save open so we can attempt a stale reopen mid-flight.
    let resolvePut;
    put.mockImplementationOnce((_path, body) =>
      new Promise((resolve) => { resolvePut = () => resolve({ ...CHAR, ...body }); }),
    );

    renderSheet();
    fireEvent.click(await findNameTrigger());
    const input = screen.getByLabelText('Character name');
    fireEvent.change(input, { target: { value: 'Strider' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // First PUT is now pending; the trigger is back but disabled, so a click
    // (which would seed a stale 'Aragorn' input) is a no-op.
    const trigger = await screen.findByRole('button', { name: /edit character name/i });
    expect(trigger).toBeDisabled();
    fireEvent.click(trigger);
    expect(screen.queryByLabelText('Character name')).toBeNull();

    // Resolve the save: exactly one PUT fired (no stale revert), editor reopenable.
    resolvePut();
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /edit character name/i })).not.toBeDisabled(),
    );
  });

  it('cancels the edit on Escape and restores the original name', async () => {
    renderSheet();
    fireEvent.click(await findNameTrigger());
    const input = screen.getByLabelText('Character name');
    fireEvent.change(input, { target: { value: 'Throwaway' } });

    // Escape resolves the edit without saving and restores the original name.
    fireEvent.keyDown(input, { key: 'Escape' });

    // No save fired, and the original name is shown again.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /edit character name/i }))
        .toHaveTextContent('Aragorn'),
    );
    expect(put).not.toHaveBeenCalled();
  });
});
