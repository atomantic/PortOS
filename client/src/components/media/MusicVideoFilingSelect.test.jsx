import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import MusicVideoFilingSelect from './MusicVideoFilingSelect';

vi.mock('../../services/apiMusicVideo.js', () => ({
  listMusicVideoProjectSummaries: vi.fn(async () => ({ items: [{ id: 'mv-a', name: 'Example Video' }, { id: 'mv-b', name: 'Second Video' }] })),
}));

function Search() {
  return <output data-testid="search">{useLocation().search}</output>;
}

// Uniquely catches the picker showing one video while the form files the render under another (the URL is what is sent).
describe('MusicVideoFilingSelect', () => {
  it('shows the video handed over in the URL and keeps the URL in step with a new pick', async () => {
    render(
      <MemoryRouter initialEntries={['/video/generate?musicVideo=mv-a']}>
        <MusicVideoFilingSelect />
        <Search />
      </MemoryRouter>,
    );
    const select = await screen.findByLabelText(/Music video/);
    await screen.findByRole('option', { name: 'Second Video' });
    expect(select.value).toBe('mv-a');
    fireEvent.change(select, { target: { value: 'mv-b' } });
    expect(screen.getByTestId('search').textContent).toBe('?musicVideo=mv-b');
    fireEvent.change(select, { target: { value: '' } });
    expect(screen.getByTestId('search').textContent).toBe('');
  });
});
