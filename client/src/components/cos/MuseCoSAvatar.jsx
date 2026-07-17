import { useRef, useMemo, useEffect, useState, useCallback, Suspense, Component } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { useGLTF, useAnimations, Sparkles } from '@react-three/drei';
import * as THREE from 'three';
import { SkeletonUtils } from 'three-stdlib';
import {
  AGENT_STATES,
  MUSE_STATE_ANIMATIONS,
  MUSE_STATE_SEQUENCES,
  MUSE_IN_PLACE_SUFFIX,
  MUSE_ANIMATION_FALLBACK,
  MUSE_SPEAKING_GESTURE,
  MUSE_ROOT_MOTION_CLIPS,
} from './constants';
import CoSAvatarOrbitControls from './CoSAvatarOrbitControls';
import CoSAvatarFrame from './CoSAvatarFrame';
import CoSBackgroundCamera from './CoSBackgroundCamera';
import { withInPlaceClips, inPlaceClipName } from '../../utils/animationClips';

const MODEL_URL = '/api/avatar/model.glb';
const FADE = 0.35; // crossfade seconds between state loops

// Loaded avatar rendered with its own textures/materials. When the GLB ships
// animation clips (the bundled RobotExpressive default does), an AnimationMixer
// drives the skeleton per CoS state and `speaking`; otherwise it falls back to
// the gentle procedural float so static GLBs still render. The per-state color
// lives entirely in the surrounding lights/halo/glow/sparkles (see Scene) — the
// model itself keeps its real colors rather than being tinted.
function GLBAvatar({ state, speaking }) {
  const gltf = useGLTF(MODEL_URL);
  const ref = useRef();

  // SkeletonUtils.clone rebinds SkinnedMeshes to the cloned skeleton so the
  // AnimationMixer actually deforms the visible mesh. A plain scene.clone(true)
  // leaves the mixer driving bones the rendered mesh no longer references, so
  // nothing would move — the reason clips were previously ignored.
  const scene = useMemo(() => SkeletonUtils.clone(gltf.scene), [gltf.scene]);
  // Append the treadmill (in-place) variants of the root-motion clips so the
  // coding montage can run/walk without drifting. Memoized on the source clips.
  const animations = useMemo(
    () => withInPlaceClips(gltf.animations, MUSE_ROOT_MOTION_CLIPS, MUSE_IN_PLACE_SUFFIX),
    [gltf.animations]
  );
  const { actions, names, mixer } = useAnimations(animations, scene);
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
  // A state resolves to EITHER a single looping base clip (desiredBaseRef) or a
  // montage that cycles clips (sequenceRef). `gestureActiveRef` defers and
  // restores around the one-shot speaking gesture so a state change mid-gesture
  // still lands on the latest state.
  const activeRef = useRef(null);          // currently-playing action
  const desiredBaseRef = useRef(null);     // { name, timeScale, once } to rest on
  const sequenceRef = useRef(null);        // { steps, index } | null when looping
  const gestureActiveRef = useRef(false);
  const speakingRef = useRef(false);

  // Crossfade the currently-active action to `clipName`. `once` → play a single
  // LoopOnce and clamp; `reps` → a finite LoopRepeat that fires `finished` after
  // N cycles (used to advance a montage); neither → an infinite base loop.
  const fadeTo = useCallback((clipName, opts = {}) => {
    const next = actions[clipName];
    if (!next) return;
    const dur = opts.duration ?? FADE;
    next.reset();
    next.enabled = true;
    next.setEffectiveTimeScale(opts.timeScale ?? 1);
    next.setEffectiveWeight(1);
    if (opts.once || opts.reps) {
      // Finite: one shot (`once`) or N reps of a montage step. Clamp on the last
      // frame so it holds its (near-neutral) end pose through the crossfade to
      // the next action instead of snapping toward the bind pose.
      next.setLoop(opts.once ? THREE.LoopOnce : THREE.LoopRepeat, opts.once ? 1 : opts.reps);
      next.clampWhenFinished = true;
    } else {
      next.setLoop(THREE.LoopRepeat, Infinity);
      next.clampWhenFinished = false;
    }
    next.fadeIn(dur).play();
    const prev = activeRef.current;
    if (prev && prev !== next) prev.fadeOut(dur);
    activeRef.current = next;
  }, [actions]);

  // Play montage step `index` (wraps). `index` is always ≥ 0 at every call site
  // (0, the current index, or current+1), so a plain modulo is enough. Steps
  // were pre-filtered to present clips.
  const playSequenceStep = useCallback((index, duration) => {
    const seq = sequenceRef.current;
    if (!seq || !seq.steps.length) return;
    const i = index % seq.steps.length;
    seq.index = i;
    const step = seq.steps[i];
    fadeTo(step.clip, { timeScale: step.timeScale, reps: step.reps ?? 1, duration });
  }, [fadeTo]);

  // Resume the current state's motion — the montage from `fromIndex`, or the
  // single base loop. Both the state effect and the gesture-finish handler need
  // this exact "sequence vs base loop" decision, so it lives in one place.
  const resumeMotion = useCallback((fromIndex, duration) => {
    if (sequenceRef.current) { playSequenceStep(fromIndex, duration); return; }
    const rest = desiredBaseRef.current;
    if (rest?.name) fadeTo(rest.name, { timeScale: rest.timeScale, once: rest.once, duration });
  }, [fadeTo, playSequenceStep]);

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

  // Resolve the montage steps for the current state against the loaded clips.
  // The step's clip is auto-routed to its in-place variant if it's a root-motion
  // clip — so the sequence data names real GLB clips (`Running`) and the
  // fixed-frame no-drift guarantee is enforced here, not by a naming convention.
  // A state needs ≥2 resolvable steps to run as a montage; otherwise it falls
  // back to its single base loop (so a GLB missing the sequence clips — or the
  // in-place variant — still animates). Kept as a memo so the state effect's
  // dependency is stable.
  const sequenceSteps = useMemo(() => {
    if (!hasClips) return null;
    const def = MUSE_STATE_SEQUENCES[state];
    if (!Array.isArray(def)) return null;
    const steps = def
      .map((s) => ({ ...s, clip: inPlaceClipName(s.clip, MUSE_ROOT_MOTION_CLIPS, MUSE_IN_PLACE_SUFFIX) }))
      .filter((s) => names.includes(s.clip));
    return steps.length >= 2 ? steps : null;
  }, [hasClips, names, state]);

  // Start / crossfade to the current state's motion (montage or base loop).
  useEffect(() => {
    if (!baseClip) return;
    desiredBaseRef.current = { name: baseClip, timeScale: baseCfg.timeScale, once: baseCfg.once };
    sequenceRef.current = sequenceSteps ? { steps: sequenceSteps, index: 0 } : null;
    // Mid-gesture: don't crossfade now — the gesture's finish handler restores
    // to whatever the refs point at, so the latest state still wins.
    if (gestureActiveRef.current) return;
    resumeMotion(0);
  }, [resumeMotion, baseClip, baseCfg.timeScale, baseCfg.once, sequenceSteps]);

  // Persistent `finished` listener with two jobs: (1) when the one-shot speaking
  // gesture finishes, hand control back to the live base loop / montage (read
  // from the refs so a state change mid-gesture still lands correctly); (2) when
  // a finite montage step finishes, advance to the next step. Non-sequence base
  // loops are infinite (never fire) and the clamped `sleeping` pose is ignored.
  useEffect(() => {
    if (!hasClips) return;
    const gesture = actions[MUSE_SPEAKING_GESTURE];
    const onFinished = (e) => {
      if (gestureActiveRef.current) {
        if (gesture && e.action !== gesture) return; // ignore body clips finishing
        gestureActiveRef.current = false;
        resumeMotion(sequenceRef.current?.index ?? 0, 0.25); // back to montage / base loop
        return;
      }
      // Advance the montage when the active step completes its reps.
      if (sequenceRef.current && e.action === activeRef.current) {
        playSequenceStep(sequenceRef.current.index + 1);
      }
    };
    mixer.addEventListener('finished', onFinished);
    return () => mixer.removeEventListener('finished', onFinished);
  }, [resumeMotion, playSequenceStep, hasClips, actions, mixer]);

  // Speaking overlay: on the false→true edge, crossfade to the gesture once.
  // The persistent listener above returns to the base loop / montage when it
  // finishes.
  useEffect(() => {
    if (!hasClips) return;
    const was = speakingRef.current;
    speakingRef.current = speaking;
    if (!speaking || was) return; // only fire on the rising edge

    const gesture = actions[MUSE_SPEAKING_GESTURE];
    if (!gesture) return;
    // Skip if a non-montage state is already resting on the gesture clip.
    const base = desiredBaseRef.current;
    if (!sequenceRef.current && base && gesture === actions[base.name]) return;

    gestureActiveRef.current = true;
    fadeTo(MUSE_SPEAKING_GESTURE, { once: true, duration: 0.2 });
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
