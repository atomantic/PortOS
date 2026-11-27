import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import CreditsOutroPanel from './CreditsOutroPanel.jsx';

it('can hide the performer, customize the card and save an arbitrary multiline grid block', () => {
  const save = vi.fn();
  function Editor() {
    const [project, setProject] = useState({ id: 'movie', creditsOutro: {
      enabled: true, layout: 'grid', title: 'Example song', artist: 'Example artist', lines: [{ role: 'Starring', name: 'Name' }],
    } });
    return <CreditsOutroPanel project={project} onEditLocal={(patch) => setProject((previous) => ({ ...previous, ...patch }))} onSave={save} />;
  }
  render(<Editor />);
  fireEvent.click(screen.getByLabelText('Show “Performed by”'));
  expect(screen.queryByLabelText('Performed by')).toBeNull();
  fireEvent.click(screen.getByLabelText('Quote song title'));
  fireEvent.change(screen.getByLabelText('Title font'), { target: { value: 'condensed' } });
  fireEvent.change(screen.getByLabelText('Credits font'), { target: { value: 'mono' } });
  fireEvent.change(screen.getByLabelText('Main text color'), { target: { value: '#ffaacc' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add credit block' }));
  const heading = screen.getByLabelText('Block 2 heading');
  fireEvent.change(heading, { target: { value: 'A note' } });
  fireEvent.blur(heading);
  const body = screen.getByLabelText('Block 2 text');
  fireEvent.change(body, { target: { value: 'First line\nSecond line' } });
  fireEvent.blur(body);
  expect(save).toHaveBeenLastCalledWith({ creditsOutro: expect.objectContaining({
    artist: 'Example artist', showPerformer: false, quoteTitle: false, titleFont: 'condensed', bodyFont: 'mono', textColor: '#ffaacc',
    lines: [{ role: 'Starring', name: 'Name' }, { role: 'A note', name: 'First line\nSecond line' }],
  }) });
  fireEvent.click(screen.getByRole('button', { name: 'Remove credit block 1' }));
  expect(screen.getByLabelText('Block 1 text').value).toBe('First line\nSecond line');
  fireEvent.click(screen.getByLabelText('Show “Performed by”'));
  expect(screen.getByLabelText('Performed by').value).toBe('Example artist');
  fireEvent.change(screen.getByLabelText('Card style'), { target: { value: 'analog-16mm' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add social handle' }));
  const handle = screen.getByLabelText('Handle');
  fireEvent.change(handle, { target: { value: '@example_yt' } });
  fireEvent.blur(handle);
  expect(save).toHaveBeenLastCalledWith({ creditsOutro: expect.objectContaining({
    style: 'analog-16mm',
    socials: [{ platform: 'youtube', handle: '@example_yt' }],
  }) });
});
