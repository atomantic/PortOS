// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  THREEJS_ENVIRONMENT_PRESETS as SERVER_PRESETS,
  DEFAULT_THREEJS_ENVIRONMENT as SERVER_DEFAULT,
  THREEJS_RENDER_PROFILE as SERVER_RENDER_PROFILE,
  resolveThreejsEnvironment,
} from '../../../server/lib/threejsModel.js';
import {
  THREEJS_ENVIRONMENT_PRESETS,
  DEFAULT_THREEJS_ENVIRONMENT,
  THREEJS_RENDER_PROFILE,
  createSculptEnvironmentScene,
  createSculptEnvironmentTexture,
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
    const scene = createSculptEnvironmentScene('studio');
    const geometries = [];
    const materials = [];
    scene.traverse((node) => {
      if (node.geometry) geometries.push(vi.spyOn(node.geometry, 'dispose'));
      if (node.material) materials.push(vi.spyOn(node.material, 'dispose'));
    });
    disposeSculptEnvironmentScene(scene);
    expect(geometries.length).toBeGreaterThan(0);
    for (const spy of [...geometries, ...materials]) expect(spy).toHaveBeenCalled();
  });
});

describe('createSculptEnvironmentTexture', () => {
  it('returns null without building anything for none or a missing renderer', () => {
    expect(createSculptEnvironmentTexture(null, 'studio')).toBeNull();
    expect(createSculptEnvironmentTexture({}, 'none')).toBeNull();
  });
});
