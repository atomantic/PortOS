import { useRef, useMemo, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useCityPalette } from './CityPaletteContext';
import { dampFactor, dampAngle, EYE_HEIGHT } from '../../utils/cityPlayerRig';

// The exploration-mode cyber-runner: a stylized articulated character (~1.7 units tall)
// rendered in third person. Reads the PlayerController's mutable rig every frame — no
// React state on the hot path — and animates by rig.state:
//   idle  — soft bob, visor breathing, slow head scan
//   walk  — opposing hip/shoulder swing with elbow/knee follow-through
//   run   — faster phase, bigger amplitude, torso pitched into the sprint
//   hover — flyover: legs tuck, jet vents flare, glow disc brightens (a flying runner,
//           not a mid-air walker)
// Body color tracks the theme's structural dark; visor/trim/soles glow the theme accent.
// Geometry is shared at module scope; materials are per-mount (theme-tinted).

const EYE_COLOR = '#ff3366'; // semantic sensor red — not themed

const GEO = {
  helmet: new THREE.IcosahedronGeometry(0.16, 1),
  visor: new THREE.BoxGeometry(0.26, 0.07, 0.08),
  sensor: new THREE.BoxGeometry(0.05, 0.02, 0.02),
  torso: new THREE.BoxGeometry(0.42, 0.5, 0.26),
  core: new THREE.CylinderGeometry(0.09, 0.09, 0.03, 6),
  pauldron: new THREE.OctahedronGeometry(0.12, 0),
  upperArm: new THREE.CylinderGeometry(0.05, 0.045, 0.28, 6),
  forearm: new THREE.CylinderGeometry(0.045, 0.04, 0.26, 6),
  fist: new THREE.SphereGeometry(0.055, 6, 6),
  pelvis: new THREE.BoxGeometry(0.3, 0.16, 0.2),
  thigh: new THREE.CylinderGeometry(0.06, 0.055, 0.32, 6),
  shin: new THREE.CylinderGeometry(0.05, 0.045, 0.3, 6),
  boot: new THREE.BoxGeometry(0.11, 0.08, 0.22),
  sole: new THREE.BoxGeometry(0.11, 0.02, 0.22),
  backUnit: new THREE.BoxGeometry(0.22, 0.28, 0.1),
  vent: new THREE.CylinderGeometry(0.035, 0.05, 0.1, 6),
  disc: new THREE.CircleGeometry(0.45, 18),
};
GEO.helmet.computeVertexNormals();

// Joint heights (feet at 0): knee 0.31, hip 0.76, torso center 1.08, shoulder 1.3, head 1.55.
const HIP_Y = 0.76;
const SHOULDER_Y = 1.3;

export default function PlayerAvatar({ rigRef }) {
  const { accent, buildingBody, tintStructure } = useCityPalette();

  // Theme-tinted materials. Trim/visor glow the accent; the animated ones (visor, vents,
  // disc) are separate instances so per-frame intensity writes don't bleed across parts.
  const mats = useMemo(() => {
    const body = new THREE.MeshStandardMaterial({
      color: buildingBody, roughness: 0.45, metalness: 0.5, flatShading: true,
    });
    const dark = new THREE.MeshStandardMaterial({
      color: tintStructure('#0b101e'), roughness: 0.6, metalness: 0.4,
    });
    const trim = new THREE.MeshStandardMaterial({
      color: accent, emissive: accent, emissiveIntensity: 0.55, toneMapped: false,
      roughness: 0.3, metalness: 0.3,
    });
    const visor = trim.clone();
    const vents = new THREE.MeshStandardMaterial({
      color: accent, emissive: accent, emissiveIntensity: 0.0, toneMapped: false,
    });
    const sensor = new THREE.MeshBasicMaterial({ color: EYE_COLOR, toneMapped: false });
    const disc = new THREE.MeshBasicMaterial({
      color: accent, transparent: true, opacity: 0.16,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    return { body, dark, trim, visor, vents, sensor, disc };
  }, [accent, buildingBody, tintStructure]);

  // R3F doesn't dispose materials handed in via the `material` prop — free the prior
  // set when a theme switch rebuilds them, and on unmount.
  useEffect(() => () => { Object.values(mats).forEach((m) => m.dispose()); }, [mats]);

  const rootRef = useRef();
  const headRef = useRef();
  const torsoRef = useRef();
  const hipL = useRef();
  const hipR = useRef();
  const kneeL = useRef();
  const kneeR = useRef();
  const shoulderL = useRef();
  const shoulderR = useRef();
  const elbowL = useRef();
  const elbowR = useRef();
  const phaseRef = useRef(0);
  const groundOffsetRef = useRef(-EYE_HEIGHT);

  useFrame(({ clock }, delta) => {
    const root = rootRef.current;
    const rig = rigRef?.current;
    if (!root || !rig) return;
    const t = clock.getElapsedTime();
    const f = dampFactor(8, delta);
    const state = rig.state;
    const hovering = state === 'hover';
    const running = state === 'run';
    const moving = state === 'walk' || running;

    // Root follows the rig: feet on the ground normally; in hover the body floats
    // closer to the camera anchor with legs tucked.
    const targetOffset = hovering ? -1.05 : -EYE_HEIGHT;
    groundOffsetRef.current += (targetOffset - groundOffsetRef.current) * f;
    const bob = state === 'idle' ? Math.sin(t * 1.6) * 0.03 : hovering ? Math.sin(t * 2.2) * 0.06 : 0;
    root.position.set(rig.position.x, rig.position.y + groundOffsetRef.current + bob, rig.position.z);
    // The avatar geometry is modeled facing +Z (visor/chest/toes at +z, jet vents at -z),
    // but the rig's forward convention is -Z (rig.facing's 0 points toward -z). Bridge the
    // model-vs-rig 180° with a +π yaw offset so the runner faces its direction of travel
    // instead of walking backward toward the camera.
    root.rotation.y = rig.facing + Math.PI;
    root.rotation.z = rig.bank;

    // Gait phase advances while moving, settles to neutral at rest.
    if (moving) phaseRef.current += delta * (running ? 14 : 9);
    else phaseRef.current *= 1 - Math.min(1, f * 1.4);
    const amp = running ? 0.9 : 0.55;
    const swing = moving ? Math.sin(phaseRef.current) * amp : 0;
    const counter = -swing;

    const lerpRot = (ref, x) => {
      if (ref.current) ref.current.rotation.x += (x - ref.current.rotation.x) * f;
    };

    if (hovering) {
      // Tuck: thighs forward, knees folded, arms slightly out and back.
      lerpRot(hipL, 0.65);
      lerpRot(hipR, 0.65);
      lerpRot(kneeL, -1.2);
      lerpRot(kneeR, -1.2);
      lerpRot(shoulderL, -0.35);
      lerpRot(shoulderR, -0.35);
      lerpRot(elbowL, -0.5);
      lerpRot(elbowR, -0.5);
    } else {
      // Gait: hips/shoulders oppose; knees and elbows follow through a half-beat later.
      const follow = moving ? Math.max(0, Math.sin(phaseRef.current + 0.5)) * amp * 0.9 : 0;
      const followR = moving ? Math.max(0, Math.sin(phaseRef.current + Math.PI + 0.5)) * amp * 0.9 : 0;
      const elbowBase = running ? -0.8 : moving ? -0.3 : -0.12;
      lerpRot(hipL, swing);
      lerpRot(hipR, counter);
      lerpRot(kneeL, -follow);
      lerpRot(kneeR, -followR);
      lerpRot(shoulderL, counter * 0.8);
      lerpRot(shoulderR, swing * 0.8);
      lerpRot(elbowL, elbowBase - Math.max(0, counter) * 0.4);
      lerpRot(elbowR, elbowBase - Math.max(0, swing) * 0.4);
    }

    // Torso pitches into a sprint; head scans slowly at idle.
    if (torsoRef.current) {
      torsoRef.current.rotation.x += ((running ? 0.18 : hovering ? -0.1 : 0) - torsoRef.current.rotation.x) * f;
    }
    if (headRef.current) {
      const scan = state === 'idle' ? Math.sin(t * 0.4) * 0.22 : 0;
      headRef.current.rotation.y = dampAngle(headRef.current.rotation.y, scan, f);
    }

    // Emissive life: visor breathes at idle, vents flare in hover, disc brightens in hover.
    mats.visor.emissiveIntensity = 0.55 + (state === 'idle' ? (Math.sin(t * 1.8) + 1) * 0.12 : 0.15);
    const ventTarget = hovering ? 0.9 + (Math.sin(t * 6) + 1) * 0.25 : moving ? 0.25 : 0.05;
    mats.vents.emissiveIntensity += (ventTarget - mats.vents.emissiveIntensity) * f;
    mats.disc.opacity = hovering ? 0.3 : 0.16;
  });

  return (
    <group ref={rootRef}>
      <group ref={torsoRef} position={[0, HIP_Y + 0.08, 0]}>
        {/* Torso + chest core */}
        <mesh geometry={GEO.torso} material={mats.body} position={[0, 0.26, 0]} />
        <mesh geometry={GEO.core} material={mats.trim} rotation={[Math.PI / 2, 0, 0]} position={[0, 0.3, 0.14]} />
        {/* Back unit + jet vents */}
        <mesh geometry={GEO.backUnit} material={mats.dark} position={[0, 0.28, -0.17]} />
        <mesh geometry={GEO.vent} material={mats.vents} position={[-0.07, 0.12, -0.18]} />
        <mesh geometry={GEO.vent} material={mats.vents} position={[0.07, 0.12, -0.18]} />

        {/* Head */}
        <group ref={headRef} position={[0, SHOULDER_Y - HIP_Y + 0.17, 0]}>
          <mesh geometry={GEO.helmet} material={mats.body} />
          <mesh geometry={GEO.visor} material={mats.visor} position={[0, 0.01, 0.12]} />
          <mesh geometry={GEO.sensor} material={mats.sensor} position={[0, -0.07, 0.14]} />
        </group>

        {/* Pauldrons */}
        <mesh geometry={GEO.pauldron} material={mats.trim} position={[-0.27, 0.48, 0]} scale={[1, 0.7, 1]} />
        <mesh geometry={GEO.pauldron} material={mats.trim} position={[0.27, 0.48, 0]} scale={[1, 0.7, 1]} />

        {/* Arms: shoulder → elbow, two segments each */}
        <group ref={shoulderL} position={[-0.3, 0.44, 0]}>
          <mesh geometry={GEO.upperArm} material={mats.body} position={[0, -0.14, 0]} />
          <group ref={elbowL} position={[0, -0.28, 0]}>
            <mesh geometry={GEO.forearm} material={mats.dark} position={[0, -0.13, 0]} />
            <mesh geometry={GEO.fist} material={mats.dark} position={[0, -0.28, 0]} />
          </group>
        </group>
        <group ref={shoulderR} position={[0.3, 0.44, 0]}>
          <mesh geometry={GEO.upperArm} material={mats.body} position={[0, -0.14, 0]} />
          <group ref={elbowR} position={[0, -0.28, 0]}>
            <mesh geometry={GEO.forearm} material={mats.dark} position={[0, -0.13, 0]} />
            <mesh geometry={GEO.fist} material={mats.dark} position={[0, -0.28, 0]} />
          </group>
        </group>
      </group>

      {/* Pelvis */}
      <mesh geometry={GEO.pelvis} material={mats.dark} position={[0, HIP_Y, 0]} />

      {/* Legs: hip → knee, two segments each, boots with glowing soles */}
      <group ref={hipL} position={[-0.1, HIP_Y - 0.04, 0]}>
        <mesh geometry={GEO.thigh} material={mats.body} position={[0, -0.16, 0]} />
        <group ref={kneeL} position={[0, -0.32, 0]}>
          <mesh geometry={GEO.shin} material={mats.dark} position={[0, -0.15, 0]} />
          <mesh geometry={GEO.boot} material={mats.dark} position={[0, -0.32, 0.04]} />
          <mesh geometry={GEO.sole} material={mats.trim} position={[0, -0.37, 0.04]} />
        </group>
      </group>
      <group ref={hipR} position={[0.1, HIP_Y - 0.04, 0]}>
        <mesh geometry={GEO.thigh} material={mats.body} position={[0, -0.16, 0]} />
        <group ref={kneeR} position={[0, -0.32, 0]}>
          <mesh geometry={GEO.shin} material={mats.dark} position={[0, -0.15, 0]} />
          <mesh geometry={GEO.boot} material={mats.dark} position={[0, -0.32, 0.04]} />
          <mesh geometry={GEO.sole} material={mats.trim} position={[0, -0.37, 0.04]} />
        </group>
      </group>

      {/* Ground glow disc */}
      <mesh geometry={GEO.disc} material={mats.disc} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} />
    </group>
  );
}
