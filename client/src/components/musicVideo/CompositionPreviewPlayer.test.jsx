import { beforeEach, describe, expect, it, vi } from 'vitest';
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

import CompositionPreviewPlayer from './CompositionPreviewPlayer.jsx';

const DOCUMENT = { directory: 'music-video/mv-1/composition/doc-a', entry: 'index.html' };
const project = {
  id: 'mv-1', name: 'Example', updatedAt: '2026-01-01T00:00:00.000Z', composition: { mode: 'document', document: DOCUMENT },
  lyricCues: [{ id: 'l1', text: 'first line', startSec: 1, endSec: 3 }, { id: 'l2', text: 'second line', startSec: 3, endSec: 6 }],
};

const opens = () => socket.emit.mock.calls.filter(([event]) => event === 'generated-preview:open');

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  socket.emit.mockReset();
  socket.emit.mockImplementation(socket.reply);
  socket.__handlers.clear();
});

describe('CompositionPreviewPlayer', () => {
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

  it('reports an explicit unavailable state and still does not mount an iframe', async () => {
    socket.emit.mockImplementation((event, payload) => {
      if (event !== 'generated-preview:open') return;
      for (const fn of socket.__handlers.get('generated-preview:unavailable') || []) {
        fn({ requestId: payload.requestId, code: 'PREVIEW_ISOLATION_UNAVAILABLE', message: 'Isolated preview is unavailable on this host.' });
      }
    });
    render(<CompositionPreviewPlayer project={project} audioUrl={null} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Isolated preview is unavailable on this host.');
    expect(screen.getByText('Preview unavailable')).toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('sends the film look with the open and again when it changes, without reopening', async () => {
    const look = { version: 1, preset: 'custom', grain: 0.4 };
    const { rerender } = render(<CompositionPreviewPlayer project={{ ...project, filmLook: look }} audioUrl={null} />);
    await waitFor(() => expect(opens()[0][1].look).toEqual(look));
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

  it('saves the docked preview frame on screen to the gallery', async () => {
    const blob = new Blob(['jpeg'], { type: 'image/jpeg' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ blob: async () => blob });
    const { container } = render(<CompositionPreviewPlayer project={{ ...project, scenes: [{ sceneId: 'a', startSec: 0 }] }} audioUrl="/song.mp3" shotNav />);
    await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBeTruthy());
    const frameSrc = container.querySelector('img').getAttribute('src');
    await act(async () => { screen.getByRole('button', { name: /Save frame/ }).click(); });
    expect(fetchSpy).toHaveBeenCalledWith(frameSrc);
    expect(uploadGalleryImage).toHaveBeenCalledWith(blob, { silent: true });
    fetchSpy.mockRestore();
  });
});
