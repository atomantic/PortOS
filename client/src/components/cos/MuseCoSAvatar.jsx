import { useRef, useMemo, useEffect, useState, Suspense } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { useGLTF, Sparkles } from '@react-three/drei';
import * as THREE from 'three';
import { AGENT_STATES } from './constants';
import CoSAvatarOrbitControls from './CoSAvatarOrbitControls';
import CoSAvatarFrame from './CoSAvatarFrame';

const MODEL_URL = '/api/avatar/model.glb';

// Loaded head wrapped in a holographic material treatment.
// Works with any rigged or static GLB — we auto-fit the bounding box
// so the head fills the viewport regardless of original scale/origin.
function GLBHead({ color, state, speaking }) {
  const gltf = useGLTF(MODEL_URL);
  const ref = useRef();

  // Clone so the cache copy isn't mutated.
  const scene = useMemo(() => gltf.scene.clone(true), [gltf.scene]);

  // Auto-fit to viewport + apply holographic material.
  useEffect(() => {
    // Replace all mesh materials with a dark base + emissive glow that
    // picks up the current state color. This avoids skin-tone uncanny
    // valley and keeps the silhouette consistent with other avatars.
    scene.traverse((obj) => {
      if (!obj.isMesh) return;
      obj.castShadow = false;
      obj.receiveShadow = false;
      obj.material = new THREE.MeshStandardMaterial({
        color: '#120820',
        emissive: color,
        emissiveIntensity: 0.55,
        metalness: 0.55,
        roughness: 0.35,
        transparent: true,
        opacity: 0.94,
        side: THREE.FrontSide,
      });
    });

    // Fit bounding box into a fixed height so different models render consistently.
    const box = new THREE.Box3().setFromObject(scene);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const targetHeight = 1.9;
    const scale = targetHeight / Math.max(size.y, 1e-3);
    scene.scale.setScalar(scale);
    scene.position.set(
      -center.x * scale,
      -center.y * scale + 0.05,
      -center.z * scale
    );
  }, [scene, color]);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (!ref.current) return;

    const rotSpeed =
      state === 'sleeping' ? 0.15 :
      state === 'coding' ? 0.55 :
      state === 'investigating' ? 0.4 :
      state === 'thinking' ? 0.25 : 0.3;
    ref.current.rotation.y = Math.sin(t * rotSpeed) * 0.25;
    ref.current.rotation.x = speaking
      ? Math.sin(t * 10) * 0.04
      : Math.sin(t * 0.3) * 0.025;

    const intensity =
      state === 'sleeping' ? 0.2 :
      state === 'thinking' ? 0.6 + Math.sin(t * 3) * 0.3 :
      state === 'coding' ? 0.75 + Math.sin(t * 8) * 0.3 :
      state === 'investigating' ? 0.7 + Math.sin(t * 5) * 0.25 :
      state === 'ideating' ? 0.8 + Math.sin(t * 4) * 0.4 :
      0.55;

    scene.traverse((obj) => {
      if (obj.isMesh && obj.material) {
        obj.material.emissiveIntensity = intensity;
      }
    });
  });

  return <primitive ref={ref} object={scene} />;
}

function Halo({ color, state }) {
  const ref = useRef();
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (!ref.current) return;
    const speed = state === 'sleeping' ? 0.1 : 0.3;
    ref.current.rotation.z = t * speed;
    ref.current.material.opacity = state === 'sleeping' ? 0.12 : 0.28 + Math.sin(t * 2) * 0.08;
  });
  return (
    <mesh ref={ref} position={[0, 0.15, -0.55]}>
      <ringGeometry args={[0.85, 1.05, 64]} />
      <meshBasicMaterial color={color} transparent opacity={0.28} side={THREE.DoubleSide} />
    </mesh>
  );
}

function GroundGlow({ color }) {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.25, 0]}>
      <circleGeometry args={[1.2, 32]} />
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={0.3}
        transparent
        opacity={0.12}
      />
    </mesh>
  );
}

function StateEffects({ color, state }) {
  if (state === 'ideating') return <Sparkles count={40} scale={2.5} size={4} speed={1} color={color} />;
  if (state === 'thinking') return <Sparkles count={30} scale={2.5} size={3} speed={0.6} color={color} />;
  if (state === 'coding') return <Sparkles count={55} scale={3} size={2} speed={2} color={color} />;
  if (state === 'investigating') return <Sparkles count={40} scale={3} size={3.5} speed={1.4} color={color} />;
  return <Sparkles count={15} scale={3} size={1.5} speed={0.3} color={color} />;
}

function Scene({ state, speaking }) {
  const stateConfig = AGENT_STATES[state] || AGENT_STATES.sleeping;
  const color = stateConfig.color;

  return (
    <>
      <ambientLight intensity={0.25} />
      <pointLight position={[2, 3, 4]} intensity={0.6} color={color} />
      <pointLight position={[-2, 1, 3]} intensity={0.3} color="#f472b6" />
      <Halo color={color} state={state} />
      <GLBHead color={color} state={state} speaking={speaking} />
      <StateEffects color={color} state={state} />
      <GroundGlow color={color} />

      <CoSAvatarOrbitControls />
    </>
  );
}

function MissingModelHint() {
  return (
    <div className="relative w-full max-w-[8rem] lg:max-w-[12rem] aspect-[5/6] flex flex-col items-center justify-center rounded-lg border border-port-border bg-port-card/60 text-center p-3">
      <div className="text-3xl mb-2">🎭</div>
      <div className="text-xs font-semibold text-slate-200 mb-1">No avatar model</div>
      <div className="text-[10px] text-slate-400 mb-1.5">Drop a GLB at</div>
      <code className="text-[9px] text-port-accent break-all leading-tight">
        data/avatar/model.glb
      </code>
    </div>
  );
}

function LoadingPlaceholder() {
  return (
    <div className="relative w-full max-w-[8rem] lg:max-w-[12rem] aspect-[5/6] flex items-center justify-center">
      <div className="text-xs text-slate-500 animate-pulse">loading…</div>
    </div>
  );
}

export default function MuseCoSAvatar({ state, speaking }) {
  // null = checking, true = GLB present, false = missing
  const [modelPresent, setModelPresent] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch(MODEL_URL, { method: 'HEAD' })
      .then((r) => {
        if (!cancelled) setModelPresent(r.ok);
      })
      .catch(() => {
        if (!cancelled) setModelPresent(false);
      });
    return () => { cancelled = true; };
  }, []);

  if (modelPresent === null) return <LoadingPlaceholder />;
  if (!modelPresent) return <MissingModelHint />;

  return (
    <CoSAvatarFrame label="Muse 3D avatar. Drag to rotate.">
      <Canvas
        camera={{ position: [0, 0, 3.3], fov: 45 }}
        style={{ background: 'transparent' }}
        gl={{ alpha: true, antialias: true }}
      >
        <Suspense fallback={null}>
          <Scene state={state} speaking={speaking} />
        </Suspense>
      </Canvas>
    </CoSAvatarFrame>
  );
}

// Preload cache once URL is known to exist.
useGLTF.preload(MODEL_URL);
