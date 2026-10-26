import { forwardRef, memo, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { Canvas, useThree } from '@react-three/fiber';
import { Edges, Grid, Html, OrbitControls } from '@react-three/drei';
import { aspectRatio, fovFromFocalLength, partColor } from '../../lib/greybox';
import useGreyboxAnchorDrag from './useGreyboxAnchorDrag';

const BACKGROUND = '#1b1e24';
const FIGURE_COLOR = '#e0884a';
const PROP_COLOR = '#4aa8a0';
const CAPTURE_LONG_EDGE = 1280;
const DEFAULT_VIEW = Object.freeze({ position: [0, 8, 18], target: [0, 0, 0] });
const rad = (deg) => (deg * Math.PI) / 180;

// A closed XZ floor outline swept up from y=0. ExtrudeGeometry sweeps a shape
// drawn in XY along +Z; rotating -90° about X turns that sweep into +Y and maps
// shape-y to world -z, so the outline's z is negated on the way in.
function extrudeGeometry(part) {
  const shape = new THREE.Shape(part.outline.map(([x, z]) => new THREE.Vector2(x, -z)));
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: part.height, bevelEnabled: false });
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

// Select on press so the click after an anchor drag cannot select the floor.
const PartMesh = memo(function PartMesh({ part, color, selected, onSelect }) {
  const geometry = useMemo(() => (part.type === 'extrude' ? extrudeGeometry(part) : null), [part]);
  const [px, py, pz] = part.position;
  const [rx, ry, rz] = part.rotationDegrees;
  return (
    <group position={[px, py, pz]} rotation={[rad(rx), rad(ry), rad(rz)]} onPointerDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); onSelect?.(`parts:${part.id}`); }}>
      <mesh geometry={geometry || undefined} rotation={part.type === 'plane' ? [-Math.PI / 2, 0, 0] : undefined}>
        {part.type === 'box' && <boxGeometry args={part.size} />}
        {part.type === 'cylinder' && <cylinderGeometry args={[part.radius, part.radius, part.height, 32]} />}
        {part.type === 'plane' && <planeGeometry args={part.size} />}
        <meshStandardMaterial color={color} roughness={1} metalness={0} side={part.type === 'plane' ? THREE.DoubleSide : THREE.FrontSide} />
        <Edges threshold={20} color="#2b2f38" />
        {selected && <Edges threshold={20} color="#ffdd55" userData={{ greyboxHelper: true }} />}
      </mesh>
    </group>
  );
});

// A stand-in for a person or prop at its floor mark; the nose shows facing.
const AnchorProxy = memo(function AnchorProxy({ anchor, selected, onSelect, onMove, ghost = false, labelPortal }) {
  const dragHandlers = useGreyboxAnchorDrag(anchor, onMove, onSelect);
  const [x, y, z] = anchor.position;
  const height = anchor.heightMeters;
  const isFigure = anchor.kind === 'figure';
  const color = isFigure ? FIGURE_COLOR : PROP_COLOR;
  return (
    <group position={[x, y, z]} rotation={[0, rad(anchor.facingDegrees), 0]} {...dragHandlers}>
      <mesh position={[0, height / 2, 0]}>
        {isFigure
          ? <capsuleGeometry args={[0.22, Math.max(height - 0.44, 0.01), 6, 16]} />
          : <boxGeometry args={[0.5, height, 0.5]} />}
        <meshStandardMaterial color={color} roughness={0.9} transparent={ghost} opacity={ghost ? 0.25 : 1} />
      </mesh>
      <mesh position={[0, height * 0.85, 0.28]} rotation={[Math.PI / 2, 0, 0]}>
        <coneGeometry args={[0.07, 0.2, 12]} />
        <meshStandardMaterial color="#ffffff" />
      </mesh>
      {selected && <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]} userData={{ greyboxHelper: true }}>
        <ringGeometry args={[0.4, 0.5, 32]} /><meshBasicMaterial color="#ffdd55" side={THREE.DoubleSide} />
      </mesh>}
      <Html portal={labelPortal} position={[0, height + 0.25, 0]} center style={{ pointerEvents: 'none' }}>
        <span className="port-media-overlay-strong px-1 rounded text-[10px] whitespace-nowrap">{anchor.label}</span>
      </Html>
    </group>
  );
});

// Lives inside the Canvas to expose the camera and a fixed-size capture to the
// panel. Capture re-renders at a set resolution (independent of the viewport) and
// hides the editor helpers (grid, landmark pins) so the reference holds only the
// layout and figure proxies.
function ViewApi({ apiRef, layout, shotView, focalLengthMm, aspect, helpersRef }) {
  const { camera, gl, scene, controls, invalidate } = useThree();
  const appliedViewId = useRef(null);

  // A selected shot's camera is applied once the controls exist, whenever the
  // lazy viewer finished loading relative to the selection.
  useEffect(() => {
    if (!shotView) {
      appliedViewId.current = null;
      return;
    }
    // Keyed on the camera itself, not just the id: a draft that re-frames the
    // selected shot must move the view, while an ordinary save leaves it where it is.
    const viewKey = `${shotView.id}:${shotView.position}:${shotView.target}`;
    if (!controls || appliedViewId.current === viewKey) return;
    appliedViewId.current = viewKey;
    camera.position.set(...shotView.position);
    controls.target.set(...shotView.target);
    controls.update();
    invalidate();
  }, [shotView, controls, camera, invalidate]);

  useEffect(() => {
    camera.fov = fovFromFocalLength(focalLengthMm);
    camera.updateProjectionMatrix();
  }, [camera, focalLengthMm]);

  // The canvas renders on demand; redraw when anything it shows changes.
  useEffect(() => { invalidate(); }, [layout, focalLengthMm, aspect, invalidate]);

  useImperativeHandle(apiRef, () => ({
    getView: () => ({ position: camera.position.toArray(), target: controls ? controls.target.toArray() : [0, 0, 0] }),
    capture: () => {
      const ratio = aspectRatio(aspect);
      const [width, height] = ratio >= 1
        ? [CAPTURE_LONG_EDGE, Math.round(CAPTURE_LONG_EDGE / ratio)]
        : [Math.round(CAPTURE_LONG_EDGE * ratio), CAPTURE_LONG_EDGE];
      const size = gl.getSize(new THREE.Vector2());
      const pixelRatio = gl.getPixelRatio();
      const previousAspect = camera.aspect;
      const hidden = [];
      scene.traverse((object) => { if (object.userData.greyboxHelper) { hidden.push([object, object.visible]); object.visible = false; } });
      if (helpersRef.current) helpersRef.current.visible = false;
      try {
        gl.setPixelRatio(1);
        gl.setSize(width, height, false);
        camera.aspect = ratio;
        camera.updateProjectionMatrix();
        gl.render(scene, camera);
        return gl.domElement.toDataURL('image/png');
      } finally {
        gl.setPixelRatio(pixelRatio);
        gl.setSize(size.x, size.y, false);
        camera.aspect = previousAspect;
        camera.updateProjectionMatrix();
        if (helpersRef.current) helpersRef.current.visible = true;
        invalidate();
        hidden.forEach(([object, visible]) => { object.visible = visible; });
      }
    },
  }), [camera, gl, scene, controls, aspect, helpersRef, invalidate]);
  return null;
}

/**
 * Orbit viewer for a place's greybox. The frame has the selected shot's aspect
 * so what you see is what a capture saves. `shotView` (`{ id, position, target }`)
 * moves the camera when its id or framing changes. `ref` exposes `getView()` and
 * `capture()` (PNG data URL).
 */
const GreyboxViewer = forwardRef(function GreyboxViewer({ scene, aspect = '16:9', focalLengthMm = 35, shotView = null, selected = '', onSelect, onMoveAnchor, activeShot = null }, ref) {
  const helpersRef = useRef(null);
  // The event target can be the canvas itself; HTML labels need a DOM overlay.
  const labelPortal = useRef(null);
  const ratio = aspectRatio(aspect);
  const start = shotView || DEFAULT_VIEW;
  const visibleAnchors = activeShot ? new Set(activeShot.figures.map((figure) => figure.anchorId)) : null;

  return (
    <div
      ref={labelPortal}
      className="relative mx-auto rounded-lg overflow-hidden border border-port-border bg-black"
      style={{ aspectRatio: ratio, width: `min(100%, ${70 * ratio}vh)` }}
      data-testid="greybox-viewer"
    >
      <Canvas
        camera={{ position: start.position, fov: fovFromFocalLength(focalLengthMm), near: 0.1, far: 2000 }}
        gl={{ preserveDrawingBuffer: true, antialias: true }}
        dpr={[1, 2]}
        frameloop="demand"
      >
        <color attach="background" args={[BACKGROUND]} />
        <ambientLight intensity={0.9} />
        <hemisphereLight args={['#ffffff', '#555a66', 0.6]} />
        <directionalLight position={[10, 18, 8]} intensity={1.4} />
        <group ref={helpersRef}>
          <Grid args={[200, 200]} cellSize={1} sectionSize={5} cellColor="#2e333d" sectionColor="#444b59" fadeDistance={80} infiniteGrid />
          {visibleAnchors && scene.anchors.filter((anchor) => !visibleAnchors.has(anchor.id)).map((anchor) =>
            <AnchorProxy key={anchor.id} anchor={anchor} selected={selected === `anchors:${anchor.id}`} onSelect={onSelect} onMove={onMoveAnchor} labelPortal={labelPortal} ghost />)}
          {scene.landmarks.map((l) => (
            <group key={l.id} position={l.position} onPointerDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); onSelect?.(`landmarks:${l.id}`); }}>
              <mesh>
                <sphereGeometry args={[selected === `landmarks:${l.id}` ? 0.24 : 0.12, 12, 12]} />
                <meshBasicMaterial color="#f2d64b" />
              </mesh>
              <Html portal={labelPortal} position={[0, 0.35, 0]} center style={{ pointerEvents: 'none' }}>
                <span className="port-media-overlay-strong px-1 rounded text-[10px] whitespace-nowrap">{l.label}</span>
              </Html>
            </group>
          ))}
        </group>
        {scene.parts.map((part) => <PartMesh key={part.id} part={part} color={partColor(scene, part)} selected={selected === `parts:${part.id}`} onSelect={onSelect} />)}
        {scene.anchors.filter((anchor) => !visibleAnchors || visibleAnchors.has(anchor.id)).map((anchor) => <AnchorProxy key={anchor.id} anchor={anchor} selected={selected === `anchors:${anchor.id}`} onSelect={onSelect} onMove={onMoveAnchor} labelPortal={labelPortal} />)}
        <OrbitControls makeDefault target={start.target} maxPolarAngle={Math.PI * 0.98} />
        <ViewApi apiRef={ref} layout={scene} shotView={shotView} focalLengthMm={focalLengthMm} aspect={aspect} helpersRef={helpersRef} />
      </Canvas>
    </div>
  );
});

export default GreyboxViewer;
