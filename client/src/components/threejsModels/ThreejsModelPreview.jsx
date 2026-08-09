import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Canvas } from '@react-three/fiber';
import { Bounds, OrbitControls, useBounds } from '@react-three/drei';
import * as THREE from 'three';
import { createSculptBufferGeometry, needsSculptBufferGeometry, sculptMaterialProps } from '../../lib/threejsSculpt';
import { buildPartSelectionIndex, computeExplodeLayout, isReliefPart } from '../../lib/threejsExplode';
import { summarizeThreejsArticulation } from '../../lib/threejsRig';

const radians = (degrees = 0) => THREE.MathUtils.degToRad(degrees);
const rotation = (degrees = [0, 0, 0]) => degrees.map(radians);

const HIGHLIGHT_COLOR = '#38bdf8';
const HIGHLIGHT_EMISSIVE_INTENSITY = 0.9;

const BACKGROUND_PRESETS = [
  { id: 'black', label: 'Black', value: '#000000' },
  { id: 'white', label: 'White', value: '#ffffff' },
  { id: 'transparent', label: 'Transparent', value: null },
  { id: 'green', label: 'Green screen', value: '#00ff00' },
];

const checkerboardStyle = {
  backgroundColor: '#191919',
  backgroundImage: [
    'linear-gradient(45deg, #2e2e2e 25%, transparent 25%)',
    'linear-gradient(-45deg, #2e2e2e 25%, transparent 25%)',
    'linear-gradient(45deg, transparent 75%, #2e2e2e 75%)',
    'linear-gradient(-45deg, transparent 75%, #2e2e2e 75%)',
  ].join(', '),
  backgroundSize: '16px 16px',
  backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0',
};

function SculptBufferGeometry({ definition }) {
  const geometry = useMemo(() => createSculptBufferGeometry(definition), [definition]);
  useEffect(() => () => geometry?.dispose(), [geometry]);
  if (!geometry) return null;
  return <primitive object={geometry} attach="geometry" />;
}

function Geometry({ definition }) {
  if (needsSculptBufferGeometry(definition)) return <SculptBufferGeometry definition={definition} />;
  switch (definition.type) {
    case 'box':
      return <boxGeometry args={[definition.width, definition.height, definition.depth]} />;
    case 'sphere':
      return <sphereGeometry args={[definition.radius, definition.widthSegments, definition.heightSegments]} />;
    case 'cylinder':
      return <cylinderGeometry args={[definition.radiusTop, definition.radiusBottom, definition.height, definition.radialSegments]} />;
    case 'cone':
      return <coneGeometry args={[definition.radius, definition.height, definition.radialSegments]} />;
    case 'torus':
      return <torusGeometry args={[definition.radius, definition.tube, definition.radialSegments, definition.tubularSegments, radians(definition.arcDegrees)]} />;
    case 'capsule':
      return <capsuleGeometry args={[definition.radius, definition.length, definition.capSegments, definition.radialSegments]} />;
    case 'lathe':
      return <latheGeometry args={[definition.points.map(([x, y]) => new THREE.Vector2(x, y)), definition.segments]} />;
    default:
      return null;
  }
}

function Material({ definition, highlighted = false }) {
  const props = sculptMaterialProps(definition);
  // Basic materials are unlit and have no emissive channel, so the only way to
  // show them as selected is the base color.
  if (definition.type === 'basic') {
    return <meshBasicMaterial {...props} color={highlighted ? HIGHLIGHT_COLOR : props.color} />;
  }
  const lit = highlighted
    ? { ...props, emissive: HIGHLIGHT_COLOR, emissiveIntensity: HIGHLIGHT_EMISSIVE_INTENSITY }
    : props;
  if (definition.type === 'physical') return <meshPhysicalMaterial {...lit} />;
  return <meshStandardMaterial {...lit} />;
}

// Part ids are provider-authored and the schema accepts `toString`, so a bare
// lookup can hand back an inherited function; only a real triple is an offset.
const offsetPosition = (position = [0, 0, 0], offset) =>
  (Array.isArray(offset) ? position.map((value, axis) => value + offset[axis]) : position);

function Part({ part, materials, layout, selection, selectedId, onSelect }) {
  const transform = {
    name: part.name,
    position: offsetPosition(part.position, layout.offsets[part.id]),
    rotation: rotation(part.rotationDegrees),
    scale: part.scale,
  };
  // The whole selected subtree lights up, so selecting a container reads as one
  // component rather than one lonely mesh inside it.
  const highlighted = Boolean(selectedId) && (selection.ancestry[part.id] || []).includes(selectedId);
  const select = (event) => {
    // Without this the ray keeps going and every part behind the click selects too.
    event.stopPropagation();
    onSelect(selection.owners[part.id] || part.id);
  };
  // Relief rides this part's own geometry, so both sit inside the mesh offset
  // when this part is a container that moves its shell independently of its
  // children. Everything else is a part in its own right and stays outside it.
  const own = (
    <>
      {part.geometry && (
        <mesh castShadow={part.castShadow} receiveShadow={part.receiveShadow} onClick={select}>
          <Geometry definition={part.geometry} />
          <Material definition={materials[part.material]} highlighted={highlighted} />
        </mesh>
      )}
      {part.children.filter(isReliefPart).map((child) => (
        <Part key={child.id} part={child} materials={materials} layout={layout} selection={selection} selectedId={selectedId} onSelect={onSelect} />
      ))}
    </>
  );
  const meshOffset = layout.meshOffsets[part.id];
  return (
    <group {...transform}>
      {Array.isArray(meshOffset) ? <group position={meshOffset}>{own}</group> : own}
      {part.children.filter((child) => !isReliefPart(child)).map((child) => (
        <Part
          key={child.id}
          part={child}
          materials={materials}
          layout={layout}
          selection={selection}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ))}
    </group>
  );
}

// <Bounds> only measures its children when it is told to. Exploding moves parts
// without remounting anything, so re-fit whenever the layout ACTUALLY grew —
// measured from the moved parts, not guessed from the slider — and the camera
// frames the disassembly instead of clipping it.
function ExplodeRefit({ growth }) {
  const bounds = useBounds();
  useEffect(() => {
    bounds?.refresh().clip().fit();
  }, [bounds, growth]);
  return null;
}

function SceneLight({ light }) {
  if (light.type === 'ambient') {
    return <ambientLight color={light.color} intensity={light.intensity} />;
  }
  if (light.type === 'hemisphere') {
    return <hemisphereLight color={light.color} groundColor={light.groundColor} intensity={light.intensity} position={light.position} />;
  }
  if (light.type === 'point') {
    return <pointLight color={light.color} intensity={light.intensity} position={light.position} castShadow />;
  }
  if (light.type === 'spot') {
    return (
      <spotLight
        color={light.color}
        intensity={light.intensity}
        position={light.position}
        angle={radians(light.angleDegrees)}
        penumbra={light.penumbra}
        castShadow
      />
    );
  }
  return <directionalLight color={light.color} intensity={light.intensity} position={light.position} castShadow />;
}

function ProceduralScene({ spec, background, layout, selection, selectedId, onSelect }) {
  return (
    <>
      {background && <color attach="background" args={[background]} />}
      {spec.lights.map((light, index) => <SceneLight key={`${light.type}-${index}`} light={light} />)}
      <Bounds fit clip observe margin={1.25}>
        <ExplodeRefit growth={layout.growth} />
        {/* Clicking past the model clears the selection, the way a file list
            does — but only when there is one, so a stray click on empty canvas
            doesn't push a URL write and re-render the page around us. */}
        <group name={spec.name} onPointerMissed={() => { if (selectedId) onSelect(null); }}>
          {spec.parts.map((part) => (
            <Part
              key={part.id}
              part={part}
              materials={spec.materials}
              layout={layout}
              selection={selection}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ))}
        </group>
      </Bounds>
      <gridHelper args={[20, 20, '#4b5563', '#252b38']} position={[0, -0.01, 0]} />
      <OrbitControls
        makeDefault
        target={spec.camera.target}
        enableDamping
        dampingFactor={0.08}
        minDistance={0.1}
        maxDistance={500}
      />
    </>
  );
}

export default function ThreejsModelPreview({ spec, className = '' }) {
  const [background, setBackground] = useState(() => spec?.background || '#000000');
  const [explode, setExplode] = useState(0);
  const [searchParams, setSearchParams] = useSearchParams();
  const explodeSliderId = useId();

  // Keyed on the authored background, not on `spec` — the detail page re-fetches
  // the record every 2s while a generation runs, and a fresh object with the
  // same content would throw away the background the user just picked.
  const authoredBackground = spec?.background;
  useEffect(() => {
    setBackground(authoredBackground || '#000000');
  }, [authoredBackground]);

  const parts = spec?.parts;
  const articulation = useMemo(() => summarizeThreejsArticulation(spec), [spec]);
  const selection = useMemo(() => buildPartSelectionIndex(parts || []), [parts]);
  const layout = useMemo(() => computeExplodeLayout(parts || [], explode), [parts, explode]);

  // Same reason: reset the disassembly only when the part set actually changes,
  // not on every poll that hands back an equivalent spec.
  const partSignature = useMemo(() => Object.keys(selection.names).join('|'), [selection]);
  useEffect(() => {
    setExplode(0);
  }, [partSignature]);

  // The URL is the source of truth for what is selected, so a picked part is
  // shareable and reload-safe; an id the current model doesn't have degrades to
  // no selection instead of an empty label.
  const requestedPartId = searchParams.get('part');
  const selectedId = requestedPartId && selection.names[requestedPartId] ? requestedPartId : null;
  const handleSelect = useCallback((partId) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      if (partId) next.set('part', partId);
      else next.delete('part');
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  if (!spec) {
    return (
      <div className={`flex items-center justify-center bg-port-bg text-gray-500 ${className}`}>
        No generated model yet
      </div>
    );
  }
  const transparent = background === null;
  const selectedPreset = BACKGROUND_PRESETS.find((preset) => preset.value === background)?.id || 'custom';
  return (
    <div
      className={`relative overflow-hidden bg-port-bg ${className}`}
      style={transparent ? checkerboardStyle : undefined}
    >
      <Canvas
        key={`${spec.name}-${spec.schemaVersion}-${transparent ? 'transparent' : background}`}
        shadows
        camera={{ position: spec.camera.position, fov: spec.camera.fov, near: 0.01, far: 10_000 }}
        dpr={[1, 2]}
        gl={{ alpha: transparent }}
      >
        <ProceduralScene
          spec={spec}
          background={background}
          layout={layout}
          selection={selection}
          selectedId={selectedId}
          onSelect={handleSelect}
        />
      </Canvas>
      <div className="always-dark absolute left-2 top-2 flex max-w-[calc(100%-1rem)] flex-wrap items-center gap-1.5 rounded-lg bg-black/70 px-2 py-1.5 text-[10px] text-gray-300 backdrop-blur-sm">
        <span className="mr-1 whitespace-nowrap text-gray-400">Background</span>
        <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Preview background">
          {BACKGROUND_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              aria-label={preset.label}
              aria-pressed={selectedPreset === preset.id}
              onClick={() => setBackground(preset.value)}
              className="rounded px-1.5 py-1 hover:bg-white/15 aria-pressed:bg-white/25 aria-pressed:text-white"
            >
              {preset.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-white/15">
          Custom
          <input
            type="color"
            aria-label="Custom preview background color"
            value={background || '#000000'}
            onChange={(event) => setBackground(event.target.value)}
            className="h-4 w-5 rounded border-0 bg-transparent p-0"
          />
        </label>
        <span className="mx-1 hidden h-3 w-px bg-white/20 sm:block" />
        <label htmlFor={explodeSliderId} className="whitespace-nowrap text-gray-400">
          Explode
        </label>
        <input
          id={explodeSliderId}
          type="range"
          min="0"
          max="1"
          step="0.02"
          value={explode}
          disabled={layout.unitIds.length < 2}
          onChange={(event) => setExplode(Number(event.target.value))}
          className="h-1 w-20 cursor-pointer accent-port-accent disabled:cursor-not-allowed disabled:opacity-40 sm:w-28"
        />
        <span className="w-8 tabular-nums text-gray-400">{Math.round(explode * 100)}%</span>
        {explode > 0 && (
          <button
            type="button"
            onClick={() => setExplode(0)}
            className="rounded px-1.5 py-1 hover:bg-white/15"
          >
            Reassemble
          </button>
        )}
      </div>
      {selectedId && (
        <div className="always-dark absolute right-2 top-2 flex max-w-[calc(100%-1rem)] items-center gap-2 rounded-lg bg-black/70 px-2 py-1.5 text-[10px] text-gray-200 backdrop-blur-sm">
          <span className="truncate font-medium text-white">{selection.names[selectedId] || selectedId}</span>
          <code className="truncate text-gray-400">{selectedId}</code>
          {/* Which declared joint (if any) drives the picked part — the diagnostic
              that turns "it says articulation-ready" into something checkable. */}
          {articulation.jointsByPartId[selectedId] && (
            <span className="truncate text-port-accent">
              joint {articulation.jointsByPartId[selectedId].id}
              {articulation.jointsByPartId[selectedId].pivotSocket
                ? ` · pivot ${articulation.jointsByPartId[selectedId].pivotSocket}`
                : ' · no pivot'}
            </span>
          )}
          <button
            type="button"
            aria-label="Clear part selection"
            onClick={() => handleSelect(null)}
            className="rounded px-1.5 py-0.5 hover:bg-white/15"
          >
            Clear
          </button>
        </div>
      )}
      <div className="always-dark pointer-events-none absolute bottom-2 left-2 flex max-w-[calc(100%-1rem)] flex-wrap items-center gap-1.5 text-[10px]">
        <span className="rounded bg-black/60 px-2 py-1 text-gray-300">
          Drag to orbit · scroll to zoom · click a part to identify it
        </span>
        {/* Never "animation-ready": nothing here is skinned. The badge says only
            whether the spec declared a usable articulation graph, and a model
            that predates the contract has none and reads as a static assembly. */}
        <span
          className={articulation.articulationReady
            ? 'rounded bg-port-success/20 px-2 py-1 text-port-success'
            : 'rounded bg-black/60 px-2 py-1 text-gray-400'}
        >
          {articulation.articulationReady
            ? `Articulation-ready · ${articulation.jointCount} joints · ${articulation.socketCount} pivot${articulation.socketCount === 1 ? '' : 's'}`
            : `Static assembly${articulation.jointCount > 0 ? ` · ${articulation.jointCount} joints declared` : ''}`}
        </span>
      </div>
    </div>
  );
}
