import { useRef, useMemo, useEffect, useState, useCallback, Suspense } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { useGLTF, Sparkles } from '@react-three/drei';
import * as THREE from 'three';
import {
  AGENT_STATES,
  resolveMuseMotion,
  MUSE_IN_PLACE_SUFFIX,
  MUSE_SPEAKING_GESTURE,
  MUSE_ROOT_MOTION_CLIPS,
} from './constants';
import CoSAvatarOrbitControls from './CoSAvatarOrbitControls';
import CoSBackgroundCamera from './CoSBackgroundCamera';
import CoSCanvasGuard from './CoSCanvasGuard';
import { withInPlaceClips } from '../../utils/animationClips';
import useClonedGltf, { GltfPrimitive } from '../../hooks/useClonedGltf';

const MODEL_URL = '/api/avatar/model.glb';
const FADE = 0.35; // crossfade seconds between state loops
const buildMuseAnimations = (animations) => (
  withInPlaceClips(animations, MUSE_ROOT_MOTION_CLIPS, MUSE_IN_PLACE_SUFFIX)
);

// Loaded avatar rendered with its own textures/materials. When the GLB ships
// animation clips (the bundled RobotExpressive default does), an AnimationMixer
// drives the skeleton per CoS state and `speaking`; otherwise it falls back to
// the gentle procedural float so static GLBs still render. The per-state color
// lives entirely in the surrounding lights/halo/glow/sparkles (see Scene) — the
// model itself keeps its real colors rather than being tinted.
function GLBAvatar({ state, speaking }) {
  const ref = useRef();
  // Append the treadmill (in-place) variants of the root-motion clips so the
  // coding montage can run/walk without drifting.
  const { scene, actions, names, mixer } = useClonedGltf(
    MODEL_URL,
    buildMuseAnimations,
  );
  const hasClips = names.length > 0;

  // Fit the model to the viewport ONCE per scene (absolute `setScalar`, so it
  // must not re-run on state changes or the avatar would pop between sizes).
  // Keep the GLB's original materials so the model renders in full texture and
  // color — we only flip a couple of per-mesh flags. Frustum culling is
  // disabled because animated poses (arms out, jump, running) can exceed the
  // bind-pose bounding box and would otherwise blink the avatar out mid-clip.
  useEffect(() => {
    scene.traverse((obj) => {
      if (!obj.isMesh) return;
      obj.castShadow = false;
      obj.receiveShadow = false;
      obj.frustumCulled = false;
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
  }, [scene]);

  // --- Animation driving -------------------------------------------------
  // Every state resolves to ONE ordered step list (see `resolveMuseMotion`): a
  // length-1 list is a plain base loop, a longer one is a montage this
  // component's `finished` listener advances through. `gestureActiveRef` defers
  // and restores around the one-shot speaking gesture so a state change
  // mid-gesture still lands on the latest state.
  const activeRef = useRef(null);                       // currently-playing action
  const motionRef = useRef({ steps: [], index: 0 });    // live step list + position
  const gestureActiveRef = useRef(false);
  const speakingRef = useRef(false);

  // Crossfade the currently-active action to `clipName`. `loop`: 'once' → a
  // single LoopOnce; `{ reps: N }` → a finite LoopRepeat that fires `finished`
  // after N cycles (used to advance a montage); 'infinite' → an endless loop.
  const fadeTo = useCallback((clipName, { timeScale = 1, loop = 'infinite', duration = FADE } = {}) => {
    const next = actions[clipName];
    if (!next) return;
    next.reset();
    next.enabled = true;
    next.setEffectiveTimeScale(timeScale);
    next.setEffectiveWeight(1);
    const reps = loop === 'once' ? 1 : (loop?.reps ?? 0);
    if (reps > 0) {
      // Finite: one shot (`once`) or N reps of a montage step. Clamp on the last
      // frame so it holds its (near-neutral) end pose through the crossfade to
      // the next action instead of snapping toward the bind pose.
      next.setLoop(loop === 'once' ? THREE.LoopOnce : THREE.LoopRepeat, reps);
      next.clampWhenFinished = true;
    } else {
      next.setLoop(THREE.LoopRepeat, Infinity);
      next.clampWhenFinished = false;
    }
    next.fadeIn(duration).play();
    const prev = activeRef.current;
    if (prev && prev !== next) prev.fadeOut(duration);
    activeRef.current = next;
  }, [actions]);

  // Play step `index` of the current motion (wraps). `index` is always ≥ 0 at
  // every call site (0, the current index, or current + 1), so a plain modulo is
  // enough. Steps were pre-filtered to clips the loaded GLB actually has.
  const playStep = useCallback((index, duration) => {
    const motion = motionRef.current;
    if (!motion.steps.length) return;
    const i = index % motion.steps.length;
    motion.index = i;
    const step = motion.steps[i];
    fadeTo(step.clip, { timeScale: step.timeScale, loop: step.loop, duration });
  }, [fadeTo]);

  // The current state's playable steps, resolved against the loaded clips (which
  // include the synthesized in-place variants, so a montage can name `Running`
  // without drifting the fixed frame). Memoized so the state effect below has a
  // stable dependency.
  const steps = useMemo(() => resolveMuseMotion(state, names), [state, names]);

  // Start / crossfade to the current state's motion.
  useEffect(() => {
    if (!steps.length) return;
    motionRef.current = { steps, index: 0 };
    // Mid-gesture: don't crossfade now — the gesture's finish handler restores
    // from the ref, so the latest state still wins.
    if (gestureActiveRef.current) return;
    playStep(0);
  }, [playStep, steps]);

  // Persistent `finished` listener with two jobs: (1) when the one-shot speaking
  // gesture finishes, hand control back to the live motion (read from the ref so
  // a state change mid-gesture still lands correctly); (2) when a finite montage
  // step finishes, advance to the next step. A single-step motion is either an
  // infinite loop (never fires) or a clamped pose that must hold (`sleeping`),
  // so only a multi-step motion advances.
  useEffect(() => {
    if (!hasClips) return;
    const gesture = actions[MUSE_SPEAKING_GESTURE];
    const onFinished = (e) => {
      if (gestureActiveRef.current) {
        if (gesture && e.action !== gesture) return; // ignore body clips finishing
        gestureActiveRef.current = false;
        playStep(motionRef.current.index, 0.25); // back to the step we were on
        return;
      }
      // Advance the montage when the active step completes its reps.
      if (motionRef.current.steps.length > 1 && e.action === activeRef.current) {
        playStep(motionRef.current.index + 1);
      }
    };
    mixer.addEventListener('finished', onFinished);
    return () => mixer.removeEventListener('finished', onFinished);
  }, [playStep, hasClips, actions, mixer]);

  // Speaking overlay: on the false→true edge, crossfade to the gesture once.
  // The persistent listener above returns to the current motion step when it
  // finishes.
  useEffect(() => {
    if (!hasClips) return;
    const was = speakingRef.current;
    speakingRef.current = speaking;
    if (!speaking || was) return; // only fire on the rising edge

    const gesture = actions[MUSE_SPEAKING_GESTURE];
    if (!gesture) return;
    // Skip if a single-step state is already resting on the gesture clip.
    const current = motionRef.current.steps;
    if (current.length === 1 && gesture === actions[current[0].clip]) return;

    gestureActiveRef.current = true;
    fadeTo(MUSE_SPEAKING_GESTURE, { loop: 'once', duration: 0.2 });
  }, [fadeTo, speaking, hasClips, actions]);

  // Subtle container float. The clip drives the body; this only adds the gentle
  // sway/head-bob so the avatar never feels frozen between clip transitions.
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
  });

  return (
    <group ref={ref}>
      <GltfPrimitive object={scene} />
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

      {/* Neutral, even lighting so the model renders in its own full texture
          and color. The per-state hue lives in the accent point light + halo /
          ground glow / sparkles below rather than being painted onto the model. */}
      <ambientLight intensity={0.7} />
      <hemisphereLight intensity={0.55} color="#ffffff" groundColor="#3a3a52" />
      <directionalLight position={[3, 5, 4]} intensity={1.1} />
      <pointLight position={[2, 3, 4]} intensity={0.45} color={color} />
      <pointLight position={[-2, 1, 3]} intensity={0.25} color="#f472b6" />
      <Halo color={color} state={state} />
      <GLBAvatar state={state} speaking={speaking} />
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
    <CoSCanvasGuard
      label="Muse 3D avatar. Drag to rotate."
      background={background}
      fallback={<MissingModelHint background={background} />}
    >
      <Canvas
        camera={{ position: [0, 0, 3.3], fov: 45 }}
        style={{ width: '100%', height: '100%', background: 'transparent' }}
        gl={{ alpha: true, antialias: true }}
      >
        <Suspense fallback={null}>
          <Scene state={state} speaking={speaking} background={background} />
        </Suspense>
      </Canvas>
    </CoSCanvasGuard>
  );
}

// Preload cache once URL is known to exist.
useGLTF.preload(MODEL_URL);
