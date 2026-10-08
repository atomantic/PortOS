import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const threeUrl = pathToFileURL(join(dirname(require.resolve('three')), 'three.module.js')).href;
const THREE = await import(threeUrl);
// The shipped source resolves beside a stored document's vendor/ directory.
const source = (await readFile(new URL('./toonWorld.js', import.meta.url), 'utf8')).replace("'./vendor/three.module.js'", JSON.stringify(threeUrl));
const { layoutRow, layoutGrid, shellLathe, solidify, warnOverlaps } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

describe('toon world geometry and placement', () => {
  it('keeps footprint clearance for empty, single, long, and curved rows/grids', () => {
    for (const count of [0, 1, 2, 7, 101]) for (const footprint of [0.01, 1, 23]) for (const gap of [0, 0.3]) {
      for (const layout of [layoutRow, layoutGrid]) {
        const points = layout({ count, footprint, gap, curve: x => Math.sin(x) * 4 });
        expect(points).toHaveLength(count);
        for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
          expect(Math.max(Math.abs(points[i].x - points[j].x), Math.abs(points[i].z - points[j].z)) + 1e-8).toBeGreaterThanOrEqual(footprint + gap);
        }
      }
    }
    expect(() => layoutRow({ count: 7, footprint: 0 })).toThrow();
    expect(() => layoutRow({ count: 7, footprint: 2, gap: -1 })).toThrow();
  });

  it('closes a bowl with normals facing out of the solid on outer and inner surfaces', () => {
    const profile = Array.from({ length: 17 }, (_, i) => [i / 16, (i / 16) ** 2 * .5]);
    const shell = shellLathe(profile, .08, 32);
    const n = shell.getAttribute('normal'), p = shell.getAttribute('position');
    const stride = profile.length * 2 + 1;
    const outer = 8, inner = profile.length + 8;
    expect(n.getY(outer)).toBeLessThan(-.5); // outside/bottom
    expect(n.getY(inner)).toBeGreaterThan(.5); // inside/top
    expect(n.getZ(outer)).toBeGreaterThan(.1);
    expect(n.getZ(inner)).toBeLessThan(-.1);
    expect(p.getY(profile.length * 2 - 1) - p.getY(0)).toBeCloseTo(.08);
    // Radial seam and contour seam close geometrically.
    for (let i = 0; i < stride; i++) {
      expect(p.getX(i)).toBeCloseTo(p.getX(i + 32 * stride));
      expect(p.getZ(i)).toBeCloseTo(p.getZ(i + 32 * stride));
    }
    expect(() => shellLathe([[0, 0], [.01, 1]], .5)).toThrow();
    shell.dispose();
    const dome = shellLathe([[1, 0], [.7, .7], [0, 1]], .08, 32);
    const dp = dome.getAttribute('position'), dn = dome.getAttribute('normal');
    expect(dp.getY(3)).toBeLessThan(dp.getY(2)); // tip offset goes into a dome
    expect(dn.getY(1)).toBeGreaterThan(0);
    expect(dn.getY(4)).toBeLessThan(0);
    dome.dispose();
  });

  it('solidifies indexed and unindexed sheets with only boundary walls and preserved front/back normals', () => {
    const sheet = new THREE.PlaneGeometry(2, 2, 2, 2);
    for (const input of [sheet, sheet.toNonIndexed()]) {
      const result = solidify(input, .2);
      expect(result.index.count).toBe(sheet.index.count * 2 + 8 * 6);
      const n = result.getAttribute('normal'), p = result.getAttribute('position');
      expect(n.getZ(0)).toBe(1); expect(n.getZ(1)).toBe(-1);
      expect(p.getZ(0)).toBeCloseTo(.1); expect(p.getZ(1)).toBeCloseTo(-.1);
      result.dispose();
    }
    expect(sheet.getAttribute('position').getZ(0)).toBe(0);
    sheet.dispose();
  });

  it('closes a folded non-indexed sheet without cracks at its hard normal seam', () => {
    const folded = new THREE.BufferGeometry();
    folded.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      1, 0, 0, 0, 0, 0, 0, 0, 1,
    ], 3));
    const shell = solidify(folded, .2);
    const p = shell.getAttribute('position'), n = shell.getAttribute('normal');
    for (const [a, b] of [[0, 8], [2, 6], [1, 9], [3, 7]]) {
      expect([p.getX(a), p.getY(a), p.getZ(a)]).toEqual([p.getX(b), p.getY(b), p.getZ(b)]);
    }
    expect(n.getZ(0)).toBe(1); expect(n.getY(8)).toBe(1);
    const edges = new Map();
    const point = i => [p.getX(i), p.getY(i), p.getZ(i)].map(v => Math.round(v * 1e6)).join(',');
    const indices = shell.index.array;
    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = [...indices.slice(i, i + 3)].map(point);
      for (const pair of [[a, b], [b, c], [c, a]]) {
        const key = pair.sort().join('|');
        edges.set(key, (edges.get(key) || 0) + 1);
      }
    }
    expect([...edges.values()].every(count => count === 2)).toBe(true);
    expect(shell.index.count).toBe(36);
    folded.dispose(); shell.dispose();
  });

  it('warns for actual transformed bounds, while touching or spaced bounds are allowed', () => {
    const objects = layoutRow({ count: 7, footprint: 2, gap: .1 }).map(p => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 2));
      mesh.position.set(p.x, p.y, p.z); return mesh;
    });
    const warn = vi.fn();
    expect(warnOverlaps(THREE, objects, { warn })).toEqual([]);
    objects[1].position.copy(objects[0].position);
    expect(warnOverlaps(THREE, objects, { warn })).toEqual([[0, 1]]);
    expect(warn).toHaveBeenCalledOnce();
    objects.forEach(o => { o.geometry.dispose(); o.material.dispose(); });
  });
});
