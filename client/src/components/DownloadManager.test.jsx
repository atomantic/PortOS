import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import DownloadManager from './DownloadManager.jsx';
import MediaCard from './media/MediaCard.jsx';
import RenderStatusPanel from './musicVideo/RenderStatusPanel.jsx';

const share = vi.fn();
beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(query => ({ matches: query === '(pointer: coarse)', addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal('navigator', { share, canShare: () => true });
  share.mockReset().mockResolvedValue();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['video'], { type: 'application/octet-stream' }) }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each(['touch browser', 'Home Screen app'])('prepares both video downloads in a %s, then shares only from a fresh Save tap', async (mode) => {
  if (mode === 'Home Screen app') window.matchMedia.mockImplementation(query => ({ matches: query === '(display-mode: standalone)' }));
  let finish;
  fetch.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  render(<>
    <DownloadManager />
    <MediaCard item={{ kind: 'video', key: 'video:clip', id: 'clip', downloadUrl: '/data/videos/clip.mp4', prompt: 'Example clip' }} showCollectionMenu={false} showMoodBoardMenu={false} />
    <RenderStatusPanel renderHistoryId="draft" finalVideo={{ src: '/data/videos/draft.mp4' }} />
  </>);
  fireEvent.click(screen.getByRole('link', { name: 'Download' }));
  expect(screen.getByRole('status')).toHaveTextContent('Loading the file onto this device');
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  await act(async () => finish({ ok: true, blob: async () => new Blob(['video'], { type: 'application/octet-stream' }) }));
  expect(share).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(share).toHaveBeenCalledWith({ files: [expect.objectContaining({ name: 'clip.mp4', type: 'video/mp4' })] });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole('link', { name: 'Download MP4' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(share.mock.calls[1][0].files[0].name).toBe('draft.mp4');
  expect(fetch.mock.calls.map(([url]) => new URL(url).search)).toEqual(['?download=1', '?download=1']);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

function renderLink() {
  return render(<><DownloadManager /><a href="/data/videos/example.mp4" download>Download example</a></>);
}

it('keeps the prepared file after share cancellation or refusal so Save can be retried', async () => {
  share.mockRejectedValueOnce(Object.assign(new Error('Canceled'), { name: 'AbortError' }))
    .mockRejectedValueOnce(new Error('Sharing blocked'));
  renderLink();
  fireEvent.click(screen.getByRole('link', { name: 'Download example' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Sharing blocked');
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each(['HTTP error', 'unsupported file'])('shows a visible %s and provides a native fallback that bypasses interception', async (failure) => {
  if (failure === 'HTTP error') fetch.mockResolvedValue({ ok: false, status: 404 });
  else navigator.canShare = () => false;
  renderLink();
  fireEvent.click(screen.getByRole('link', { name: 'Download example' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Download failed');
  const fallback = screen.getByRole('link', { name: 'Browser download' });
  expect(fallback).toHaveAttribute('href', '/data/videos/example.mp4?download=1');
  expect(fallback).toHaveAttribute('target', '_blank');
  // Observe the capture handler's decision, then suppress actual happy-dom
  // navigation so this contract test never makes a real network request.
  fallback.addEventListener('click', event => {
    expect(event.defaultPrevented).toBe(false);
    event.preventDefault();
  }, { once: true });
  fireEvent.click(fallback);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('aborts a closed download and ignores its late response', async () => {
  let finish;
  fetch.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  renderLink();
  fireEvent.click(screen.getByRole('link', { name: 'Download example' }));
  const { signal } = fetch.mock.calls[0][1];
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(signal.aborted).toBe(true);
  await act(async () => finish({ ok: true, blob: async () => new Blob(['late']) }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(share).not.toHaveBeenCalled();
});

function streamedResponse(chunks, headers = {}) {
  const pending = [];
  const read = vi.fn(() => new Promise((resolve) => { pending.push(resolve); }));
  const cancel = vi.fn().mockResolvedValue();
  const step = () => {
    const resolve = pending.shift();
    const chunk = chunks.shift();
    resolve(chunk ? { done: false, value: chunk } : { done: true, value: undefined });
  };
  return { response: { ok: true, headers: new Headers(headers), body: { getReader: () => ({ read, cancel }), cancel } }, step, cancel };
}

it('shows how much of the file has loaded while it is prepared', async () => {
  const stream = streamedResponse([new Uint8Array(300), new Uint8Array(700)], { 'content-length': '1000', 'content-type': 'video/mp4' });
  fetch.mockResolvedValueOnce(stream.response);
  renderLink();
  fireEvent.click(screen.getByRole('link', { name: 'Download example' }));
  await waitFor(() => expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0'));
  await act(async () => stream.step());
  await waitFor(() => expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '30'));
  expect(screen.getByRole('status')).toHaveTextContent('(30%)');
  expect(screen.getByText('300 B of 1000 B')).toBeInTheDocument();
  await act(async () => stream.step());
  await act(async () => stream.step());
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(share.mock.calls[0][0].files[0]).toMatchObject({ name: 'example.mp4', type: 'video/mp4', size: 1000 });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

it.each(['Content-Length', 'streamed size'])('sends a file too big for phone memory to the browser download (%s)', async (measure) => {
  const big = 101 * 1024 * 1024;
  const stream = measure === 'Content-Length'
    ? streamedResponse([], { 'content-length': String(big) })
    : streamedResponse([{ byteLength: big }]);
  fetch.mockResolvedValueOnce(stream.response);
  renderLink();
  fireEvent.click(screen.getByRole('link', { name: 'Download example' }));
  if (measure !== 'Content-Length') await waitFor(() => expect(screen.getByRole('progressbar')).toBeInTheDocument()).then(() => act(async () => stream.step()));
  expect(await screen.findByRole('status')).toHaveTextContent(measure === 'Content-Length' ? 'This file is 101 MB, too big for the phone' : 'This file is over 100 MB, too big for the phone');
  expect(stream.cancel).toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Browser download' })).toHaveAttribute('href', '/data/videos/example.mp4?download=1');
});
