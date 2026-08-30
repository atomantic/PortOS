import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { PIXEL_FONT_URL, openWorldDayMix } from './openWorldConstants';
import { useOpenWorldPalette } from './OpenWorldPaletteContext';
import OpenWorldLabel from './OpenWorldLabel';
import { computeBackupVault } from '../../utils/openWorldBackupVault';
import { timeAgo } from '../../utils/formatters';

// OpenWorld's backup-vault landmark (roadmap 2.3): a squat armored bunker west of
// downtown with a glowing circular seal on its face. The seal's color tracks backup
// health (green protected → amber aging → red stale/failed → blue while a backup
// runs), it pulses on `backup:started/completed`, and the label shows time-since the
// last snapshot — going red and reading "STALE" when a backup is overdue.
export default function OpenWorldBackupVault({ backupStatus, settings }) {
  const { tintStructure } = useOpenWorldPalette();
  const vault = useMemo(() => computeBackupVault(backupStatus), [backupStatus]);
  const sealRef = useRef();

  // Honor the quality dial: drop the seal pulse on the lowest preset, but keep the
  // static glow so the vault's health is still legible.
  const animate = (settings?.particleDensity ?? 1) >= 0.5;
  const dayMix = openWorldDayMix(settings);

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
      {/* A faceted memory cairn reads as part of the landscape, while its live seal
          preserves the original backup-health contract. */}
      <mesh position={[0, height * 0.36, 0]} scale={[1, 0.82, 0.82]}>
        <dodecahedronGeometry args={[width * 0.62, 0]} />
        <meshStandardMaterial
          color={tintStructure('#263238')}
          emissive={color}
          emissiveIntensity={0.12 + vault.intensity * 0.18}
          metalness={0.2}
          roughness={0.86}
          flatShading
        />
      </mesh>
      <mesh position={[0, 0.16, 0]}>
        <cylinderGeometry args={[width * 0.76, width * 0.9, 0.32, 10]} />
        <meshStandardMaterial color={tintStructure('#344247')} emissive={color} emissiveIntensity={0.16} roughness={0.9} flatShading />
      </mesh>
      {/* Circular vault seal on the front (+Z) face — the live health indicator */}
      <mesh ref={sealRef} position={[0, height * 0.37, width * 0.52]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[width * 0.28, width * 0.28, 0.12, 24]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={vault.intensity} toneMapped={false} />
      </mesh>
      {/* Label + status/time-since sublabel above the vault */}
      <OpenWorldLabel position={[0, height * 0.78, 0]} fontSize={0.64} color={color} dayMix={dayMix} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={18}>
        VAULT
      </OpenWorldLabel>
      <OpenWorldLabel position={[0, height * 0.69, 0]} fontSize={0.38} color="#94a3b8" dayMix={dayMix} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={18}>
        {sublabel}
      </OpenWorldLabel>
    </group>
  );
}
