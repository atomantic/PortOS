import { useRef, useMemo, useEffect, useState, useCallback, Suspense, Component } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { useGLTF, useAnimations, Sparkles } from '@react-three/drei';
import * as THREE from 'three';
import { SkeletonUtils } from 'three-stdlib';
import {
  AGENT_STATES,
  MUSE_STATE_ANIMATIONS,
  MUSE_ANIMATION_FALLBACK,
  MUSE_SPEAKING_GESTURE,
  MUSE_ROOT_MOTION_CLIPS,
} from './constants';
import CoSAvatarOrbitControls from './CoSAvatarOrbitControls';
import CoSAvatarFrame from './CoSAvatarFrame';
import CoSBackgroundCamera from './CoSBackgroundCamera';

const MODEL_URL = '/api/avatar/model.glb';
const FADE = 0.35; // crossfade seconds between state loops

// Loaded avatar wrapped in a holographic material treatment. When the GLB
// ships animation clips (the bundled RobotExpressive default does), an
// AnimationMixer drives the skeleton per CoS state and `speaking`; otherwise it
// falls back to the fully-procedural rotation/glow so static GLBs still render.
function GLBAvatar({ color, state, speaking }) {
  const gltf = useGLTF(MODEL_URL);
  const ref = useRef();

  // SkeletonUtils.clone rebinds SkinnedMeshes to the cloned skeleton so the
  // AnimationMixer actually deforms the visible mesh. A plain scene.clone(true)
  // leaves the mixer driving bones the rendered mesh no longer references, so
  // nothing would move — the reason clips were previously ignored.
  const scene = useMemo(() => SkeletonUtils.clone(gltf.scene), [gltf.scene]);
  const { actions, names, mixer } = useAnimations(gltf.animations, scene);
  const hasClips = names.length > 0;

  // Materials to pulse each frame (collected once so we don't traverse the
  // whole scene graph on every frame).
  const matsRef = useRef([]);

  // Apply the holographic material + fit the model to the viewport ONCE per
  // scene. Keyed on [scene] only — NOT color — because the fit is an absolute
  // `setScalar`, so re-measuring the already-scaled scene on a color change
  // would reset it toward native size (the avatar would pop between two sizes
  // on every state transition) and re-allocating materials each time would
  // leak GPU resources. Replacing the material does NOT affect skinning — the
  // skeleton drives deformation regardless of the bound material, so clips
  // still animate the body. The per-state emissive hue is handled separately
  // below so this heavy pass runs just once.
  useEffect(() => {
    const mats = [];
    scene.traverse((obj) => {
      if (!obj.isMesh) return;
      obj.castShadow = false;
      obj.receiveShadow = false;
      // Animated poses (arms out, jump) can exceed the bind-pose bounding box;
      // disable frustum culling so the avatar never blinks out mid-clip.
      obj.frustumCulled = false;
      const material = new THREE.MeshStandardMaterial({
        color: '#120820',
        emissiveIntensity: 0.55,
        metalness: 0.55,
        roughness: 0.35,
        transparent: true,
        opacity: 0.94,
        side: THREE.FrontSide,
      });
      obj.material = material;
      mats.push(material);
    });
    matsRef.current = mats;

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
    return () => { for (const m of mats) m.dispose(); };
  }, [scene]);

  // Recolor the emissive hue in place when the CoS state changes — mutate the
  // materials created above rather than re-allocating them (see the fit effect).
  useEffect(() => {
    for (const m of matsRef.current) m.emissive.set(color);
  }, [color]);

  // --- Animation driving -------------------------------------------------
  // The base loop we should return to when idle (updated by the state effect),
  // plus a flag so a state change mid-gesture defers the crossfade to the
  // gesture's finish handler instead of fighting it.
  const activeRef = useRef(null);          // currently-playing action
  const desiredBaseRef = useRef(null);     // { name, timeScale, once } to rest on
  const gestureActiveRef = useRef(false);
  const speakingRef = useRef(false);

  // Crossfade the currently-active action to `clipName`.
  const fadeTo = useCallback((clipName, opts = {}) => {
    const next = actions[clipName];
    if (!next) return;
    const dur = opts.duration ?? FADE;
    next.reset();
    next.enabled = true;
    next.setEffectiveTimeScale(opts.timeScale ?? 1);
    next.setEffectiveWeight(1);
    next.setLoop(opts.once ? THREE.LoopOnce : THREE.LoopRepeat, opts.once ? 1 : Infinity);
    next.clampWhenFinished = !!opts.once;
    next.fadeIn(dur).play();
    const prev = activeRef.current;
    if (prev && prev !== next) prev.fadeOut(dur);
    activeRef.current = next;
  }, [actions]);

  // Resolve the base loop clip for the current state (guarded against a GLB
  // that lacks the mapped clip).
  const baseCfg = MUSE_STATE_ANIMATIONS[state] || {};
  const baseClip = useMemo(() => {
    if (!hasClips) return null;
    if (baseCfg.clip && names.includes(baseCfg.clip)) return baseCfg.clip;
    if (names.includes(MUSE_ANIMATION_FALLBACK)) return MUSE_ANIMATION_FALLBACK;
    // Last resort for a custom GLB with clips but none mapped: prefer the first
    // in-place clip so a leading walk cycle can't drift the fixed-frame avatar
    // out of view; fall back to names[0] only if every clip is root-motion.
    return names.find((n) => !MUSE_ROOT_MOTION_CLIPS.includes(n)) || names[0];
  }, [hasClips, names, baseCfg.clip]);

  // Play / crossfade the base state loop.
  useEffect(() => {
    if (!baseClip) return;
    desiredBaseRef.current = { name: baseClip, timeScale: baseCfg.timeScale, once: baseCfg.once };
    // Mid-gesture: don't crossfade now — the gesture's finish handler restores
    // to whatever desiredBaseRef points at, so the latest state still wins.
    if (gestureActiveRef.current) return;
    fadeTo(baseClip, { timeScale: baseCfg.timeScale, once: baseCfg.once });
  }, [fadeTo, baseClip, baseCfg.timeScale, baseCfg.once]);

  // Persistent listener: when the one-shot speaking gesture finishes, hand
  // control back to whatever base loop the current state wants (read live from
  // desiredBaseRef, so a state change mid-gesture still lands correctly). Kept
  // separate from the trigger effect below so that `speaking` flipping back to
  // false mid-gesture can't tear down the restore path — the gesture always
  // returns to a base loop instead of freezing on its end pose.
  useEffect(() => {
    if (!hasClips) return;
    const gesture = actions[MUSE_SPEAKING_GESTURE];
    const onFinished = (e) => {
      if (!gestureActiveRef.current) return;
      if (gesture && e.action !== gesture) return; // ignore base clips finishing
      gestureActiveRef.current = false;
      const rest = desiredBaseRef.current;
      if (rest?.name) fadeTo(rest.name, { timeScale: rest.timeScale, once: rest.once, duration: 0.25 });
    };
    mixer.addEventListener('finished', onFinished);
    return () => mixer.removeEventListener('finished', onFinished);
  }, [fadeTo, hasClips, actions, mixer]);

  // Speaking overlay: on the false→true edge, crossfade to the gesture once.
  // The persistent listener above returns to the base loop when it finishes.
  useEffect(() => {
    if (!hasClips) return;
    const was = speakingRef.current;
    speakingRef.current = speaking;
    if (!speaking || was) return; // only fire on the rising edge

    const gesture = actions[MUSE_SPEAKING_GESTURE];
    const base = desiredBaseRef.current;
    if (!gesture || (base && gesture === actions[base.name])) return;

    gestureActiveRef.current = true;
    fadeTo(MUSE_SPEAKING_GESTURE, { once: true, duration: 0.2 });
  }, [fadeTo, speaking, hasClips, actions]);

  // Subtle container sway + holographic emissive pulse. The clip drives the
  // body; this only adds the gentle float/glow that reads as "holographic".
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (ref.current) {
      const rotSpeed =
        state === 'sleeping' ? 0.15 :
        state === 'coding' ? 0.55 :
        state === 'investigating' ? 0.4 :
        state === 'thinking' ? 0.25 : 0.3;
      ref.current.rotation.y = Math.sin(t * rotSpeed) * 0.2;
      ref.current.rotation.x = speaking
        ? Math.sin(t * 10) * 0.03
        : Math.sin(t * 0.3) * 0.02;
    }

    const intensity =
      state === 'sleeping' ? 0.2 :
      state === 'thinking' ? 0.6 + Math.sin(t * 3) * 0.3 :
      state === 'coding' ? 0.75 + Math.sin(t * 8) * 0.3 :
      state === 'investigating' ? 0.7 + Math.sin(t * 5) * 0.25 :
      state === 'ideating' ? 0.8 + Math.sin(t * 4) * 0.4 :
      0.55;
    const mats = matsRef.current;
    for (let i = 0; i < mats.length; i++) mats[i].emissiveIntensity = intensity;
  });

  return (
    <group ref={ref}>
      <primitive object={scene} />
    </group>
  );
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

function Scene({ state, speaking, background }) {
  const stateConfig = AGENT_STATES[state] || AGENT_STATES.sleeping;
  const color = stateConfig.color;

  return (
    <>
      <CoSBackgroundCamera enabled={background} z={3.3} />

      <ambientLight intensity={0.25} />
      <pointLight position={[2, 3, 4]} intensity={0.6} color={color} />
      <pointLight position={[-2, 1, 3]} intensity={0.3} color="#f472b6" />
      <Halo color={color} state={state} />
      <GLBAvatar color={color} state={state} speaking={speaking} />
      <StateEffects color={color} state={state} />
      <GroundGlow color={color} />

      <CoSAvatarOrbitControls />
    </>
  );
}

function MissingModelHint({ background = false }) {
  return (
    <div className={`${background ? 'relative w-full h-full min-h-full' : 'relative w-full max-w-[8rem] lg:max-w-[12rem] aspect-[5/6]'} flex flex-col items-center justify-center rounded-lg border border-port-border bg-port-card/60 text-center p-3`}>
      <div className="text-3xl mb-2">🎭</div>
      <div className="text-xs font-semibold text-gray-200 mb-1">No avatar model</div>
      <div className="text-[10px] text-gray-400 mb-1.5">Run <code className="text-port-accent">npm run setup:data</code> or drop a GLB at</div>
      <code className="text-[9px] text-port-accent break-all leading-tight">
        data/avatar/model.glb
      </code>
    </div>
  );
}

// Error boundary so a corrupt/non-GLTF body (the HEAD probe only confirms
// r.ok, not valid GLTF) degrades to the missing-model hint instead of
// white-screening the whole CoS page.
class AvatarErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err) {
    console.warn(`⚠️ Muse avatar failed to load: ${err?.message || err}`);
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

export default function MuseCoSAvatar({ state, speaking, background = false }) {
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

  if (modelPresent === null) return <LoadingPlaceholder background={background} />;
  if (!modelPresent) return <MissingModelHint background={background} />;

  return (
    <CoSAvatarFrame label="Muse 3D avatar. Drag to rotate." background={background}>
      <AvatarErrorBoundary fallback={<MissingModelHint background={background} />}>
        <Canvas
          camera={{ position: [0, 0, 3.3], fov: 45 }}
          style={{ width: '100%', height: '100%', background: 'transparent' }}
          gl={{ alpha: true, antialias: true }}
        >
          <Suspense fallback={null}>
            <Scene state={state} speaking={speaking} background={background} />
          </Suspense>
        </Canvas>
      </AvatarErrorBoundary>
    </CoSAvatarFrame>
  );
}

// Preload cache once URL is known to exist.
useGLTF.preload(MODEL_URL);
