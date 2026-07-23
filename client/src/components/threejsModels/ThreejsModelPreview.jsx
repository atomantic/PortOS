import { useEffect, useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { Bounds, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';

const radians = (degrees = 0) => THREE.MathUtils.degToRad(degrees);
const rotation = (degrees = [0, 0, 0]) => degrees.map(radians);

function CustomGeometry({ definition }) {
  const geometry = useMemo(() => {
    const next = new THREE.BufferGeometry();
    next.setAttribute('position', new THREE.Float32BufferAttribute(definition.vertices, 3));
    next.setIndex(definition.indices);
    next.computeVertexNormals();
    next.computeBoundingSphere();
    return next;
  }, [definition]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return <primitive object={geometry} attach="geometry" />;
}

function Geometry({ definition }) {
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
    case 'custom':
      return <CustomGeometry definition={definition} />;
    default:
      return null;
  }
}

function Material({ definition }) {
  const common = {
    color: definition.color,
    emissive: definition.emissive,
    emissiveIntensity: definition.emissiveIntensity,
    opacity: definition.opacity,
    transparent: definition.transparent,
    wireframe: definition.wireframe,
  };
  if (definition.type === 'basic') return <meshBasicMaterial {...common} />;
  if (definition.type === 'physical') {
    return (
      <meshPhysicalMaterial
        {...common}
        metalness={definition.metalness}
        roughness={definition.roughness}
        clearcoat={definition.clearcoat}
        clearcoatRoughness={definition.clearcoatRoughness}
      />
    );
  }
  return (
    <meshStandardMaterial
      {...common}
      metalness={definition.metalness}
      roughness={definition.roughness}
    />
  );
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

function ProceduralScene({ spec }) {
  return (
    <>
      <color attach="background" args={[spec.background]} />
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
  if (!spec) {
    return (
      <div className={`flex items-center justify-center bg-port-bg text-gray-500 ${className}`}>
        No generated model yet
      </div>
    );
  }
  return (
    <div className={`relative overflow-hidden bg-port-bg ${className}`}>
      <Canvas
        key={`${spec.name}-${spec.schemaVersion}`}
        shadows
        camera={{ position: spec.camera.position, fov: spec.camera.fov, near: 0.01, far: 10_000 }}
        dpr={[1, 2]}
      >
        <ProceduralScene spec={spec} />
      </Canvas>
      <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/60 px-2 py-1 text-[10px] text-gray-300">
        Drag to orbit · scroll to zoom
      </div>
    </div>
  );
}
