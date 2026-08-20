// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

// PMREM prefiltering needs a live WebGL context, which node has none of — so the
// generator is the one piece stubbed out. Everything the module owns around it
// (which scene it hands over, and releasing the generator and that scene
// afterwards) is exercised for real.
const pmrem = vi.hoisted(() => ({ renderers: [], calls: [], disposals: 0, sceneDisposals: [], fail: false }));
vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal();
  function FakePMREMGenerator(renderer) {
    pmrem.renderers.push(renderer);
    return {
      fromScene(scene, sigma) {
        // Spy here rather than after the call: the module disposes the scene on
        // the way out, so this is the last moment its nodes are reachable.
        scene.traverse((node) => {
          if (node.geometry) pmrem.sceneDisposals.push(vi.spyOn(node.geometry, 'dispose'));
          if (node.material) pmrem.sceneDisposals.push(vi.spyOn(node.material, 'dispose'));
        });
        pmrem.calls.push({ scene, sigma });
        if (pmrem.fail) throw new Error('context lost');
        return { texture: { isTexture: true }, dispose: vi.fn() };
      },
      dispose() { pmrem.disposals += 1; },
    };
  }
  return { ...actual, PMREMGenerator: FakePMREMGenerator };
});
import {
  THREEJS_ENVIRONMENT_PRESETS as SERVER_PRESETS,
  DEFAULT_THREEJS_ENVIRONMENT as SERVER_DEFAULT,
  THREEJS_RENDER_PROFILE as SERVER_RENDER_PROFILE,
  resolveThreejsEnvironment,
} from '../../../server/lib/threejsModelEnvironment.js';
import {
  THREEJS_ENVIRONMENT_PRESETS,
  DEFAULT_THREEJS_ENVIRONMENT,
  THREEJS_RENDER_PROFILE,
  createSculptEnvironmentScene,
  createSculptEnvironmentTarget,
  disposeSculptEnvironmentScene,
  resolveSculptEnvironment,
} from './threejsEnvironment.js';

describe('preset contract parity with the server schema', () => {
  // The server schema is the authoring contract. A preset the viewer cannot
  // build would be accepted from a provider and then render as nothing, which is
  // exactly the "authored metal has no environment" bug this module exists to
  // close — so the two lists have to be one list.
  it('offers exactly the presets the spec schema accepts', () => {
    expect(THREEJS_ENVIRONMENT_PRESETS).toEqual(SERVER_PRESETS);
    expect(DEFAULT_THREEJS_ENVIRONMENT).toEqual(SERVER_DEFAULT);
  });

  // The export stamps the server's copy onto every model; the preview renders at
  // the client's. Let them drift and the exported render profile is a lie.
  it('renders at the render profile the export stamps on the model', () => {
    expect(THREEJS_RENDER_PROFILE).toEqual(SERVER_RENDER_PROFILE);
  });

  it('resolves a spec the same way the server does', () => {
    const specs = [
      null,
      {},
      { environment: { preset: 'studio', intensity: 2 } },
      { environment: { preset: 'neutral' } },
      { environment: { preset: 'hdri', intensity: 3 } },
      { environment: { intensity: Number.NaN } },
      { environment: 'studio' },
    ];
    for (const spec of specs) {
      expect(resolveSculptEnvironment(spec)).toEqual(resolveThreejsEnvironment(spec));
    }
  });

  it('reads a spec with no environment key as none — what it was authored against', () => {
    expect(resolveSculptEnvironment({ lights: [] })).toEqual({ preset: 'none', intensity: 1 });
  });
});

describe('createSculptEnvironmentScene', () => {
  it('builds nothing for none, or for a preset a newer peer authored', () => {
    expect(createSculptEnvironmentScene('none')).toBeNull();
    expect(createSculptEnvironmentScene('hdri')).toBeNull();
    expect(createSculptEnvironmentScene(undefined)).toBeNull();
  });

  it('builds the neutral room and the studio rig entirely in-process', () => {
    for (const preset of ['neutral', 'studio']) {
      const scene = createSculptEnvironmentScene(preset);
      expect(scene).toBeInstanceOf(THREE.Scene);
      expect(scene.children.length).toBeGreaterThan(0);
      disposeSculptEnvironmentScene(scene);
    }
  });

  // The reason for hand-building `studio` rather than reaching for drei's
  // <Environment preset=…>: a conductor needs bright sources against a dark
  // surround to read as metal, and PortOS must fetch no HDR to render locally.
  it('gives studio emissive panels brighter than white against a dark shell', () => {
    const scene = createSculptEnvironmentScene('studio');
    const brightness = scene.children.map((child) => child.material.color.r);
    expect(Math.max(...brightness)).toBeGreaterThan(1);
    expect(Math.min(...brightness)).toBeLessThan(0.2);
    disposeSculptEnvironmentScene(scene);
  });

  it('releases every geometry and material the preset allocated', () => {
    for (const preset of ['neutral', 'studio']) {
      const scene = createSculptEnvironmentScene(preset);
      const spies = [];
      scene.traverse((node) => {
        if (node.geometry) spies.push(vi.spyOn(node.geometry, 'dispose'));
        if (node.material) spies.push(vi.spyOn(node.material, 'dispose'));
      });
      disposeSculptEnvironmentScene(scene);
      expect(spies.length).toBeGreaterThan(0);
      for (const spy of spies) expect(spy).toHaveBeenCalled();
    }
  });

  // RoomEnvironment is built from InstancedMesh, whose per-instance matrix
  // buffer is uploaded separately and survives disposing geometry + material.
  it('releases an instanced mesh’s own GPU buffers too', () => {
    const scene = createSculptEnvironmentScene('neutral');
    const instanced = [];
    scene.traverse((node) => {
      if (node.isInstancedMesh) instanced.push(vi.spyOn(node, 'dispose'));
    });
    expect(instanced.length).toBeGreaterThan(0);
    disposeSculptEnvironmentScene(scene);
    for (const spy of instanced) expect(spy).toHaveBeenCalled();
  });
});

describe('createSculptEnvironmentTarget', () => {
  const renderer = { isWebGLRenderer: true };

  beforeEach(() => {
    pmrem.renderers.length = 0;
    pmrem.calls.length = 0;
    pmrem.sceneDisposals.length = 0;
    pmrem.disposals = 0;
    pmrem.fail = false;
  });

  it('returns null without building anything for none or a missing renderer', () => {
    expect(createSculptEnvironmentTarget(null, 'studio')).toBeNull();
    expect(createSculptEnvironmentTarget(renderer, 'none')).toBeNull();
    expect(pmrem.calls).toHaveLength(0);
  });

  // The TARGET, not its texture: the framebuffer behind it is only freed by
  // WebGLRenderTarget.dispose(), so handing back the texture alone would leak it
  // on every preset swap.
  it('prefilters the preset scene and hands back the whole render target', () => {
    const target = createSculptEnvironmentTarget(renderer, 'studio');

    expect(pmrem.renderers).toEqual([renderer]);
    expect(pmrem.calls).toHaveLength(1);
    expect(pmrem.calls[0].scene).toBeInstanceOf(THREE.Scene);
    expect(target.texture.isTexture).toBe(true);
  });

  it('releases the generator and the source scene, on success and on failure alike', () => {
    createSculptEnvironmentTarget(renderer, 'studio');
    expect(pmrem.disposals).toBe(1);
    expect(pmrem.sceneDisposals.length).toBeGreaterThan(0);
    for (const spy of pmrem.sceneDisposals) expect(spy).toHaveBeenCalled();

    // A lost GL context still throws through to the caller — but not before the
    // generator and the scene it was handed are released.
    pmrem.fail = true;
    pmrem.sceneDisposals.length = 0;
    expect(() => createSculptEnvironmentTarget(renderer, 'neutral')).toThrow('context lost');
    expect(pmrem.disposals).toBe(2);
    for (const spy of pmrem.sceneDisposals) expect(spy).toHaveBeenCalled();
  });
});
