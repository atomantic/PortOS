import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const playback = vi.hoisted(() => vi.fn());
const socket = vi.hoisted(() => {
  const handlers = new Map();
  return {
    emit: vi.fn(),
    on: vi.fn((event, cb) => { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(cb); }),
    off: vi.fn((event, cb) => { handlers.get(event)?.delete(cb); }),
    connected: true,
    send(event, payload) { for (const fn of handlers.get(event) || []) fn(payload); },
    handlers,
  };
});
vi.mock('../../services/socket', () => ({ default: socket }));
vi.mock('../../services/apiMusicVideo.js', async (original) => ({ ...(await original()), getMusicVideoCompositionPlayback: playback }));

import PreviewDock from './PreviewDock.jsx';
import { listPreviewSources } from '../../lib/musicVideoStages.js';

const project = {
  id: 'mv-1', name: 'Example', trackId: 't1',
  composition: { mode: 'document', document: { directory: 'music-video/mv-1/composition/doc-a', entry: 'index.html' } },
  scenes: [{ sceneId: 's1', startSec: 0, endSec: 4, referenceImageId: 'frame.png', videoHistoryId: null }],
};
const opens = () => socket.emit.mock.calls.filter(([event]) => event === 'generated-preview:open');
const dock = () => render(<MemoryRouter><PreviewDock project={project} sources={listPreviewSources(project, { leadWith: 'storyboard' })} audioUrl="/song.mp3" /></MemoryRouter>);

beforeEach(() => {
  // happy-dom loads no blob images, so frames skip the off-screen decode.
  vi.stubGlobal('Image', undefined);
  playback.mockReset();
  socket.emit.mockReset();
  socket.handlers.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe('PreviewDock composition document', () => {
  // Uniquely catches a stock-template video starting the isolated renderer just to play, or a paused frame that is not the document's own.
  it('plays the shipped template in the page and asks the worker only for the paused frame', async () => {
    playback.mockResolvedValue({ native: true });
    dock();
    expect(await screen.findByLabelText('Composition preview')).toBeTruthy();
    expect(playback).toHaveBeenCalledWith('mv-1', { silent: true });
    const audio = screen.getByLabelText('Song for the composition preview');
    expect(opens()).toHaveLength(0);
    expect(screen.queryByTestId('exact-document-frame')).toBeNull();
    await act(async () => fireEvent.play(audio));
    expect(opens()).toHaveLength(0);
    await act(async () => fireEvent.pause(audio));
    expect(opens()).toHaveLength(1);
    const { requestId } = opens()[0][1];
    const session = { requestId, sessionId: '00000000-0000-4000-8000-000000000001' };
    await act(async () => {
      socket.send('generated-preview:opened', { ...session, durationSec: 4, fps: 24, width: 1920, height: 1080 });
      socket.send('generated-preview:frame', { ...session, generation: 0, data: btoa('opening') });
    });
    // The opening frame predates the seek for the paused time, so it stays hidden.
    expect(screen.getByTestId('exact-document-frame')).toHaveAttribute('data-shown', 'false');
    expect(socket.emit).toHaveBeenCalledWith('generated-preview:seek', expect.objectContaining({ t: 0, playing: false }));
    await act(async () => socket.send('generated-preview:frame', { ...session, generation: 1, data: btoa('exact') }));
    expect(screen.getByTestId('exact-document-frame')).toHaveAttribute('data-shown', 'true');
    await act(async () => fireEvent.play(audio));
    expect(screen.getByTestId('exact-document-frame')).toHaveAttribute('data-shown', 'false');
  });

  // Uniquely catches authored or customized document code reaching the page when the server does not vouch for it.
  it.each([['a customized document', () => Promise.resolve({ native: false, reason: 'custom-helper' })], ['an unanswered check', () => Promise.reject(new Error('offline'))]])(
    'keeps %s in the isolated worker', async (_name, answer) => {
      playback.mockImplementation(answer);
      dock();
      await act(async () => {});
      expect(opens()).toHaveLength(1);
      expect(screen.queryByLabelText('Song for the composition preview')).toBeNull();
    });
});
