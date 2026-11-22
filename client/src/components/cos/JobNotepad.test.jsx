import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../services/apiAgents.js', () => ({
  getCosJobNotepad: vi.fn(),
  setCosJobNote: vi.fn(),
  deleteCosJobNote: vi.fn(),
  clearCosJobNotepad: vi.fn(),
}));
const api = await import('../../services/apiAgents.js');
const JobNotepad = (await import('./JobNotepad')).default;

const pad = (notes) => ({ notes, usedBytes: 12, maxBytes: 65536, remainingBytes: 65524 });
const open = async () => {
  const details = document.querySelector('details');
  // Setting `open` makes the DOM queue its own toggle event; flush it inside act too.
  await act(async () => {
    details.open = true;
    fireEvent(details, new Event('toggle'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getCosJobNotepad.mockResolvedValue(pad([{ key: 'cursor', value: '41', updatedAt: '2026-01-01T00:00:00.000Z' }]));
});
afterEach(cleanup);

describe('JobNotepad', () => {
  it('does not fetch until opened, then shows entries and usage', async () => {
    render(<JobNotepad jobId="job-1" />);
    expect(api.getCosJobNotepad).not.toHaveBeenCalled();
    await open();
    expect(await screen.findByText('cursor')).toBeTruthy();
    expect(screen.getByText('41')).toBeTruthy();
    expect(screen.getByText('12 / 65,536 bytes used')).toBeTruthy();
    expect(api.getCosJobNotepad).toHaveBeenCalledWith('job-1', { silent: true });
  });

  it('applies the mutation response locally without refetching', async () => {
    api.setCosJobNote.mockResolvedValue(pad([{ key: 'cursor', value: '42', updatedAt: '2026-01-02T00:00:00.000Z' }]));
    render(<JobNotepad jobId="job-1" />);
    await open();
    await screen.findByText('41');
    fireEvent.click(screen.getByRole('button', { name: 'Edit cursor' }));
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: '42' } });
    fireEvent.click(screen.getByRole('button', { name: /Save entry/ }));
    expect(await screen.findByText('42')).toBeTruthy();
    expect(api.setCosJobNote).toHaveBeenCalledWith('job-1', 'cursor', '42');
    expect(api.getCosJobNotepad).toHaveBeenCalledTimes(1);
  });

  it('blocks an invalid key and deletes an entry from the server response', async () => {
    api.deleteCosJobNote.mockResolvedValue(pad([]));
    render(<JobNotepad jobId="job-1" />);
    await open();
    await screen.findByText('41');
    fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'bad key' } });
    expect(screen.getByRole('button', { name: /Save entry/ }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Delete cursor' }));
    await waitFor(() => expect(screen.getByText(/No entries/)).toBeTruthy());
    expect(api.deleteCosJobNote).toHaveBeenCalledWith('job-1', 'cursor');
  });
});
