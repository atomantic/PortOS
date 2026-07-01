import { useRef, useMemo, useEffect, useState, Suspense, Component } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { useGLTF, useAnimations } from '@react-three/drei';
import * as THREE from 'three';
import { SkeletonUtils } from 'three-stdlib';
import { AGENT_STATES } from './constants';
import CoSAvatarOrbitControls from './CoSAvatarOrbitControls';
import CoSAvatarFrame from './CoSAvatarFrame';
import CoSBackgroundCamera from './CoSBackgroundCamera';

// Kenney Mini Characters (CC0) ship 32 named clips. We map the CoS agent
// states onto the most evocative ones. Each entry has a clip name plus a
// per-state turntable rotation speed so the body language reads at a glance.
const STATE_CLIP_MAP = {
  sleeping:      { clip: 'sit',       rot: 0.05, timeScale: 0.6 },
  thinking:      { clip: 'idle',      rot: 0.15, timeScale: 0.8 },
  coding:        { clip: 'walk',      rot: 0.0,  timeScale: 1.4 },
  investigating: { clip: 'interact-right', rot: 0.0, timeScale: 1.0 },
  reviewing:     { clip: 'emote-yes', rot: 0.0,  timeScale: 0.9 },
  planning:      { clip: 'idle',      rot: 0.4,  timeScale: 1.0 },
  ideating:      { clip: 'sprint',    rot: 0.0,  timeScale: 1.2 },
};
const FALLBACK = { clip: 'idle', rot: 0.2, timeScale: 1.0 };

// Shared ground-plane Y. The character's feet rest here AND the shadow/glow
// disc sits here, so they can never drift apart. Lowering this value pushes
// the whole avatar down in frame (~210px per world unit at this camera).
const GROUND_Y = -1.4;

// Variants shipped in data.reference/avatar/ and seeded into data/avatar/ by
// `npm run setup:data`. For these the "missing model" case means the seed
// hasn't run yet — not that the user must supply their own GLB.
const BUNDLED_VARIANTS = new Set(['mini-male-c', 'mini-female-d']);

function buildModelUrl(variant) {
  return variant ? `/api/avatar/model.glb?variant=${encodeURIComponent(variant)}` : '/api/avatar/model.glb';
}

function MiniCharacter({ state, speaking, variant }) {
  const url = useMemo(() => buildModelUrl(variant), [variant]);
  const gltf = useGLTF(url);
  const group = useRef();

  // Clone via SkeletonUtils — a plain Object3D.clone() does NOT rebind the
  // SkinnedMesh to the cloned skeleton, so AnimationMixer would drive bones
  // the visible mesh no longer references and nothing moves. SkeletonUtils
  // rebuilds the bone bindings on the clone so animations actually deform it.
  const scene = useMemo(() => SkeletonUtils.clone(gltf.scene), [gltf.scene]);
  const { actions, names } = useAnimations(gltf.animations, scene);

  // Fit the character into a consistent height regardless of source scale.
  // Kenney mini-characters are authored ~1.7 units tall already, but we
  // normalize so any dropped-in model fills the frame the same way.
  useEffect(() => {
    const box = new THREE.Box3().setFromObject(scene);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const targetHeight = 2.6;
    const scale = targetHeight / Math.max(size.y, 1e-3);
    scene.scale.setScalar(scale);
    // Recenter horizontally; rest the feet on the shared ground plane
    // (GROUND_Y) rather than centering vertically so the character stands
    // in frame with its feet on the shadow disc.
    scene.position.set(
      -center.x * scale,
      -box.min.y * scale + GROUND_Y,
      -center.z * scale,
    );
  }, [scene]);

  // Resolve the active clip for this state, falling back gracefully.
  const cfg = STATE_CLIP_MAP[state] || FALLBACK;
  const clipName = useMemo(() => {
    if (names.includes(cfg.clip)) return cfg.clip;
    if (names.includes('idle')) return 'idle';
    return names[0];
  }, [names, cfg.clip]);

  // Crossfade between clips on state change.
  const prevClip = useRef(null);
  useEffect(() => {
    const next = actions[clipName];
    if (!next) return;
    next.reset().setEffectiveTimeScale(cfg.timeScale || 1).fadeIn(0.3).play();
    if (prevClip.current && prevClip.current !== next) {
      prevClip.current.fadeOut(0.3);
    }
    prevClip.current = next;
    return () => {
      next.fadeOut(0.3);
    };
  }, [actions, clipName, cfg.timeScale]);

  // Turntable rotation + speaking head-bob.
  useFrame((_, delta) => {
    if (!group.current) return;
    group.current.rotation.y += (cfg.rot || 0) * delta;
    const bob = speaking ? Math.sin(performance.now() * 0.012) * 0.03 : 0;
    group.current.position.y = bob;
  });

  return (
    <group ref={group}>
      <primitive object={scene} />
    </group>
  );
}

function StageLighting({ color }) {
  return (
    <>
      <ambientLight intensity={0.6} />
      <directionalLight position={[3, 5, 4]} intensity={1.2} />
      <pointLight position={[-3, 2, 3]} intensity={0.5} color={color} />
      {/* soft ground glow tinted by state — sits on the shared ground plane
          so it stays under the character's feet (slight +0.01 lift avoids
          z-fighting with the lowest foot geometry). */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, GROUND_Y + 0.01, 0]}>
        <circleGeometry args={[1.1, 48]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.25} transparent opacity={0.15} />
      </mesh>
    </>
  );
}

function Scene({ state, speaking, background, variant }) {
  const stateConfig = AGENT_STATES[state] || AGENT_STATES.sleeping;
  const color = stateConfig.color;
  return (
    <>
      <CoSBackgroundCamera enabled={background} z={3.6} />
      <StageLighting color={color} />
      <MiniCharacter state={state} speaking={speaking} variant={variant} />
      <CoSAvatarOrbitControls />
    </>
  );
}

function MissingModelHint({ background = false, bundled = false }) {
  return (
    <div className={`${background ? 'relative w-full h-full min-h-full' : 'relative w-full max-w-[8rem] lg:max-w-[12rem] aspect-[5/6]'} flex flex-col items-center justify-center rounded-lg border border-port-border bg-port-card/60 text-center p-3`}>
      <div className="text-3xl mb-2">🧍</div>
      {bundled ? (
        <>
          <div className="text-xs font-semibold text-gray-200 mb-1">Model not yet seeded</div>
          <div className="text-[10px] text-gray-400 mb-1.5">Run</div>
          <code className="text-[9px] text-port-accent break-all leading-tight">npm run setup:data</code>
        </>
      ) : (
        <>
          <div className="text-xs font-semibold text-gray-200 mb-1">No mini-character model</div>
          <code className="text-[9px] text-port-accent break-all leading-tight">data/avatar/&lt;variant&gt;.glb</code>
        </>
      )}
    </div>
  );
}

// Error boundary so a corrupt/missing GLB or a GET that returns a non-GLTF
// body (the HEAD probe only confirms r.ok, not valid GLTF) degrades to the
// missing-model hint instead of white-screening the whole CoS page.
class AvatarErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err) {
    console.warn(`⚠️ Mini-character avatar failed to load: ${err?.message || err}`);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function LoadingPlaceholder({ background = false }) {
  return (
    <div className={`${background ? 'relative w-full h-full min-h-full' : 'relative w-full max-w-[8rem] lg:max-w-[12rem] aspect-[5/6]'} flex items-center justify-center`}>
      <div className="text-xs text-gray-500 animate-pulse">loading…</div>
    </div>
  );
}

// `variant` is wired by the per-character style wrappers (MiniCharMaleC, etc.).
export default function MiniCharacterCoSAvatar({ state, speaking, background = false, variant = 'mini-male-c' }) {
  const [modelPresent, setModelPresent] = useState(null);
  const url = useMemo(() => buildModelUrl(variant), [variant]);

  useEffect(() => {
    let cancelled = false;
    fetch(url, { method: 'HEAD' })
      .then((r) => { if (!cancelled) setModelPresent(r.ok); })
      .catch(() => { if (!cancelled) setModelPresent(false); });
    return () => { cancelled = true; };
  }, [url]);

  const bundled = BUNDLED_VARIANTS.has(variant);
  if (modelPresent === null) return <LoadingPlaceholder background={background} />;
  if (!modelPresent) return <MissingModelHint background={background} bundled={bundled} />;

  return (
    <CoSAvatarFrame label="Mini-character avatar. Drag to rotate." background={background}>
      <AvatarErrorBoundary fallback={<MissingModelHint background={background} bundled={bundled} />}>
        <Canvas
          camera={{ position: [0, 0.2, 3.0], fov: 40 }}
          style={{ width: '100%', height: '100%', background: 'transparent' }}
          gl={{ alpha: true, antialias: true }}
        >
          <Suspense fallback={null}>
            <Scene state={state} speaking={speaking} background={background} variant={variant} />
          </Suspense>
        </Canvas>
      </AvatarErrorBoundary>
    </CoSAvatarFrame>
  );
}
