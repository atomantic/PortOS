import { useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Float, MeshDistortMaterial, Sparkles } from '@react-three/drei';
import * as THREE from 'three';
import { AGENT_STATES } from './constants';

function SigilCore({ color, state, speaking }) {
  const coreRef = useRef();
  const knotRef = useRef();
  const haloARef = useRef();
  const haloBRef = useRef();
  const haloCRef = useRef();
  const eyeRef = useRef();

  const speed = state === 'sleeping' ? 0.12 : state === 'coding' ? 1.8 : state === 'investigating' ? 1.4 : 0.8;
  const distort = state === 'sleeping' ? 0.06 : state === 'thinking' ? 0.35 : state === 'investigating' ? 0.45 : state === 'coding' ? 0.18 : 0.12;
  const emissiveIntensity = state === 'sleeping' ? 0.12 : state === 'coding' ? 0.9 : 0.55;

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();

    if (coreRef.current) {
      coreRef.current.rotation.y = t * speed * 0.25;
      coreRef.current.rotation.x = Math.sin(t * 0.5) * 0.08;
      coreRef.current.rotation.z = Math.cos(t * 0.35) * 0.06;
      const pulse = speaking ? 1 + Math.sin(t * 18) * 0.04 : 1 + Math.sin(t * 2) * 0.015;
      coreRef.current.scale.setScalar(pulse);
    }

    if (knotRef.current) {
      knotRef.current.rotation.y = -t * speed * 0.6;
      knotRef.current.rotation.x = t * speed * 0.35;
    }

    if (haloARef.current) {
      haloARef.current.rotation.z = t * speed * 0.7;
      haloARef.current.rotation.x = Math.PI / 3;
    }
    if (haloBRef.current) {
      haloBRef.current.rotation.y = -t * speed * 0.55;
      haloBRef.current.rotation.x = Math.PI / 2.5;
    }
    if (haloCRef.current) {
      haloCRef.current.rotation.x = -t * speed * 0.45;
      haloCRef.current.rotation.z = Math.PI / 2.8;
    }

    if (eyeRef.current) {
      const r = 0.95;
      eyeRef.current.position.x = Math.cos(t * speed * 1.2) * r;
      eyeRef.current.position.z = Math.sin(t * speed * 1.2) * r;
      eyeRef.current.position.y = Math.sin(t * 0.9) * 0.35;
      eyeRef.current.material.emissiveIntensity = (speaking ? 2 : 1.2) + Math.sin(t * 6) * 0.25;
    }
  });

  return (
    <Float speed={2} rotationIntensity={0.08} floatIntensity={0.28}>
      <group ref={coreRef}>
        {/* Inner void */}
        <mesh>
          <octahedronGeometry args={[0.55, 3]} />
          <MeshDistortMaterial
            color="#05050a"
            emissive={color}
            emissiveIntensity={emissiveIntensity * 0.25}
            distort={distort}
            speed={state === 'sleeping' ? 0.6 : 2.2}
            transparent
            opacity={0.9}
          />
        </mesh>

        {/* Outer knot - neon sigil */}
        <mesh ref={knotRef}>
          <torusKnotGeometry args={[0.62, 0.14, 180, 18]} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={emissiveIntensity}
            wireframe
            transparent
            opacity={0.38}
          />
        </mesh>

        {/* Halos */}
        <mesh ref={haloARef}>
          <torusGeometry args={[0.95, 0.01, 8, 80]} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={0.9}
            transparent
            opacity={0.55}
          />
        </mesh>
        <mesh ref={haloBRef}>
          <torusGeometry args={[1.05, 0.008, 8, 80]} />
          <meshStandardMaterial
            color="#06b6d4"
            emissive={color}
            emissiveIntensity={0.55}
            transparent
            opacity={0.25}
          />
        </mesh>
        <mesh ref={haloCRef}>
          <torusGeometry args={[1.16, 0.006, 8, 80]} />
          <meshStandardMaterial
            color="#8b5cf6"
            emissive={color}
            emissiveIntensity={0.45}
            transparent
            opacity={0.18}
          />
        </mesh>

        {/* Orbiting "eye" */}
        <mesh ref={eyeRef}>
          <sphereGeometry args={[0.05, 12, 12]} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={1.2}
            transparent
            opacity={0.9}
          />
        </mesh>
      </group>
    </Float>
  );
}

function RuneRing({ color, state }) {
  const groupRef = useRef();

  const runes = useMemo(() => {
    const count = 22;
    const arr = [];
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      arr.push({
        angle,
        radius: 1.35 + (i % 2) * 0.08,
        y: (Math.sin(i * 1.7) * 0.25),
        tilt: (Math.random() - 0.5) * 0.7,
        size: 0.028 + Math.random() * 0.02
      });
    }
    return arr;
  }, []);

  const speedMul = state === 'sleeping' ? 0.12 : state === 'coding' ? 1.7 : state === 'investigating' ? 1.3 : 0.7;

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (!groupRef.current) return;

    groupRef.current.rotation.y = t * speedMul * 0.35;
    groupRef.current.children.forEach((child, i) => {
      const r = runes[i];
      const a = r.angle + t * speedMul * 0.45;
      child.position.x = Math.cos(a) * r.radius;
      child.position.z = Math.sin(a) * r.radius;
      child.position.y = r.y + Math.sin(t * 1.8 + i) * 0.08;
      child.rotation.y = -a + r.tilt;
      child.rotation.z = Math.sin(t * 2.2 + i) * 0.25;
      const flicker = 0.6 + Math.sin(t * 6 + i) * 0.25;
      child.material.opacity = state === 'sleeping' ? 0.12 : flicker;
      child.material.emissiveIntensity = state === 'sleeping' ? 0.15 : 0.7 + flicker * 0.6;
    });
  });

  return (
    <group ref={groupRef}>
      {runes.map((r, i) => (
        <mesh key={i}>
          <boxGeometry args={[r.size * 0.9, r.size * 4, r.size]} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={0.9}
            transparent
            opacity={0.65}
            metalness={0.2}
            roughness={0.5}
          />
        </mesh>
      ))}
    </group>
  );
}

function Veil({ color, state }) {
  const veilRef = useRef();

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (!veilRef.current) return;
    veilRef.current.rotation.y = t * (state === 'sleeping' ? 0.05 : 0.25);
    veilRef.current.rotation.x = t * 0.1;
    veilRef.current.material.opacity = state === 'investigating' ? 0.14 : 0.08;
  });

  return (
    <mesh ref={veilRef}>
      <sphereGeometry args={[1.35, 28, 18]} />
      <meshStandardMaterial
        color="#05050a"
        emissive={color}
        emissiveIntensity={0.12}
        transparent
        opacity={0.08}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

function ScanBeam({ color, state }) {
  const ref = useRef();

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (!ref.current) return;
    ref.current.rotation.y = t * 1.7;
    ref.current.position.y = Math.sin(t * 1.9) * 0.9;
    ref.current.material.opacity = 0.12 + Math.sin(t * 3.5) * 0.05;
  });

  if (state !== 'investigating') return null;

  return (
    <mesh ref={ref} position={[0, 0, 0]}>
      <planeGeometry args={[2.8, 0.06]} />
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={2}
        transparent
        opacity={0.16}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

function Scene({ state, speaking }) {
  const stateConfig = AGENT_STATES[state] || AGENT_STATES.sleeping;
  const color = stateConfig.color;

  const sparkleCount = state === 'coding' ? 90 : state === 'thinking' ? 60 : state === 'investigating' ? 70 : 35;
  const sparkleSpeed = state === 'coding' ? 3.2 : state === 'sleeping' ? 0.2 : 0.9;
  const sparkleSize = state === 'sleeping' ? 1.2 : state === 'ideating' ? 4.5 : 2.4;

  return (
    <>
      <ambientLight intensity={0.08} />
      <pointLight position={[2.2, 2.8, 3.2]} intensity={0.6} color={color} />
      <pointLight position={[-2.5, -1.5, 3]} intensity={0.35} color="#8b5cf6" />
      <pointLight position={[0, 2.5, -2]} intensity={0.25} color="#06b6d4" />

      <Veil color={color} state={state} />
      <SigilCore color={color} state={state} speaking={speaking} />
      <RuneRing color={color} state={state} />
      <ScanBeam color={color} state={state} />

      <Sparkles
        count={sparkleCount}
        scale={3.2}
        size={sparkleSize}
        speed={sparkleSpeed}
        color={color}
      />
    </>
  );
}

export default function SigilCoSAvatar({ state, speaking }) {
  return (
    <div className="relative w-full max-w-[14rem] lg:max-w-[20rem] aspect-[5/6]">
      <Canvas
        camera={{ position: [0, 0.1, 3.7], fov: 45 }}
        style={{ background: 'transparent' }}
        gl={{ alpha: true, antialias: true }}
      >
        <Scene state={state} speaking={speaking} />
      </Canvas>
    </div>
  );
}

