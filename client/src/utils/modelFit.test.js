import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { fitModelToHeight } from './modelFit.js';

// Build a scene-root Group (what GLTFLoader hands back) holding one box mesh of
// the given dimensions, offset so the box sits at an arbitrary place in space.
// Assertions below check where the box lands in WORLD space, not the formula.
function makeModel({ width = 1, height = 4, depth = 1, offset = [0, 0, 0] } = {}) {
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth));
  mesh.position.set(...offset);
  root.add(mesh);
  return root;
}

// Where the model's bounding box actually ends up once the fit is applied.
function worldBox(object) {
  object.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(object);
}

describe('fitModelToHeight', () => {
  it('scales the model so its rendered height matches targetHeight', () => {
    const model = makeModel({ height: 8 });
    fitModelToHeight(model, { targetHeight: 2 });
    const box = worldBox(model);
    expect(box.getSize(new THREE.Vector3()).y).toBeCloseTo(2, 5);
  });

  it('scales uniformly, preserving the source aspect ratio', () => {
    const model = makeModel({ width: 3, height: 6, depth: 1.5 });
    fitModelToHeight(model, { targetHeight: 3 });
    const size = worldBox(model).getSize(new THREE.Vector3());
    expect(size.x / size.y).toBeCloseTo(3 / 6, 5);
    expect(size.z / size.y).toBeCloseTo(1.5 / 6, 5);
  });

  it('centers the model vertically by default', () => {
    const model = makeModel({ height: 4, offset: [7, 12, -3] });
    fitModelToHeight(model, { targetHeight: 2 });
    const center = worldBox(model).getCenter(new THREE.Vector3());
    expect(center.x).toBeCloseTo(0, 5);
    expect(center.y).toBeCloseTo(0, 5);
    expect(center.z).toBeCloseTo(0, 5);
  });

  it('rests the lowest point on y=0 with feetOnGround, still recentering x/z', () => {
    const model = makeModel({ height: 4, offset: [7, 12, -3] });
    fitModelToHeight(model, { targetHeight: 2, feetOnGround: true });
    const box = worldBox(model);
    expect(box.min.y).toBeCloseTo(0, 5);
    const center = box.getCenter(new THREE.Vector3());
    expect(center.x).toBeCloseTo(0, 5);
    expect(center.z).toBeCloseTo(0, 5);
  });

  it('lifts the anchor by yOffset — the centered anchor moves the center', () => {
    const model = makeModel({ height: 4 });
    fitModelToHeight(model, { targetHeight: 2, yOffset: 0.05 });
    expect(worldBox(model).getCenter(new THREE.Vector3()).y).toBeCloseTo(0.05, 5);
  });

  it('lifts the anchor by yOffset — the feet anchor moves the ground plane', () => {
    const model = makeModel({ height: 4 });
    fitModelToHeight(model, { targetHeight: 2.6, feetOnGround: true, yOffset: -1.4 });
    expect(worldBox(model).min.y).toBeCloseTo(-1.4, 5);
  });

  // Measuring an already-fitted object would compute scale ≈ 1 and blow the
  // model back up to source size, so every extra call must land in the same
  // place — including the second call StrictMode makes on the same scene.
  // Checked at each of the first four calls: a fit that merely oscillates
  // between two placements would pass a check made only on an odd call count.
  it.each([2, 3, 4])('lands in the same place on call %i as on the first', (calls) => {
    const model = makeModel({ height: 8, offset: [2, 5, 1] });
    fitModelToHeight(model, { targetHeight: 1.9, feetOnGround: true });
    const first = worldBox(model).clone();
    for (let i = 1; i < calls; i += 1) {
      fitModelToHeight(model, { targetHeight: 1.9, feetOnGround: true });
    }
    const after = worldBox(model);
    expect(after.min.toArray()).toEqual(first.min.toArray().map((v) => expect.closeTo(v, 5)));
    expect(after.max.toArray()).toEqual(first.max.toArray().map((v) => expect.closeTo(v, 5)));
  });

  it('keeps a zero-height model finite instead of scaling it to Infinity', () => {
    const model = makeModel({ height: 0 });
    fitModelToHeight(model, { targetHeight: 2 });
    expect(Number.isFinite(model.scale.x)).toBe(true);
    expect(model.position.toArray().every(Number.isFinite)).toBe(true);
  });

  it('leaves a geometry-less object at identity rather than flinging it to -Infinity', () => {
    const empty = new THREE.Group();
    empty.add(new THREE.Group());
    fitModelToHeight(empty, { targetHeight: 2, feetOnGround: true });
    expect(empty.position.toArray()).toEqual([0, 0, 0]);
    expect(empty.scale.toArray()).toEqual([1, 1, 1]);
  });
});
