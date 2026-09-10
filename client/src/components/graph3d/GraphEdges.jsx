import { useEffect, useRef } from 'react';
import * as THREE from 'three';

/**
 * Shared edge geometry for the 3D graph scenes (BrainGraph, MemoryGraph): one
 * line-segment buffer built from `simEdges`, colored and dimmed per edge.
 *
 * `edgeColor`/`edgeIntensity` are callbacks rather than a fixed palette so
 * each page's own edge legend reproduces its current render exactly —
 * BrainGraph's three-way similar/shared_tag/linked color map with a
 * `weight || 0.5` fallback for an unweighted edge, and MemoryGraph's flat
 * blue-linked/gray-everything-else, weight-scaled for both edge kinds.
 *
 * @param {{sourceNode:{x,y,z}, targetNode:{x,y,z}, source, target}[]} simEdges
 * @param {string|null} [selectedId]
 * @param {(edge:object) => string} edgeColor
 * @param {(edge:object, dimmed:boolean) => number} edgeIntensity
 */
export default function GraphEdges({ simEdges, selectedId, edgeColor, edgeIntensity }) {
  const geoRef = useRef();

  useEffect(() => {
    const geo = geoRef.current;
    if (!geo || !simEdges.length) return;

    const count = simEdges.length;
    const positions = new Float32Array(count * 6);
    const colors = new Float32Array(count * 6);
    const tmpColor = new THREE.Color();

    simEdges.forEach((e, i) => {
      const a = e.sourceNode, b = e.targetNode;
      const off = i * 6;
      positions[off] = a.x; positions[off + 1] = a.y; positions[off + 2] = a.z;
      positions[off + 3] = b.x; positions[off + 4] = b.y; positions[off + 5] = b.z;

      const dimmed = !!(selectedId && e.source !== selectedId && e.target !== selectedId);
      tmpColor.set(edgeColor(e));
      const intensity = edgeIntensity(e, dimmed);
      const r = tmpColor.r * intensity, g = tmpColor.g * intensity, bl = tmpColor.b * intensity;
      colors[off] = r; colors[off + 1] = g; colors[off + 2] = bl;
      colors[off + 3] = r; colors[off + 4] = g; colors[off + 5] = bl;
    });

    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeBoundingSphere();
  }, [simEdges, selectedId, edgeColor, edgeIntensity]);

  return (
    <lineSegments>
      <bufferGeometry ref={geoRef} />
      <lineBasicMaterial vertexColors />
    </lineSegments>
  );
}
