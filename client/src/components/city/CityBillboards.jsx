import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import * as THREE from 'three';
import { CITY_COLORS, PIXEL_FONT_URL } from './cityConstants';

// A single floating holographic billboard that cycles through messages
function Billboard({ position, rotation, messages, color, width = 3.5, height = 1.8, speed = 0.08 }) {
  const groupRef = useRef();
  const borderRef = useRef();
  const textRef = useRef();
  const stateRef = useRef({ index: 0, lastSwitch: 0 });

  const displayText = useRef(messages[0]?.text || '');
  const displayLabel = useRef(messages[0]?.label || '');

  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    const t = clock.getElapsedTime();

    // Gentle bob
    groupRef.current.position.y = position[1] + Math.sin(t * 0.5 + position[0]) * 0.15;

    // Border pulse
    if (borderRef.current) {
      borderRef.current.material.opacity = 0.15 + Math.sin(t * 1.5) * 0.08;
    }

    // Cycle through messages every ~6 seconds
    const state = stateRef.current;
    if (t - state.lastSwitch > 6) {
      state.index = (state.index + 1) % messages.length;
      state.lastSwitch = t;
      displayText.current = messages[state.index]?.text || '';
      displayLabel.current = messages[state.index]?.label || '';
      // Force text update via key change won't work here, so we update ref
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
      {/* Billboard background panel */}
      <mesh>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial color="#020208" transparent opacity={0.7} side={THREE.DoubleSide} />
      </mesh>

      {/* Neon border frame */}
      <mesh ref={borderRef} geometry={borderGeom} position={[0, 0, 0.01]}>
        <meshBasicMaterial color={color} transparent opacity={0.2} side={THREE.DoubleSide} />
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

    // Billboard 1 - Left side facing inward
    billboards.push({
      id: 'bb-left',
      position: [minX - pad, 6, (minZ + maxZ) / 2],
      rotation: [0, Math.PI / 2, 0],
      messages: systemMessages,
      color: colors[0],
    });

    // Billboard 2 - Right side facing inward
    billboards.push({
      id: 'bb-right',
      position: [maxX + pad, 7.5, (minZ + maxZ) / 2],
      rotation: [0, -Math.PI / 2, 0],
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
