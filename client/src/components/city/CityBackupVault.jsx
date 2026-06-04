import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import { PIXEL_FONT_URL } from './cityConstants';
import { computeBackupVault } from '../../utils/cityBackupVault';
import { timeAgo } from '../../utils/formatters';

// CyberCity's backup-vault landmark (roadmap 2.3): a squat armored bunker west of
// downtown with a glowing circular seal on its face. The seal's color tracks backup
// health (green protected → amber aging → red stale/failed → blue while a backup
// runs), it pulses on `backup:started/completed`, and the label shows time-since the
// last snapshot — going red and reading "STALE" when a backup is overdue.
export default function CityBackupVault({ backupStatus, settings }) {
  const vault = useMemo(() => computeBackupVault(backupStatus), [backupStatus]);
  const sealRef = useRef();

  // Honor the quality dial: drop the seal pulse on the lowest preset, but keep the
  // static glow so the vault's health is still legible.
  const animate = (settings?.particleDensity ?? 1) >= 0.5;

  useFrame(({ clock }) => {
    if (!animate || !sealRef.current) return;
    // Running backups pulse fast; an alerting (stale/failed) vault throbs urgently;
    // a healthy vault breathes slowly.
    const speed = vault.running ? 4 : vault.alerting ? 2.4 : 0.8;
    const pulse = 0.5 + ((Math.sin(clock.getElapsedTime() * speed) + 1) / 2) * 0.7;
    sealRef.current.material.emissiveIntensity = pulse * (vault.intensity + 0.3);
  });

  const { position, width, height, color } = vault;
  const sublabel = vault.running
    ? vault.statusLabel
    : `${vault.statusLabel} · ${timeAgo(vault.lastRun)}`;

  return (
    <group position={position}>
      {/* Armored vault body — dark slab with a faint health-tinted glow */}
      <mesh position={[0, height / 2, 0]}>
        <boxGeometry args={[width, height, width * 0.8]} />
        <meshStandardMaterial
          color="#0a0e16"
          emissive={color}
          emissiveIntensity={0.12 + vault.intensity * 0.18}
          metalness={0.6}
          roughness={0.5}
        />
      </mesh>
      {/* Beveled cap so it reads as a sealed bunker, not just a box */}
      <mesh position={[0, height + 0.25, 0]}>
        <boxGeometry args={[width * 1.1, 0.5, width * 0.9]} />
        <meshStandardMaterial color="#0d131f" emissive={color} emissiveIntensity={0.25} metalness={0.7} roughness={0.4} />
      </mesh>
      {/* Circular vault seal on the front (+Z) face — the live health indicator */}
      <mesh ref={sealRef} position={[0, height * 0.5, width * 0.4 + 0.05]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[width * 0.28, width * 0.28, 0.12, 24]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={vault.intensity} toneMapped={false} />
      </mesh>
      {/* Label + status/time-since sublabel above the vault */}
      <Text position={[0, height + 1.7, 0]} fontSize={1.3} color={color} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={18}>
        VAULT
      </Text>
      <Text position={[0, height + 0.85, 0]} fontSize={0.85} color="#94a3b8" anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={18}>
        {sublabel}
      </Text>
    </group>
  );
}
