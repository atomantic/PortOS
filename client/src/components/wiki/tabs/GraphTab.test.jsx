import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import GraphTab from './GraphTab';
import * as api from '../../../services/api';

vi.mock('../../../services/api');

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname + loc.search}</div>;
}

// One node lays out at graph (615, 300); with an 800x600 canvas that is client (615, 300) at zoom 1, offset 0.
const NODE_POINT = { clientX: 615, clientY: 300 };

async function renderCanvas() {
  api.getNotesVaultGraph.mockResolvedValue({
    nodes: [{ path: 'wiki/alpha.md', name: 'alpha', folder: 'wiki' }],
    edges: [],
    totalNodes: 1,
    totalEdges: 0,
  });
  const { container } = render(
    <MemoryRouter initialEntries={['/wiki/graph']}>
      <GraphTab vaultId="v1" />
      <LocationProbe />
    </MemoryRouter>
  );
  await screen.findByText('1 nodes, 0 edges');
  return container.querySelector('canvas');
}

const touch = (extra) => ({ pointerId: 1, pointerType: 'touch', button: 0, ...extra });

describe('GraphTab touch gestures', () => {
  let rectSpy;
  let ctxSpy;
  beforeEach(() => {
    vi.clearAllMocks();
    rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect')
      .mockReturnValue({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 });
    ctxSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(new Proxy({}, {
      get: () => () => {},
      set: () => true,
    }));
  });
  afterEach(() => {
    rectSpy.mockRestore();
    ctxSpy.mockRestore();
  });

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
