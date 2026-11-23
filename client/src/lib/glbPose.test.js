/**
 * The GLB a real Blender 5.3 build exported (box-with-lid.gltf.json), posed the way the viewer poses it, against a plain
 * three.js AnimationMixer and against where the hinge puts the lid.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AnimationMixer, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { createGlbPoser } from './glbPose.js';

const COMPONENTS = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };

/** The exported GLB, reassembled from its JSON and the numbers of each buffer view. */
function glb() {
  const { gltf, views } = JSON.parse(readFileSync(resolve(process.cwd(), 'src/test/fixtures/box-with-lid.gltf.json'), 'utf8'));
  const header = Buffer.from(JSON.stringify(gltf));
  const json = Buffer.concat([header, Buffer.alloc(-header.length & 3, ' ')]);
  const bin = Buffer.alloc(gltf.buffers[0].byteLength);
  views.forEach(({ componentType, values }, index) => Buffer.from(COMPONENTS[componentType].from(values).buffer).copy(bin, gltf.bufferViews[index].byteOffset ?? 0));
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(data.length, 0);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, data]);
  };
  const body = Buffer.concat([chunk('JSON', json), chunk('BIN\0', bin)]);
  const start = Buffer.alloc(12);
  start.write('glTF', 0, 'latin1');
  start.writeUInt32LE(2, 4);
  start.writeUInt32LE(12 + body.length, 8);
  return new Uint8Array(Buffer.concat([start, body])).buffer;
}

const bytes = glb();
const load = () => new GLTFLoader().parseAsync(bytes.slice(0), '');
const worldMatrices = (scene) => {
  scene.updateMatrixWorld(true);
  const found = {};
  scene.traverse((object) => { found[object.userData.name || object.name] = object.matrixWorld.elements.slice(); });
  return found;
};
const expectSame = (a, b) => {
  expect(Object.keys(a)).toEqual(Object.keys(b));
  for (const name of Object.keys(a)) a[name].forEach((value, index) => expect(value).toBeCloseTo(b[name][index], 6));
};
const named = (scene, name) => {
  let found = null;
  scene.traverse((object) => { if (object.userData.name === name || object.name === name) found = object; });
  return found;
};

describe('createGlbPoser', () => {
  let gltf;
  let poser;
  beforeEach(async () => {
    gltf = await load();
    poser = createGlbPoser(gltf.scene, gltf.animations);
  });

  it('exports one one-second clip per control, and each action', () => {
    expect(gltf.animations.map((clip) => clip.name).sort()).toEqual(['action:open', 'control:clip', 'control:lid']);
    for (const name of ['control:lid', 'control:clip']) expect(gltf.animations.find((clip) => clip.name === name).duration).toBe(1);
  });

  it.each([0, 0.15, 0.5, 0.73, 1])('poses the lid and the clip at %s as a plain mixer seeking each clip does', async (value) => {
    poser.seek({ 'control:lid': value, 'control:clip': 1 - value });
    const plain = await load();
    // A mixer per clip, so each can seek to its own time.
    for (const [name, time] of [['control:lid', value], ['control:clip', 1 - value]]) {
      const mixer = new AnimationMixer(plain.scene);
      const action = mixer.clipAction(plain.animations.find((clip) => clip.name === name));
      action.clampWhenFinished = true;
      action.play();
      mixer.setTime(Math.min(time, 1 - 1e-9));
    }
    expectSame(worldMatrices(gltf.scene), worldMatrices(plain.scene));
  });

  it('turns the lid about the hinge it declares: 110 degrees at 1, clamped past it', () => {
    const rest = named(gltf.scene, 'lid').getWorldPosition(new Vector3());
    // Blender's (0, 0.1, 0.151) hinge is (0, 0.151, -0.1) in glTF's Y-up space.
    const hinge = new Vector3(0, 0.151, -0.1);
    const opened = (value) => {
      poser.seek({ 'control:lid': value });
      return named(gltf.scene, 'lid').getWorldPosition(new Vector3());
    };
    const angle = opened(1).sub(hinge).angleTo(rest.clone().sub(hinge));
    expect((angle * 180) / Math.PI).toBeCloseTo(110, 3);
    expect(opened(1.3).distanceTo(opened(1))).toBeCloseTo(0, 9);
    expect(opened(-0.3).distanceTo(rest)).toBeCloseTo(0, 6);
  });

  it('ignores a clip the GLB does not have, and puts the shared scene back on dispose', () => {
    const before = worldMatrices(gltf.scene);
    poser.seek({ 'control:lid': 0.6, 'control:ghost': 1 });
    expect(named(gltf.scene, 'lid').getWorldPosition(new Vector3()).y).toBeGreaterThan(0.2);
    poser.dispose();
    expectSame(worldMatrices(gltf.scene), before);
  });
});
