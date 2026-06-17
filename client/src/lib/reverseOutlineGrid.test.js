import { describe, it, expect } from 'vitest';
import { buildPlotlineGrid, sceneComponentCount } from './reverseOutlineGrid.js';

const plotlines = [
  { id: 'A', label: 'Main', color: '#f00' },
  { id: 'B', label: 'Sub', color: '#0f0' },
];

const scenes = [
  { id: 'scene-001', plotlineId: 'A', secondaryPlotlineId: 'B' },
  { id: 'scene-002', plotlineId: 'B', secondaryPlotlineId: null },
  { id: 'scene-003', plotlineId: 'A', secondaryPlotlineId: null },
];

describe('buildPlotlineGrid', () => {
  it('returns one column per scene and one row per plotline', () => {
    const { columns, rows } = buildPlotlineGrid(scenes, plotlines);
    expect(columns).toHaveLength(3);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.cells.length === 3)).toBe(true);
  });

  it('marks primary vs secondary vs absent per cell', () => {
    const { rows } = buildPlotlineGrid(scenes, plotlines);
    const rowA = rows.find((r) => r.plotline.id === 'A');
    const rowB = rows.find((r) => r.plotline.id === 'B');

    expect(rowA.cells[0].role).toBe('primary');   // scene-001 primary A
    expect(rowB.cells[0].role).toBe('secondary');  // scene-001 secondary B
    expect(rowA.cells[1]).toBeNull();              // scene-002 not on A
    expect(rowB.cells[1].role).toBe('primary');    // scene-002 primary B
  });

  it('counts only primary scenes per plotline', () => {
    const { rows } = buildPlotlineGrid(scenes, plotlines);
    expect(rows.find((r) => r.plotline.id === 'A').count).toBe(2);
    expect(rows.find((r) => r.plotline.id === 'B').count).toBe(1);
  });

  it('tolerates empty / non-array inputs', () => {
    expect(buildPlotlineGrid(null, null)).toEqual({ columns: [], rows: [] });
    expect(buildPlotlineGrid([], plotlines).rows.every((r) => r.cells.length === 0)).toBe(true);
  });
});

describe('sceneComponentCount', () => {
  it('counts the present prose modes (0–3)', () => {
    expect(sceneComponentCount({ components: { narrative: true, action: true, dialogue: true } })).toBe(3);
    expect(sceneComponentCount({ components: { narrative: true, action: false, dialogue: true } })).toBe(2);
    expect(sceneComponentCount({ components: {} })).toBe(0);
    expect(sceneComponentCount({})).toBe(0);
    expect(sceneComponentCount(null)).toBe(0);
  });
});
