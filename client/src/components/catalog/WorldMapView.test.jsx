import { expect, it } from 'vitest';
import { fitWorldView, layoutWorldLabels } from './WorldMapView.jsx';

const overlaps = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

// Catches set names drawn on top of each other when sets sit close together.
it('lays out labels for crowded sets without any two overlapping', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ id: `set-${i}`, text: `Example place ${i}`, x: i * 8, y: 0, top: -10, bottom: 10 }));
  const placed = layoutWorldLabels(items, 0.5);
  expect(placed.length).toBeGreaterThan(1);
  expect(placed[0]).toMatchObject({ id: 'set-0', y: 0 });
  placed.forEach((a, i) => placed.slice(i + 1).forEach((b) => expect(overlaps(a, b)).toBe(false)));
});

// Catches a fit that frames only set centers, clipping a large set's footprint.
it('fits the whole footprint of a loaded greybox, not just its center', () => {
  const world = { sets: [{ id: 'a', ingredientId: 'cat-a', position: [0, 0], rotationDegrees: 0 }], paths: [] };
  const places = { 'cat-a': { ingredient: { payload: { greybox: { parts: [{ type: 'box', position: [0, 0, 0], size: [400, 5, 100] }] } } } } };
  const view = fitWorldView(world, places);
  expect(view.size).toBeGreaterThanOrEqual(400);
  expect(view).toMatchObject({ cx: 0, cz: 0 });
});
