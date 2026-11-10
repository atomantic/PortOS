import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    // The playing picture carries the template's own still move, vignette and grain.
    // The move is written by an effect, which can land after the figure is found.
    await waitFor(() => expect(screen.getByTestId('animatic-still').style.transform).toMatch(/^translate\(.+\) scale\(1\.\d+\)$/));
    expect(screen.getByTestId('document-template-finish')).toBeTruthy();
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

// The live native picture must not keep the texture layers after the director turns them off.
it('updates the native template finish and camera when video or shot controls change', async () => {
  playback.mockResolvedValue({ native: true });
  const props = { ...project, templateEffects: { grain: 0, vignette: 0, stillMotion: 0 } };
  const draw = p => <MemoryRouter><PreviewDock project={p} sources={listPreviewSources(p, { leadWith: 'storyboard' })} audioUrl="/song.mp3" /></MemoryRouter>;
  const { rerender } = render(draw(props));
  await screen.findByLabelText('Composition preview');
  await waitFor(() => expect(screen.getByTestId('animatic-still').style.transform).toBe('translate(0%, 0%) scale(1)'));
  const finish = screen.getByTestId('document-template-finish');
  expect(finish.children[0].style.background).toContain('rgba(0,0,0,0)');
  expect(finish.children[1].style.opacity).toBe('0');
  rerender(draw({ ...props, scenes: props.scenes.map(scene => ({ ...scene, templateEffects: { grain: 0.2, vignette: 0.7 } })) }));
  await waitFor(() => expect(finish.children[1].style.opacity).toBe('0.2'));
  expect(finish.children[0].style.background).toContain('0.7');
});

// Uniquely catches a beat control changing export while the playing preview omits its pulse/glitch.
it('uses the document renderer for active beat reaction, including shot overrides, and native playback when disabled', async () => {
  playback.mockResolvedValue({ native: true });
  const active = { ...project, audioAnalysis: { beats: [0], features: { envelopes: { fps: 1, rms: [0.5] } } } };
  const draw = p => <MemoryRouter><PreviewDock project={p} sources={listPreviewSources(p, { leadWith: 'storyboard' })} audioUrl="/song.mp3" /></MemoryRouter>;
  const { rerender } = render(draw(active));
  await waitFor(() => expect(opens()).toHaveLength(1));
  expect(screen.queryByLabelText('Song for the composition preview')).toBeNull();
  const disabled = { ...active, templateEffects: { beatReaction: 0 } };
  rerender(draw(disabled));
  expect(await screen.findByLabelText('Song for the composition preview')).toBeTruthy();
  rerender(draw({ ...disabled, scenes: disabled.scenes.map(scene => ({ ...scene, templateEffects: { beatReaction: 0.2 } })) }));
  await waitFor(() => expect(screen.queryByLabelText('Song for the composition preview')).toBeNull());
  expect(opens()).toHaveLength(2);
});
