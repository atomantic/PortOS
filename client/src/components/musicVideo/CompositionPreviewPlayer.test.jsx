import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getMusicVideoCompositionPreview: vi.fn(),
  fetchMusicVideoPreviewAsset: vi.fn(),
}));
vi.mock('../../services/apiMusicVideo.js', () => api);

import CompositionPreviewPlayer from './CompositionPreviewPlayer.jsx';

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
  it.each([false, true])('loads available preview media and reports missing assets when a fetch fails (%s)', async (missing) => {
    const assets = [{ key: 'scene-a', url: '/preview/scene-a' }, { key: 'scene-b', url: '/preview/scene-b' }];
    const blob = new Blob(['example media'], { type: 'image/png' });
    api.getMusicVideoCompositionPreview.mockResolvedValue({ html: '<!doctype html><p>preview</p>', assets, fps: 24, durationSec: 10 });
    api.fetchMusicVideoPreviewAsset.mockImplementation((url) => missing && url === assets[1].url
      ? Promise.reject(new Error('Example unavailable asset')) : Promise.resolve(blob));
    render(<CompositionPreviewPlayer project={project} audioUrl={null} />);
    const frame = await screen.findByTitle('Composition document preview');
    const post = vi.spyOn(frame.contentWindow, 'postMessage');
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: 'portos-mv:loaded' } }));
    });
    await waitFor(() => expect(post).toHaveBeenCalledWith({
      type: 'portos-mv:assets', files: missing ? { 'scene-a': blob } : { 'scene-a': blob, 'scene-b': blob },
    }, '*'));
    if (missing) expect(screen.getByText('Some preview media could not be loaded')).toBeInTheDocument();
    else expect(screen.queryByText('Some preview media could not be loaded')).not.toBeInTheDocument();
    expect(screen.queryByText(/Loading preview media/)).not.toBeInTheDocument();
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
