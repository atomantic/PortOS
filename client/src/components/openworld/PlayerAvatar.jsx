import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useOpenWorldPalette } from './OpenWorldPaletteContext';
import { dampFactor, EYE_HEIGHT, VEHICLE } from '../../utils/openWorldPlayerRig';
import { mixHex } from './openWorldConstants';

// A small, procedural low-poly rover keeps the third-person actor local to OpenWorld.
// It is intentionally made from primitives instead of another downloaded GLB: the car
// inherits the active theme, loads instantly, and stays readable while sprinting, jumping,
// or flying above the city.
const CAR_LENGTH = VEHICLE.bodyLength;
const CAR_WIDTH = VEHICLE.bodyWidth;
const WHEEL_RADIUS = 0.24;
const WHEEL_X = CAR_WIDTH * 0.57;
const WHEEL_Z = CAR_LENGTH * 0.31;
const _rootTarget = new THREE.Vector3();

export default function PlayerAvatar({ rigRef }) {
  const { accent, surface, isDay } = useOpenWorldPalette();
  const rootRef = useRef();
  const bodyRef = useRef();
  const hoverRingRef = useRef();
  const underglowRef = useRef();
  const thrusterRef = useRef();
  const brakeLightRef = useRef();
  const skidSmokeRef = useRef();
  const wheelRefs = useRef([]);

  const bodyColor = mixHex('#ee8f68', accent, 0.16);
  const bodyShadow = mixHex('#263447', accent, 0.16);
  const glassColor = mixHex('#294765', accent, 0.22);
  const wheelColor = '#17212d';
  // Night driving readability: additive light cones project from the headlamps after
  // dark (the palette's day flag doubles as the world's local time of day). Visual-only
  // beams — no real light — keeps the rig free of per-frame shadow/light cost.
  const headlightsOn = !isDay;

  useFrame(({ clock }, delta) => {
    const root = rootRef.current;
    const body = bodyRef.current;
    const rig = rigRef?.current;
    if (!root || !body || !rig) return;

    const t = clock.getElapsedTime();
    const hovering = rig.state === 'hover';
    const moving = rig.state === 'walk' || rig.state === 'run';
    const running = rig.state === 'run';
    const follow = dampFactor(10, delta);
    const targetY = rig.position.y - EYE_HEIGHT + (hovering ? 0.25 : 0);
    const speed = rig.speed || 0;
    const speedRatio = Math.min(1, Math.abs(speed) / 38);
    const isBoosting = Math.abs(speed) > 24 || (running && speedRatio > 0.6);
    const isBraking = speed < -0.1 || (rig.skid > 0.5 && speedRatio > 0.2);

    root.position.lerp(_rootTarget.set(rig.position.x, targetY, rig.position.z), follow);
    root.rotation.y = rig.facing;
    root.rotation.z = rig.bank * 0.58;

    const bob = hovering
      ? 0.2 + Math.sin(t * 2.4) * 0.07
      : Math.sin(t * (7 + speedRatio * 8)) * 0.018 * speedRatio;
    body.position.y += (bob - body.position.y) * follow;
    body.rotation.x = hovering ? Math.sin(t * 2.1) * 0.045 : -speedRatio * 0.018;
    body.rotation.z = rig.bank * 0.34;

    const wheelSpeed = speed !== 0 ? speed / WHEEL_RADIUS : running ? 15 : moving ? 8 : 0;
    wheelRefs.current.forEach((wheel, index) => {
      if (!wheel) return;
      wheel.rotation.x -= wheelSpeed * delta;
      // The front axle follows the damped steering angle. Rear wheels stay planted while
      // the whole rover banks, which makes steering readable even at low speed.
      wheel.rotation.y = index >= 2 ? (rig.wheelAngle || 0) : 0;
    });

    if (hoverRingRef.current) {
      hoverRingRef.current.rotation.z = t * 0.75;
      hoverRingRef.current.material.opacity = hovering ? 0.72 : 0.22;
      hoverRingRef.current.scale.setScalar(hovering ? 1 + Math.sin(t * 3) * 0.08 : 1);
    }
    if (underglowRef.current) {
      underglowRef.current.material.opacity = (hovering ? 0.42 : moving ? 0.26 : 0.16) + Math.sin(t * 4) * 0.025;
    }

    if (thrusterRef.current) {
      const flameScale = isBoosting ? 1 + Math.sin(t * 28) * 0.3 : 0.001;
      thrusterRef.current.scale.set(flameScale, flameScale, isBoosting ? 1.4 + Math.sin(t * 32) * 0.4 : 0.001);
      thrusterRef.current.visible = isBoosting;
    }

    if (brakeLightRef.current) {
      brakeLightRef.current.material.emissiveIntensity = isBraking ? 1.2 : 0.28;
    }

    if (skidSmokeRef.current) {
      const isSkidding = rig.skid > 0.35 && speedRatio > 0.3;
      skidSmokeRef.current.visible = isSkidding;
      if (isSkidding) {
        skidSmokeRef.current.rotation.z = t * 4;
        skidSmokeRef.current.scale.setScalar(0.8 + Math.sin(t * 16) * 0.25);
      }
    }
  });

  const setWheelRef = (index) => (node) => {
    wheelRefs.current[index] = node;
  };

  return (
    <group ref={rootRef}>
      <group ref={bodyRef}>
        {/* Low-poly body and cabin */}
        <mesh position={[0, 0.48, 0]}>
          <boxGeometry args={[CAR_WIDTH, 0.42, CAR_LENGTH]} />
          <meshStandardMaterial {...surface} color={bodyColor} roughness={0.58} metalness={0.22} />
        </mesh>
        <mesh position={[0, 0.74, 0.08]}>
          <boxGeometry args={[CAR_WIDTH * 0.72, 0.26, CAR_LENGTH * 0.46]} />
          <meshStandardMaterial {...surface} color={glassColor} roughness={0.24} metalness={0.36} transparent opacity={0.92} />
        </mesh>
        {/* Hood scoop breaks up the flat hood line and reads at speed. */}
        <mesh position={[0, 0.72, -CAR_LENGTH * 0.16]}>
          <boxGeometry args={[CAR_WIDTH * 0.26, 0.06, CAR_LENGTH * 0.16]} />
          <meshStandardMaterial {...surface} color={bodyShadow} roughness={0.5} metalness={0.3} />
        </mesh>
        {/* Aero: front splitter + side skirts ground the body visually. */}
        <mesh position={[0, 0.2, -CAR_LENGTH * 0.48]}>
          <boxGeometry args={[CAR_WIDTH * 0.94, 0.05, 0.18]} />
          <meshStandardMaterial color={wheelColor} roughness={0.85} metalness={0.1} />
        </mesh>
        {[-1, 1].map((side) => (
          <mesh key={`skirt-${side}`} position={[side * (CAR_WIDTH / 2), 0.24, 0]}>
            <boxGeometry args={[0.06, 0.13, CAR_LENGTH * 0.66]} />
            <meshStandardMaterial color={wheelColor} roughness={0.85} metalness={0.1} />
          </mesh>
        ))}
        {/* Rear wing on two struts — the silhouette cue that says "rover" from far away. */}
        {[-1, 1].map((side) => (
          <mesh key={`strut-${side}`} position={[side * CAR_WIDTH * 0.28, 0.76, CAR_LENGTH * 0.38]}>
            <boxGeometry args={[0.05, 0.14, 0.07]} />
            <meshStandardMaterial {...surface} color={bodyShadow} roughness={0.5} metalness={0.35} />
          </mesh>
        ))}
        <mesh position={[0, 0.85, CAR_LENGTH * 0.4]}>
          <boxGeometry args={[CAR_WIDTH * 1.04, 0.05, CAR_LENGTH * 0.13]} />
          <meshStandardMaterial {...surface} color={bodyShadow} roughness={0.45} metalness={0.4} />
        </mesh>
        {/* Trailing accent strip along the wing's back edge. */}
        <mesh position={[0, 0.85, CAR_LENGTH * 0.5]}>
          <boxGeometry args={[CAR_WIDTH * 1.02, 0.03, 0.02]} />
          <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.5} />
        </mesh>
        <mesh position={[0, 0.39, -CAR_LENGTH * 0.53]}>
          <boxGeometry args={[CAR_WIDTH * 0.88, 0.08, 0.1]} />
          <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.45} />
        </mesh>
        <mesh ref={brakeLightRef} position={[0, 0.4, CAR_LENGTH * 0.53]}>
          <boxGeometry args={[CAR_WIDTH * 0.82, 0.07, 0.08]} />
          <meshStandardMaterial color="#ef5252" emissive="#ef5252" emissiveIntensity={0.28} />
        </mesh>
        {/* Twin exhaust tips below the rear light bar. */}
        {[-1, 1].map((side) => (
          <mesh key={`exhaust-${side}`} position={[side * CAR_WIDTH * 0.18, 0.3, CAR_LENGTH * 0.54]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.045, 0.05, 0.09, 8]} />
            <meshStandardMaterial color={bodyShadow} roughness={0.35} metalness={0.65} />
          </mesh>
        ))}

        {/* Headlight beams after dark: apex at the lamp, cone spreading forward and a
            touch down so the road ahead reads while driving at night. */}
        {headlightsOn && [-1, 1].map((side) => (
          <group key={`beam-${side}`} position={[side * CAR_WIDTH * 0.3, 0.55, -CAR_LENGTH * 0.55]} rotation={[-0.09, 0, 0]}>
            {/* Cone axis is +Y by default; rotating +90° about X aims apex to +Z and base to -Z.
                With offset [0, 0, -2.7], apex is on the lamp (z=0) and wide base spreads forward (z=-5.4). */}
            <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0, -2.7]}>
              <coneGeometry args={[1.15, 5.4, 10, 1, true]} />
              <meshBasicMaterial
                color="#ffe9b8"
                transparent
                opacity={0.14}
                blending={THREE.AdditiveBlending}
                depthWrite={false}
                side={THREE.DoubleSide}
                toneMapped={false}
              />
            </mesh>
            {/* Soft projected illumination spot on the road ahead */}
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.48, -4.2]}>
              <circleGeometry args={[1.2, 16]} />
              <meshBasicMaterial
                color="#ffe9b8"
                transparent
                opacity={0.09}
                blending={THREE.AdditiveBlending}
                depthWrite={false}
                side={THREE.DoubleSide}
              />
            </mesh>
          </group>
        ))}

        <group ref={thrusterRef} position={[0, 0.38, CAR_LENGTH * 0.58]} visible={false}>
          {[-CAR_WIDTH * 0.24, CAR_WIDTH * 0.24].map((offsetX, i) => (
            <mesh key={`flame-${i}`} position={[offsetX, 0, 0]} rotation={[Math.PI / 2, 0, 0]}>
              <coneGeometry args={[0.14, 0.65, 8]} />
              <meshBasicMaterial color="#38bdf8" transparent opacity={0.88} blending={THREE.AdditiveBlending} />
            </mesh>
          ))}
        </group>

        {/* Front lamps and the small roof beacon make the vehicle readable in both views. */}
        {[-1, 1].map((side) => (
          <mesh key={`lamp-${side}`} position={[side * CAR_WIDTH * 0.3, 0.55, -CAR_LENGTH * 0.53]}>
            <boxGeometry args={[0.13, 0.08, 0.035]} />
            <meshBasicMaterial color="#fff5cf" toneMapped={false} />
          </mesh>
        ))}
        <mesh position={[0, 0.96, 0.08]}>
          <sphereGeometry args={[0.055, 8, 6]} />
          <meshBasicMaterial color={accent} toneMapped={false} />
        </mesh>

        {/* Wheels are deliberately chunky: the actor should read as a vehicle at a glance. */}
        {[
          [-WHEEL_X, WHEEL_Z],
          [WHEEL_X, WHEEL_Z],
          [-WHEEL_X, -WHEEL_Z],
          [WHEEL_X, -WHEEL_Z],
        ].map(([x, z], index) => (
          <group key={`wheel-${index}`} ref={setWheelRef(index)} position={[x, WHEEL_RADIUS, z]} rotation={[0, 0, Math.PI / 2]}>
            <mesh>
              <cylinderGeometry args={[WHEEL_RADIUS, WHEEL_RADIUS, 0.16, 12]} />
              <meshStandardMaterial color={wheelColor} roughness={0.88} metalness={0.08} />
            </mesh>
            <mesh rotation={[0, Math.PI / 2, 0]}>
              <cylinderGeometry args={[WHEEL_RADIUS * 0.44, WHEEL_RADIUS * 0.44, 0.17, 10]} />
              <meshStandardMaterial color={bodyShadow} roughness={0.48} metalness={0.4} />
            </mesh>
          </group>
        ))}
      </group>

      <group ref={skidSmokeRef} position={[0, 0.08, WHEEL_Z]} visible={false}>
        {[-WHEEL_X, WHEEL_X].map((wx, i) => (
          <mesh key={`smoke-${i}`} position={[wx, 0, 0]}>
            <sphereGeometry args={[0.22, 6, 6]} />
            <meshBasicMaterial color="#94a3b8" transparent opacity={0.45} blending={THREE.AdditiveBlending} depthWrite={false} />
          </mesh>
        ))}
      </group>

      {/* Ground feedback is intentionally simpler than the old robot's large footprint. */}
      <mesh ref={underglowRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.025, 0]}>
        <circleGeometry args={[0.9, 24]} />
        <meshBasicMaterial color={accent} transparent opacity={0.16} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <mesh ref={hoverRingRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.04, 0]}>
        <torusGeometry args={[0.82, 0.025, 6, 24]} />
        <meshBasicMaterial color={accent} transparent opacity={0.22} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
    </group>
  );
}
