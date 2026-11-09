import { expect, it } from 'vitest';
import { fitWorldView, layoutWorldLabels, worldSetView } from './WorldMapView.jsx';

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
