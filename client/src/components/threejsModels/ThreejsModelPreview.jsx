import { useEffect, useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { Bounds, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { createSculptBufferGeometry, needsSculptBufferGeometry, sculptMaterialProps } from '../../lib/threejsSculpt';

const radians = (degrees = 0) => THREE.MathUtils.degToRad(degrees);
const rotation = (degrees = [0, 0, 0]) => degrees.map(radians);

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

function BufferGeometry({ definition }) {
  const geometry = useMemo(() => createSculptBufferGeometry(definition), [definition]);
  useEffect(() => () => geometry?.dispose(), [geometry]);
  if (!geometry) return null;
  return <primitive object={geometry} attach="geometry" />;
}

function Geometry({ definition }) {
  if (needsSculptBufferGeometry(definition)) return <BufferGeometry definition={definition} />;
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

function Material({ definition }) {
  const props = sculptMaterialProps(definition);
  if (definition.type === 'basic') return <meshBasicMaterial {...props} />;
  if (definition.type === 'physical') return <meshPhysicalMaterial {...props} />;
  return <meshStandardMaterial {...props} />;
}
function Part({ part, materials }) {
  const transform = {
    name: part.name,
    position: part.position,
    rotation: rotation(part.rotationDegrees),
    scale: part.scale,
  };
  return (
    <group {...transform}>
      {part.geometry && (
        <mesh castShadow={part.castShadow} receiveShadow={part.receiveShadow}>
          <Geometry definition={part.geometry} />
          <Material definition={materials[part.material]} />
        </mesh>
      )}
      {part.children.map((child) => (
        <Part key={child.id} part={child} materials={materials} />
      ))}
    </group>
  );
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

function ProceduralScene({ spec, background }) {
  return (
    <>
      {background && <color attach="background" args={[background]} />}
      {spec.lights.map((light, index) => <SceneLight key={`${light.type}-${index}`} light={light} />)}
      <Bounds fit clip observe margin={1.25}>
        <group name={spec.name}>
          {spec.parts.map((part) => <Part key={part.id} part={part} materials={spec.materials} />)}
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

  useEffect(() => {
    setBackground(spec?.background || '#000000');
  }, [spec]);

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
        <ProceduralScene spec={spec} background={background} />
      </Canvas>
      <div className="absolute left-2 top-2 flex max-w-[calc(100%-1rem)] flex-wrap items-center gap-1.5 rounded-lg bg-black/70 px-2 py-1.5 text-[10px] text-gray-300 backdrop-blur-sm">
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
      </div>
      <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/60 px-2 py-1 text-[10px] text-gray-300">
        Drag to orbit · scroll to zoom
      </div>
    </div>
  );
}
