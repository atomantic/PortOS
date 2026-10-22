import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import GraphCanvas from './GraphCanvas';

const nodes = [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }];
const positions = { a: { x: 20, y: 20 }, b: { x: 300, y: 20 } };

const renderCanvas = (props = {}) => render(
  <GraphCanvas
    width={600}
    height={200}
    nodes={nodes}
    positions={positions}
    nodeW={160}
    nodeH={80}
    nodeLabel={(n) => `Node: ${n.label}`}
    renderNode={() => <rect width={160} height={80} />}
    surfaceProps={{ 'data-testid': 'surface' }}
    {...props}
  />,
);

describe('GraphCanvas', () => {
  it('zooms by scaling the SVG while positions stay in canvas units', () => {
    renderCanvas();
    const svg = screen.getByTestId('surface').querySelector('svg');
    expect(svg).toHaveAttribute('width', '600');

    fireEvent.click(screen.getByLabelText('Zoom in'));
    expect(svg).toHaveAttribute('width', '750');
    expect(svg).toHaveAttribute('viewBox', '0 0 600 200');
    expect(screen.getByLabelText('Node: Alpha')).toHaveAttribute('transform', 'translate(20, 20)');
    expect(screen.getByLabelText('Reset zoom to 100%')).toHaveTextContent('125%');

    fireEvent.click(screen.getByLabelText('Reset zoom to 100%'));
    expect(svg).toHaveAttribute('width', '600');
  });

  it('commits a drag at zoom in canvas units, not screen pixels', () => {
    const onMove = vi.fn();
    renderCanvas({ onMove });
    fireEvent.click(screen.getByLabelText('Zoom in'));
    fireEvent.click(screen.getByLabelText('Zoom in'));
    expect(screen.getByLabelText('Reset zoom to 100%')).toHaveTextContent('156%');

    const card = screen.getByLabelText('Node: Alpha');
    fireEvent.pointerDown(card, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(card, { pointerId: 1, pointerType: 'mouse', clientX: 256, clientY: 100 });
    fireEvent.pointerUp(card, { pointerId: 1, pointerType: 'mouse' });

    // 156 screen px at 1.56× is 100 canvas units.
    expect(onMove).toHaveBeenCalledWith('a', { x: 120, y: 20 });
  });

  it('zooms with ctrl + wheel (a trackpad pinch) and blocks the page zoom', () => {
    renderCanvas();
    const surface = screen.getByTestId('surface');
    // happy-dom's WheelEvent drops ctrlKey, so build the event by hand.
    const wheel = (init) => Object.assign(new Event('wheel', { bubbles: true, cancelable: true }), { deltaY: -200, clientX: 0, clientY: 0, ...init });
    const pinch = wheel({ ctrlKey: true });
    act(() => { surface.dispatchEvent(pinch); });
    expect(pinch.defaultPrevented).toBe(true);
    expect(Number(surface.dataset.zoom)).toBeGreaterThan(1);

    const scroll = wheel({});
    act(() => { surface.dispatchEvent(scroll); });
    expect(scroll.defaultPrevented).toBe(false);
  });

  it('never drags a card when dragging is off, so a stacked layout keeps its positions', () => {
    const onMove = vi.fn();
    renderCanvas({ onMove, canDragNodes: false });
    const card = screen.getByLabelText('Node: Beta');
    fireEvent.pointerDown(card, { pointerId: 2, pointerType: 'mouse', button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(card, { pointerId: 2, pointerType: 'mouse', clientX: 200, clientY: 100 });
    fireEvent.pointerUp(card, { pointerId: 2, pointerType: 'mouse' });
    expect(onMove).not.toHaveBeenCalled();
  });
});
