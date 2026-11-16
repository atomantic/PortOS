/**
 * Three.js construction helpers for the validated procedural sculpt spec
 * (`server/lib/threejsModel.js`).
 *
 * These mirror the `createGeometry` / `createMaterial` bodies that
 * `buildThreejsFactorySource()` emits into the downloadable standalone factory,
 * so the in-browser preview and the exported source render the same scene.
 * Primitive geometries (box, sphere, cylinder, cone, torus, capsule, lathe) stay
 * declarative r3f elements; only the forms that need an imperatively-built
 * BufferGeometry live here.
 */

import * as THREE from 'three';

const BUFFER_GEOMETRY_TYPES = new Set(['custom', 'extrude', 'tube']);

/** True when the definition must be built with `createSculptBufferGeometry`. */
export const needsSculptBufferGeometry = (definition) => BUFFER_GEOMETRY_TYPES.has(definition?.type);

/**
 * Build a BufferGeometry for the schema forms r3f has no direct element for.
 * Returns null for primitive types, which the preview renders declaratively.
 * Callers own disposal.
 */
export function createSculptBufferGeometry(definition) {
  if (definition?.type === 'custom') {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(definition.vertices, 3));
    geometry.setIndex(definition.indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }
  if (definition?.type === 'extrude') {
    const shape = new THREE.Shape(definition.outline.map(([x, y]) => new THREE.Vector2(x, y)));
    for (const hole of definition.holes || []) {
      shape.holes.push(new THREE.Path(hole.map(([x, y]) => new THREE.Vector2(x, y))));
    }
    return new THREE.ExtrudeGeometry(shape, {
      depth: definition.depth,
      bevelEnabled: definition.bevelEnabled,
      bevelThickness: definition.bevelThickness,
      bevelSize: definition.bevelSize,
      bevelSegments: definition.bevelSegments,
      curveSegments: definition.curveSegments,
      steps: definition.steps,
    });
  }
  if (definition?.type === 'tube') {
    const curve = new THREE.CatmullRomCurve3(
      definition.path.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
      definition.closed,
      definition.curveType,
      definition.tension,
    );
    return new THREE.TubeGeometry(curve, definition.tubularSegments, definition.radius, definition.radialSegments, definition.closed);
  }
  return null;
}

/**
 * Map a validated material definition to the props for its Three.js material.
 * Physical-only channels are dropped for standard/basic so an authored spec that
 * carries schema defaults cannot leak unsupported props onto the wrong material.
 *
 * `envMapIntensity` is the spec-level `environment.intensity` (see
 * `threejsEnvironment.js`), forwarded to every lit material so the strength the
 * spec authored actually reaches the surfaces reflecting it. `basic` is unlit
 * and takes no environment at all. Mirrors `createMaterial()` in
 * `buildThreejsFactorySource()`, which reads the same value off the exported
 * render profile — the two must move together.
 */
export function sculptMaterialProps(definition, envMapIntensity = 1) {
  const doubleSided = definition.side === 'double' ? { side: THREE.DoubleSide } : {};
  const unlit = {
    color: definition.color,
    opacity: definition.opacity,
    transparent: definition.transparent,
    wireframe: definition.wireframe,
    ...doubleSided,
  };
  if (definition.type === 'basic') return unlit;
  const lit = {
    ...unlit,
    metalness: definition.metalness,
    roughness: definition.roughness,
    emissive: definition.emissive,
    emissiveIntensity: definition.emissiveIntensity,
    envMapIntensity,
  };
  if (definition.type !== 'physical') return lit;
  return {
    ...lit,
    clearcoat: definition.clearcoat,
    clearcoatRoughness: definition.clearcoatRoughness,
    ior: definition.ior,
    transmission: definition.transmission,
    thickness: definition.thickness,
    sheen: definition.sheen,
    iridescence: definition.iridescence,
    anisotropy: definition.anisotropy,
  };
}
