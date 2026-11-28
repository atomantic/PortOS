import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import CreditsOutroPanel from './CreditsOutroPanel.jsx';

vi.mock('../../services/apiMusicVideo.js', () => ({
  getMusicVideoCreditsPrefill: vi.fn(),
}));

import { getMusicVideoCreditsPrefill } from '../../services/apiMusicVideo.js';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

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
  const savesBeforeColor = save.mock.calls.length;
  const textColor = screen.getByLabelText('Main text color');
  fireEvent.change(textColor, { target: { value: '#112233' } });
  fireEvent.change(textColor, { target: { value: '#ffaacc' } });
  expect(save).toHaveBeenCalledTimes(savesBeforeColor);
  fireEvent.blur(textColor);
  expect(save).toHaveBeenCalledTimes(savesBeforeColor + 1);
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

it('keeps a stale backgroundImageId visible and clearable when no shot stills match', () => {
  const save = vi.fn();
  const editLocal = vi.fn();
  render(
    <CreditsOutroPanel
      project={{ id: 'mv-bg', scenes: [], creditsOutro: { enabled: true, title: 'Song', backgroundImageId: 'removed-still.png' } }}
      onEditLocal={editLocal}
      onSave={save}
    />,
  );
  const bgSelect = screen.getByLabelText('Background still');
  expect(bgSelect.value).toBe('removed-still.png');
  fireEvent.change(bgSelect, { target: { value: '' } });
  expect(save).toHaveBeenLastCalledWith({ creditsOutro: expect.not.objectContaining({ backgroundImageId: expect.anything() }) });
});

it('drops a stale credits prefill response even if the user switches away and returns to the original project', async () => {
  let resolvePrefill;
  getMusicVideoCreditsPrefill.mockImplementation(() => new Promise((resolve) => { resolvePrefill = resolve; }));
  const save = vi.fn();
  const editLocal = vi.fn();
  const { rerender } = render(
    <CreditsOutroPanel project={{ id: 'mv-a', creditsOutro: null }} onEditLocal={editLocal} onSave={save} />,
  );
  fireEvent.click(screen.getByLabelText(/Off/i));
  expect(getMusicVideoCreditsPrefill).toHaveBeenCalledWith('mv-a');

  rerender(
    <CreditsOutroPanel project={{ id: 'mv-b', creditsOutro: null }} onEditLocal={editLocal} onSave={save} />,
  );
  rerender(
    <CreditsOutroPanel project={{ id: 'mv-a', creditsOutro: null }} onEditLocal={editLocal} onSave={save} />,
  );
  resolvePrefill({ credits: { title: 'Project A Song', artist: 'Project A Artist' } });
  await waitFor(() => expect(screen.getByLabelText(/Off/i).disabled).toBe(false));
  expect(save).not.toHaveBeenCalled();
  expect(editLocal).not.toHaveBeenCalled();
});

it('flushes a pending color edit to the original project save handler on project switch or unmount', () => {
  const saveA = vi.fn();
  const saveB = vi.fn();
  const editLocal = vi.fn();
  const { rerender, unmount } = render(
    <CreditsOutroPanel
      project={{ id: 'mv-a', creditsOutro: { enabled: true, title: 'Song A' } }}
      onEditLocal={editLocal}
      onSave={saveA}
    />,
  );
  fireEvent.change(screen.getByLabelText('Main text color'), { target: { value: '#123456' } });
  expect(saveA).not.toHaveBeenCalled();

  rerender(
    <CreditsOutroPanel
      project={{ id: 'mv-b', creditsOutro: { enabled: true, title: 'Song B' } }}
      onEditLocal={editLocal}
      onSave={saveB}
    />,
  );
  expect(saveA).toHaveBeenCalledTimes(1);
  expect(saveA).toHaveBeenCalledWith({ creditsOutro: expect.objectContaining({ textColor: '#123456' }) });
  expect(saveB).not.toHaveBeenCalled();

  fireEvent.change(screen.getByLabelText('Main text color'), { target: { value: '#abcdef' } });
  unmount();
  expect(saveB).toHaveBeenCalledTimes(1);
  expect(saveB).toHaveBeenCalledWith({ creditsOutro: expect.objectContaining({ textColor: '#abcdef' }) });
});
