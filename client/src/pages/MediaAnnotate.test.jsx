import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { createMemoryRouter, RouterProvider, Routes, Route, Link } from 'react-router';
import MediaAnnotate from './MediaAnnotate';
import { awaitEnabled } from '../test/enabledBarrier.js';

// Re-render (issue #2036 phase 2) is the focus: annotate an image, then feed the
// flattened markup back through img2img. The canvas itself is exercised by
// sketchCanvas.test.js — here it's stubbed to report dimensions
// and expose a flattened-PNG export so the page's re-render wiring can run.
vi.mock('../components/media/AnnotationCanvas', async () => {
  const React = await import('react');
  return {
    default: React.forwardRef(function StubCanvas({ onImageLoad, onStrokesChange, imageSrc, blankWidth, blankHeight }, ref) {
      React.useImperativeHandle(ref, () => ({ exportPng: () => 'data:image/png;base64,QQ==' }), []);
      // Defer to a macrotask: the real <img> onLoad fires asynchronously, AFTER
      // the page's own mount effect resets dims to null. Reporting synchronously
      // here would be clobbered by that reset (child effects run before parent).
      React.useEffect(() => {
        const t = setTimeout(() => onImageLoad?.(imageSrc
          ? { w: 100, h: 80 }
          : { w: blankWidth, h: blankHeight }), 0);
        return () => clearTimeout(t);
      }, [onImageLoad, imageSrc, blankWidth, blankHeight]);
      return (
        <div data-testid="stub-canvas">
          <button type="button" onClick={() => onStrokesChange?.([{ mode: 'draw', color: '#000000', size: 2, points: [{ x: 0, y: 0 }] }])}>stub-draw</button>
        </div>
      );
    }),
  };
});

const getMediaSketch = vi.fn();
const saveMediaSketch = vi.fn();
const getRegenAvailability = vi.fn();
const rerenderWithAnnotations = vi.fn();

vi.mock('../services/apiImageVideo.js', () => ({
  getMediaSketch: (...a) => getMediaSketch(...a),
  saveMediaSketch: (...a) => saveMediaSketch(...a),
  getRegenAvailability: (...a) => getRegenAvailability(...a),
  rerenderWithAnnotations: (...a) => rerenderWithAnnotations(...a),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('../components/ui/Toast', () => ({
  default: { success: (...a) => toastSuccess(...a), error: (...a) => toastError(...a) },
}));

const navigate = vi.fn();
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useNavigate: () => navigate };
});

// The unsaved-drawing guard needs a data router.
function MemoryRouter({ initialEntries, children }) {
  const [router] = useState(() => createMemoryRouter([{ path: '*', element: children }], { initialEntries }));
  return <RouterProvider router={router} />;
}

const renderPage = async () => {
  const result = render(
    <MemoryRouter initialEntries={['/media/annotate/image:foo.png']}>
      <Routes>
        <Route path="/media/annotate/:mediaKey" element={<MediaAnnotate />} />
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => {});
  return result;
};

describe('MediaAnnotate re-render with annotations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMediaSketch.mockResolvedValue({ sketch: { strokes: [{ mode: 'draw', color: '#ef4444', size: 4, points: [{ x: 1, y: 2 }] }] } });
    getRegenAvailability.mockResolvedValue({ available: true, modelId: 'flux-dev', strengthMin: 0.02, strengthMax: 0.6, strengthDefault: 0.25 });
    saveMediaSketch.mockResolvedValue({ sketch: {} });
    rerenderWithAnnotations.mockResolvedValue({ jobId: 'job-1', position: 1, status: 'queued' });
  });

  it('saves the annotation and enqueues an img2img re-render, naming the local model', async () => {
    await renderPage();

    // The button enables once the canvas reports dims AND saved strokes load.
    const btn = await awaitEnabled(() => screen.getByTitle('Re-render this image guided by your annotations'));
    fireEvent.click(btn);

    // Provider/model is visible before any AI call (no cold-bootstrap).
    expect(await screen.findByText('flux-dev')).toBeInTheDocument();

    // Confirm → persist annotation (flattened PNG) then enqueue the re-render.
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Re-render' }));

    await waitFor(() => expect(rerenderWithAnnotations).toHaveBeenCalledTimes(1));
    expect(saveMediaSketch).toHaveBeenCalledWith(
      'image:foo.png',
      expect.objectContaining({ width: 100, height: 80, png: 'data:image/png;base64,QQ==' }),
      { silent: true },
    );
    expect(rerenderWithAnnotations).toHaveBeenCalledWith('foo.png', { strength: 0.5, prompt: undefined });
    expect(toastSuccess).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/media/history');
  });

  it('disables re-render and surfaces the reason when local img2img is unavailable', async () => {
    getRegenAvailability.mockResolvedValue({ available: false, reason: 'No local FLUX runner installed.' });
    await renderPage();

    const btn = await awaitEnabled(() => screen.getByTitle('Re-render this image guided by your annotations'));
    fireEvent.click(btn);

    expect(await screen.findByText('No local FLUX runner installed.')).toBeInTheDocument();
    // The confirm button in the modal is disabled when unavailable.
    const confirm = within(screen.getByRole('dialog')).getByRole('button', { name: 'Re-render' });
    expect(confirm).toBeDisabled();
    expect(rerenderWithAnnotations).not.toHaveBeenCalled();
  });
});

describe('MediaAnnotate blank-canvas sketch (phase 3)', () => {
  const renderBlank = (search = '') => render(
    <MemoryRouter initialEntries={[`/media/annotate/sketch:11111111-1111-1111-1111-111111111111${search}`]}>
      <Routes>
        <Route path="/media/annotate/:mediaKey" element={<MediaAnnotate />} />
      </Routes>
    </MemoryRouter>,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    getMediaSketch.mockResolvedValue({ sketch: null });
    saveMediaSketch.mockResolvedValue({ sketch: {} });
  });

  it('renders a canvas with no Re-render button and saves under the sketch key', async () => {
    renderBlank();
    // The canvas mounts (stub reports dims) but Re-render (img2img) is absent —
    // a blank sketch has no source render to feed back.
    await screen.findByTestId('stub-canvas');
    expect(screen.queryByTitle('Re-render this image guided by your annotations')).toBeNull();
    // No img2img availability probe for a blank canvas.
    expect(getRegenAvailability).not.toHaveBeenCalled();

    const saveBtn = await awaitEnabled(() => screen.getByTitle('Save sketch'));
    fireEvent.click(saveBtn);
    await waitFor(() => expect(saveMediaSketch).toHaveBeenCalledTimes(1));
    expect(saveMediaSketch).toHaveBeenCalledWith(
      'sketch:11111111-1111-1111-1111-111111111111',
      expect.objectContaining({ width: 1024, height: 1024 }),
      { silent: true },
    );
  });

  it.each([
    ['empty dimensions', '?w=&h=%20', 1024, 1024],
    ['explicit dimensions and rounding', '?w=640.6&h=360', 641, 360],
    ['numeric bounds', '?w=0&h=8192', 64, 4096],
    ['invalid dimensions', '?w=invalid&h=Infinity', 1024, 1024],
  ])('saves the canvas size for %s', async (_label, search, width, height) => {
    renderBlank(search);
    const saveBtn = await awaitEnabled(() => screen.getByTitle('Save sketch'));
    fireEvent.click(saveBtn);
    await waitFor(() => expect(saveMediaSketch).toHaveBeenCalledWith(
      'sketch:11111111-1111-1111-1111-111111111111',
      expect.objectContaining({ width, height }),
      { silent: true },
    ));
  });

  it('routes the back link to ?returnTo when provided', async () => {
    renderBlank('?returnTo=%2Fpipeline%2Fissues%2Fabc%2Fstoryboards');
    const back = await screen.findByRole('link', { name: 'Back' });
    expect(back).toHaveAttribute('href', '/pipeline/issues/abc/storyboards');
  });
});

describe('MediaAnnotate saved-state safety', () => {
  const SAVED = [{ mode: 'draw', color: '#ef4444', size: 4, points: [{ x: 1, y: 2 }] }];
  const renderSketch = () => render(
    <MemoryRouter initialEntries={['/media/annotate/sketch:11111111-1111-1111-1111-111111111111']}>
      <Routes>
        <Route path="/media/annotate/:mediaKey" element={<MediaAnnotate />} />
      </Routes>
    </MemoryRouter>,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    saveMediaSketch.mockResolvedValue({ sketch: {} });
  });

  it('blocks Save and edits while the saved read is pending, then enables on success', async () => {
    let resolveRead;
    getMediaSketch.mockReturnValue(new Promise((r) => { resolveRead = r; }));
    renderSketch();
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });

    expect(screen.getByTitle('Save sketch')).toBeDisabled();
    fireEvent.click(screen.getByText('stub-draw'));
    expect(screen.getByTitle('Undo last stroke')).toBeDisabled();

    await act(async () => { resolveRead({ sketch: { strokes: SAVED } }); });
    const save = await awaitEnabled(() => screen.getByTitle('Save sketch'));
    fireEvent.click(save);
    await waitFor(() => expect(saveMediaSketch).toHaveBeenCalledWith(
      'sketch:11111111-1111-1111-1111-111111111111',
      expect.objectContaining({ strokes: SAVED }),
      { silent: true },
    ));
  });

  it('keeps Save blocked after a failed read and restores editing on a successful Retry', async () => {
    getMediaSketch.mockRejectedValueOnce(new Error('503'));
    renderSketch();
    const retry = await screen.findByRole('button', { name: /Retry/ });
    expect(screen.getByTitle('Save sketch')).toBeDisabled();
    fireEvent.click(screen.getByText('stub-draw'));
    expect(screen.getByTitle('Undo last stroke')).toBeDisabled();
    expect(saveMediaSketch).not.toHaveBeenCalled();

    getMediaSketch.mockResolvedValueOnce({ sketch: { strokes: SAVED } });
    fireEvent.click(retry);
    await awaitEnabled(() => screen.getByTitle('Save sketch'));
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
    expect(screen.getByTitle('Undo last stroke')).toBeEnabled();
  });

  it('allows a new sketch after an empty read and saves a deliberate clear of a loaded sketch', async () => {
    getMediaSketch.mockResolvedValueOnce({ sketch: null });
    const first = renderSketch();
    await awaitEnabled(() => screen.getByTitle('Save sketch'));
    fireEvent.click(screen.getByText('stub-draw'));
    await waitFor(() => expect(screen.getByTitle('Clear all strokes')).toBeEnabled());
    first.unmount();

    getMediaSketch.mockResolvedValueOnce({ sketch: { strokes: SAVED } });
    renderSketch();
    const clear = await awaitEnabled(() => screen.getByTitle('Clear all strokes'));
    fireEvent.click(clear);
    fireEvent.click(screen.getByTitle('Save sketch'));
    await waitFor(() => expect(saveMediaSketch).toHaveBeenCalledWith(
      'sketch:11111111-1111-1111-1111-111111111111',
      expect.objectContaining({ strokes: [] }),
      { silent: true },
    ));
  });

  it('does not reuse an earlier loaded result when navigating A to B and back to A mid-read', async () => {
    const A = 'sketch:11111111-1111-1111-1111-111111111111';
    const B = 'sketch:22222222-2222-2222-2222-222222222222';
    getMediaSketch.mockResolvedValueOnce({ sketch: { strokes: SAVED } });
    render(
      <MemoryRouter initialEntries={['/media/annotate/' + A]}>
        <Link to={'/media/annotate/' + B}>go-b</Link>
        <Link to={'/media/annotate/' + A}>go-a</Link>
        <Routes>
          <Route path="/media/annotate/:mediaKey" element={<MediaAnnotate />} />
        </Routes>
      </MemoryRouter>,
    );
    await awaitEnabled(() => screen.getByTitle('Save sketch'));

    getMediaSketch.mockReturnValue(new Promise(() => {}));
    fireEvent.click(screen.getByText('go-b'));
    fireEvent.click(screen.getByText('go-a'));
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    expect(screen.getByTitle('Save sketch')).toBeDisabled();
  });

  it('asks before leaving with unsaved strokes, and leaves freely once they are saved', async () => {
    getMediaSketch.mockResolvedValue({ sketch: null });
    render(
      <MemoryRouter initialEntries={['/media/annotate/sketch:11111111-1111-1111-1111-111111111111']}>
        <Routes>
          <Route path="/media/annotate/:mediaKey" element={<MediaAnnotate />} />
          <Route path="/media/history" element={<div>Media History page</div>} />
        </Routes>
      </MemoryRouter>,
    );
    await awaitEnabled(() => screen.getByTitle('Save sketch'));
    fireEvent.click(screen.getByText('stub-draw'));
    fireEvent.click(screen.getByRole('link', { name: 'Media History' }));
    expect(await screen.findByText('Discard your unsaved sketch?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByTestId('stub-canvas')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Save sketch'));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Sketch saved'));
    fireEvent.click(screen.getByRole('link', { name: 'Media History' }));
    expect(await screen.findByText('Media History page')).toBeInTheDocument();
  });

  it('keeps an annotated image saveable after Retry (the image does not re-report its size)', async () => {
    getMediaSketch.mockRejectedValueOnce(new Error('503'));
    getRegenAvailability.mockResolvedValue({ available: false });
    render(
      <MemoryRouter initialEntries={['/media/annotate/image:foo.png']}>
        <Routes>
          <Route path="/media/annotate/:mediaKey" element={<MediaAnnotate />} />
        </Routes>
      </MemoryRouter>,
    );
    const retry = await screen.findByRole('button', { name: /Retry/ });
    getMediaSketch.mockResolvedValueOnce({ sketch: { strokes: SAVED } });
    fireEvent.click(retry);
    fireEvent.click(await awaitEnabled(() => screen.getByTitle('Save annotation')));
    await waitFor(() => expect(saveMediaSketch).toHaveBeenCalledWith(
      'image:foo.png',
      expect.objectContaining({ width: 100, height: 80, strokes: SAVED }),
      { silent: true },
    ));
  });
});
