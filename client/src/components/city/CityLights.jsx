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
      intensity={0.3}
      color="#06b6d4"
      angle={0.15}
      penumbra={0.8}
      distance={80}
      decay={1.5}
      castShadow={false}
    />
  );
}

export default function CityLights() {
  return (
    <>
      <ambientLight intensity={0.06} color={CITY_COLORS.ambient} />
      {/* Main overhead cyan - brighter */}
      <pointLight position={[0, 25, 0]} intensity={0.6} color="#06b6d4" distance={80} />
      {/* Magenta accent from left - animated color shift */}
      <AnimatedLight position={[-20, 10, -15]} baseColor="#ec4899" intensity={0.45} distance={55} speed={0.3} shiftRange={0.15} />
      {/* Blue accent from right - animated shift */}
      <AnimatedLight position={[20, 10, 15]} baseColor="#3b82f6" intensity={0.45} distance={55} speed={0.4} shiftRange={0.12} />
      {/* Purple from behind - more presence */}
      <pointLight position={[0, 15, -25]} intensity={0.3} color="#8b5cf6" distance={50} />
      {/* Warm orange ground level accent */}
      <pointLight position={[10, 3, 5]} intensity={0.2} color="#f97316" distance={30} />
      {/* Additional green accent - ground level from opposite side */}
      <pointLight position={[-12, 2, 8]} intensity={0.12} color="#22c55e" distance={20} />
      {/* Red warning accent from below-right */}
      <pointLight position={[15, 1, -10]} intensity={0.08} color="#f43f5e" distance={18} />
      {/* Sweeping searchlight */}
      <Searchlight />
    </>
  );
}
