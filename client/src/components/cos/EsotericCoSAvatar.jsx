import { useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Float, MeshDistortMaterial, Sparkles, Stars, Trail } from '@react-three/drei';
import * as THREE from 'three';
import { AGENT_STATES } from './constants';

// Central mystical core - an artifact of unknown origin
function EsotericCore({ color, state, speaking }) {
  const meshRef = useRef();
  const glowRef = useRef();
  
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    
    // Core rotation and pulse
    if (meshRef.current) {
      meshRef.current.rotation.x = Math.sin(t * 0.2) * 0.5;
      meshRef.current.rotation.y += 0.01;
      
      // React to speaking
      const speakPulse = speaking ? Math.sin(t * 20) * 0.2 : 0;
      meshRef.current.scale.setScalar(1 + Math.sin(t * 1.5) * 0.05 + speakPulse);
    }

    if (glowRef.current) {
        glowRef.current.scale.setScalar(1.2 + Math.sin(t * 2) * 0.1);
        glowRef.current.material.opacity = 0.2 + Math.sin(t * 3) * 0.1;
    }
  });

  return (
    <group>
      <Float speed={2} rotationIntensity={0.5} floatIntensity={0.5}>
        {/* Inner Core */}
        <mesh ref={meshRef}>
          <octahedronGeometry args={[0.8, 0]} />
          <MeshDistortMaterial
            color={color}
            emissive={color}
            emissiveIntensity={state === 'thinking' ? 2 : 0.5}
            roughness={0.1}
            metalness={1}
            distort={0.4}
            speed={2}
            wireframe={state === 'investigating'}
          />
        </mesh>
        
        {/* Outer Glow Shell */}
        <mesh ref={glowRef}>
          <icosahedronGeometry args={[0.9, 2]} />
          <meshBasicMaterial
            color={color}
            transparent
            opacity={0.1}
            wireframe
            side={THREE.DoubleSide}
          />
        </mesh>
      </Float>
    </group>
  );
}

// Orbiting runic shards
function RunicShards({ color, state }) {
  const groupRef = useRef();
  const shards = useMemo(() => {
    return Array.from({ length: 5 }).map((_, i) => ({
      rotationSpeed: (Math.random() - 0.5) * 2,
      orbitSpeed: 0.5 + Math.random() * 0.5,
      orbitRadius: 1.5 + Math.random() * 0.5,
      phase: Math.random() * Math.PI * 2,
      scale: 0.2 + Math.random() * 0.3
    }));
  }, []);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (groupRef.current) {
      groupRef.current.children.forEach((child, i) => {
        const shard = shards[i];
        const angle = t * shard.orbitSpeed + shard.phase;
        
        // Orbital motion
        child.position.x = Math.cos(angle) * shard.orbitRadius;
        child.position.z = Math.sin(angle) * shard.orbitRadius;
        child.position.y = Math.sin(t * 0.5 + shard.phase) * 0.5;
        
        // Self rotation
        child.rotation.x += shard.rotationSpeed * 0.02;
        child.rotation.y += shard.rotationSpeed * 0.03;
      });
      
      // Speed up for active states
      const speedMult = state === 'coding' || state === 'thinking' ? 2 : 1;
      groupRef.current.rotation.y = t * 0.1 * speedMult;
    }
  });

  return (
    <group ref={groupRef}>
      {shards.map((shard, i) => (
        <mesh key={i}>
          <coneGeometry args={[shard.scale, shard.scale * 2, 4]} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={1}
            transparent
            opacity={0.8}
            roughness={0.2}
            metalness={0.8}
          />
        </mesh>
      ))}
    </group>
  );
}

// Ancient halo rings
function AncientHalo({ color, state }) {
    const ringRef = useRef();
    const ring2Ref = useRef();

    useFrame(({ clock }) => {
        const t = clock.getElapsedTime();
        if (ringRef.current) {
            ringRef.current.rotation.z = t * 0.2;
            ringRef.current.rotation.x = Math.PI / 2 + Math.sin(t * 0.5) * 0.2;
        }
        if (ring2Ref.current) {
            ring2Ref.current.rotation.z = -t * 0.15;
            ring2Ref.current.rotation.y = Math.PI / 3 + Math.sin(t * 0.3) * 0.1;
        }
    });

    return (
        <group>
             <mesh ref={ringRef}>
                <torusGeometry args={[1.8, 0.02, 16, 100]} />
                <meshStandardMaterial 
                    color={color} 
                    emissive={color}
                    emissiveIntensity={0.5}
                    transparent
                    opacity={0.4}
                />
            </mesh>
             <mesh ref={ring2Ref}>
                <torusGeometry args={[2.2, 0.01, 16, 100]} />
                <meshStandardMaterial 
                    color={color} 
                    emissive={color}
                    emissiveIntensity={0.3}
                    transparent
                    opacity={0.2}
                />
            </mesh>
        </group>
    )
}

function FloatingRunes({ color }) {
    // Generate random positions for "runes" (small geometries)
    const count = 15;
    const positions = useMemo(() => {
        return new Float32Array(count * 3).map(() => (Math.random() - 0.5) * 5);
    }, []);

    return (
        <Sparkles 
            count={30}
            scale={4}
            size={4}
            speed={0.4}
            opacity={0.5}
            color={color}
        />
    )
}


function Scene({ state, speaking }) {
  const stateConfig = AGENT_STATES[state] || AGENT_STATES.sleeping;
  const color = stateConfig.color;

  return (
    <>
      <ambientLight intensity={0.2} />
      <pointLight position={[10, 10, 10]} intensity={1} color={color} />
      <pointLight position={[-10, -10, -10]} intensity={0.5} color="#4c1d95" />
      
      <EsotericCore color={color} state={state} speaking={speaking} />
      <RunicShards color={color} state={state} />
      <AncientHalo color={color} state={state} />
      <FloatingRunes color={color} />
      
      {/* Background stars for depth */}
      <Stars radius={100} depth={50} count={1000} factor={4} saturation={0} fade speed={1} />
    </>
  );
}

export default function EsotericCoSAvatar({ state, speaking }) {
  return (
    <div className="relative w-28 h-36 sm:w-36 sm:h-44 md:w-44 md:h-56 lg:w-56 lg:h-72">
      <Canvas
        camera={{ position: [0, 0, 5], fov: 45 }}
        style={{ background: 'transparent' }}
        gl={{ alpha: true, antialias: true }}
      >
        <Scene state={state} speaking={speaking} />
      </Canvas>
    </div>
  );
}
