import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

// Matrix-style cascading data columns falling through the sky

const DATA_RAIN_VERT = `
  attribute float charIndex;
  attribute float columnPhase;
  attribute float speed;
  attribute float brightness;
  uniform float uTime;
  varying float vBrightness;
  varying float vFade;

  void main() {
    vec3 pos = position;

    // Each character falls independently within its column
    float t = mod(uTime * speed + columnPhase + charIndex * 0.05, 1.0);
    pos.y = mix(30.0, -5.0, t);

    // Head of the column is brightest, tail fades
    float headDist = t;
    vBrightness = brightness * smoothstep(0.0, 0.05, t) * smoothstep(1.0, 0.3, t);

    // Atmospheric fade with distance
    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    vFade = smoothstep(-80.0, -20.0, mvPosition.z);

    gl_PointSize = (1.8 + brightness * 1.2) * (120.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const DATA_RAIN_FRAG = `
  varying float vBrightness;
  varying float vFade;
  uniform vec3 uColor;

  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float d = length(uv);
    if (d > 0.5) discard;

    // Sharp rectangular glyph shape
    float rect = step(abs(uv.x), 0.35) * step(abs(uv.y), 0.4);
    float alpha = rect * vBrightness * vFade * 0.6;

    // Bright center, colored edges
    vec3 color = mix(uColor, vec3(1.0), vBrightness * 0.3);
    gl_FragColor = vec4(color, alpha);
  }
`;

export default function CityDataRain() {
  const pointsRef = useRef();
  const matRef = useRef();

  const { positions, charIndices, columnPhases, speeds, brightnesses, count } = useMemo(() => {
    const columns = 40;
    const charsPerColumn = 12;
    const total = columns * charsPerColumn;

    const pos = new Float32Array(total * 3);
    const chars = new Float32Array(total);
    const phases = new Float32Array(total);
    const spd = new Float32Array(total);
    const bright = new Float32Array(total);

    // Seeded random
    let s = 77;
    const rand = () => { s = (s * 16807 + 0) % 2147483647; return (s & 0x7fffffff) / 2147483647; };

    for (let col = 0; col < columns; col++) {
      const x = (rand() - 0.5) * 70;
      const z = (rand() - 0.5) * 70;
      const colPhase = rand();
      const colSpeed = 0.15 + rand() * 0.25;

      for (let ch = 0; ch < charsPerColumn; ch++) {
        const idx = col * charsPerColumn + ch;
        pos[idx * 3] = x + (rand() - 0.5) * 0.3;
        pos[idx * 3 + 1] = 0; // Will be animated in shader
        pos[idx * 3 + 2] = z + (rand() - 0.5) * 0.3;

        chars[idx] = ch / charsPerColumn;
        phases[idx] = colPhase;
        spd[idx] = colSpeed;
        // Head chars are brightest, tail dims out
        bright[idx] = 1.0 - (ch / charsPerColumn) * 0.7;
      }
    }

    return {
      positions: pos,
      charIndices: chars,
      columnPhases: phases,
      speeds: spd,
      brightnesses: bright,
      count: total,
    };
  }, []);

  useFrame(({ clock }) => {
    if (matRef.current) {
      matRef.current.uniforms.uTime.value = clock.getElapsedTime();
    }
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={count} array={positions} itemSize={3} />
        <bufferAttribute attach="attributes-charIndex" count={count} array={charIndices} itemSize={1} />
        <bufferAttribute attach="attributes-columnPhase" count={count} array={columnPhases} itemSize={1} />
        <bufferAttribute attach="attributes-speed" count={count} array={speeds} itemSize={1} />
        <bufferAttribute attach="attributes-brightness" count={count} array={brightnesses} itemSize={1} />
      </bufferGeometry>
      <shaderMaterial
        ref={matRef}
        vertexShader={DATA_RAIN_VERT}
        fragmentShader={DATA_RAIN_FRAG}
        uniforms={{
          uTime: { value: 0 },
          uColor: { value: new THREE.Color('#06b6d4') },
        }}
        transparent
        blending={THREE.AdditiveBlending}
        depthWrite={false}
        fog={false}
      />
    </points>
  );
}
