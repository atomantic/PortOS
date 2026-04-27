import { useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Float, MeshDistortMaterial, Sparkles } from '@react-three/drei';
import * as THREE from 'three';
import { AGENT_STATES } from './constants';
import CoSAvatarOrbitControls from './CoSAvatarOrbitControls';
import CoSAvatarFrame from './CoSAvatarFrame';

// Central brain-like neural core
function NeuralCore({ color, state, speaking }) {
  const coreRef = useRef();
  const shellRef = useRef();
  const pulseRef = useRef();

  const speed = state === 'sleeping' ? 0.15 : state === 'coding' ? 1.5 : state === 'thinking' ? 1.2 : 0.6;
  const distort = state === 'sleeping' ? 0.1 : state === 'thinking' ? 0.5 : state === 'coding' ? 0.3 : 0.2;

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();

    if (coreRef.current) {
      coreRef.current.rotation.y = t * speed * 0.3;
      coreRef.current.rotation.x = Math.sin(t * 0.4) * 0.1;
      const pulse = speaking ? 1 + Math.sin(t * 15) * 0.08 : 1 + Math.sin(t * 2) * 0.03;
      coreRef.current.scale.setScalar(pulse);
    }

    if (shellRef.current) {
      shellRef.current.rotation.y = -t * speed * 0.2;
      shellRef.current.rotation.z = t * speed * 0.15;
    }

    if (pulseRef.current) {
      const pulseScale = 1 + Math.sin(t * 3) * 0.15;
      pulseRef.current.scale.setScalar(pulseScale);
      pulseRef.current.material.opacity = 0.15 + Math.sin(t * 3) * 0.1;
    }
  });

  return (
    <Float speed={1.5} rotationIntensity={0.1} floatIntensity={0.2}>
      <group ref={coreRef}>
        {/* Inner neural mass */}
        <mesh>
          <dodecahedronGeometry args={[0.45, 1]} />
          <MeshDistortMaterial
            color="#0a0a15"
            emissive={color}
            emissiveIntensity={state === 'sleeping' ? 0.2 : 0.6}
            distort={distort}
            speed={state === 'sleeping' ? 0.5 : 2}
            transparent
            opacity={0.95}
            roughness={0.3}
            metalness={0.7}
          />
        </mesh>

        {/* Outer neural shell - wireframe */}
        <mesh ref={shellRef}>
          <icosahedronGeometry args={[0.6, 1]} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={0.4}
            wireframe
            transparent
            opacity={0.5}
          />
        </mesh>

        {/* Pulse wave */}
        <mesh ref={pulseRef}>
          <sphereGeometry args={[0.7, 16, 16]} />
          <meshBasicMaterial
            color={color}
            transparent
            opacity={0.15}
            side={THREE.BackSide}
          />
        </mesh>
      </group>
    </Float>
  );
}

// Neural network nodes orbiting the core
function NeuralNodes({ color, state }) {
  const groupRef = useRef();
  const nodeRefs = useRef([]);

  const nodes = useMemo(() => {
    const arr = [];
    const count = 12;
    for (let i = 0; i < count; i++) {
      const phi = Math.acos(-1 + (2 * i) / count);
      const theta = Math.sqrt(count * Math.PI) * phi;
      arr.push({
        basePos: new THREE.Vector3(
          Math.cos(theta) * Math.sin(phi),
          Math.sin(theta) * Math.sin(phi),
          Math.cos(phi)
        ).multiplyScalar(1.1),
        size: 0.04 + Math.random() * 0.03,
        phase: Math.random() * Math.PI * 2,
        pulseSpeed: 2 + Math.random() * 2,
      });
    }
    return arr;
  }, []);

  const speedMul = state === 'sleeping' ? 0.1 : state === 'coding' ? 1.8 : state === 'thinking' ? 1.2 : 0.7;

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (!groupRef.current) return;

    groupRef.current.rotation.y = t * speedMul * 0.2;
    groupRef.current.rotation.x = Math.sin(t * 0.3) * 0.1;

    nodeRefs.current.forEach((node, i) => {
      if (!node) return;
      const n = nodes[i];
      const breathe = 1 + Math.sin(t * 0.5 + n.phase) * 0.1;
      node.position.copy(n.basePos).multiplyScalar(breathe);
      const pulse = state === 'sleeping' ? 0.3 : 0.8 + Math.sin(t * n.pulseSpeed + n.phase) * 0.4;
      node.material.emissiveIntensity = pulse;
    });
  });

  return (
    <group ref={groupRef}>
      {nodes.map((n, i) => (
        <mesh
          key={i}
          ref={el => nodeRefs.current[i] = el}
          position={n.basePos}
        >
          <sphereGeometry args={[n.size, 8, 8]} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={0.8}
            transparent
            opacity={0.9}
          />
        </mesh>
      ))}
    </group>
  );
}

// Synaptic connections between nodes
function SynapticLinks({ color, state }) {
  const groupRef = useRef();
  const linksRef = useRef([]);

  const links = useMemo(() => {
    const arr = [];
    const count = 8;
    for (let i = 0; i < count; i++) {
      const startAngle = (i / count) * Math.PI * 2;
      const endAngle = startAngle + Math.PI * (0.5 + Math.random() * 0.5);
      arr.push({
        startAngle,
        endAngle,
        radius: 0.9 + Math.random() * 0.3,
        yOffset: (Math.random() - 0.5) * 0.6,
        phase: Math.random() * Math.PI * 2,
      });
    }
    return arr;
  }, []);

  const speedMul = state === 'sleeping' ? 0.1 : state === 'coding' ? 2 : 0.8;

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (!groupRef.current) return;

    linksRef.current.forEach((link, i) => {
      if (!link) return;
      const l = links[i];
      const progress = (Math.sin(t * speedMul + l.phase) + 1) / 2;
      link.material.opacity = state === 'sleeping' ? 0.1 : 0.3 + progress * 0.4;
      link.material.emissiveIntensity = 0.5 + progress * 1;
    });
  });

  return (
    <group ref={groupRef}>
      {links.map((l, i) => {
        const curve = new THREE.CatmullRomCurve3([
          new THREE.Vector3(
            Math.cos(l.startAngle) * l.radius,
            l.yOffset,
            Math.sin(l.startAngle) * l.radius
          ),
          new THREE.Vector3(0, l.yOffset * 0.5, 0),
          new THREE.Vector3(
            Math.cos(l.endAngle) * l.radius,
            -l.yOffset,
            Math.sin(l.endAngle) * l.radius
          ),
        ]);
        const geometry = new THREE.TubeGeometry(curve, 20, 0.008, 4, false);
        return (
          <mesh
            key={i}
            ref={el => linksRef.current[i] = el}
            geometry={geometry}
          >
            <meshStandardMaterial
              color={color}
              emissive={color}
              emissiveIntensity={0.8}
              transparent
              opacity={0.4}
            />
          </mesh>
        );
      })}
    </group>
  );
}

// Data flow particles along synapses
function DataFlowParticles({ color, state }) {
  const particlesRef = useRef([]);

  const particles = useMemo(() => {
    const arr = [];
    const count = 20;
    for (let i = 0; i < count; i++) {
      arr.push({
        angle: (i / count) * Math.PI * 2,
        radius: 0.8 + Math.random() * 0.5,
        speed: 1 + Math.random() * 2,
        yAmplitude: 0.3 + Math.random() * 0.4,
        phase: Math.random() * Math.PI * 2,
        size: 0.015 + Math.random() * 0.015,
      });
    }
    return arr;
  }, []);

  const speedMul = state === 'sleeping' ? 0.05 : state === 'coding' ? 2.5 : state === 'thinking' ? 1.5 : 0.8;

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    particlesRef.current.forEach((particle, i) => {
      if (!particle) return;
      const p = particles[i];
      const angle = p.angle + t * p.speed * speedMul;
      particle.position.x = Math.cos(angle) * p.radius;
      particle.position.z = Math.sin(angle) * p.radius;
      particle.position.y = Math.sin(t * p.speed + p.phase) * p.yAmplitude;
      particle.material.emissiveIntensity = 1 + Math.sin(t * 5 + p.phase) * 0.5;
    });
  });

  return (
    <group>
      {particles.map((p, i) => (
        <mesh
          key={i}
          ref={el => particlesRef.current[i] = el}
        >
          <sphereGeometry args={[p.size, 6, 6]} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={1.5}
            transparent
            opacity={state === 'sleeping' ? 0.2 : 0.8}
          />
        </mesh>
      ))}
    </group>
  );
}

// Outer hexagonal grid shell
function HexGrid({ color, state }) {
  const gridRef = useRef();

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (!gridRef.current) return;
    const speed = state === 'sleeping' ? 0.05 : state === 'coding' ? 0.3 : 0.15;
    gridRef.current.rotation.y = t * speed;
    gridRef.current.rotation.x = Math.sin(t * 0.2) * 0.05;
  });

  return (
    <mesh ref={gridRef}>
      <icosahedronGeometry args={[1.6, 1]} />
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={state === 'sleeping' ? 0.1 : 0.3}
        wireframe
        transparent
        opacity={state === 'sleeping' ? 0.1 : 0.25}
      />
    </mesh>
  );
}

// Status indicator ring
function StatusRing({ color, state }) {
  const ringRef = useRef();

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (!ringRef.current) return;
    const speed = state === 'sleeping' ? 0.1 : state === 'coding' ? 1 : 0.5;
    ringRef.current.rotation.z = t * speed;
  });

  return (
    <mesh ref={ringRef} rotation={[Math.PI / 2, 0, 0]} position={[0, -0.8, 0]}>
      <torusGeometry args={[0.6, 0.015, 8, 32, Math.PI * 1.5]} />
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={1}
        transparent
        opacity={0.7}
      />
    </mesh>
  );
}

function Scene({ state, speaking }) {
  const stateConfig = AGENT_STATES[state] || AGENT_STATES.sleeping;
  const color = stateConfig.color;

  const sparkleCount = state === 'coding' ? 60 : state === 'thinking' ? 45 : state === 'sleeping' ? 10 : 30;
  const sparkleSpeed = state === 'coding' ? 2 : state === 'sleeping' ? 0.2 : 0.8;

  return (
    <>
      <ambientLight intensity={0.1} />
      <pointLight position={[3, 2, 3]} intensity={0.6} color={color} />
      <pointLight position={[-2, -2, 2]} intensity={0.3} color="#6366f1" />
      <pointLight position={[0, 3, -2]} intensity={0.4} color="#06b6d4" />

      <NeuralCore color={color} state={state} speaking={speaking} />
      <NeuralNodes color={color} state={state} />
      <SynapticLinks color={color} state={state} />
      <DataFlowParticles color={color} state={state} />
      <HexGrid color={color} state={state} />
      <StatusRing color={color} state={state} />

      <Sparkles
        count={sparkleCount}
        scale={3}
        size={2}
        speed={sparkleSpeed}
        color={color}
      />

      <CoSAvatarOrbitControls />
    </>
  );
}

export default function NexusCoSAvatar({ state, speaking }) {
  return (
    <CoSAvatarFrame label="Nexus 3D avatar. Drag to rotate.">
      <Canvas
        camera={{ position: [0, 0.2, 3.5], fov: 45 }}
        style={{ background: 'transparent' }}
        gl={{ alpha: true, antialias: true }}
      >
        <Scene state={state} speaking={speaking} />
      </Canvas>
    </CoSAvatarFrame>
  );
}
