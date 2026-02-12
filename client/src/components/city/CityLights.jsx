import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { CITY_COLORS } from './cityConstants';

// Animated accent light that slowly shifts color
function AnimatedLight({ position, baseColor, intensity, distance, shiftRange = 0.1, speed = 0.5 }) {
  const ref = useRef();

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.getElapsedTime();
    ref.current.intensity = intensity + Math.sin(t * speed) * intensity * shiftRange;
  });

  return (
    <pointLight
      ref={ref}
      position={position}
      intensity={intensity}
      color={baseColor}
      distance={distance}
    />
  );
}

// Sweeping searchlight effect
function Searchlight() {
  const ref = useRef();

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.getElapsedTime();
    const angle = t * 0.2;
    const radius = 25;
    ref.current.position.x = Math.cos(angle) * radius;
    ref.current.position.z = Math.sin(angle) * radius;
    // Point toward center
    ref.current.target.position.set(0, 0, 0);
    ref.current.target.updateMatrixWorld();
  });

  return (
    <spotLight
      ref={ref}
      position={[25, 30, 0]}
      intensity={0.6}
      color="#06b6d4"
      angle={0.2}
      penumbra={0.8}
      distance={90}
      decay={1.2}
      castShadow={false}
    />
  );
}

export default function CityLights({ settings }) {
  const b = settings?.ambientBrightness ?? 1.2;
  return (
    <>
      <ambientLight intensity={0.18 * b} color="#1a1a3a" />
      {/* Main overhead cyan */}
      <pointLight position={[0, 30, 0]} intensity={1.2 * b} color="#06b6d4" distance={100} />
      {/* Secondary overhead fill - broad white/blue */}
      <pointLight position={[0, 20, 10]} intensity={0.5 * b} color="#4488cc" distance={90} />
      {/* Magenta accent from left - animated color shift */}
      <AnimatedLight position={[-20, 12, -15]} baseColor="#ec4899" intensity={0.7 * b} distance={60} speed={0.3} shiftRange={0.15} />
      {/* Blue accent from right - animated shift */}
      <AnimatedLight position={[20, 12, 15]} baseColor="#3b82f6" intensity={0.7 * b} distance={60} speed={0.4} shiftRange={0.12} />
      {/* Purple from behind - more presence */}
      <pointLight position={[0, 15, -25]} intensity={0.5 * b} color="#8b5cf6" distance={60} />
      {/* Warm orange ground level accent */}
      <pointLight position={[10, 3, 5]} intensity={0.35 * b} color="#f97316" distance={35} />
      {/* Additional green accent - ground level from opposite side */}
      <pointLight position={[-12, 3, 8]} intensity={0.2 * b} color="#22c55e" distance={25} />
      {/* Red warning accent from below-right */}
      <pointLight position={[15, 2, -10]} intensity={0.15 * b} color="#f43f5e" distance={22} />
      {/* Sweeping searchlight */}
      <Searchlight />
    </>
  );
}
