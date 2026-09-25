import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

vi.mock('../services/apiWritersRoom', async (importOriginal) => ({
  ...await importOriginal(),
  listWritersRoomFolders: vi.fn(async () => []),
  listWritersRoomWorks: vi.fn(async () => ({ items: [], total: 0, nextCursor: null })),
  getWritersRoomWork: vi.fn(),
  createWritersRoomWork: vi.fn(async () => ({ id: 'work-new' })),
}));

import WritersRoom from './WritersRoom';
import { listWritersRoomWorks } from '../services/apiWritersRoom';

describe('WritersRoom empty state', () => {
  it('opens the existing New work form from the unselected work pane', async () => {
    render(
      <MemoryRouter initialEntries={['/writers-room']}>
        <Routes>
          <Route path="/writers-room" element={<WritersRoom />} />
          <Route path="/writers-room/works/:workId" element={<div>New work opened</div>} />
        </Routes>
      </MemoryRouter>,
    );

    const main = screen.getByRole('main');
    expect(within(main).getByText('Create a work or pick one from the library to start writing.')).toBeInTheDocument();
    expect(within(main).queryByText(/Write for 10/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
    expect(screen.getByRole('textbox', { name: 'Folder name' })).toBeInTheDocument();
    fireEvent.click(within(main).getByRole('button', { name: 'New work' }));

    expect(await screen.findByRole('textbox', { name: 'Work title' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Work title' })).toHaveFocus();
    expect(screen.queryByRole('textbox', { name: 'Folder name' })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Work kind' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Work title' }), { target: { value: 'A new draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('New work opened')).toBeInTheDocument();
  });
});


it('loads 50 works, appends on demand, and restarts an expired snapshot', async () => {
  listWritersRoomWorks.mockResolvedValueOnce({ items: [{ id: 'a', title: 'First work' }], total: 2, nextCursor: 'page-two' })
    .mockResolvedValueOnce({ items: [{ id: 'b', title: 'Second work' }], total: 3, nextCursor: 'page-three' })
    .mockRejectedValueOnce(Object.assign(new Error('Library page expired. Restart the library to continue.'), { code: 'CURSOR_EXPIRED' }))
    .mockResolvedValueOnce({ items: [{ id: 'c', title: 'Fresh work' }], total: 1, nextCursor: null });
  render(<MemoryRouter><WritersRoom /></MemoryRouter>);
  expect(await screen.findByText('First work')).toBeInTheDocument();
  expect(screen.queryByText('Second work')).toBeNull();
  expect(listWritersRoomWorks).toHaveBeenLastCalledWith({ limit: 50, cursor: null }, expect.objectContaining({ silent: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Load more works' }));
  expect(await screen.findByText('Second work')).toBeInTheDocument();
  expect(screen.getByText('First work')).toBeInTheDocument();
  expect(listWritersRoomWorks).toHaveBeenLastCalledWith({ limit: 50, cursor: 'page-two' }, expect.anything());
  fireEvent.click(screen.getByRole('button', { name: 'Load more works' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Retry loading' }));
  expect(await screen.findByText('Fresh work')).toBeInTheDocument();
  expect(screen.queryByText('First work')).toBeNull();
  expect(listWritersRoomWorks).toHaveBeenLastCalledWith({ limit: 50, cursor: null }, expect.anything());
});
