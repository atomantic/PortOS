import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const listUniverses = vi.fn();
const getUniverse = vi.fn();
vi.mock('../../services/api', () => ({
  listUniverses: (...a) => listUniverses(...a),
  getUniverse: (...a) => getUniverse(...a),
}));

import UniverseCharacterPicker from './UniverseCharacterPicker';

const renderPicker = async () => {
  render(<UniverseCharacterPicker universeId="u1" entryKind="characters" entryId="" onUniverseChange={vi.fn()} onEntryChange={vi.fn()} />);
  await act(async () => {});
};

beforeEach(() => {
  vi.clearAllMocks();
  listUniverses.mockResolvedValue([{ id: 'u1', name: 'Example Universe' }]);
});

describe('UniverseCharacterPicker', () => {
  it('shows a Retry — not "No characters in this universe" — when the universe read fails, and lists them on retry', async () => {
    getUniverse.mockRejectedValueOnce(new Error('Server unavailable'));
    await renderPicker();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load the universe — Server unavailable');
    expect(screen.queryByText('No characters in this universe')).toBeNull();

    getUniverse.mockResolvedValueOnce({ characters: [{ id: 'c1', name: 'Alice' }] });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('option', { name: 'Alice' })).toBeInTheDocument();
  });

  it('shows a Retry — not an empty universe picker — when the universe list read fails', async () => {
    listUniverses.mockRejectedValueOnce(new Error('Server unavailable'));
    getUniverse.mockResolvedValue({ characters: [] });
    await renderPicker();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load universes — Server unavailable');

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(screen.getByRole('option', { name: 'Example Universe' })).toBeInTheDocument();
  });

  it('says "No characters in this universe" only after a successful empty read', async () => {
    getUniverse.mockResolvedValue({ characters: [] });
    await renderPicker();
    expect(screen.getByText('No characters in this universe')).toBeInTheDocument();
  });
});
