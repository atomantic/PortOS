import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

vi.mock('../services/apiWritersRoom', async (importOriginal) => ({
  ...await importOriginal(),
  listWritersRoomFolders: vi.fn(async () => []),
  listWritersRoomWorks: vi.fn(async () => []),
  getWritersRoomWork: vi.fn(),
  createWritersRoomWork: vi.fn(async () => ({ id: 'work-new' })),
}));

import WritersRoom from './WritersRoom';

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

    fireEvent.click(within(main).getByRole('button', { name: 'New work' }));

    expect(await screen.findByRole('textbox', { name: 'Work title' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Work kind' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Work title' }), { target: { value: 'A new draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('New work opened')).toBeInTheDocument();
  });
});
