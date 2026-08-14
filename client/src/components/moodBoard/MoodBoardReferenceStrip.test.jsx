import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import MoodBoardReferenceStrip from './MoodBoardReferenceStrip';
import * as api from '../../services/api';

vi.mock('../../services/api', () => ({
  listMoodBoards: vi.fn(),
  getMoodBoard: vi.fn(),
  createMoodBoard: vi.fn(),
}));

const BOARDS = [
  { id: 'mb-1', name: 'Board One', items: [] },
  { id: 'mb-2', name: 'Board Two', items: [] },
];

const expand = () => fireEvent.click(screen.getByRole('button', { name: /mood board reference/i }));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  api.listMoodBoards.mockResolvedValue(BOARDS);
  api.getMoodBoard.mockImplementation((id) => Promise.resolve(BOARDS.find((b) => b.id === id) || null));
});

describe('MoodBoardReferenceStrip — uncontrolled (localStorage) mode', () => {
  it('falls back to the first board when nothing is remembered', async () => {
    render(<MoodBoardReferenceStrip storageKey="test" />);
    expand();
    const select = await screen.findByLabelText('Board');
    expect(select.value).toBe('mb-1');
    // No "none" placeholder in uncontrolled mode.
    expect(screen.queryByRole('option', { name: /no board linked/i })).toBeNull();
  });

  it('persists an explicit pick to localStorage', async () => {
    render(<MoodBoardReferenceStrip storageKey="test" />);
    expand();
    const select = await screen.findByLabelText('Board');
    fireEvent.change(select, { target: { value: 'mb-2' } });
    expect(localStorage.getItem('portos.moodBoardRef.test')).toBe('mb-2');
    await act(async () => {}); // settle the board-detail fetch the pick kicked off
  });
});

describe('MoodBoardReferenceStrip — controlled (persisted link) mode', () => {
  it('shows the caller value and never falls back to the first board', async () => {
    render(<MoodBoardReferenceStrip storageKey="u" value="" onChange={() => {}} />);
    expand();
    const select = await screen.findByLabelText('Board');
    expect(select.value).toBe('');
    expect(screen.getByRole('option', { name: /no board linked/i })).toBeTruthy();
    expect(screen.getByText(/No board linked — pick one above/)).toBeTruthy();
  });

  it('reports picks through onChange and does not touch localStorage', async () => {
    const onChange = vi.fn();
    render(<MoodBoardReferenceStrip storageKey="u" value="" onChange={onChange} />);
    expand();
    const select = await screen.findByLabelText('Board');
    fireEvent.change(select, { target: { value: 'mb-2' } });
    expect(onChange).toHaveBeenCalledWith('mb-2');
    expect(localStorage.getItem('portos.moodBoardRef.u')).toBeNull();
  });

  it('treats a deleted/unknown linked board as unset instead of drifting to another board', async () => {
    render(<MoodBoardReferenceStrip storageKey="u" value="mb-gone" onChange={() => {}} />);
    expand();
    const select = await screen.findByLabelText('Board');
    expect(select.value).toBe('');
  });

  it('creates a board named for the record and links it via onChange', async () => {
    const onChange = vi.fn();
    api.createMoodBoard.mockResolvedValue({ id: 'mb-new', name: 'Example Universe', items: [] });
    render(
      <MoodBoardReferenceStrip storageKey="u" value="" onChange={onChange} newBoardName="Example Universe" />,
    );
    expand();
    await screen.findByLabelText('Board');
    fireEvent.click(screen.getByRole('button', { name: /^New$/ }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('mb-new'));
    expect(api.createMoodBoard).toHaveBeenCalledWith({ name: 'Example Universe' }, { silent: true });
  });

  it('offers create-and-link even when no boards exist yet', async () => {
    const onChange = vi.fn();
    api.listMoodBoards.mockResolvedValue([]);
    api.createMoodBoard.mockResolvedValue({ id: 'mb-first', name: 'Example Universe', items: [] });
    render(
      <MoodBoardReferenceStrip storageKey="u" value="" onChange={onChange} newBoardName="Example Universe" />,
    );
    expand();
    const btn = await screen.findByRole('button', { name: /New board/ });
    fireEvent.click(btn);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('mb-first'));
  });
});
