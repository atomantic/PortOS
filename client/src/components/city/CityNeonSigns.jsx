import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import * as THREE from 'three';
import { CITY_COLORS, PIXEL_FONT_URL } from './cityConstants';

// Floating neon street-level signs with animated glow

function NeonSign({ position, rotation, text, color, fontSize = 0.4, flickerRate = 0, phase = 0 }) {
  const textRef = useRef();
  const backRef = useRef();
  const glowRef = useRef();

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();

    // Flicker effect for some signs
    let opacity = 0.9;
    if (flickerRate > 0) {
      const flicker = Math.sin(t * flickerRate + phase);
      // Occasional rapid flicker
      if (flicker > 0.85) opacity = 0.3 + Math.random() * 0.5;
      else if (flicker > 0.7) opacity = 0.1;
    }

    if (textRef.current) {
      textRef.current.fillOpacity = opacity;
    }
    if (backRef.current) {
      backRef.current.material.opacity = 0.5 * opacity;
    }
    if (glowRef.current) {
      glowRef.current.material.opacity = 0.15 * opacity;
    }
  });

  const textWidth = text.length * fontSize * 0.55;
  const textHeight = fontSize * 1.4;

  return (
    <group position={position} rotation={rotation}>
      {/* Dark backing panel */}
      <mesh ref={backRef} position={[0, 0, -0.02]}>
        <planeGeometry args={[textWidth + 0.3, textHeight + 0.15]} />
        <meshBasicMaterial color="#020208" transparent opacity={0.5} side={THREE.DoubleSide} />
      </mesh>

      {/* Neon text */}
      <Text
        ref={textRef}
        fontSize={fontSize}
        color={color}
        anchorX="center"
        anchorY="middle"
        font={PIXEL_FONT_URL}
      >
        {text}
      </Text>

      {/* Glow halo behind text */}
      <mesh ref={glowRef} position={[0, 0, -0.03]}>
        <planeGeometry args={[textWidth + 0.8, textHeight + 0.6]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.15}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Point light for neon glow effect on surroundings */}
      <pointLight color={color} intensity={0.3} distance={4} decay={2} />
    </group>
  );
}

// Vertical neon bar decoration
function NeonBar({ position, rotation, color, height = 2 }) {
  const ref = useRef();

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.getElapsedTime();
    ref.current.material.opacity = 0.4 + Math.sin(t * 2 + position[0]) * 0.15;
  });

  return (
    <mesh ref={ref} position={position} rotation={rotation}>
      <boxGeometry args={[0.04, height, 0.04]} />
      <meshBasicMaterial color={color} transparent opacity={0.4} />
    </mesh>
  );
}

export default function CityNeonSigns({ positions }) {
  const signs = useMemo(() => {
    if (!positions || positions.size < 2) return [];

    const entries = [];
    positions.forEach((pos) => {
      if (pos.district === 'downtown') entries.push(pos);
    });

    if (entries.length < 2) return [];

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    entries.forEach(p => {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    });

    const colors = CITY_COLORS.neonAccents;
    const pad = 3;
    const result = [];

    // Signs along the perimeter of downtown
    const signTexts = [
      'PORTOS', 'SYSTEM ONLINE', 'CYBER', 'DIGITAL',
      'NEURAL NET', 'DATA CORE', 'QUANTUM', 'UPLINK',
      'OVERRIDE', 'SYNC', 'MATRIX', 'NEON',
    ];

    // Front signs
    result.push({
      id: 'sign-front-1',
      position: [minX - pad + 2, 2.5, minZ - pad + 1],
      rotation: [0, 0, 0],
      text: signTexts[0],
      color: colors[0],
      fontSize: 0.5,
      flickerRate: 0,
      phase: 0,
    });
    result.push({
      id: 'sign-front-2',
      position: [maxX + pad - 2, 1.8, minZ - pad + 1],
      rotation: [0, 0, 0],
      text: signTexts[1],
      color: colors[1],
      fontSize: 0.35,
      flickerRate: 8,
      phase: 1,
    });

    // Right side signs
    result.push({
      id: 'sign-right-1',
      position: [maxX + pad, 3.2, (minZ + maxZ) / 2 - 3],
      rotation: [0, -Math.PI / 2, 0],
      text: signTexts[2],
      color: colors[4],
      fontSize: 0.6,
      flickerRate: 0,
      phase: 2,
    });
    result.push({
      id: 'sign-right-2',
      position: [maxX + pad, 1.5, (minZ + maxZ) / 2 + 2],
      rotation: [0, -Math.PI / 2, 0],
      text: signTexts[3],
      color: colors[5],
      fontSize: 0.3,
      flickerRate: 12,
      phase: 3,
    });

    // Left side signs
    result.push({
      id: 'sign-left-1',
      position: [minX - pad, 2.8, (minZ + maxZ) / 2],
      rotation: [0, Math.PI / 2, 0],
      text: signTexts[4],
      color: colors[2],
      fontSize: 0.35,
      flickerRate: 0,
      phase: 4,
    });

    // Back signs
    result.push({
      id: 'sign-back-1',
      position: [(minX + maxX) / 2, 2, maxZ + pad - 1],
      rotation: [0, Math.PI, 0],
      text: signTexts[5],
      color: colors[3],
      fontSize: 0.4,
      flickerRate: 6,
      phase: 5,
    });

    return result;
  }, [positions]);

  const bars = useMemo(() => {
    if (!positions || positions.size < 2) return [];

    const entries = [];
    positions.forEach((pos) => {
      if (pos.district === 'downtown') entries.push(pos);
    });

    if (entries.length < 2) return [];

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    entries.forEach(p => {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    });

    const colors = CITY_COLORS.neonAccents;
    const pad = 3;
    const result = [];

    // Vertical neon bars at corners
    const corners = [
      [minX - pad, minZ - pad],
      [maxX + pad, minZ - pad],
      [minX - pad, maxZ + pad],
      [maxX + pad, maxZ + pad],
    ];

    corners.forEach(([x, z], i) => {
      result.push({
        id: `bar-${i}`,
        position: [x, 1.5, z],
        rotation: [0, 0, 0],
        color: colors[i % colors.length],
        height: 3,
      });
    });

    return result;
  }, [positions]);

  if (signs.length === 0) return null;

  return (
    <group>
      {signs.map(sign => (
        <NeonSign
          key={sign.id}
          position={sign.position}
          rotation={sign.rotation}
          text={sign.text}
          color={sign.color}
          fontSize={sign.fontSize}
          flickerRate={sign.flickerRate}
          phase={sign.phase}
        />
      ))}
      {bars.map(bar => (
        <NeonBar
          key={bar.id}
          position={bar.position}
          rotation={bar.rotation}
          color={bar.color}
          height={bar.height}
        />
      ))}
    </group>
  );
}
