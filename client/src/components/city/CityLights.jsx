import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';

// Animated accent light that slowly shifts color, with reactive brightness
function AnimatedLight({ position, baseColor, baseIntensity, distance, shiftRange = 0.1, speed = 0.5, brightnessRef }) {
  const ref = useRef();

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const b = brightnessRef.current;
    const t = clock.getElapsedTime();
    ref.current.intensity = (baseIntensity + Math.sin(t * speed) * baseIntensity * shiftRange) * b;
  });

  return (
    <pointLight
      ref={ref}
      position={position}
      intensity={baseIntensity}
      color={baseColor}
      distance={distance}
    />
  );
}

// Sweeping searchlight effect with reactive brightness
function Searchlight({ brightnessRef }) {
  const ref = useRef();

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.getElapsedTime();
    const angle = t * 0.2;
    const radius = 25;
    ref.current.position.x = Math.cos(angle) * radius;
    ref.current.position.z = Math.sin(angle) * radius;
    ref.current.intensity = 0.6 * brightnessRef.current;
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

// Static point light that updates intensity every frame from brightness ref
function ReactivePointLight({ position, baseIntensity, color, distance, brightnessRef }) {
  const ref = useRef();

  useFrame(() => {
    if (!ref.current) return;
    ref.current.intensity = baseIntensity * brightnessRef.current;
  });

  return (
    <pointLight
      ref={ref}
      position={position}
      intensity={baseIntensity}
      color={color}
      distance={distance}
    />
  );
}

export default function CityLights({ settings }) {
  // Store brightness in a ref so useFrame callbacks always see current value
  const brightnessRef = useRef(settings?.ambientBrightness ?? 1.2);
  brightnessRef.current = settings?.ambientBrightness ?? 1.2;

  const ambientRef = useRef();
  useFrame(() => {
    if (!ambientRef.current) return;
    ambientRef.current.intensity = 0.18 * brightnessRef.current;
  });

  return (
    <>
      <ambientLight ref={ambientRef} intensity={0.18} color="#1a1a3a" />
      {/* Main overhead cyan */}
      <ReactivePointLight position={[0, 30, 0]} baseIntensity={1.2} color="#06b6d4" distance={100} brightnessRef={brightnessRef} />
      {/* Secondary overhead fill - broad white/blue */}
      <ReactivePointLight position={[0, 20, 10]} baseIntensity={0.5} color="#4488cc" distance={90} brightnessRef={brightnessRef} />
      {/* Magenta accent from left - animated color shift */}
      <AnimatedLight position={[-20, 12, -15]} baseColor="#ec4899" baseIntensity={0.7} distance={60} speed={0.3} shiftRange={0.15} brightnessRef={brightnessRef} />
      {/* Blue accent from right - animated shift */}
      <AnimatedLight position={[20, 12, 15]} baseColor="#3b82f6" baseIntensity={0.7} distance={60} speed={0.4} shiftRange={0.12} brightnessRef={brightnessRef} />
      {/* Purple from behind - more presence */}
      <ReactivePointLight position={[0, 15, -25]} baseIntensity={0.5} color="#8b5cf6" distance={60} brightnessRef={brightnessRef} />
      {/* Warm orange ground level accent */}
      <ReactivePointLight position={[10, 3, 5]} baseIntensity={0.35} color="#f97316" distance={35} brightnessRef={brightnessRef} />
      {/* Additional green accent - ground level from opposite side */}
      <ReactivePointLight position={[-12, 3, 8]} baseIntensity={0.2} color="#22c55e" distance={25} brightnessRef={brightnessRef} />
      {/* Red warning accent from below-right */}
      <ReactivePointLight position={[15, 2, -10]} baseIntensity={0.15} color="#f43f5e" distance={22} brightnessRef={brightnessRef} />
      {/* Sweeping searchlight */}
      <Searchlight brightnessRef={brightnessRef} />
    </>
  );
}
