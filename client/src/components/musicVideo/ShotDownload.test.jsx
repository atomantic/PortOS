import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ShotDownload from './ShotDownload.jsx';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('prepares a download, permits a repeat, and releases object URLs', async () => {
  const create = vi.fn().mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second');
  const revoke = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['video']) })));
  vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke });
  const { unmount } = render(<ShotDownload projectId="p" sceneId="s" startSec={2} endSec={3} />);
  fireEvent.click(screen.getByRole('button', { name: 'Prepare clip with music' }));
  expect((await screen.findByRole('link', { name: 'Download clip' })).getAttribute('href')).toBe('blob:first');
  fireEvent.click(screen.getByRole('button', { name: 'Prepare again' }));
  await waitFor(() => expect(screen.getByRole('link', { name: 'Download clip' }).getAttribute('href')).toBe('blob:second'));
  expect(revoke).toHaveBeenCalledWith('blob:first');
  unmount();
  expect(revoke).toHaveBeenCalledWith('blob:second');
});

it('cancels an in-flight request and surfaces server errors on retry', async () => {
  let signal;
  vi.stubGlobal('fetch', vi.fn((_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  }).mockResolvedValueOnce({ ok: false, status: 422, json: async () => ({ error: 'No song audio' }) }));
  render(<ShotDownload projectId="p" sceneId="s" />);
  fireEvent.click(screen.getByRole('button', { name: 'Prepare clip with music' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('No song audio');
  fireEvent.click(screen.getByRole('button', { name: 'Prepare clip with music' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(signal.aborted).toBe(true);
  expect(screen.getByRole('button', { name: 'Prepare clip with music' })).toBeTruthy();
});
