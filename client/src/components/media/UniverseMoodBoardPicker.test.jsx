import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const listUniverseNames = vi.fn();
const listUniverseStyles = vi.fn();
const listMoodBoardNames = vi.fn();
vi.mock('../../services/api', () => ({
  listUniverseNames: (...a) => listUniverseNames(...a),
  listUniverseStyles: (...a) => listUniverseStyles(...a),
  listMoodBoardNames: (...a) => listMoodBoardNames(...a),
}));

import UniverseMoodBoardPicker, { useStyleSourceLists, BOARD_FOLLOW_UNIVERSE } from './UniverseMoodBoardPicker';

function Harness() {
  const lists = useStyleSourceLists();
  return (
    <MemoryRouter>
      <UniverseMoodBoardPicker
        lists={lists}
        universeId=""
        moodBoardChoice={BOARD_FOLLOW_UNIVERSE}
        onUniverseChange={() => {}}
        onBoardChoiceChange={() => {}}
        idPrefix="t"
        labelClass=""
        inputClass=""
      />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  listUniverseNames.mockResolvedValue([{ id: 'u1', name: 'Example Universe' }]);
  listUniverseStyles.mockResolvedValue([]);
  listMoodBoardNames.mockResolvedValue([]);
});

describe('UniverseMoodBoardPicker', () => {
  it('shows "No mood boards yet" only for a list that loaded empty', async () => {
    render(<Harness />);
    await act(async () => {});
    expect(screen.getByText(/No mood boards yet/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a load error with Retry — not "No mood boards yet" — when any list read fails', async () => {
    listMoodBoardNames.mockRejectedValueOnce(new Error('Server unavailable'));
    render(<Harness />);
    await act(async () => {});
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load universes and mood boards — Server unavailable');
    expect(screen.queryByText(/No mood boards yet/)).toBeNull();

    listMoodBoardNames.mockResolvedValueOnce([{ id: 'b1', name: 'Example Board' }]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('option', { name: 'Example Board' })).toBeInTheDocument();
  });
});
