import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getMusicVideoCompositionPreview: vi.fn(),
  fetchMusicVideoPreviewAsset: vi.fn(),
}));
vi.mock('../../services/apiMusicVideo.js', () => api);

import CompositionPreviewPlayer, { PREVIEW_BLOB_BUDGET_BYTES } from './CompositionPreviewPlayer.jsx';

const DOCUMENT = { directory: 'music-video/mv-1/composition/doc-a', entry: 'index.html' };
const project = {
  id: 'mv-1', name: 'Example', updatedAt: '2026-01-01T00:00:00.000Z', composition: { mode: 'document', document: DOCUMENT },
  lyricCues: [{ id: 'l1', text: 'first line', startSec: 1, endSec: 3 }, { id: 'l2', text: 'second line', startSec: 3, endSec: 6 }],
};

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.getMusicVideoCompositionPreview.mockResolvedValue({ html: '<!doctype html><p>preview</p>', assets: [], width: 1920, height: 1080, fps: 24, durationSec: 10 });
});

describe('CompositionPreviewPlayer', () => {
  // The iframe is played by the test: it reports `loaded`, then asks for keys the way the bootstrap does.
  const loadPreview = async (assets) => {
    api.getMusicVideoCompositionPreview.mockResolvedValue({ html: '<!doctype html><p>preview</p>', assets, fps: 24, durationSec: 10 });
    render(<CompositionPreviewPlayer project={project} audioUrl={null} />);
    const frame = await screen.findByTitle('Composition document preview');
    const post = vi.spyOn(frame.contentWindow, 'postMessage');
    const send = (data) => act(async () => {
      window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data }));
    });
    // findByTitle can resolve before React flushes the passive effect that attaches the message listener, so a
    // `loaded` sent that early is dropped; repeat it until the player answers with its manifest.
    await waitFor(async () => {
      await send({ type: 'portos-mv:loaded' });
      expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'portos-mv:manifest' }), '*');
    });
    const ask = async (key) => {
      await send({ type: 'portos-mv:request', key });
      await waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'portos-mv:asset', key }), '*'));
      const answer = post.mock.calls.filter(([data]) => data.type === 'portos-mv:asset' && data.key === key).at(-1)[0];
      post.mockClear();
      return answer.blob;
    };
    return { post, send, ask };
  };

  it('posts the media manifest first and fetches only the files the document asks for', async () => {
    const assets = [{ key: 'media/scene-a.mp4', url: '/preview/scene-a' }, { key: 'media/scene-b.png', url: '/preview/scene-b' }, { key: 'media/scene-c.png', url: '/preview/scene-c' }];
    const blob = new Blob(['example media'], { type: 'image/png' });
    api.fetchMusicVideoPreviewAsset.mockResolvedValue(blob);
    const { post, ask } = await loadPreview(assets);
    expect(post).toHaveBeenCalledWith({ type: 'portos-mv:manifest', keys: assets.map((asset) => asset.key) }, '*');
    expect(post).toHaveBeenCalledWith({ type: 'portos-mv:seek', t: 0 }, '*');
    expect(api.fetchMusicVideoPreviewAsset).not.toHaveBeenCalled();

    expect(await ask('media/scene-b.png')).toBe(blob);
    expect(api.fetchMusicVideoPreviewAsset.mock.calls).toEqual([['/preview/scene-b']]);
    // A key outside the manifest is refused without a request: document code names nothing else.
    expect(await ask('../secrets.png')).toBeNull();
    expect(api.fetchMusicVideoPreviewAsset).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Some preview media could not be loaded')).toBeInTheDocument();
  });

  it('answers a failed fetch with no blob and reports the missing media once the first frame is drawn', async () => {
    api.fetchMusicVideoPreviewAsset.mockRejectedValue(new Error('Example unavailable asset'));
    const { send, ask } = await loadPreview([{ key: 'media/scene-a.png', url: '/preview/scene-a' }]);
    expect(screen.getByText('Loading preview media…')).toBeInTheDocument();
    expect(await ask('media/scene-a.png')).toBeNull();
    await send({ type: 'portos-mv:seeked', t: 0 });
    expect(screen.getByText('Some preview media could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText('Loading preview media…')).not.toBeInTheDocument();
  });

  it('keeps fetched media within the blob budget, dropping the least recently used file first', async () => {
    const assets = ['a', 'b', 'c', 'd'].map((name) => ({ key: `media/${name}.jpg`, url: `/preview/${name}` }));
    // Each file is half the budget, so two fit; sizes stand in for real blobs without allocating them.
    api.fetchMusicVideoPreviewAsset.mockImplementation(async (url) => ({ url, size: PREVIEW_BLOB_BUDGET_BYTES / 2 }));
    const { ask } = await loadPreview(assets);
    const fetched = () => api.fetchMusicVideoPreviewAsset.mock.calls.map(([url]) => url);
    await ask('media/a.jpg');
    await ask('media/b.jpg');
    await ask('media/a.jpg'); // cached, and now the most recently used
    expect(fetched()).toEqual(['/preview/a', '/preview/b']);
    await ask('media/c.jpg'); // over budget: b goes, a stays
    await ask('media/a.jpg');
    expect(fetched()).toEqual(['/preview/a', '/preview/b', '/preview/c']);
    await ask('media/b.jpg'); // evicted, so fetched again (and c, now oldest, goes)
    await ask('media/c.jpg');
    expect(fetched()).toEqual(['/preview/a', '/preview/b', '/preview/c', '/preview/b', '/preview/c']);
  });

  it('keeps the loaded preview through an unrelated project save and rebuilds when the document version changes', async () => {
    const { rerender } = render(<CompositionPreviewPlayer project={project} audioUrl={null} />);
    const frame = await screen.findByTitle('Composition document preview');
    rerender(<CompositionPreviewPlayer project={{ ...project, updatedAt: '2026-02-02T00:00:00.000Z', name: 'Renamed' }} audioUrl={null} />);
    await act(async () => {});
    expect(api.getMusicVideoCompositionPreview).toHaveBeenCalledTimes(1);
    expect(screen.getByTitle('Composition document preview')).toBe(frame);
    const next = { ...project, composition: { mode: 'document', document: { ...DOCUMENT, directory: 'music-video/mv-1/composition/doc-b' } } };
    rerender(<CompositionPreviewPlayer project={next} audioUrl={null} />);
    await waitFor(() => expect(api.getMusicVideoCompositionPreview).toHaveBeenCalledTimes(2));
  });

  it('does not build the preview behind a collapsed phone mini-player until it is expanded', async () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn(() => ({ matches: false }));
    try {
      const { rerender } = render(<CompositionPreviewPlayer project={project} audioUrl={null} collapsed />);
      await act(async () => {});
      expect(api.getMusicVideoCompositionPreview).not.toHaveBeenCalled();
      expect(screen.getByText('Expand to load preview')).toBeInTheDocument();
      expect(screen.getByLabelText('Scrub the composition preview')).toBeDisabled();
      expect(screen.queryByText('0.00s / 0.0s')).not.toBeInTheDocument();
      rerender(<CompositionPreviewPlayer project={project} audioUrl={null} collapsed={false} />);
      await screen.findByTitle('Composition document preview');
      expect(api.getMusicVideoCompositionPreview).toHaveBeenCalledTimes(1);
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
      expect(api.getMusicVideoCompositionPreview).not.toHaveBeenCalled();
      await act(async () => {
        desktop.matches = true;
        desktop.dispatchEvent(new Event('change'));
      });
      await screen.findByTitle('Composition document preview');
      expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled();
      expect(api.getMusicVideoCompositionPreview).toHaveBeenCalledTimes(1);
      await act(async () => {
        desktop.matches = false;
        desktop.dispatchEvent(new Event('change'));
      });
      expect(screen.getByTitle('Composition document preview')).toBeInTheDocument();
      expect(api.getMusicVideoCompositionPreview).toHaveBeenCalledTimes(1);
    } finally {
      window.matchMedia = original;
    }
  });

  it('runs the document in an opaque-origin sandbox and renders nothing without one', async () => {
    const { container, rerender } = render(<CompositionPreviewPlayer project={{ ...project, composition: { mode: 'document' } }} audioUrl={null} />);
    expect(container).toBeEmptyDOMElement();
    expect(api.getMusicVideoCompositionPreview).not.toHaveBeenCalled();

    rerender(<CompositionPreviewPlayer project={project} audioUrl={null} />);
    const frame = await screen.findByTitle('Composition document preview');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
  });

  it('seeks to each outside request once the preview knows its length, and follows the lyric line', async () => {
    const { rerender } = render(<CompositionPreviewPlayer project={project} audioUrl="/data/music/song.mp3" seekRequest={{ t: 2, n: 1 }} />);
    // The request arrived before the preview loaded; it applies when the duration is known.
    await waitFor(() => expect(screen.getByText('2.00s / 10.0s')).toBeTruthy());
    expect(screen.getByTestId('preview-lyric')).toHaveTextContent('first line');

    // Seeking again to the same time is a new request (a new n), not a no-op.
    rerender(<CompositionPreviewPlayer project={project} audioUrl="/data/music/song.mp3" seekRequest={{ t: 4.5, n: 2 }} />);
    await waitFor(() => expect(screen.getByText('4.50s / 10.0s')).toBeTruthy());
    expect(screen.getByTestId('preview-lyric')).toHaveTextContent('second line');

    // Past the end clamps to the last frame instead of leaving the timeline.
    rerender(<CompositionPreviewPlayer project={project} audioUrl="/data/music/song.mp3" seekRequest={{ t: 99, n: 3 }} />);
    await waitFor(() => expect(screen.getByText(/^9\.9\ds \/ 10\.0s$/)).toBeTruthy());
  });

  it('gives simultaneous active and candidate previews distinct scrubbers', async () => {
    const both = { ...project, composition: { ...project.composition,
      documentDraft: { ...DOCUMENT, directory: 'music-video/mv-1/composition/doc-candidate' } } };
    render(<><CompositionPreviewPlayer project={both} audioUrl={null} /><CompositionPreviewPlayer project={both} audioUrl={null} draft /></>);
    await screen.findByTitle('Composition candidate preview');
    expect(screen.getByLabelText('Scrub the composition preview').id).toBe('mv-doc-scrub');
    expect(screen.getByLabelText('Scrub the composition candidate').id).toBe('mv-doc-draft-scrub');
  });
});
