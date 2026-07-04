import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import MediaAnnotate from './MediaAnnotate';

// Re-render (issue #2036 phase 2) is the focus: annotate an image, then feed the
// flattened markup back through img2img. The canvas itself is exercised by
// sketchCanvas.test.js — here it's stubbed to synchronously report dimensions
// and expose a flattened-PNG export so the page's re-render wiring can run.
vi.mock('../components/media/AnnotationCanvas', async () => {
  const React = await import('react');
  return {
    default: React.forwardRef(function StubCanvas({ onImageLoad }, ref) {
      React.useImperativeHandle(ref, () => ({ exportPng: () => 'data:image/png;base64,QQ==' }), []);
      // Defer to a macrotask: the real <img> onLoad fires asynchronously, AFTER
      // the page's own mount effect resets dims to null. Reporting synchronously
      // here would be clobbered by that reset (child effects run before parent).
      React.useEffect(() => {
        const t = setTimeout(() => onImageLoad?.({ w: 100, h: 80 }), 0);
        return () => clearTimeout(t);
      }, [onImageLoad]);
      return <div data-testid="stub-canvas" />;
    }),
  };
});

const getMediaSketch = vi.fn();
const saveMediaSketch = vi.fn();
const getRegenAvailability = vi.fn();
const rerenderWithAnnotations = vi.fn();

vi.mock('../services/api', () => ({
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
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useNavigate: () => navigate };
});

const renderPage = () => render(
  <MemoryRouter initialEntries={['/media/annotate/image:foo.png']}>
    <Routes>
      <Route path="/media/annotate/:mediaKey" element={<MediaAnnotate />} />
    </Routes>
  </MemoryRouter>,
);

describe('MediaAnnotate re-render with annotations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMediaSketch.mockResolvedValue({ sketch: { strokes: [{ mode: 'draw', color: '#ef4444', size: 4, points: [{ x: 1, y: 2 }] }] } });
    getRegenAvailability.mockResolvedValue({ available: true, modelId: 'flux-dev', strengthMin: 0.02, strengthMax: 0.6, strengthDefault: 0.25 });
    saveMediaSketch.mockResolvedValue({ sketch: {} });
    rerenderWithAnnotations.mockResolvedValue({ jobId: 'job-1', position: 1, status: 'queued' });
  });

  it('saves the annotation and enqueues an img2img re-render, naming the local model', async () => {
    renderPage();

    // The button enables once the canvas reports dims AND saved strokes load.
    const btn = await screen.findByTitle('Re-render this image guided by your annotations');
    await waitFor(() => expect(btn).not.toBeDisabled());
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
    renderPage();

    const btn = await screen.findByTitle('Re-render this image guided by your annotations');
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);

    expect(await screen.findByText('No local FLUX runner installed.')).toBeInTheDocument();
    // The confirm button in the modal is disabled when unavailable.
    const confirm = within(screen.getByRole('dialog')).getByRole('button', { name: 'Re-render' });
    expect(confirm).toBeDisabled();
    expect(rerenderWithAnnotations).not.toHaveBeenCalled();
  });
});
