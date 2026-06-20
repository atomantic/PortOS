import { describe, it, expect } from 'vitest';
import {
  INTERIOR_WINDOW,
  buildingHasInteriorWindows,
  computeWindowGrid,
} from './cityInteriorWindows';

describe('buildingHasInteriorWindows', () => {
  it('selects online, non-archived towers tall enough for a grid', () => {
    expect(buildingHasInteriorWindows({ overallStatus: 'online' }, 5)).toBe(true);
  });

  it('rejects archived buildings even when online and tall', () => {
    expect(buildingHasInteriorWindows({ overallStatus: 'online', archived: true }, 5)).toBe(false);
  });

  it('rejects non-online statuses', () => {
    for (const overallStatus of ['stopped', 'not_started', 'not_found', 'unknown']) {
      expect(buildingHasInteriorWindows({ overallStatus }, 5)).toBe(false);
    }
  });

  it('rejects towers below the minimum height', () => {
    expect(buildingHasInteriorWindows({ overallStatus: 'online' }, INTERIOR_WINDOW.minHeight - 0.01)).toBe(false);
    expect(buildingHasInteriorWindows({ overallStatus: 'online' }, INTERIOR_WINDOW.minHeight)).toBe(true);
  });

  it('rejects a missing app', () => {
    expect(buildingHasInteriorWindows(null, 5)).toBe(false);
    expect(buildingHasInteriorWindows(undefined, 5)).toBe(false);
  });
});

describe('computeWindowGrid', () => {
  // Asymmetric width !== depth so the per-face extent logic is actually
  // exercised (a width/depth swap in the placement math would change results).
  const dims = { width: 3, depth: 2, height: 5, seed: 42 };

  it('tiles all four vertical faces', () => {
    const windows = computeWindowGrid(dims);
    expect(windows.length).toBeGreaterThan(0);
    const rotations = new Set(windows.map((w) => w.rotationY.toFixed(4)));
    expect(rotations).toEqual(
      new Set([0, Math.PI, Math.PI / 2, -Math.PI / 2].map((r) => r.toFixed(4)))
    );
  });

  it('is deterministic for the same input', () => {
    expect(computeWindowGrid(dims)).toEqual(computeWindowGrid(dims));
  });

  it('varies window ids by seed', () => {
    const a = computeWindowGrid(dims);
    const b = computeWindowGrid({ ...dims, seed: 43 });
    expect(a[0].windowId).not.toEqual(b[0].windowId);
  });

  it('keeps per-pane window ids distinct after the Float32Array round-trip, even for a large hash', () => {
    // The instanced attribute stores windowId in a Float32Array, which loses
    // sub-integer precision past ~16.7M. A raw app-name hash this large must not
    // collapse every pane on a face to the same id (which would make every room
    // identical). Quantize through Float32Array exactly as the GPU upload does.
    const windows = computeWindowGrid({ width: 3, depth: 2, height: 5, seed: 1234567890 });
    const buf = new Float32Array(windows.length * 3);
    windows.forEach((w, i) => buf.set(w.windowId, i * 3));
    const keys = new Set(Array.from({ length: windows.length }, (_, i) => buf.slice(i * 3, i * 3 + 3).join(',')));
    // Distinct ids per pane (allow a tiny collision margin from the modular phase).
    expect(keys.size).toBeGreaterThan(windows.length * 0.9);
  });

  it('places panes proud of the correct face plane', () => {
    const { width, depth } = dims;
    const offset = depth / 2 + INTERIOR_WINDOW.inset;
    for (const w of computeWindowGrid(dims)) {
      const [x, , z] = w.position;
      if (w.rotationY === 0) expect(z).toBeCloseTo(offset, 5);
      else if (w.rotationY === Math.PI) expect(z).toBeCloseTo(-offset, 5);
      else if (w.rotationY === Math.PI / 2) expect(x).toBeCloseTo(width / 2 + INTERIOR_WINDOW.inset, 5);
      else if (w.rotationY === -Math.PI / 2) expect(x).toBeCloseTo(-(width / 2 + INTERIOR_WINDOW.inset), 5);
    }
  });

  it('keeps every pane within the usable vertical band and its own face width', () => {
    const { width, depth, height } = dims;
    for (const w of computeWindowGrid(dims)) {
      const [x, y, z] = w.position;
      expect(y).toBeGreaterThanOrEqual(INTERIOR_WINDOW.marginBottom);
      expect(y).toBeLessThanOrEqual(height - INTERIOR_WINDOW.marginTop);
      // Front/back faces span `width` (along x); side faces span `depth` (along
      // z). Each pane must stay inside the half-extent of its own face.
      const frontBack = w.rotationY === 0 || w.rotationY === Math.PI;
      const horiz = frontBack ? x : z;
      const halfExtent = (frontBack ? width : depth) / 2;
      expect(Math.abs(horiz)).toBeLessThanOrEqual(halfExtent);
    }
  });

  it('returns no windows when the tower is too short for a single row', () => {
    expect(computeWindowGrid({ width: 2, depth: 2, height: 1, seed: 1 })).toEqual([]);
  });
});
