import { act, cleanup, createEvent, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import GraphTab from './GraphTab';
import { getNotesVaultGraph } from '../../../services/apiNotes.js';

vi.mock('../../../services/apiNotes.js');

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname + loc.search}</div>;
}

// One node lays out at graph (615, 300); with an 800x600 canvas that is client (615, 300) at zoom 1, offset 0.
const NODE_POINT = { clientX: 615, clientY: 300 };

async function renderCanvas(graph = {}) {
  getNotesVaultGraph.mockResolvedValue({
    nodes: [{ path: 'wiki/alpha.md', name: 'alpha', folder: 'wiki' }],
    edges: [],
    totalNodes: 1,
    totalEdges: 0,
    ...graph,
  });
  const { container } = render(
    <MemoryRouter initialEntries={['/wiki/graph']}>
      <GraphTab vaultId="v1" />
      <LocationProbe />
    </MemoryRouter>
  );
  await screen.findByText('1 nodes, 0 edges');
  const canvas = container.querySelector('canvas');
  await waitFor(() => expect(canvas.width).toBe(800 * window.devicePixelRatio));
  return canvas;
}

const touch = (extra) => ({ pointerId: 1, pointerType: 'touch', button: 0, ...extra });

let rectSpy;
let context;
let labels;
beforeEach(() => {
  vi.clearAllMocks();
  rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect')
    .mockReturnValue({ left: 0, top: 0, width: 800, height: 600 });
  labels = vi.fn();
  context = new Proxy({
    setTransform: vi.fn(),
    fillText(name) { labels(name, this.fillStyle); },
  }, {
    get: (target, key) => target[key] ?? (() => {}),
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  const root = document.documentElement;
  root.removeAttribute('data-port-theme');
  root.style.removeProperty('--port-text');
  root.style.removeProperty('--port-text-muted');
});

describe('GraphTab touch gestures', () => {
  it('pans on a touch drag without opening the note under the finger', async () => {
    const canvas = await renderCanvas();
    fireEvent.pointerDown(canvas, touch(NODE_POINT));
    fireEvent.pointerMove(canvas, touch({ clientX: 515, clientY: 300 }));
    fireEvent.pointerUp(canvas, touch({ clientX: 515, clientY: 300 }));
    expect(screen.getByTestId('location').textContent).toBe('/wiki/graph');

    // The node moved with the pan: its old spot is empty and the new spot opens it.
    fireEvent.pointerDown(canvas, touch(NODE_POINT));
    fireEvent.pointerUp(canvas, touch(NODE_POINT));
    expect(screen.getByTestId('location').textContent).toBe('/wiki/graph');
    fireEvent.pointerDown(canvas, touch({ clientX: 515, clientY: 300 }));
    fireEvent.pointerUp(canvas, touch({ clientX: 515, clientY: 300 }));
    expect(screen.getByTestId('location').textContent).toBe('/wiki/browse?note=wiki%2Falpha.md');
  });

  it('opens the note on a touch tap', async () => {
    const canvas = await renderCanvas();
    fireEvent.pointerDown(canvas, touch(NODE_POINT));
    fireEvent.pointerUp(canvas, touch(NODE_POINT));
    expect(screen.getByTestId('location').textContent).toBe('/wiki/browse?note=wiki%2Falpha.md');
  });
});

describe('GraphTab keyboard access', () => {
  it('is focusable with an accessible name', async () => {
    const canvas = await renderCanvas();
    expect(canvas.tabIndex).toBe(0);
    expect(screen.getByRole('application', { name: /knowledge graph/i })).toBe(canvas);
  });

  it('pans with arrow keys (node moves under the old pointer spot)', async () => {
    const canvas = await renderCanvas();
    fireEvent.keyDown(canvas, { key: 'ArrowLeft' });
    // offset.x +40: node now at client x 655.
    fireEvent.pointerDown(canvas, touch({ clientX: 655, clientY: 300 }));
    fireEvent.pointerUp(canvas, touch({ clientX: 655, clientY: 300 }));
    expect(screen.getByTestId('location').textContent).toBe('/wiki/browse?note=wiki%2Falpha.md');
  });

  it('cycles nodes, announces them politely, and opens the active note with Enter', async () => {
    const canvas = await renderCanvas();
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('');
    fireEvent.keyDown(canvas, { key: 'Enter' });
    expect(screen.getByTestId('location').textContent).toBe('/wiki/graph');

    fireEvent.keyDown(canvas, { key: ']' });
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toMatch(/alpha, root, 0 connections/);
    fireEvent.keyDown(canvas, { key: 'Enter' });
    expect(screen.getByTestId('location').textContent).toBe('/wiki/browse?note=wiki%2Falpha.md');
  });
});

describe('GraphTab viewport and controls', () => {
  it('cancels wheel scrolling and moves the interactive node with zoom', async () => {
    const canvas = await renderCanvas();
    const wheel = createEvent.wheel(canvas, { cancelable: true, deltaY: -200 });
    fireEvent(canvas, wheel);
    expect(wheel.defaultPrevented).toBe(true);

    const zoomedPoint = { clientX: 738, clientY: 360 };
    fireEvent.pointerDown(canvas, touch(zoomedPoint));
    fireEvent.pointerUp(canvas, touch(zoomedPoint));
    expect(screen.getByTestId('location').textContent).toBe('/wiki/browse?note=wiki%2Falpha.md');
  });

  it('redraws on resize at device resolution and opens the note at its CSS pixel location', async () => {
    let resize;
    vi.stubGlobal('ResizeObserver', function (callback) {
      resize = callback;
      return { observe: vi.fn(), disconnect: vi.fn() };
    });
    vi.stubGlobal('devicePixelRatio', 2);
    const canvas = await renderCanvas();

    rectSpy.mockReturnValue({ left: 20, top: 25, width: 500, height: 400 });
    act(() => resize());
    expect(canvas.width).toBe(1000);
    expect(canvas.height).toBe(800);
    expect(context.setTransform).toHaveBeenLastCalledWith(2, 0, 0, 2, 0, 0);

    const resizedPoint = { clientX: 485, clientY: 225 };
    fireEvent.pointerDown(canvas, touch(resizedPoint));
    fireEvent.pointerUp(canvas, touch(resizedPoint));
    expect(screen.getByTestId('location').textContent).toBe('/wiki/browse?note=wiki%2Falpha.md');
  });

  it('redraws labels from the active theme when its text colors change', async () => {
    const canvas = await renderCanvas();
    const root = document.documentElement;
    await act(async () => {
      root.style.setProperty('--port-text', '35 35 40');
      root.style.setProperty('--port-text-muted', '82 82 91');
      root.setAttribute('data-port-theme', 'classic-day');
      await Promise.resolve();
    });

    expect(labels).toHaveBeenLastCalledWith('alpha', 'rgb(82, 82, 91)');
    fireEvent.pointerMove(canvas, { pointerId: 1, pointerType: 'mouse', ...NODE_POINT });
    expect(labels).toHaveBeenLastCalledWith('alpha', 'rgb(35, 35, 40)');
  });

  it('keeps the offline notice outside the zoom controls and resets the view', async () => {
    const canvas = await renderCanvas({ skippedUnavailable: 2 });
    const reset = screen.getByRole('button', { name: 'Reset' });
    expect(reset.parentElement).not.toContainElement(screen.getByText(/2 notes are stored in iCloud/));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    fireEvent.click(reset);
    fireEvent.pointerDown(canvas, touch(NODE_POINT));
    fireEvent.pointerUp(canvas, touch(NODE_POINT));
    expect(screen.getByTestId('location').textContent).toBe('/wiki/browse?note=wiki%2Falpha.md');
  });

  it('fills its flex container without a hardcoded calc() viewport height', async () => {
    const canvas = await renderCanvas();
    const wrapper = canvas.parentElement;
    expect(wrapper.className).toContain('flex-1');
    expect(wrapper.className).toContain('min-h-0');
    expect(wrapper.getAttribute('style')).toBeNull();
  });

  it('shows a retryable error instead of an empty state when loading the graph fails', async () => {
    getNotesVaultGraph.mockRejectedValueOnce(new Error('vault offline')).mockResolvedValueOnce({
      nodes: [{ path: 'wiki/alpha.md', name: 'alpha', folder: 'wiki' }],
      edges: [],
      totalNodes: 1,
      totalEdges: 0,
    });
    render(
      <MemoryRouter initialEntries={['/wiki/graph']}>
        <GraphTab vaultId="v1" />
      </MemoryRouter>
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the knowledge graph');
    expect(screen.queryByText('No pages to graph yet')).toBeNull();
    expect(getNotesVaultGraph).toHaveBeenCalledWith('v1', { silent: true });

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('1 nodes, 0 edges')).toBeInTheDocument();
  });
});
