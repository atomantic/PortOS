// Draws geometry edges and a distance-faded floor grid, and keeps scene labels facing the active camera.
import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Color, DoubleSide, EdgesGeometry, Quaternion } from 'three';

export function Edges({ threshold, color, userData }) {
  const line = useRef(null);
  const source = useRef(null);
  // R3F can replace a sibling boxGeometry's args without remounting the mesh.
  // Read the attached geometry after each commit, including parent-only edits.
  useLayoutEffect(() => {
    const geometry = line.current.parent.geometry;
    if (source.current?.geometry === geometry && source.current.threshold === threshold) return;
    const edges = new EdgesGeometry(geometry, threshold);
    source.current?.edges.dispose();
    source.current = { geometry, threshold, edges };
    line.current.geometry = edges;
  });
  useLayoutEffect(() => () => {
    source.current?.edges.dispose();
    source.current = null;
  }, []);
  return <lineSegments ref={line} userData={userData}><lineBasicMaterial color={color} /></lineSegments>;
}

const gridVertex = `
  varying vec3 world;
  uniform float fadeDistance;
  uniform bool infiniteGrid;
  void main() {
    world = (modelMatrix * vec4(position.x, 0., position.y, 1.)).xyz;
    if (infiniteGrid) world.xz = cameraPosition.xz + position.xy * (fadeDistance + 1.);
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.);
  }`;
const gridFragment = `
  varying vec3 world;
  uniform float cellSize, sectionSize, fadeDistance;
  uniform vec3 cellColor, sectionColor;
  float lineAt(float stepSize) {
    vec2 coord = world.xz / stepSize;
    vec2 line = abs(fract(coord - .5) - .5) / fwidth(coord);
    return 1. - min(min(line.x, line.y), 1.);
  }
  void main() {
    float cell = lineAt(cellSize);
    float section = lineAt(sectionSize);
    float fade = max(0., 1. - distance(cameraPosition.xz, world.xz) / fadeDistance);
    gl_FragColor = vec4(mix(cellColor, sectionColor, section), max(cell, section) * fade);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

export function Grid({ args, cellSize, sectionSize, cellColor, sectionColor, fadeDistance, infiniteGrid }) {
  const uniforms = useMemo(() => ({
    cellSize: { value: cellSize }, sectionSize: { value: sectionSize },
    cellColor: { value: new Color(cellColor) }, sectionColor: { value: new Color(sectionColor) },
    fadeDistance: { value: fadeDistance }, infiniteGrid: { value: infiniteGrid },
  }), [cellColor, cellSize, fadeDistance, infiniteGrid, sectionColor, sectionSize]);
  return <mesh frustumCulled={false}>
    <planeGeometry args={infiniteGrid ? [2, 2] : args} />
    <shaderMaterial uniforms={uniforms} vertexShader={gridVertex} fragmentShader={gridFragment} side={DoubleSide} transparent depthWrite={false} />
  </mesh>;
}

export function Billboard({ ref, position, children }) {
  const face = useRef(null);
  const worldRotation = useMemo(() => new Quaternion(), []);
  useFrame(({ camera }) => {
    // Undo the parent's world rotation before applying the camera's.
    face.current.parent.getWorldQuaternion(face.current.quaternion).invert();
    face.current.quaternion.multiply(camera.getWorldQuaternion(worldRotation));
  });
  return <group ref={ref} position={position}><group ref={face}>{children}</group></group>;
}
