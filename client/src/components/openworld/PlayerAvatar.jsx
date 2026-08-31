import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useOpenWorldPalette } from './OpenWorldPaletteContext';
import { dampFactor, EYE_HEIGHT, solveVehicleSuspensionPose, VEHICLE } from '../../utils/openWorldPlayerRig';
import { openWorldTerrainHeight } from '../../utils/openWorldPlan';
import { mixHex } from './openWorldConstants';

// A small procedural utility cart keeps the player local to OpenWorld. Its orchard-orange
// body, canvas roof, timber cargo bed, and chunky suspension belong to the village instead
// of reading like a generic sports car dropped into it.
const CAR_LENGTH = VEHICLE.bodyLength;
const CAR_WIDTH = VEHICLE.bodyWidth;
const WHEEL_RADIUS = 0.34;
const WHEEL_X = CAR_WIDTH * 0.57;
const WHEEL_Z = CAR_LENGTH * 0.31;
const _rootTarget = new THREE.Vector3();
const _suspensionTarget = new THREE.Quaternion();
const _bankTarget = new THREE.Quaternion();
const _identityTarget = new THREE.Quaternion();
const _bankAxis = new THREE.Vector3(0, 0, 1);

export default function PlayerAvatar({ rigRef }) {
  const { accent, surface } = useOpenWorldPalette();
  const rootRef = useRef();
  const bodyRef = useRef();
  const hoverRingRef = useRef();
  const underglowRef = useRef();
  const thrusterRef = useRef();
  const brakeLightRef = useRef();
  const skidSmokeRef = useRef();
  const wheelSteerRefs = useRef([]);
  const wheelRollRefs = useRef([]);

  const bodyColor = mixHex('#e98b55', accent, 0.1);
  const bodyShadow = mixHex('#36544f', accent, 0.12);
  const glassColor = mixHex('#6ca7aa', accent, 0.14);
  const wheelColor = '#17212d';
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
    root.rotation.z = 0;

    const terrainHeight = openWorldTerrainHeight(rig.position.x, rig.position.z);
    const suspension = solveVehicleSuspensionPose({
      x: rig.position.x,
      z: rig.position.z,
      heading: rig.facing,
      centerHeight: terrainHeight,
      halfWidth: WHEEL_X,
      halfLength: WHEEL_Z,
      heightAt: openWorldTerrainHeight,
    });
    _suspensionTarget.set(
      suspension.rotation.x,
      suspension.rotation.y,
      suspension.rotation.z,
      suspension.rotation.w,
    );
    _bankTarget.setFromAxisAngle(_bankAxis, rig.bank * 0.24);
    _suspensionTarget.multiply(_bankTarget);

    const bob = hovering
      ? 0.2 + Math.sin(t * 2.4) * 0.07
      : Math.sin(t * (7 + speedRatio * 8)) * 0.018 * speedRatio;
    const rideOffset = hovering || rig.jumping ? 0 : suspension.translation.y;
    body.position.y += (rideOffset + bob - body.position.y) * follow;
    body.quaternion.slerp(hovering || rig.jumping ? _identityTarget : _suspensionTarget, dampFactor(12, delta));

    const wheelSpeed = speed !== 0 ? speed / WHEEL_RADIUS : running ? 15 : moving ? 8 : 0;
    wheelSteerRefs.current.forEach((steerPivot, index) => {
      if (!steerPivot) return;
      // Steering, suspension travel, and rolling live on separate nested pivots. Combining
      // them on one Euler made the cylinder's roll axis precess as the front wheels turned,
      // which read as a wobble even on flat ground.
      steerPivot.rotation.y = index >= 2 ? (rig.wheelAngle || 0) : 0;
      const wheelOffset = hovering || rig.jumping ? -0.08 : suspension.wheelTravel[index];
      steerPivot.position.y += ((WHEEL_RADIUS + wheelOffset) - steerPivot.position.y) * dampFactor(15, delta);
      const rollPivot = wheelRollRefs.current[index];
      if (rollPivot) rollPivot.rotation.y -= wheelSpeed * delta;
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

  const setWheelSteerRef = (index) => (node) => {
    wheelSteerRefs.current[index] = node;
  };

  const setWheelRollRef = (index) => (node) => {
    wheelRollRefs.current[index] = node;
  };

  return (
    <group ref={rootRef}>
      <group ref={bodyRef}>
        {/* Low, friendly utility-cart body. */}
        <mesh position={[0, 0.48, 0]} castShadow receiveShadow>
          <boxGeometry args={[CAR_WIDTH, 0.42, CAR_LENGTH]} />
          <meshStandardMaterial {...surface} color={bodyColor} roughness={0.58} metalness={0.22} />
        </mesh>
        <mesh position={[0, 0.76, -CAR_LENGTH * 0.12]} castShadow receiveShadow>
          <boxGeometry args={[CAR_WIDTH * 0.72, 0.3, CAR_LENGTH * 0.38]} />
          <meshStandardMaterial {...surface} color={glassColor} roughness={0.24} metalness={0.36} transparent opacity={0.92} />
        </mesh>
        <mesh position={[0, 0.7, -CAR_LENGTH * 0.38]} castShadow receiveShadow>
          <boxGeometry args={[CAR_WIDTH * 0.62, 0.08, CAR_LENGTH * 0.2]} />
          <meshStandardMaterial {...surface} color={bodyShadow} roughness={0.5} metalness={0.3} />
        </mesh>

        {/* Canvas sun roof and roll bars give the cart a memorable toy-like profile. */}
        {[-1, 1].map((side) => (
          <mesh key={`rollbar-${side}`} position={[side * CAR_WIDTH * 0.31, 1.03, -CAR_LENGTH * 0.08]} castShadow>
            <boxGeometry args={[0.07, 0.56, 0.07]} />
            <meshStandardMaterial color="#584b3d" roughness={0.82} metalness={0.12} />
          </mesh>
        ))}
        <mesh position={[0, 1.3, -CAR_LENGTH * 0.08]} castShadow receiveShadow>
          <boxGeometry args={[CAR_WIDTH * 0.82, 0.08, CAR_LENGTH * 0.5]} />
          <meshStandardMaterial color="#f4d8a8" roughness={0.94} metalness={0} />
        </mesh>
        <mesh position={[0, 1.345, -CAR_LENGTH * 0.08]}>
          <boxGeometry args={[CAR_WIDTH * 0.55, 0.012, CAR_LENGTH * 0.34]} />
          <meshStandardMaterial color={accent} roughness={0.7} metalness={0} />
        </mesh>

        {/* Timber cargo bed makes this a working village runabout. */}
        <mesh position={[0, 0.75, CAR_LENGTH * 0.3]} castShadow receiveShadow>
          <boxGeometry args={[CAR_WIDTH * 0.74, 0.13, CAR_LENGTH * 0.3]} />
          <meshStandardMaterial color="#8b5e3c" roughness={0.9} metalness={0} />
        </mesh>
        {[-1, 1].map((side) => (
          <mesh key={`cargo-rail-${side}`} position={[side * CAR_WIDTH * 0.33, 0.91, CAR_LENGTH * 0.31]} castShadow>
            <boxGeometry args={[0.07, 0.24, CAR_LENGTH * 0.34]} />
            <meshStandardMaterial color="#5c402f" roughness={0.92} metalness={0} />
          </mesh>
        ))}
        <mesh position={[0.18, 0.93, CAR_LENGTH * 0.31]} rotation={[0.08, 0.18, 0]} castShadow>
          <boxGeometry args={[0.42, 0.28, 0.48]} />
          <meshStandardMaterial color="#d6a64d" roughness={0.92} metalness={0} />
        </mesh>
        <mesh position={[-0.25, 0.92, CAR_LENGTH * 0.31]} rotation={[0, 0, Math.PI / 2]} castShadow>
          <cylinderGeometry args={[0.13, 0.13, 0.42, 12]} />
          <meshStandardMaterial color="#7ea89a" roughness={0.95} metalness={0} />
        </mesh>

        {/* Sturdy bumpers and running boards ground the silhouette. */}
        <mesh position={[0, 0.24, -CAR_LENGTH * 0.52]} castShadow>
          <boxGeometry args={[CAR_WIDTH * 0.94, 0.09, 0.16]} />
          <meshStandardMaterial color="#584b3d" roughness={0.84} metalness={0.1} />
        </mesh>
        {[-1, 1].map((side) => (
          <mesh key={`step-${side}`} position={[side * (CAR_WIDTH * 0.54), 0.27, 0]} castShadow>
            <boxGeometry args={[0.12, 0.08, CAR_LENGTH * 0.5]} />
            <meshStandardMaterial color="#584b3d" roughness={0.84} metalness={0.1} />
          </mesh>
        ))}
        <mesh position={[0, 0.39, -CAR_LENGTH * 0.53]}>
          <boxGeometry args={[CAR_WIDTH * 0.88, 0.08, 0.1]} />
          <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.45} />
        </mesh>
        <mesh ref={brakeLightRef} position={[0, 0.4, CAR_LENGTH * 0.53]}>
          <boxGeometry args={[CAR_WIDTH * 0.82, 0.07, 0.08]} />
          <meshStandardMaterial color="#ef5252" emissive="#ef5252" emissiveIntensity={0.28} />
        </mesh>
        <mesh position={[0, 0.3, CAR_LENGTH * 0.55]} castShadow>
          <boxGeometry args={[CAR_WIDTH * 0.9, 0.08, 0.12]} />
          <meshStandardMaterial color="#584b3d" roughness={0.84} metalness={0.1} />
        </mesh>

        <group ref={thrusterRef} position={[0, 0.38, CAR_LENGTH * 0.58]} visible={false}>
          {[-CAR_WIDTH * 0.24, CAR_WIDTH * 0.24].map((offsetX, i) => (
            <mesh key={`flame-${i}`} position={[offsetX, 0, 0]} rotation={[Math.PI / 2, 0, 0]}>
              <coneGeometry args={[0.14, 0.65, 8]} />
              <meshBasicMaterial color="#38bdf8" transparent opacity={0.88} blending={THREE.AdditiveBlending} />
            </mesh>
          ))}
        </group>

        {/* Front lamps and a little village pennant make the cart readable in both views. */}
        {[-1, 1].map((side) => (
          <mesh key={`lamp-${side}`} position={[side * CAR_WIDTH * 0.3, 0.55, -CAR_LENGTH * 0.53]}>
            <boxGeometry args={[0.13, 0.08, 0.035]} />
            <meshBasicMaterial color="#fff5cf" toneMapped={false} />
          </mesh>
        ))}
        <mesh position={[0, 1.56, -CAR_LENGTH * 0.08]} castShadow>
          <cylinderGeometry args={[0.018, 0.018, 0.44, 6]} />
          <meshStandardMaterial color="#584b3d" roughness={0.8} />
        </mesh>
        <mesh position={[0.13, 1.69, -CAR_LENGTH * 0.08]} rotation={[0, 0, -0.18]} castShadow>
          <coneGeometry args={[0.16, 0.3, 3]} />
          <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.12} roughness={0.8} />
        </mesh>

        {/* Wheels are deliberately chunky: the actor should read as a vehicle at a glance. */}
        {[
          [-WHEEL_X, WHEEL_Z],
          [WHEEL_X, WHEEL_Z],
          [-WHEEL_X, -WHEEL_Z],
          [WHEEL_X, -WHEEL_Z],
        ].map(([x, z], index) => (
          <group key={`wheel-${index}`} ref={setWheelSteerRef(index)} position={[x, WHEEL_RADIUS, z]}>
            <group rotation={[0, 0, Math.PI / 2]}>
              <group ref={setWheelRollRef(index)}>
                <mesh castShadow receiveShadow>
                  <cylinderGeometry args={[WHEEL_RADIUS, WHEEL_RADIUS, 0.16, 12]} />
                  <meshStandardMaterial color={wheelColor} roughness={0.88} metalness={0.08} />
                </mesh>
                <mesh>
                  <cylinderGeometry args={[WHEEL_RADIUS * 0.44, WHEEL_RADIUS * 0.44, 0.17, 10]} />
                  <meshStandardMaterial color={bodyShadow} roughness={0.48} metalness={0.4} />
                </mesh>
              </group>
            </group>
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
