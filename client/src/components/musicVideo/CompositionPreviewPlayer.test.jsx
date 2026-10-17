import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getMusicVideoCompositionPreview: vi.fn(),
  getMusicVideoLyricPlaythroughPreview: vi.fn(),
  fetchMusicVideoPreviewAsset: vi.fn(),
}));
const socket = vi.hoisted(() => {
  const handlers = new Map();
  let sessions = 0;
  const reply = (event, payload) => {
    if (event !== 'generated-preview:open') return;
    sessions += 1;
    const opened = {
      requestId: payload.requestId,
      sessionId: `00000000-0000-4000-8000-${String(sessions).padStart(12, '0')}`,
      durationSec: 10,
      fps: 24,
      width: 1920,
      height: 1080,
      revision: payload.revision,
      audio: 'none',
    };
    for (const fn of handlers.get('generated-preview:opened') || []) fn(opened);
    for (const fn of handlers.get('generated-preview:frame') || []) {
      fn({ ...opened, generation: 0, mime: 'image/jpeg', data: btoa('frame') });
    }
  };
  return {
    emit: vi.fn(reply),
    reply,
    on: vi.fn((event, cb) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(cb);
    }),
    off: vi.fn((event, cb) => { handlers.get(event)?.delete(cb); }),
    connected: true,
    __handlers: handlers,
  };
});
vi.mock('../../services/apiMusicVideo.js', () => api);
vi.mock('../../services/socket', () => ({ default: socket }));
const uploadGalleryImage = vi.hoisted(() => vi.fn(async () => ({ filename: 'upload-1234abcd.png' })));
vi.mock('../../services/apiSystem.js', () => ({ uploadGalleryImage }));

import CompositionPreviewPlayer, { playthroughVersion } from './CompositionPreviewPlayer.jsx';

const DOCUMENT = { directory: 'music-video/mv-1/composition/doc-a', entry: 'index.html' };
const project = {
  id: 'mv-1', name: 'Example', updatedAt: '2026-01-01T00:00:00.000Z', composition: { mode: 'document', document: DOCUMENT },
  lyricCues: [{ id: 'l1', text: 'first line', startSec: 1, endSec: 3 }, { id: 'l2', text: 'second line', startSec: 3, endSec: 6 }],
};

// happy-dom does not load blob images. Drive the actual element's load/decode
// boundary explicitly, rather than treating a src assignment as presentation.
const loadImage = async (image, decoding = Promise.resolve()) => {
  Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 1920 });
  image.decode = vi.fn(() => decoding);
  await act(async () => fireEvent.load(image));
};

const opens = () => socket.emit.mock.calls.filter(([event]) => event === 'generated-preview:open');

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  socket.emit.mockReset();
  socket.emit.mockImplementation(socket.reply);
  socket.__handlers.clear();
  socket.connected = true;
});

describe('playthroughVersion', () => {
  // Uniquely catches the lyric overlay keeping a stale layout when the title card starts or stops showing.
  it('rebuilds the lyric page when the title card gains or loses its text', () => {
    const card = { enabled: true, title: '', artist: '', year: '', extra: '', position: 'lower-left', startSec: 2, endSec: 8, outro: false };
    const blank = playthroughVersion({ titleCard: card });
    expect(playthroughVersion({ titleCard: { ...card, title: 'Example Song' } })).not.toBe(blank);
    expect(playthroughVersion({ titleCard: null })).toBe(blank);
  });
});

describe('CompositionPreviewPlayer', () => {
  it('resumes an expired preview only on request and restores its controls and playhead', async () => {
    const look = { version: 1, preset: 'custom', grain: 0.4 };
    const { rerender } = render(<CompositionPreviewPlayer project={{ ...project, filmLook: look }} audioUrl='/song.mp3' />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Scrub the composition preview'), { target: { value: '2' } });
    const oldOpen = opens()[0][1];
    const oldSessionId = socket.emit.mock.calls.find(([event]) => event === 'generated-preview:seek')[1].sessionId;
    act(() => {
      for (const fn of socket.__handlers.get('generated-preview:closed') || []) fn({ sessionId: oldSessionId, reason: 'idle' });
    });
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled();
    expect(opens()).toHaveLength(1);
    const nextLook = { ...look, grain: 0.9 };
    rerender(<CompositionPreviewPlayer project={{ ...project, filmLook: nextLook }} audioUrl='/song.mp3' />);
    fireEvent.click(screen.getByRole('button', { name: 'Resume preview' }));
    expect(opens()).toHaveLength(2);
    const nextOpen = opens()[1][1];
    expect(nextOpen.requestId).not.toBe(oldOpen.requestId);
    expect(nextOpen.look).toEqual(nextLook);
    expect(socket.emit).toHaveBeenLastCalledWith('generated-preview:seek', expect.objectContaining({ requestId: nextOpen.requestId, t: 2 }));
    const nextSessionId = socket.emit.mock.calls.at(-1)[1].sessionId;
    act(() => {
      for (const fn of socket.__handlers.get('generated-preview:closed') || []) fn({ sessionId: oldSessionId, reason: 'idle' });
    });
    expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled();
    act(() => {
      for (const fn of socket.__handlers.get('generated-preview:closed') || []) fn({ sessionId: nextSessionId, reason: 'replaced' });
    });
    expect(opens()).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Resume preview' })).toBeEnabled();
    act(() => {
      socket.connected = false;
      for (const fn of socket.__handlers.get('disconnect') || []) fn();
      socket.connected = true;
      for (const fn of socket.__handlers.get('connect') || []) fn();
    });
    expect(opens()).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Resume preview' })).toBeEnabled();
  });

  it('waits for a connection before opening and never reopens after unmount', async () => {
    socket.connected = false;
    const { unmount } = render(<CompositionPreviewPlayer project={project} audioUrl='/song.mp3' />);
    expect(opens()).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled();
    act(() => {
      socket.connected = true;
      for (const fn of socket.__handlers.get('connect') || []) fn();
      for (const fn of socket.__handlers.get('connect') || []) fn();
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled());
    expect(opens()).toHaveLength(1);
    act(() => {
      socket.connected = false;
      for (const fn of socket.__handlers.get('disconnect') || []) fn();
    });
    const sent = socket.emit.mock.calls.length;
    unmount();
    act(() => {
      socket.connected = true;
      for (const fn of socket.__handlers.get('connect') || []) fn();
    });
    expect(socket.emit.mock.calls).toHaveLength(sent);
  });

  it.each([false, true])('reopens a disconnected preview after a session error (frame recovered: %s) with current controls', async (frameRecovered) => {
    const look = { version: 1, preset: 'custom', grain: 0.4 };
    const { rerender } = render(<CompositionPreviewPlayer project={{ ...project, filmLook: look }} audioUrl='/song.mp3' />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Scrub the composition preview'), { target: { value: '2' } });
    const oldOpen = opens()[0][1];
    act(() => {
      for (const fn of socket.__handlers.get('generated-preview:error') || []) fn({ requestId: oldOpen.requestId, message: 'Synthetic seek failure' });
    });
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled();
    if (frameRecovered) {
      act(() => {
        for (const fn of socket.__handlers.get('generated-preview:frame') || []) {
          fn({ requestId: oldOpen.requestId, generation: 1, mime: 'image/jpeg', data: btoa('recovered frame') });
        }
      });
      expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled();
    }
    act(() => {
      socket.connected = false;
      for (const fn of socket.__handlers.get('disconnect') || []) fn();
    });
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled();
    expect(screen.getByLabelText('Scrub the composition preview')).toBeDisabled();
    const sent = socket.emit.mock.calls.length;
    const nextLook = { ...look, grain: 0.9 };
    rerender(<CompositionPreviewPlayer project={{ ...project, filmLook: nextLook }} audioUrl='/song.mp3' />);
    expect(socket.emit.mock.calls).toHaveLength(sent);
    socket.emit.mockImplementation(() => {});
    act(() => {
      socket.connected = true;
      for (const fn of socket.__handlers.get('connect') || []) fn();
      for (const fn of socket.__handlers.get('connect') || []) fn();
    });
    expect(opens()).toHaveLength(2);
    const nextOpen = opens()[1][1];
    expect(nextOpen.requestId).not.toBe(oldOpen.requestId);
    expect(nextOpen.look).toEqual(nextLook);
    act(() => socket.reply('generated-preview:open', oldOpen));
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled();
    act(() => socket.reply('generated-preview:open', nextOpen));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled());
    expect(socket.emit).toHaveBeenLastCalledWith('generated-preview:seek', expect.objectContaining({ requestId: nextOpen.requestId, t: 2 }));
    fireEvent.change(screen.getByLabelText('Scrub the composition preview'), { target: { value: '3' } });
    expect(socket.emit).toHaveBeenLastCalledWith('generated-preview:seek', expect.objectContaining({ requestId: nextOpen.requestId, t: 3 }));
  });

  it('preserves a one-frame step while pausing playback with audio present', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    try {
      const { container } = render(<CompositionPreviewPlayer project={project} audioUrl='/song.mp3' shotNav />);
      await waitFor(() => expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: 'Play' }));
      container.querySelector('audio').currentTime = 48.5 / 24;
      act(() => raf.mock.calls.at(-1)[0]());
      fireEvent.click(screen.getByRole('button', { name: 'Forward 1 frame' }));
      const next = 49.5 / 24;
      expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled();
      expect(container.querySelector('audio').currentTime).toBeCloseTo(next);
      expect(socket.emit).toHaveBeenLastCalledWith('generated-preview:seek', expect.objectContaining({ t: next, playing: false }));
    } finally { play.mockRestore(); pause.mockRestore(); raf.mockRestore(); cancel.mockRestore(); }
  });

  it('sends motion mode during playback and exact mode on pause and scrub without reopening', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    try {
      const { container } = render(<CompositionPreviewPlayer project={project} audioUrl='/song.mp3' />);
      await waitFor(() => expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: 'Play' }));
      const tick = raf.mock.calls.at(-1)[0];
      container.querySelector('audio').currentTime = 2;
      act(() => tick());
      expect(socket.emit).toHaveBeenLastCalledWith('generated-preview:seek', expect.objectContaining({ t: 2, playing: true }));
      fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
      await waitFor(() => expect(socket.emit).toHaveBeenLastCalledWith('generated-preview:seek', expect.objectContaining({ t: 2, playing: false })));
      fireEvent.change(screen.getByLabelText('Scrub the composition preview'), { target: { value: '3' } });
      expect(socket.emit).toHaveBeenLastCalledWith('generated-preview:seek', expect.objectContaining({ t: 3, playing: false }));
      expect(opens()).toHaveLength(1);
    } finally { play.mockRestore(); pause.mockRestore(); raf.mockRestore(); cancel.mockRestore(); }
  });

  it('opens an isolated preview and never fetches media or mounts generated HTML', async () => {
    render(<CompositionPreviewPlayer project={project} audioUrl={null} />);
    await screen.findByTitle('Composition document preview');
    await waitFor(() => expect(opens()).toHaveLength(1));
    expect(opens()[0][1]).toEqual(expect.objectContaining({
      kind: 'music-video', projectId: 'mv-1', revision: `${DOCUMENT.directory}|`,
    }));
    expect(api.getMusicVideoCompositionPreview).not.toHaveBeenCalled();
    expect(api.fetchMusicVideoPreviewAsset).not.toHaveBeenCalled();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it.each(['unavailable', 'error'])('reports a terminal opening %s without retrying on reconnect or mounting an iframe', async (terminalEvent) => {
    socket.emit.mockImplementation((event, payload) => {
      if (event !== 'generated-preview:open') return;
      for (const fn of socket.__handlers.get(`generated-preview:${terminalEvent}`) || []) {
        fn({ requestId: payload.requestId, code: 'PREVIEW_ISOLATION_UNAVAILABLE', message: 'Isolated preview is unavailable on this host.' });
      }
    });
    render(<CompositionPreviewPlayer project={project} audioUrl={null} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Isolated preview is unavailable on this host.');
    expect(screen.getByText('Preview unavailable')).toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeNull();
    act(() => {
      socket.connected = false;
      for (const fn of socket.__handlers.get('disconnect') || []) fn();
      socket.connected = true;
      for (const fn of socket.__handlers.get('connect') || []) fn();
    });
    expect(opens()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled();
    expect(screen.getByText('Preview unavailable')).toBeInTheDocument();
  });

  it('applies film look and title-card edits made while the isolated worker is opening', async () => {
    socket.emit.mockImplementation(() => {});
    const look = { version: 1, preset: 'custom', grain: 0.4 };
    const card = { enabled: true, title: 'Opening title', startSec: 2, endSec: 8 };
    const { rerender } = render(<CompositionPreviewPlayer project={{ ...project, filmLook: look, titleCard: card }} audioUrl={null} />);
    const open = opens()[0][1];
    const nextLook = { ...look, grain: 0.9 };
    const nextCard = { ...card, title: 'Edited title' };
    rerender(<CompositionPreviewPlayer project={{ ...project, filmLook: nextLook, titleCard: nextCard }} audioUrl={null} />);
    expect(socket.emit.mock.calls.filter(([event]) => event === 'generated-preview:command')).toHaveLength(0);

    act(() => socket.reply('generated-preview:open', open));
    await waitFor(() => expect(socket.emit).toHaveBeenCalledWith('generated-preview:command', expect.objectContaining({
      requestId: open.requestId, action: 'film-look', look: nextLook,
    })));
    expect(socket.emit).toHaveBeenCalledWith('generated-preview:command', expect.objectContaining({
      requestId: open.requestId, action: 'title-card', card: expect.objectContaining({ title: 'Edited title' }),
    }));
    expect(opens()).toHaveLength(1);
  });

  it('reconciles controls only for the new session after reopening and ignores the old reply', async () => {
    const look = { version: 1, preset: 'custom', grain: 0.4 };
    const { rerender } = render(<CompositionPreviewPlayer project={{ ...project, filmLook: look }} audioUrl={null} />);
    const oldOpen = opens()[0][1];
    socket.emit.mockImplementation(() => {});
    const nextProject = { ...project, filmLook: { ...look, grain: 0.6 }, composition: { ...project.composition,
      document: { ...DOCUMENT, updatedAt: '2026-02-02T00:00:00.000Z' } } };
    rerender(<CompositionPreviewPlayer project={nextProject} audioUrl={null} />);
    const nextOpen = opens()[1][1];
    const latestLook = { ...look, grain: 0.9 };
    rerender(<CompositionPreviewPlayer project={{ ...nextProject, filmLook: latestLook }} audioUrl={null} />);
    act(() => socket.reply('generated-preview:open', oldOpen));
    expect(socket.emit.mock.calls.filter(([event]) => event === 'generated-preview:command')).toHaveLength(0);
    act(() => socket.reply('generated-preview:open', nextOpen));
    await waitFor(() => expect(socket.emit).toHaveBeenCalledWith('generated-preview:command', expect.objectContaining({
      requestId: nextOpen.requestId, action: 'film-look', look: latestLook,
    })));
    expect(socket.emit.mock.calls.filter(([event]) => event === 'generated-preview:command')).toHaveLength(1);
  });

  it('sends the film look with the open and again when it changes, without reopening', async () => {
    const look = { version: 1, preset: 'custom', grain: 0.4 };
    const { rerender } = render(<CompositionPreviewPlayer project={{ ...project, filmLook: look }} audioUrl={null} />);
    await waitFor(() => expect(opens()[0][1].look).toEqual(look));
    expect(socket.emit.mock.calls.filter(([event]) => event === 'generated-preview:command')).toHaveLength(0);
    const next = { ...look, grain: 0.9 };
    rerender(<CompositionPreviewPlayer project={{ ...project, filmLook: next }} audioUrl={null} />);
    await waitFor(() => expect(socket.emit).toHaveBeenCalledWith('generated-preview:command', expect.objectContaining({ action: 'film-look', look: next })));
    rerender(<CompositionPreviewPlayer project={{ ...project, filmLook: null }} audioUrl={null} />);
    await waitFor(() => expect(socket.emit).toHaveBeenCalledWith('generated-preview:command', expect.objectContaining({ action: 'film-look', look: null })));
    expect(opens()).toHaveLength(1);
  });

  it('sends the normalized title card with the open and again on each edit, without reopening', async () => {
    const card = { enabled: true, title: 'Example Song', startSec: 2, endSec: 8 };
    const { rerender } = render(<CompositionPreviewPlayer project={{ ...project, titleCard: card }} audioUrl={null} />);
    await waitFor(() => expect(opens()[0][1].card).toEqual(expect.objectContaining({ title: 'Example Song', position: 'lower-left' })));
    rerender(<CompositionPreviewPlayer project={{ ...project, titleCard: { ...card, position: 'upper-right' } }} audioUrl={null} />);
    await waitFor(() => expect(socket.emit).toHaveBeenCalledWith('generated-preview:command', expect.objectContaining({
      action: 'title-card', card: expect.objectContaining({ position: 'upper-right' }),
    })));
    rerender(<CompositionPreviewPlayer project={{ ...project, titleCard: null }} audioUrl={null} />);
    await waitFor(() => expect(socket.emit).toHaveBeenCalledWith('generated-preview:command', expect.objectContaining({ action: 'title-card', card: null })));
    expect(opens()).toHaveLength(1);
  });

  it('keeps the loaded preview through an unrelated project save and reopens when the document version changes', async () => {
    const { rerender } = render(<CompositionPreviewPlayer project={project} audioUrl={null} />);
    await waitFor(() => expect(opens()).toHaveLength(1));
    rerender(<CompositionPreviewPlayer project={{ ...project, updatedAt: '2026-02-02T00:00:00.000Z', name: 'Renamed' }} audioUrl={null} />);
    await act(async () => {});
    expect(opens()).toHaveLength(1);
    const next = { ...project, composition: { mode: 'document', document: { ...DOCUMENT, directory: 'music-video/mv-1/composition/doc-b' } } };
    rerender(<CompositionPreviewPlayer project={next} audioUrl={null} />);
    await waitFor(() => expect(opens()).toHaveLength(2));
  });

  it('does not open the preview behind a collapsed phone mini-player until it is expanded', async () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn(() => ({ matches: false }));
    try {
      const { rerender } = render(<CompositionPreviewPlayer project={project} audioUrl={null} collapsed />);
      await act(async () => {});
      expect(opens()).toHaveLength(0);
      expect(screen.getByText('Expand to load preview')).toBeInTheDocument();
      expect(screen.getByLabelText('Scrub the composition preview')).toBeDisabled();
      expect(screen.queryByText('0.00s / 0.0s')).not.toBeInTheDocument();
      rerender(<CompositionPreviewPlayer project={project} audioUrl={null} collapsed={false} />);
      await waitFor(() => expect(opens()).toHaveLength(1));
      expect(screen.getByTitle('Composition document preview')).toBeInTheDocument();
    } finally {
      window.matchMedia = original;
    }
  });

  it('loads a deferred preview when resizing to desktop without expanding the mobile dock', async () => {
    const original = window.matchMedia;
    const desktop = Object.assign(new EventTarget(), { matches: false });
    window.matchMedia = vi.fn(() => desktop);
    try {
      render(<CompositionPreviewPlayer project={project} audioUrl="/data/music/song.mp3" collapsed />);
      await act(async () => {});
      expect(opens()).toHaveLength(0);
      await act(async () => {
        desktop.matches = true;
        desktop.dispatchEvent(new Event('change'));
      });
      await screen.findByTitle('Composition document preview');
      expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled();
      expect(opens()).toHaveLength(1);
      await act(async () => {
        desktop.matches = false;
        desktop.dispatchEvent(new Event('change'));
      });
      expect(screen.getByTitle('Composition document preview')).toBeInTheDocument();
      expect(opens()).toHaveLength(1);
    } finally {
      window.matchMedia = original;
    }
  });

  it('renders nothing without a document and never mounts an iframe when one exists', async () => {
    const { container, rerender } = render(<CompositionPreviewPlayer project={{ ...project, composition: { mode: 'document' } }} audioUrl={null} />);
    expect(container).toBeEmptyDOMElement();
    expect(opens()).toHaveLength(0);

    rerender(<CompositionPreviewPlayer project={project} audioUrl={null} />);
    await screen.findByTitle('Composition document preview');
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('seeks to each outside request once the preview knows its length, and follows the lyric line', async () => {
    const { rerender } = render(<CompositionPreviewPlayer project={project} audioUrl={null} seekRequest={{ t: 2, n: 1 }} />);
    await waitFor(() => expect(screen.getByText('2.00s / 10.0s')).toBeTruthy());
    expect(screen.getByTestId('preview-lyric')).toHaveTextContent('first line');
    const seekAt = socket.emit.mock.calls.findIndex(([event, payload]) => event === 'generated-preview:seek' && payload.t === 2);
    expect(seekAt).toBeGreaterThan(socket.emit.mock.calls.findIndex(([event]) => event === 'generated-preview:open'));

    rerender(<CompositionPreviewPlayer project={project} audioUrl={null} seekRequest={{ t: 4.5, n: 2 }} />);
    await waitFor(() => expect(screen.getByText('4.50s / 10.0s')).toBeTruthy());
    expect(screen.getByTestId('preview-lyric')).toHaveTextContent('second line');

    rerender(<CompositionPreviewPlayer project={project} audioUrl={null} seekRequest={{ t: 99, n: 3 }} />);
    await waitFor(() => expect(screen.getByText(/^9\.9\ds \/ 10\.0s$/)).toBeTruthy());
  });

  it('gives simultaneous active and candidate previews distinct scrubbers', async () => {
    const both = { ...project, composition: { ...project.composition,
      documentDraft: { ...DOCUMENT, directory: 'music-video/mv-1/composition/doc-candidate' } } };
    render(<><CompositionPreviewPlayer project={both} audioUrl={null} /><CompositionPreviewPlayer project={both} audioUrl={null} draft /></>);
    await screen.findByTitle('Composition candidate preview');
    expect(screen.getByLabelText('Scrub the composition preview').id).toBe('mv-doc-scrub');
    expect(screen.getByLabelText('Scrub the composition candidate').id).toBe('mv-doc-draft-scrub');
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('keeps DOM-selected URLs live through StrictMode effect replay and releases them after unmount', async () => {
    const create = vi.spyOn(URL, 'createObjectURL');
    const release = URL.revokeObjectURL;
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
      for (const image of document.querySelectorAll('img')) {
        expect(image.getAttribute('src')).not.toBe(url);
        expect(image.currentSrc).not.toBe(url);
      }
      release(url);
    });
    const { container, unmount } = render(<StrictMode><CompositionPreviewPlayer project={project} audioUrl='/song.mp3' /></StrictMode>);
    await loadImage(container.querySelector('img'));
    const visible = container.querySelector('img').src;
    expect(revoke).not.toHaveBeenCalledWith(visible);
    unmount();
    for (const { value: url } of create.mock.results) expect(revoke.mock.calls.filter(([value]) => value === url)).toHaveLength(1);
    create.mockRestore();
    revoke.mockRestore();
  });

  it('saves the docked preview frame on screen to the gallery', async () => {
    const blob = new Blob(['jpeg'], { type: 'image/jpeg' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ blob: async () => blob });
    const { container } = render(<CompositionPreviewPlayer project={{ ...project, scenes: [{ sceneId: 'a', startSec: 0 }] }} audioUrl="/song.mp3" shotNav />);
    await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBeTruthy());
    const frameSrc = container.querySelector('img').getAttribute('src');
    await loadImage(container.querySelector('img'));
    await act(async () => { screen.getByRole('button', { name: /Save frame/ }).click(); });
    expect(fetchSpy).toHaveBeenCalledWith(frameSrc);
    expect(uploadGalleryImage).toHaveBeenCalledWith(blob, { silent: true });
    fetchSpy.mockRestore();
  });
});


// Exercise the rendered player through the socket boundary. In particular,
// action sequence numbers and capture frame sequence numbers are independent.
describe('native composition playback', () => {
  const receive = (event, payload) => {
    for (const handler of socket.__handlers.get(`generated-preview:${event}`) || []) handler(payload);
  };
  const playbackMessages = (action) => socket.emit.mock.calls.filter(([event, payload]) => event === 'generated-preview:playback' && payload.action === action).map(([, payload]) => payload);
  let advanceWall;
  const installNative = ({ prepare = true, roundTrips = [0, 0, 0] } = {}) => {
    let now = 100;
    let probes = 0;
    let opened;
    advanceWall = (ms) => { now += ms; };
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    socket.emit.mockImplementation((event, payload) => {
      if (event === 'generated-preview:open') {
        opened = { requestId: payload.requestId, sessionId: '10000000-0000-4000-8000-000000000001', durationSec: 10, fps: 30, playback: { version: 1 } };
        receive('opened', opened);
        receive('frame', { ...opened, generation: 0, data: btoa('initial') });
      }
      if (event !== 'generated-preview:playback') return;
      if (payload.action === 'clock') {
        const rtt = roundTrips[probes++ % roundTrips.length];
        now += rtt;
        receive('playback-state', { ...payload, workerTime: payload.clientTime + rtt / 2 + 5000 });
      }
      if (payload.action === 'prepare' && prepare) receive('playback-state', { ...payload, status: 'ready' });
    });
    return { advance: advanceWall, session: () => opened };
  };
  const media = ({ holdClock = false } = {}) => {
    let audio = null;
    let paused = true;
    let startupFrames = 0;
    let frameId = 0;
    vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(() => paused);
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function () {
      audio = this;
      paused = false;
      startupFrames = holdClock ? 0 : 12;
      return Promise.resolve();
    });
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => { paused = true; startupFrames = 0; });
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      // Native tests model an advancing audio clock; legacy RAFs stay manual.
      if (startupFrames > 0 && playbackMessages('prepare').length > playbackMessages('play').length) {
        startupFrames -= 1;
        queueMicrotask(() => { if (!paused) { advanceWall(1000 / 60); audio.currentTime += 1 / 60; callback(); } });
      }
      return ++frameId;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    return { play, pause, raf };
  };
  const presenter = async ({ shotNav = false } = {}) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const native = installNative();
    const controls = media();
    const create = vi.spyOn(URL, 'createObjectURL');
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const view = render(<CompositionPreviewPlayer project={project} audioUrl='/song.mp3' shotNav={shotNav} />);
    const image = view.container.querySelector('img');
    await loadImage(image);
    const baseline = image.src;
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Play' })));
    expect(playbackMessages('play')).toHaveLength(1);
    const anchor = playbackMessages('play')[0];
    const callbacks = new Map();
    let nextId = 1000;
    controls.raf.mockImplementation((callback) => { callbacks.set(++nextId, callback); return nextId; });
    window.cancelAnimationFrame.mockImplementation((id) => callbacks.delete(id));
    const frame = (sequence, extra = {}) => {
      act(() => receive('frame', { ...native.session(), playbackEpoch: anchor.epoch, sequence, data: btoa(`frame-${sequence}`), ...extra }));
      return create.mock.results.at(-1).value;
    };
    const task = async () => { await act(async () => vi.advanceTimersByTime(0)); };
    const batch = () => {
      const snapshot = [...callbacks.values()];
      callbacks.clear();
      act(() => { for (const callback of snapshot) callback(performance.now()); });
    };
    const advance = async (ms) => { native.advance(ms); await act(async () => vi.advanceTimersByTime(ms)); };
    return { ...view, ...controls, native, image, baseline, frame, task, batch, advance, create, revoke, callbacks };
  };

  it('presents a burst FIFO and keeps its source for observers on both sides of the acknowledgement RAF', async () => {
    const p = await presenter();
    const first = p.frame(1);
    const second = p.frame(2);
    const third = p.frame(3);
    expect(p.image.src).toBe(p.baseline);
    await p.task();
    expect(p.image.src).toBe(first);
    const observed = [];
    requestAnimationFrame(() => observed.push(p.image.src));
    await loadImage(p.image);
    requestAnimationFrame(() => observed.push(p.image.src));
    p.batch();
    expect(observed).toEqual([first, first]);
    expect(p.image.src).toBe(first);
    expect(p.revoke).not.toHaveBeenCalledWith(first);
    await p.task();
    expect(p.image.src).toBe(second);
    await loadImage(p.image);
    expect(p.revoke).toHaveBeenCalledWith(first);
    p.batch();
    expect(p.image.src).toBe(second);
    await p.task();
    expect(p.image.src).toBe(third);
    await loadImage(p.image);
    p.batch();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(p.image.src).toBe(third);
  });

  it('routes an arrival between acknowledgement and promotion through the owned task', async () => {
    const p = await presenter();
    const first = p.frame(1);
    await p.task();
    await loadImage(p.image);
    requestAnimationFrame(() => {
      p.frame(2);
      expect(p.image.src).toBe(first);
    });
    p.batch();
    expect(p.image.src).toBe(first);
    await p.task();
    expect(p.image.src).not.toBe(first);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(p.image.src).toBe(first);
  });

  it('restores the decoded picture on pause, saves it, and rejects old decode/epoch work after a newer exact frame', async () => {
    const p = await presenter({ shotNav: true });
    const first = p.frame(1);
    await p.task();
    await loadImage(p.image);
    p.batch();
    const second = p.frame(2);
    await p.task();
    expect(p.image.src).toBe(second);
    let finishDecode;
    await loadImage(p.image, new Promise((resolve) => { finishDecode = resolve; }));
    const blob = new Blob(['displayed']);
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ blob: async () => blob });
    const uploadsBefore = uploadGalleryImage.mock.calls.length;
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Save frame/ })));
    expect(fetch).not.toHaveBeenCalled();
    expect(uploadGalleryImage).toHaveBeenCalledTimes(uploadsBefore);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(p.image.src).toBe(first);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Save frame/ })));
    expect(fetch).toHaveBeenCalledWith(first);
    expect(uploadGalleryImage).toHaveBeenCalledTimes(uploadsBefore + 1);
    expect(uploadGalleryImage).toHaveBeenLastCalledWith(blob, { silent: true });
    const exact = socket.emit.mock.calls.filter(([event]) => event === 'generated-preview:seek').at(-1)[1];
    const urls = p.create.mock.calls.length;
    p.frame(3);
    expect(p.create).toHaveBeenCalledTimes(urls);
    act(() => receive('frame', { ...p.native.session(), generation: exact.generation, data: btoa('exact') }));
    const latest = p.image.src;
    await loadImage(p.image);
    await act(async () => finishDecode());
    p.batch();
    await p.task();
    expect(p.image.src).toBe(latest);
    expect(p.revoke).toHaveBeenCalledWith(second);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Save frame/ })));
    expect(fetch).toHaveBeenLastCalledWith(latest);
  });

  it('flushes old-look frames at visual control dispatch before the server responds', async () => {
    const p = await presenter();
    const first = p.frame(1);
    await p.task();
    await loadImage(p.image);
    p.batch();
    const candidate = p.frame(2);
    await p.task();
    let finishDecode;
    await loadImage(p.image, new Promise((resolve) => { finishDecode = resolve; }));
    const queued = p.frame(3);
    p.rerender(<CompositionPreviewPlayer project={{ ...project, filmLook: { version: 1, preset: 'custom', grain: 0.4 } }} audioUrl='/song.mp3' />);
    expect(socket.emit).toHaveBeenLastCalledWith('generated-preview:command', expect.objectContaining({ action: 'film-look' }));
    expect(p.image.src).toBe(first);
    const count = p.create.mock.calls.length;
    p.frame(4);
    expect(p.create).toHaveBeenCalledTimes(count);
    await act(async () => finishDecode());
    await p.task();
    expect(p.image.src).toBe(first);
    expect(p.revoke).toHaveBeenCalledWith(candidate);
    expect(p.revoke).toHaveBeenCalledWith(queued);
    // The same wire epoch still admits the server's control-resync signal.
    const anchor = playbackMessages('play')[0];
    await act(async () => receive('playback-state', { ...p.native.session(), ...anchor, action: 'sync', status: 'resync-required', reason: 'controls' }));
    expect(playbackMessages('prepare')).toHaveLength(2);
  });

  it('fails visibly and pauses on queue overflow rather than discarding a source frame', async () => {
    const p = await presenter();
    p.frame(1);
    p.frame(2);
    p.frame(3);
    p.frame(4);
    expect(screen.getByRole('alert')).toHaveTextContent('presentation queue is full');
    expect(p.image.src).toBe(p.baseline);
    expect(p.pause).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled();
    expect(socket.emit).toHaveBeenCalledWith('generated-preview:close', expect.objectContaining({ sessionId: p.native.session().sessionId }));
    await p.task();
    expect(p.image.src).toBe(p.baseline);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('enforces the receipt-to-ack deadline even when decode finishes but RAF is held', async () => {
    const p = await presenter();
    const first = p.frame(1);
    await p.task();
    await loadImage(p.image);
    await p.advance(99);
    expect(screen.queryByRole('alert')).toBeNull();
    await p.advance(1);
    expect(screen.getByRole('alert')).toHaveTextContent('presentation fell behind');
    expect(p.image.src).toBe(first);
    expect(p.pause).toHaveBeenCalled();
    expect(p.callbacks.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rechecks the deadline at acknowledgement when an overdue timer has not fired', async () => {
    const p = await presenter();
    p.frame(1);
    await p.task();
    await loadImage(p.image);
    p.native.advance(100);
    p.batch();
    expect(screen.getByRole('alert')).toHaveTextContent('presentation fell behind');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rechecks queued frame age in the promotion task before replacing an acknowledged picture', async () => {
    const p = await presenter();
    const first = p.frame(1);
    await p.task();
    await loadImage(p.image);
    p.batch();
    p.frame(2);
    p.native.advance(100);
    await p.task();
    expect(screen.getByRole('alert')).toHaveTextContent('presentation fell behind');
    expect(p.image.src).toBe(first);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('disposes a held DOM decode and its queued successors on unmount without rearming work', async () => {
    const p = await presenter();
    p.frame(1);
    await p.task();
    let finishDecode;
    await loadImage(p.image, new Promise((resolve) => { finishDecode = resolve; }));
    p.frame(2);
    const all = p.create.mock.results.map(({ value }) => value);
    p.unmount();
    await act(async () => finishDecode());
    p.batch();
    await p.task();
    for (const url of all) expect(p.revoke.mock.calls.filter(([value]) => value === url)).toHaveLength(1);
    expect(p.callbacks.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves the visible picture across reopen and revokes each owned URL once on unmount', async () => {
    const p = await presenter();
    p.frame(1);
    await p.task();
    await loadImage(p.image);
    p.batch();
    const retained = p.image.src;
    p.frame(2);
    socket.emit.mockImplementation(() => {});
    p.rerender(<CompositionPreviewPlayer project={{ ...project, composition: { ...project.composition, document: { ...DOCUMENT, updatedAt: '2026-01-02' } } }} audioUrl='/song.mp3' />);
    expect(opens()).toHaveLength(2);
    expect(p.image.src).toBe(retained);
    expect(p.revoke).not.toHaveBeenCalledWith(retained);
    const replacement = { ...p.native.session(), requestId: opens()[1][1].requestId, sessionId: '10000000-0000-4000-8000-000000000002' };
    act(() => {
      receive('opened', replacement);
      receive('frame', { ...replacement, generation: 0, data: btoa('replacement baseline') });
    });
    expect(p.image.src).not.toBe(retained);
    expect(p.revoke).not.toHaveBeenCalledWith(retained);
    await loadImage(p.image);
    expect(p.revoke).toHaveBeenCalledWith(retained);
    const all = p.create.mock.results.map(({ value }) => value);
    p.unmount();
    expect(p.image.isConnected).toBe(false);
    for (const url of all) expect(p.revoke.mock.calls.filter(([value]) => value === url)).toHaveLength(1);
    expect(p.callbacks.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('waits for native preparation, anchors actual audio time, and sends bounded clock updates without frame seeks', async () => {
    const native = installNative({ prepare: false, roundTrips: [180, 20, 120] });
    const { play, raf } = media();
    const { container } = render(<CompositionPreviewPlayer project={project} audioUrl='/song.mp3' />);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await waitFor(() => expect(playbackMessages('prepare')).toHaveLength(1));
    expect(play).not.toHaveBeenCalled();
    expect(playbackMessages('clock')).toHaveLength(3);
    const prepared = playbackMessages('prepare')[0];
    expect(prepared.generation).toBe(0);
    const audio = container.querySelector('audio');
    audio.currentTime = 0.125;
    await act(async () => receive('playback-state', { ...prepared, status: 'ready' }));
    expect(play).toHaveBeenCalledOnce();
    const anchor = playbackMessages('play')[0];
    expect(anchor.t).toBeCloseTo(0.225, 8);
    expect(anchor.t).toBe(audio.currentTime);
    expect(anchor.workerTime).toBe(performance.now() + 5000);
    for (let i = 1; i <= 60; i += 1) {
      native.advance(1000 / 60);
      audio.currentTime = i / 60;
      act(() => raf.mock.calls.at(-1)[0]());
    }
    expect(playbackMessages('sync').length).toBeGreaterThanOrEqual(3);
    expect(playbackMessages('sync').length).toBeLessThanOrEqual(4);
    expect(socket.emit.mock.calls.filter(([event, payload]) => event === 'generated-preview:seek' && payload.playing)).toHaveLength(0);
    expect(screen.getByText('1.00s / 10.0s')).toBeInTheDocument();
    // Assert the client's exact wire projection here; authoritative schema
    // admission is exercised through the server's public socket tests.
    const identity = { requestId: opens()[0][1].requestId, sessionId: native.session().sessionId };
    for (const id of Object.values(identity)) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const syncs = playbackMessages('sync');
    const emitted = socket.emit.mock.calls.filter(([event]) => event === 'generated-preview:playback').map(([, payload]) => payload);
    expect(emitted).toStrictEqual([
      ...[100, 280, 300].map((clientTime, probeId) => ({ ...identity, action: 'clock', probeId, clientTime })),
      { ...identity, action: 'prepare', epoch: 1, sequence: 1, generation: 0, t: 0 },
      { ...identity, action: 'play', epoch: 1, sequence: 2, t: anchor.t, workerTime: anchor.workerTime },
      ...syncs.map((payload, index) => ({ ...identity, action: 'sync', epoch: 1, sequence: index + 3, t: payload.t, workerTime: payload.workerTime })),
    ]);
    let previousTime = anchor.workerTime;
    let previousPosition = anchor.t;
    for (const payload of emitted) {
      for (const field of ['clientTime', 't', 'workerTime']) {
        if (field in payload) expect(Number.isFinite(payload[field]), `${payload.action}.${field}`).toBe(true);
      }
      if ('t' in payload) {
        expect(payload.t).toBeGreaterThanOrEqual(0);
        expect(payload.t).toBeLessThanOrEqual(10);
      }
      if (payload.action === 'sync') {
        expect(payload.workerTime).toBeGreaterThan(previousTime);
        expect(payload.t).toBeGreaterThan(previousPosition);
        previousTime = payload.workerTime;
        previousPosition = payload.t;
      }
    }

    const frame = (extra) => receive('frame', { ...native.session(), playbackEpoch: anchor.epoch, sequence: 1, data: btoa('native'), ...extra });
    act(() => frame({}));
    const image = container.querySelector('img');
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    await loadImage(image);
    const accepted = image.src;
    act(() => frame({ data: btoa('duplicate') }));
    expect(image.src).toBe(accepted);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    const exact = socket.emit.mock.calls.filter(([event]) => event === 'generated-preview:seek').at(-1)[1];
    act(() => frame({ sequence: 2 }));
    expect(image.src).toBe(accepted);
    act(() => receive('frame', { ...native.session(), generation: exact.generation - 1, data: btoa('stale exact') }));
    expect(image.src).toBe(accepted);
    act(() => receive('frame', { ...native.session(), generation: exact.generation, data: btoa('paused exact') }));
    expect(image.src).not.toBe(accepted);
  });

  it('waits through a resolved play promise and 120ms audio hold before anchoring a stable clock window', async () => {
    const native = installNative();
    const { play, raf } = media({ holdClock: true });
    const { container } = render(<CompositionPreviewPlayer project={project} audioUrl='/song.mp3' />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Play' })));
    const audio = container.querySelector('audio');
    expect(play).toHaveBeenCalledOnce();
    expect(playbackMessages('prepare')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Pause' })).toBeEnabled();
    for (let i = 0; i < 6; i += 1) {
      native.advance(20);
      act(() => raf.mock.calls.at(-1)[0]());
    }
    expect(audio.currentTime).toBe(0);
    expect(playbackMessages('play')).toHaveLength(0);
    expect(playbackMessages('sync')).toHaveLength(0);
    audio.currentTime = 0.01;
    native.advance(10);
    act(() => raf.mock.calls.at(-1)[0]());
    expect(playbackMessages('play')).toHaveLength(0);
    audio.currentTime = 0.02;
    native.advance(10);
    act(() => raf.mock.calls.at(-1)[0]());
    expect(playbackMessages('play')).toHaveLength(0);
    for (let i = 3; i <= 10; i += 1) {
      audio.currentTime = i / 100;
      native.advance(10);
      act(() => raf.mock.calls.at(-1)[0]());
      if (i < 10) expect(playbackMessages('play')).toHaveLength(0);
    }
    const anchor = playbackMessages('play')[0];
    expect(anchor.t).toBe(0.1);
    expect(anchor.workerTime).toBe(performance.now() + 5000);
    audio.currentTime = 0.35;
    native.advance(250);
    act(() => raf.mock.calls.at(-1)[0]());
    const sync = playbackMessages('sync')[0];
    expect(sync.t - anchor.t).toBeCloseTo((sync.workerTime - anchor.workerTime) / 1000);
    expect(socket.emit.mock.calls.filter(([event, payload]) => event === 'generated-preview:seek' && payload.playing)).toHaveLength(0);
  });

  it('rejects early 21ms clock advances followed by a 78ms hold until the latest window runs steadily at 1x', async () => {
    const native = installNative();
    const { raf } = media({ holdClock: true });
    const { container } = render(<CompositionPreviewPlayer project={project} audioUrl='/song.mp3' />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Play' })));
    const audio = container.querySelector('audio');
    const observe = (wallMs, mediaTime) => {
      native.advance(wallMs);
      audio.currentTime = mediaTime;
      act(() => raf.mock.calls.at(-1)[0]());
    };
    observe(10.5, 0.0105);
    observe(10.5, 0.021);
    expect(playbackMessages('play')).toHaveLength(0);
    for (let i = 0; i < 3; i += 1) observe(26, 0.021);
    expect(playbackMessages('play')).toHaveLength(0);
    for (let i = 1; i <= 5; i += 1) {
      observe(20, 0.021 + i * 0.02);
      if (i < 5) expect(playbackMessages('play')).toHaveLength(0);
    }
    expect(playbackMessages('play')).toHaveLength(1);
    expect(playbackMessages('play')[0].t).toBeCloseTo(0.121);
    expect(playbackMessages('play')[0].workerTime).toBe(performance.now() + 5000);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('cancels the audio clock wait on scrub and unmount without allowing stale RAFs to start native playback', async () => {
    installNative();
    const { raf } = media({ holdClock: true });
    const { container, unmount } = render(<CompositionPreviewPlayer project={project} audioUrl='/song.mp3' />);
    vi.useFakeTimers();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Play' })));
    expect(vi.getTimerCount()).toBe(1);
    const stale = raf.mock.calls.at(-1)[0];
    fireEvent.change(screen.getByLabelText('Scrub the composition preview'), { target: { value: '2' } });
    expect(vi.getTimerCount()).toBe(0);
    container.querySelector('audio').currentTime = 3;
    act(() => stale());
    expect(playbackMessages('play')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Play' })));
    expect(vi.getTimerCount()).toBe(1);
    const unmounted = raf.mock.calls.at(-1)[0];
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    const sent = socket.emit.mock.calls.length;
    act(() => unmounted());
    expect(socket.emit.mock.calls).toHaveLength(sent);
  });

  it('pauses with a visible error when a resolved play promise never advances the audio clock', async () => {
    installNative();
    const { pause } = media({ holdClock: true });
    render(<CompositionPreviewPlayer project={project} audioUrl='/song.mp3' />);
    vi.useFakeTimers();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Play' })));
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(screen.getByRole('alert')).toHaveTextContent('audio clock did not start');
    expect(playbackMessages('play')).toHaveLength(0);
    expect(pause).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a never-settling play promise and ignores its resolution after the deadline', async () => {
    installNative();
    const { play, raf } = media({ holdClock: true });
    let resolvePlay;
    play.mockImplementation(() => new Promise((resolve) => { resolvePlay = resolve; }));
    render(<CompositionPreviewPlayer project={project} audioUrl='/song.mp3' />);
    vi.useFakeTimers();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Play' })));
    expect(play).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    expect(raf).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(screen.getByRole('alert')).toHaveTextContent('audio clock did not start');
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => resolvePlay());
    expect(playbackMessages('play')).toHaveLength(0);
    expect(raf).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled();
  });

  it('cancels cold preparation on scrub and ignores its late ready and captured frames', async () => {
    const native = installNative({ prepare: false });
    const { play } = media();
    const { container, unmount } = render(<CompositionPreviewPlayer project={project} audioUrl='/song.mp3' />);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await waitFor(() => expect(playbackMessages('prepare')).toHaveLength(1));
    const prepared = playbackMessages('prepare')[0];
    const initial = container.querySelector('img').src;
    fireEvent.change(screen.getByLabelText('Scrub the composition preview'), { target: { value: '3' } });
    await act(async () => {
      receive('playback-state', { ...prepared, status: 'ready' });
      receive('frame', { ...native.session(), playbackEpoch: prepared.epoch, sequence: 50, data: btoa('late') });
    });
    expect(play).not.toHaveBeenCalled();
    expect(playbackMessages('play')).toHaveLength(0);
    expect(container.querySelector('img').src).toBe(initial);
    expect(screen.getByText('3.00s / 10.0s')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await waitFor(() => expect(playbackMessages('prepare')).toHaveLength(2));
    unmount();
    const sent = socket.emit.mock.calls.length;
    await act(async () => receive('playback-state', { ...playbackMessages('prepare')[1], status: 'ready' }));
    expect(socket.emit.mock.calls).toHaveLength(sent);
    expect(play).not.toHaveBeenCalled();
  });

  it('displays delayed fallback frames in order while playing, then rejects them across pause and resume', async () => {
    const native = installNative({ roundTrips: [120, 160, 200] });
    const { raf } = media();
    const { container } = render(<CompositionPreviewPlayer project={project} audioUrl='/song.mp3' />);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await screen.findByText(/Native playback clock could not be synchronized/);
    expect(playbackMessages('prepare')).toHaveLength(0);
    expect(playbackMessages('play')).toHaveLength(0);
    // The fallback message renders before the player schedules its first tick.
    await waitFor(() => expect(raf).toHaveBeenCalled());
    const audio = container.querySelector('audio');
    const image = container.querySelector('img');
    const initial = image.src;
    const frame = (generation) => receive('frame', { ...native.session(), generation, data: btoa(`fallback-${generation}`) });
    audio.currentTime = 1;
    act(() => raf.mock.calls.at(-1)[0]());
    audio.currentTime = 2;
    act(() => raf.mock.calls.at(-1)[0]());
    expect(socket.emit).toHaveBeenLastCalledWith('generated-preview:seek', expect.objectContaining({ t: 2, generation: 2, playing: true }));
    act(() => frame(1));
    const first = image.src;
    expect(first).not.toBe(initial);
    act(() => frame(0));
    expect(image.src).toBe(first);
    act(() => frame(2));
    const second = image.src;
    expect(second).not.toBe(first);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(socket.emit).toHaveBeenLastCalledWith('generated-preview:seek', expect.objectContaining({ generation: 3, playing: false }));
    act(() => { frame(1); frame(2); });
    expect(image.src).toBe(second);
    act(() => frame(3));
    const paused = image.src;
    expect(paused).not.toBe(second);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Play' })));
    audio.currentTime = 3;
    act(() => raf.mock.calls.at(-1)[0]());
    audio.currentTime = 4;
    act(() => raf.mock.calls.at(-1)[0]());
    act(() => frame(2));
    expect(image.src).toBe(paused);
    act(() => frame(4));
    expect(image.src).not.toBe(paused);
  });

  it('resynchronizes clock drift at actual audio time and stops repeated clock failures with a visible error', async () => {
    installNative();
    media();
    const { container } = render(<CompositionPreviewPlayer project={project} audioUrl='/song.mp3' />);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await waitFor(() => expect(playbackMessages('play')).toHaveLength(1));
    container.querySelector('audio').currentTime = 3;
    for (let i = 1; i <= 3; i += 1) {
      const previous = playbackMessages('play').at(-1);
      await act(async () => receive('playback-state', { ...previous, action: 'sync', status: 'resync-required' }));
      await waitFor(() => expect(playbackMessages('play')).toHaveLength(i + 1));
      expect(playbackMessages('play').at(-1)).toEqual(expect.objectContaining({ t: container.querySelector('audio').currentTime, epoch: expect.any(Number) }));
      expect(playbackMessages('play').at(-1).epoch).toBeGreaterThan(previous.epoch);
    }
    await act(async () => receive('playback-state', { ...playbackMessages('play').at(-1), action: 'sync', status: 'resync-required' }));
    expect(screen.getByRole('alert')).toHaveTextContent('repeatedly lost synchronization');
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled();
    expect(playbackMessages('prepare')).toHaveLength(4);
  });

  it('reprepares repeated intentional control edits without consuming the clock retry budget', async () => {
    installNative();
    media();
    const { container } = render(<CompositionPreviewPlayer project={project} audioUrl='/song.mp3' />);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await waitFor(() => expect(playbackMessages('play')).toHaveLength(1));
    container.querySelector('audio').currentTime = 2;
    for (let i = 1; i <= 5; i += 1) {
      await act(async () => receive('playback-state', { ...playbackMessages('play').at(-1), action: 'sync', status: 'resync-required', reason: 'controls' }));
      expect(playbackMessages('play')).toHaveLength(i + 1);
      expect(playbackMessages('play').at(-1).t).toBe(container.querySelector('audio').currentTime);
    }
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeEnabled();
    expect(playbackMessages('prepare')).toHaveLength(6);
    await act(async () => receive('playback-state', { ...playbackMessages('play').at(-1), action: 'sync', status: 'resync-required', reason: 'clock' }));
    expect(playbackMessages('play')).toHaveLength(7);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps native playback stopped when audio play fails', async () => {
    installNative();
    const { play, pause } = media();
    play.mockRejectedValue(new Error('Audio permission denied'));
    render(<CompositionPreviewPlayer project={project} audioUrl='/song.mp3' />);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Audio permission denied');
    expect(pause).toHaveBeenCalled();
    expect(playbackMessages('play')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Retry preview' })).toBeEnabled();
  });

  it('pauses with a visible error when native preparation never becomes ready', async () => {
    installNative({ prepare: false });
    const { play } = media();
    render(<CompositionPreviewPlayer project={project} audioUrl='/song.mp3' />);
    vi.useFakeTimers();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Play' })));
    expect(playbackMessages('prepare')).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(screen.getByRole('alert')).toHaveTextContent('Native preview preparation failed');
    expect(play).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves play intent across shot navigation and gates queued frames when hidden', async () => {
    const native = installNative();
    const { play } = media();
    const shots = { ...project, scenes: [{ sceneId: 'a', startSec: 0 }, { sceneId: 'b', startSec: 4 }] };
    const { container } = render(<CompositionPreviewPlayer project={shots} audioUrl='/song.mp3' shotNav />);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await waitFor(() => expect(playbackMessages('play')).toHaveLength(1));
    const previous = playbackMessages('play')[0];
    fireEvent.click(screen.getByRole('button', { name: 'Next shot' }));
    await waitFor(() => expect(playbackMessages('play')).toHaveLength(2));
    const anchor = playbackMessages('play')[1];
    expect(anchor.t).toBeGreaterThanOrEqual(4.1);
    expect(anchor.t).toBe(container.querySelector('audio').currentTime);
    expect(anchor.epoch).toBeGreaterThan(previous.epoch);
    expect(play).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Pause' })).toBeEnabled();
    const image = container.querySelector('img');
    const initial = image.src;
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    act(() => receive('frame', { ...native.session(), playbackEpoch: anchor.epoch, sequence: 100, data: btoa('hidden frame') }));
    expect(image.src).toBe(initial);
    expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled();
    expect(socket.emit).toHaveBeenLastCalledWith('generated-preview:seek', expect.objectContaining({ t: container.querySelector('audio').currentTime, playing: false }));
  });

  it('preserves a terminal error through closed and reconnect until explicit retry', async () => {
    const native = installNative();
    media();
    render(<CompositionPreviewPlayer project={project} audioUrl='/song.mp3' />);
    act(() => {
      receive('error', { ...native.session(), message: 'Native worker failed' });
      receive('closed', { ...native.session(), reason: 'error' });
      receive('frame', { ...native.session(), generation: 0, data: btoa('late') });
      for (const fn of socket.__handlers.get('disconnect') || []) fn();
      for (const fn of socket.__handlers.get('connect') || []) fn();
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Native worker failed');
    expect(opens()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry preview' }));
    expect(opens()).toHaveLength(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
