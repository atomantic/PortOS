import { useEffect, useMemo, memo } from 'react';
import { useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import GraphEdges from './GraphEdges';
import { pickNearestNodeByScreenDistance } from '../../lib/graphPicking';

// The force layout is settled before the scene renders, so reduced-motion
// users can see it immediately at rest. Keep the canvas on demand and turn
// off OrbitControls' inertia too, preventing movement after an interaction.
// Canonical home for both graph pages — call from the page that owns the
// <Canvas> to size its `frameloop` prop; GraphScene reads `reducedMotion`
// directly for its own OrbitControls damping.
export const graphMotionSettings = (reducedMotion) => ({
  frameloop: reducedMotion ? 'demand' : 'always',
  enableDamping: !reducedMotion
});

// Memoized: the container's onPointerMove re-renders the owning page on every
// mouse move over the canvas WHILE A NODE IS HOVERED (it tracks the tooltip
// position), and every prop here is already identity-stable across that
// render — so without memo each move reconciles a <mesh> per node for
// nothing (#4116).
const GraphScene = memo(function GraphScene({
  graph,
  selectedId,
  adjacentIds,
  nodeColor,
  edgeColor,
  edgeIntensity,
  onSelect,
  onFocus,
  onHover,
  pickRef,
  touchGestureRef,
  reducedMotion = false
}) {
  const sphereGeo = useMemo(() => new THREE.SphereGeometry(1, 16, 12), []);
  const { camera, size } = useThree();

  const selNode = selectedId ? graph.idMap.get(selectedId) : null;
  const selRadius = selNode ? 0.4 + (selNode.importance ?? 0.5) * 0.8 : 0;

  // Publish a live screen-space pick to the DOM wrapper, which owns the touch
  // gesture (see useGraphCanvasInteraction). The camera object is stable
  // across orbiting, so the matrices are read at tap time, not captured here.
  useEffect(() => {
    if (!pickRef) return;
    pickRef.current = (point) => {
      camera.updateMatrixWorld();
      const viewProjection = new THREE.Matrix4()
        .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
        .elements;
      return pickNearestNodeByScreenDistance({
        nodes: graph.simNodes,
        viewProjection,
        width: size.width,
        height: size.height,
        point
      });
    };
    return () => { pickRef.current = null; };
  }, [camera, graph, size.width, size.height, pickRef]);

  return (
    <>
      <ambientLight intensity={0.4} />
      <pointLight position={[50, 50, 50]} intensity={0.8} />
      <pointLight position={[-30, -30, -30]} intensity={0.3} />

      <GraphEdges
        simEdges={graph.simEdges}
        selectedId={selectedId}
        edgeColor={edgeColor}
        edgeIntensity={edgeIntensity}
      />

      {graph.simNodes.map(node => {
        const radius = 0.4 + (node.importance ?? 0.5) * 0.8;
        const color = nodeColor(node);
        const isSelected = node.id === selectedId;
        const isConnected = adjacentIds?.has(node.id);
        const dimmed = selectedId && !isSelected && !isConnected;

        return (
          <mesh
            key={node.id}
            geometry={sphereGeo}
            scale={radius}
            position={[node.x, node.y, node.z]}
            // Touch selection is owned by the wrapper's threshold pick, which
            // fires on `pointerup` — ahead of the compatibility `click` r3f
            // raycasts here — so a tap that lands on a mesh must not toggle the
            // same node a second time. `click` is a MouseEvent with no
            // `pointerType` after a touch, hence the recorded gesture ref.
            onClick={(e) => {
              e.stopPropagation();
              if (touchGestureRef?.current) return;
              onSelect(node);
            }}
            // `onFocus` is optional — MemoryGraph has no focus stack to drill
            // into, so it passes none and a double-click here is a no-op,
            // matching its pre-extraction behavior of never binding the prop.
            onDoubleClick={onFocus ? (e) => { e.stopPropagation(); onFocus(node); } : undefined}
            // Pass the enter event's coordinates up: the wrapper's onPointerMove
            // only tracks the cursor WHILE a node is hovered, so the tooltip's
            // first frame has to be placed from this event.
            onPointerOver={(e) => { e.stopPropagation(); onHover(node, { x: e.clientX, y: e.clientY }); }}
            onPointerOut={() => onHover(null)}
          >
            <meshStandardMaterial
              color={dimmed ? '#1a1a1a' : color}
              emissive={color}
              emissiveIntensity={isSelected ? 0.6 : (dimmed ? 0.03 : 0.2)}
            />
          </mesh>
        );
      })}

      {selNode && (
        <mesh geometry={sphereGeo} position={[selNode.x, selNode.y, selNode.z]} scale={selRadius + 0.2}>
          <meshBasicMaterial color="#ffffff" transparent opacity={0.15} wireframe />
        </mesh>
      )}

      <OrbitControls enableDamping={!reducedMotion} dampingFactor={0.05} minDistance={10} maxDistance={200} />
    </>
  );
});

export default GraphScene;
