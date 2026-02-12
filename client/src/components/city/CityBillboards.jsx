import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import * as THREE from 'three';
import { CITY_COLORS, PIXEL_FONT_URL } from './cityConstants';

// Holographic scan line shader for billboard overlay
const SCAN_VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SCAN_FRAG = `
  uniform float uTime;
  uniform vec3 uColor;
  varying vec2 vUv;
  void main() {
    // Horizontal scan lines
    float scanLine = step(0.5, fract(vUv.y * 40.0));
    float scanAlpha = scanLine * 0.04;

    // Moving scan beam
    float beam = smoothstep(0.0, 0.02, abs(vUv.y - fract(uTime * 0.15)));
    beam = 1.0 - beam;
    scanAlpha += beam * 0.12;

    // Edge vignette
    float edgeX = smoothstep(0.0, 0.05, vUv.x) * smoothstep(1.0, 0.95, vUv.x);
    float edgeY = smoothstep(0.0, 0.05, vUv.y) * smoothstep(1.0, 0.95, vUv.y);
    float edge = 1.0 - edgeX * edgeY;
    scanAlpha += edge * 0.08;

    gl_FragColor = vec4(uColor, scanAlpha);
  }
`;

// A single floating holographic billboard that cycles through messages
function Billboard({ position, rotation, messages, color, width = 3.5, height = 1.8, speed = 0.08 }) {
  const groupRef = useRef();
  const borderRef = useRef();
  const textRef = useRef();
  const scanRef = useRef();
  const glowRef = useRef();
  const stateRef = useRef({ index: 0, lastSwitch: 0 });

  const displayText = useRef(messages[0]?.text || '');
  const displayLabel = useRef(messages[0]?.label || '');

  const colorVec = useMemo(() => new THREE.Color(color), [color]);

  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    const t = clock.getElapsedTime();

    // Gentle bob
    groupRef.current.position.y = position[1] + Math.sin(t * 0.5 + position[0]) * 0.15;

    // Border pulse
    if (borderRef.current) {
      borderRef.current.material.opacity = 0.15 + Math.sin(t * 1.5) * 0.08;
    }

    // Scan line animation
    if (scanRef.current) {
      scanRef.current.uniforms.uTime.value = t;
    }

    // Glow pulse
    if (glowRef.current) {
      glowRef.current.material.opacity = 0.1 + Math.sin(t * 0.8 + position[0]) * 0.05;
    }

    // Cycle through messages every ~6 seconds
    const state = stateRef.current;
    if (t - state.lastSwitch > 6) {
      state.index = (state.index + 1) % messages.length;
      state.lastSwitch = t;
      displayText.current = messages[state.index]?.text || '';
      displayLabel.current = messages[state.index]?.label || '';
      if (textRef.current) {
        textRef.current.text = displayText.current;
      }
    }
  });

  // Static frame geometry
  const borderGeom = useMemo(() => {
    const shape = new THREE.Shape();
    shape.moveTo(-width / 2, -height / 2);
    shape.lineTo(width / 2, -height / 2);
    shape.lineTo(width / 2, height / 2);
    shape.lineTo(-width / 2, height / 2);
    shape.lineTo(-width / 2, -height / 2);

    const hole = new THREE.Path();
    const inset = 0.08;
    hole.moveTo(-width / 2 + inset, -height / 2 + inset);
    hole.lineTo(width / 2 - inset, -height / 2 + inset);
    hole.lineTo(width / 2 - inset, height / 2 - inset);
    hole.lineTo(-width / 2 + inset, height / 2 - inset);
    hole.lineTo(-width / 2 + inset, -height / 2 + inset);
    shape.holes.push(hole);

    return new THREE.ShapeGeometry(shape);
  }, [width, height]);

  return (
    <group ref={groupRef} position={position} rotation={rotation}>
      {/* Billboard background panel (front face only) */}
      <mesh>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial color="#020208" transparent opacity={0.7} />
      </mesh>

      {/* Solid back blocker to prevent mirrored text bleed-through */}
      <mesh position={[0, 0, -0.01]}>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial color="#020208" side={THREE.BackSide} />
      </mesh>

      {/* Neon border frame */}
      <mesh ref={borderRef} geometry={borderGeom} position={[0, 0, 0.01]}>
        <meshBasicMaterial color={color} transparent opacity={0.2} />
      </mesh>

      {/* Top label */}
      <Text
        position={[0, height / 2 - 0.28, 0.02]}
        fontSize={0.15}
        color={color}
        anchorX="center"
        anchorY="middle"
        font={PIXEL_FONT_URL}
        maxWidth={width - 0.4}
      >
        {displayLabel.current}
      </Text>

      {/* Main text - cycling content */}
      <Text
        ref={textRef}
        position={[0, -0.05, 0.02]}
        fontSize={0.22}
        color="#ffffff"
        anchorX="center"
        anchorY="middle"
        font={PIXEL_FONT_URL}
        maxWidth={width - 0.6}
      >
        {displayText.current}
      </Text>

      {/* Accent line under label */}
      <mesh position={[0, height / 2 - 0.45, 0.01]}>
        <planeGeometry args={[width - 0.4, 0.02]} />
        <meshBasicMaterial color={color} transparent opacity={0.4} />
      </mesh>

      {/* Holographic scan line overlay */}
      <mesh position={[0, 0, 0.03]}>
        <planeGeometry args={[width, height]} />
        <shaderMaterial
          ref={scanRef}
          vertexShader={SCAN_VERT}
          fragmentShader={SCAN_FRAG}
          uniforms={{
            uTime: { value: 0 },
            uColor: { value: colorVec },
          }}
          transparent
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>

      {/* Glow halo behind billboard */}
      <mesh ref={glowRef} position={[0, 0, -0.05]}>
        <planeGeometry args={[width + 1.2, height + 0.8]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.1}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>

      {/* Support pole / projector beam */}
      <mesh position={[0, -height / 2 - 0.3, 0]}>
        <cylinderGeometry args={[0.02, 0.04, 0.6, 6]} />
        <meshBasicMaterial color={color} transparent opacity={0.2} />
      </mesh>
    </group>
  );
}

export default function CityBillboards({ positions, apps, cosStatus, productivityData }) {
  // Build billboard messages from real system data
  const billboardConfig = useMemo(() => {
    if (!positions || positions.size < 2) return [];

    const onlineApps = apps.filter(a => !a.archived && a.overallStatus === 'online');
    const stoppedApps = apps.filter(a => !a.archived && a.overallStatus === 'stopped');
    const totalActive = apps.filter(a => !a.archived).length;
    const colors = CITY_COLORS.neonAccents;

    // Find downtown bounding box for billboard placement
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

    const uptime = totalActive > 0
      ? `${Math.round(onlineApps.length / totalActive * 100)}%`
      : '---';

    const systemMessages = [
      { label: 'SYSTEM STATUS', text: `${onlineApps.length} ONLINE / ${totalActive} TOTAL` },
      { label: 'UPTIME', text: uptime },
      { label: 'COS ENGINE', text: cosStatus?.running ? 'ACTIVE' : 'STANDBY' },
    ];

    if (stoppedApps.length > 0) {
      systemMessages.push({
        label: 'ATTENTION',
        text: `${stoppedApps.length} SYSTEM${stoppedApps.length > 1 ? 'S' : ''} STOPPED`,
      });
    }

    const activityMessages = [
      { label: 'CYBERCITY', text: 'DIGITAL INFRASTRUCTURE' },
      { label: 'PORTOS', text: 'PERSONAL OPERATING SYSTEM' },
    ];

    if (productivityData) {
      if (productivityData.todaySucceeded > 0) {
        activityMessages.push({
          label: 'TODAY',
          text: `${productivityData.todaySucceeded} TASKS COMPLETED`,
        });
      }
      if (productivityData.currentDailyStreak > 0) {
        activityMessages.push({
          label: 'STREAK',
          text: `${productivityData.currentDailyStreak} DAY${productivityData.currentDailyStreak > 1 ? 'S' : ''} ACTIVE`,
        });
      }
    }

    const billboards = [];
    const pad = 4;

    // Billboard 1 - Left side facing outward (toward viewers)
    billboards.push({
      id: 'bb-left',
      position: [minX - pad, 6, (minZ + maxZ) / 2],
      rotation: [0, -Math.PI / 2, 0],
      messages: systemMessages,
      color: colors[0],
    });

    // Billboard 2 - Right side facing outward (toward viewers)
    billboards.push({
      id: 'bb-right',
      position: [maxX + pad, 7.5, (minZ + maxZ) / 2],
      rotation: [0, Math.PI / 2, 0],
      messages: activityMessages,
      color: colors[1],
    });

    // Billboard 3 - Front facing into the city (only if enough buildings)
    if (entries.length >= 4) {
      const frontMessages = onlineApps.slice(0, 6).map(a => ({
        label: 'ONLINE',
        text: (a.name || '').toUpperCase(),
      }));
      if (frontMessages.length > 0) {
        billboards.push({
          id: 'bb-front',
          position: [(minX + maxX) / 2, 8.5, minZ - pad - 1],
          rotation: [0, 0, 0],
          messages: frontMessages.length > 1 ? frontMessages : [{ label: 'STATUS', text: 'ALL SYSTEMS NOMINAL' }],
          color: colors[5],
        });
      }
    }

    return billboards;
  }, [positions, apps, cosStatus, productivityData]);

  if (billboardConfig.length === 0) return null;

  return (
    <group>
      {billboardConfig.map(bb => (
        <Billboard
          key={bb.id}
          position={bb.position}
          rotation={bb.rotation}
          messages={bb.messages}
          color={bb.color}
        />
      ))}
    </group>
  );
}
