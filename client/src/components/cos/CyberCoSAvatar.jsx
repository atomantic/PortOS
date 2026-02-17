import { useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Float, MeshDistortMaterial, Sparkles } from '@react-three/drei';
import * as THREE from 'three';
import { AGENT_STATES } from './constants';

// Holographic wireframe skull/head geometry
function CyberHead({ color, state, speaking }) {
  const headRef = useRef();
  const eyeLeftRef = useRef();
  const eyeRightRef = useRef();
  const jawRef = useRef();
  const antennaRef = useRef();
  const glitchRef = useRef();

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();

    // Head subtle float
    if (headRef.current) {
      headRef.current.rotation.y = Math.sin(t * 0.5) * 0.15;
      headRef.current.rotation.x = Math.sin(t * 0.3) * 0.05;
    }

    // Eye pulsing
    const eyeScale = 1 + Math.sin(t * 3) * 0.15;
    if (eyeLeftRef.current) {
      eyeLeftRef.current.scale.setScalar(state === 'sleeping' ? 0.3 : eyeScale);
    }
    if (eyeRightRef.current) {
      eyeRightRef.current.scale.setScalar(state === 'sleeping' ? 0.3 : eyeScale);
    }

    // Jaw animation for speaking
    if (jawRef.current) {
      const jawOpen = speaking ? Math.sin(t * 15) * 0.08 : 0;
      jawRef.current.position.y = -0.65 + jawOpen;
    }

    // Antenna glow pulse
    if (antennaRef.current) {
      antennaRef.current.material.emissiveIntensity = 1 + Math.sin(t * 4) * 0.5;
    }

    // Glitch effect for certain states
    if (glitchRef.current) {
      const shouldGlitch = state === 'coding' || state === 'investigating';
      if (shouldGlitch && Math.random() > 0.95) {
        glitchRef.current.position.x = (Math.random() - 0.5) * 0.1;
        glitchRef.current.position.y = (Math.random() - 0.5) * 0.05;
      } else {
        glitchRef.current.position.x *= 0.9;
        glitchRef.current.position.y *= 0.9;
      }
    }
  });

  return (
    <group ref={glitchRef}>
      <Float speed={2} rotationIntensity={0.1} floatIntensity={0.3}>
        <group ref={headRef}>
          {/* Main head - icosahedron wireframe for cyberpunk look */}
          <mesh>
            <icosahedronGeometry args={[0.8, 1]} />
            <meshStandardMaterial
              color={color}
              wireframe
              transparent
              opacity={0.4}
              emissive={color}
              emissiveIntensity={0.3}
            />
          </mesh>

          {/* Inner head solid with distortion */}
          <mesh>
            <icosahedronGeometry args={[0.65, 2]} />
            <MeshDistortMaterial
              color="#0a0a1a"
              emissive={color}
              emissiveIntensity={0.15}
              distort={state === 'thinking' ? 0.3 : state === 'coding' ? 0.15 : 0.05}
              speed={state === 'sleeping' ? 0.5 : 2}
              transparent
              opacity={0.85}
            />
          </mesh>

          {/* Face visor - flat plane across face */}
          <mesh position={[0, 0.05, 0.55]} rotation={[0, 0, 0]}>
            <planeGeometry args={[1.0, 0.35]} />
            <meshStandardMaterial
              color="#000"
              emissive={color}
              emissiveIntensity={0.5}
              transparent
              opacity={0.7}
              side={THREE.DoubleSide}
            />
          </mesh>

          {/* Left Eye */}
          <mesh ref={eyeLeftRef} position={[-0.22, 0.08, 0.7]}>
            <octahedronGeometry args={[0.1, 0]} />
            <meshStandardMaterial
              color={color}
              emissive={color}
              emissiveIntensity={state === 'sleeping' ? 0.2 : 2}
              transparent
              opacity={state === 'sleeping' ? 0.3 : 1}
            />
          </mesh>

          {/* Right Eye */}
          <mesh ref={eyeRightRef} position={[0.22, 0.08, 0.7]}>
            <octahedronGeometry args={[0.1, 0]} />
            <meshStandardMaterial
              color={color}
              emissive={color}
              emissiveIntensity={state === 'sleeping' ? 0.2 : 2}
              transparent
              opacity={state === 'sleeping' ? 0.3 : 1}
            />
          </mesh>

          {/* Mouth / Jaw piece */}
          <mesh ref={jawRef} position={[0, -0.65, 0.35]}>
            <boxGeometry args={[0.4, 0.08, 0.3]} />
            <meshStandardMaterial
              color="#1a1a2e"
              emissive={color}
              emissiveIntensity={speaking ? 1.5 : 0.2}
              metalness={0.8}
              roughness={0.2}
            />
          </mesh>

          {/* Antenna */}
          <mesh position={[0, 0.9, 0]}>
            <cylinderGeometry args={[0.02, 0.02, 0.3]} />
            <meshStandardMaterial color="#334155" metalness={0.9} roughness={0.1} />
          </mesh>
          <mesh ref={antennaRef} position={[0, 1.1, 0]}>
            <sphereGeometry args={[0.06, 8, 8]} />
            <meshStandardMaterial
              color={color}
              emissive={color}
              emissiveIntensity={1}
              transparent
              opacity={0.9}
            />
          </mesh>

          {/* Side panels - cybernetic implants */}
          <mesh position={[-0.75, 0, 0]} rotation={[0, 0, Math.PI / 6]}>
            <boxGeometry args={[0.15, 0.5, 0.2]} />
            <meshStandardMaterial
              color="#1a1a2e"
              emissive={color}
              emissiveIntensity={0.2}
              metalness={0.9}
              roughness={0.1}
            />
          </mesh>
          <mesh position={[0.75, 0, 0]} rotation={[0, 0, -Math.PI / 6]}>
            <boxGeometry args={[0.15, 0.5, 0.2]} />
            <meshStandardMaterial
              color="#1a1a2e"
              emissive={color}
              emissiveIntensity={0.2}
              metalness={0.9}
              roughness={0.1}
            />
          </mesh>

          {/* Neck piece */}
          <mesh position={[0, -0.85, 0]}>
            <cylinderGeometry args={[0.25, 0.35, 0.3, 6]} />
            <meshStandardMaterial
              color="#1a1a2e"
              wireframe
              emissive={color}
              emissiveIntensity={0.15}
            />
          </mesh>
        </group>
      </Float>
    </group>
  );
}

// Orbital ring that spins around the head
function OrbitalRing({ color, state }) {
  const ringRef = useRef();
  const ring2Ref = useRef();

  const speed = state === 'sleeping' ? 0.2 : state === 'coding' ? 2 : 1;

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (ringRef.current) {
      ringRef.current.rotation.z = t * speed;
      ringRef.current.rotation.x = Math.PI / 3;
    }
    if (ring2Ref.current) {
      ring2Ref.current.rotation.z = -t * speed * 0.7;
      ring2Ref.current.rotation.y = Math.PI / 4;
    }
  });

  return (
    <>
      <mesh ref={ringRef}>
        <torusGeometry args={[1.2, 0.015, 8, 64]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.8}
          transparent
          opacity={0.6}
        />
      </mesh>
      <mesh ref={ring2Ref}>
        <torusGeometry args={[1.35, 0.01, 8, 64]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.5}
          transparent
          opacity={0.3}
        />
      </mesh>
    </>
  );
}

// Data streams - floating glyphs/particles around the head
function DataStream({ color, state }) {
  const groupRef = useRef();
  const count = 30;

  const particles = useMemo(() => {
    const arr = [];
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const radius = 1.5 + Math.random() * 0.5;
      arr.push({
        angle,
        radius,
        speed: 0.3 + Math.random() * 0.5,
        y: (Math.random() - 0.5) * 2,
        size: 0.02 + Math.random() * 0.03,
      });
    }
    return arr;
  }, []);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (!groupRef.current) return;

    const speedMul = state === 'sleeping' ? 0.1 : state === 'coding' ? 1.5 : 0.8;

    groupRef.current.children.forEach((child, i) => {
      const p = particles[i];
      const a = p.angle + t * p.speed * speedMul;
      child.position.x = Math.cos(a) * p.radius;
      child.position.z = Math.sin(a) * p.radius;
      child.position.y = p.y + Math.sin(t * 2 + i) * 0.3;
    });
  });

  return (
    <group ref={groupRef}>
      {particles.map((p, i) => (
        <mesh key={i} position={[0, 0, 0]}>
          <boxGeometry args={[p.size, p.size * 3, p.size]} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={1}
            transparent
            opacity={0.6}
          />
        </mesh>
      ))}
    </group>
  );
}

// Holographic scan lines effect
function ScanLines({ color, state }) {
  const ref = useRef();

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.getElapsedTime();
    ref.current.position.y = Math.sin(t * 2) * 0.8;
    ref.current.material.opacity = state === 'investigating' ? 0.4 : 0.15;
  });

  return (
    <mesh ref={ref} position={[0, 0, 0]}>
      <planeGeometry args={[3, 0.02]} />
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={2}
        transparent
        opacity={0.15}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

// State-specific effects
function StateEffects({ color, state }) {
  // Thinking: pulsing brain-like energy
  if (state === 'thinking') {
    return (
      <Sparkles
        count={40}
        scale={2.5}
        size={3}
        speed={0.8}
        color={color}
      />
    );
  }

  // Coding: fast particles
  if (state === 'coding') {
    return (
      <Sparkles
        count={80}
        scale={3}
        size={2}
        speed={3}
        color={color}
      />
    );
  }

  // Investigating: scan effect with more sparkles
  if (state === 'investigating') {
    return (
      <Sparkles
        count={60}
        scale={3}
        size={4}
        speed={1.5}
        color={color}
      />
    );
  }

  // Ideating: bright creative sparks
  if (state === 'ideating') {
    return (
      <Sparkles
        count={50}
        scale={2.5}
        size={5}
        speed={1}
        color={color}
      />
    );
  }

  // Default: subtle ambient sparkles
  return (
    <Sparkles
      count={20}
      scale={3}
      size={1.5}
      speed={0.3}
      color={color}
    />
  );
}

// Ground glow plane
function GroundGlow({ color }) {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.3, 0]}>
      <circleGeometry args={[1.5, 32]} />
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={0.3}
        transparent
        opacity={0.15}
      />
    </mesh>
  );
}

function Scene({ state, speaking }) {
  const stateConfig = AGENT_STATES[state] || AGENT_STATES.sleeping;
  const color = stateConfig.color;

  return (
    <>
      {/* Lighting */}
      <ambientLight intensity={0.1} />
      <pointLight position={[2, 3, 4]} intensity={0.5} color={color} />
      <pointLight position={[-2, -1, 3]} intensity={0.3} color="#6366f1" />

      {/* Main head */}
      <CyberHead color={color} state={state} speaking={speaking} />

      {/* Orbital rings */}
      <OrbitalRing color={color} state={state} />

      {/* Data stream particles */}
      <DataStream color={color} state={state} />

      {/* Scan lines */}
      <ScanLines color={color} state={state} />

      {/* State-specific effects */}
      <StateEffects color={color} state={state} />

      {/* Ground glow */}
      <GroundGlow color={color} />
    </>
  );
}

export default function CyberCoSAvatar({ state, speaking }) {
  return (
    <div className="relative w-full max-w-[8rem] lg:max-w-[12rem] aspect-[5/6]">
      <Canvas
        camera={{ position: [0, 0, 3.5], fov: 45 }}
        style={{ background: 'transparent' }}
        gl={{ alpha: true, antialias: true }}
      >
        <Scene state={state} speaking={speaking} />
      </Canvas>
    </div>
  );
}
