import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import WorldMap, { fitWorldView, layoutWorldLabels, worldSetView } from './WorldMapView.jsx';

const overlaps = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

// Catches set names drawn on top of each other when sets sit close together.
it('lays out names for crowded sets without any two overlapping', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ id: `set-${i}`, text: `Example place ${i}`, x: i * 8, y: (i % 3) * 4 }));
  const unitPerPx = 0.5;
  const placed = layoutWorldLabels(items, unitPerPx);
  expect(placed.length).toBeGreaterThan(1);
  const h = 11 * 1.3 * unitPerPx;
  const boxes = placed.map((entry) => {
    const w = (entry.text.length * 11 * 0.62 + 4) * unitPerPx;
    return { x0: entry.x - w / 2, x1: entry.x + w / 2, y0: entry.y - h / 2, y1: entry.y + h / 2 };
  });
  boxes.forEach((a, i) => boxes.slice(i + 1).forEach((b) => expect(overlaps(a, b)).toBe(false)));
});

// Catches the map framing a set's huge ground plane instead of the sets themselves, and zoom-to-set missing its footprint.
it('fits the whole world to set markers and zooms one set to its footprint', () => {
  const world = {
    sets: [{ id: 'a', ingredientId: 'cat-a', position: [0, 0], rotationDegrees: 0 }, { id: 'b', ingredientId: 'cat-b', position: [100, 0], rotationDegrees: 0 }],
    paths: [],
  };
  expect(fitWorldView(world)).toMatchObject({ cx: 50, cz: 0, size: 120 });
  const entry = { ingredient: { payload: { greybox: { parts: [{ type: 'box', position: [0, 0, 0], rotationDegrees: [0, 0, 0], size: [200, 5, 40] }] } } } };
  expect(worldSetView(world.sets[0], entry)).toMatchObject({ cx: 0, cz: 0, size: 260 });
});

// Catches the right/left fitted-world labels being clipped outside the visible SVG.
it('keeps fitted edge labels within the current map bounds', () => {
  const items = [{ id: 'right', text: 'Rightmost named set', x: 100, y: 0 }, { id: 'left', text: 'Leftmost named set', x: 0, y: 0 }];
  const bounds = { x0: -10, x1: 110, y0: -60, y1: 60 };
  const labels = layoutWorldLabels(items, 0.3, 11, bounds);
  expect(labels).toHaveLength(2);
  for (const entry of labels) {
    const width = (entry.text.length * 11 * 0.62 + 4) * 0.3;
    expect(entry.x - width / 2).toBeGreaterThanOrEqual(bounds.x0);
    expect(entry.x + width / 2).toBeLessThanOrEqual(bounds.x1);
    expect(entry.y - 11 * 1.3 * 0.3 / 2).toBeGreaterThanOrEqual(bounds.y0);
    expect(entry.y + 11 * 1.3 * 0.3 / 2).toBeLessThanOrEqual(bounds.y1);
  }
});

// Catches keyboard users unable to reach the map, pan with Arrow keys, or place a point without a pointer.
it('focuses the map, pans with Arrow keys without scrolling, and adds center points on Enter or Space while drawing', () => {
  const emptyWorld = { sets: [], paths: [] };
  const onView = vi.fn();
  const onAddPoint = vi.fn();
  const view = { cx: 10.24, cz: -20.66, size: 100 };
  const { rerender } = render(
    <WorldMap world={emptyWorld} places={{}} view={view} onView={onView} onAddPoint={onAddPoint} />,
  );

  const map = screen.getByRole('application', { name: 'World map, north is up' });
  expect(map).toHaveAttribute('tabindex', '0');
  const instructionsId = map.getAttribute('aria-describedby');
  expect(instructionsId).toBeTruthy();
  expect(document.getElementById(instructionsId)?.textContent).toBe(
    'Arrow keys pan. Enter adds a point at the center while drawing or placing.',
  );

  const right = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
  map.dispatchEvent(right);
  expect(right.defaultPrevented).toBe(true);
  expect(onView).toHaveBeenLastCalledWith({ cx: expect.closeTo(20.24, 5), cz: -20.66, size: 100 });

  fireEvent.keyDown(map, { key: 'ArrowLeft', shiftKey: true });
  expect(onView).toHaveBeenLastCalledWith({ cx: expect.closeTo(-29.76, 5), cz: -20.66, size: 100 });
  fireEvent.keyDown(map, { key: 'ArrowUp' });
  expect(onView).toHaveBeenLastCalledWith({ cx: 10.24, cz: expect.closeTo(-30.66, 5), size: 100 });
  fireEvent.keyDown(map, { key: 'ArrowDown', shiftKey: true });
  expect(onView).toHaveBeenLastCalledWith({ cx: 10.24, cz: expect.closeTo(19.34, 5), size: 100 });

  // Read-only / non-drawing map ignores Enter and Space without entering edit mode.
  fireEvent.keyDown(map, { key: 'Enter' });
  fireEvent.keyDown(map, { key: ' ' });
  expect(onAddPoint).not.toHaveBeenCalled();

  // Drawing/placing mode (including empty array from previz) still pans and accepts Enter/Space.
  rerender(<WorldMap world={emptyWorld} places={{}} drawing={[]} view={view} onView={onView} onAddPoint={onAddPoint} />);
  fireEvent.keyDown(map, { key: 'ArrowRight' });
  expect(onView).toHaveBeenLastCalledWith({ cx: expect.closeTo(20.24, 5), cz: -20.66, size: 100 });

  const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  map.dispatchEvent(enter);
  expect(enter.defaultPrevented).toBe(true);
  expect(onAddPoint).toHaveBeenLastCalledWith([10.2, -20.7]);

  const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
  map.dispatchEvent(space);
  expect(space.defaultPrevented).toBe(true);
  expect(onAddPoint).toHaveBeenCalledTimes(2);
});
