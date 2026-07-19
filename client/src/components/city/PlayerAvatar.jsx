import { useRef, useMemo, useEffect, useCallback } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF, useAnimations } from '@react-three/drei';
import * as THREE from 'three';
import { SkeletonUtils } from 'three-stdlib';
import { useCityPalette } from './CityPaletteContext';
import { dampFactor, EYE_HEIGHT } from '../../utils/cityPlayerRig';
import { withInPlaceClips, inPlaceClipName } from '../../utils/animationClips';
// The root-motion clip set + treadmill suffix are model-level facts about the bundled
// RobotExpressive GLB, so import the single source of truth rather than redeclaring it —
// a divergent copy would silently break in-place routing in one avatar and not the other.
import { MUSE_ROOT_MOTION_CLIPS as ROOT_MOTION_CLIPS, MUSE_IN_PLACE_SUFFIX as IN_PLACE_SUFFIX } from '../cos/constants';

// The exploration-mode player, rendered in third person with the bundled rigged GLB
// (three.js's RobotExpressive by default — data/avatar/model.glb, the same model the CoS
// "Cyber Muse" avatar uses). The character keeps its own textures/colors; the only city
// tint is a themed ground-glow disc under its feet so it still reads as "our runner."
//
// It reads the PlayerController's mutable rig every frame (no React state on the hot path)
// and crossfades the GLB's skeletal clips by rig.state:
//   idle  → Idle
//   walk  → Walking (in place)
//   run   → Running (in place)
//   hover → Jump (flyover: legs off the ground, body floated toward the camera anchor)
// Walking/Running carry root translation (they'd walk the model out from under the rig,
// which OWNS world position); we route them to the synthesized "in place" treadmill
// variants (see withInPlaceClips) so the gait animates while the rig drives movement.

const MODEL_URL = '/api/avatar/model.glb';
const TARGET_HEIGHT = 1.7; // world units, matches the old procedural runner
const FADE = 0.25;         // crossfade seconds between state clips
// The bundled RobotExpressive model is authored facing +Z; the rig's forward is -Z
// (rig.facing 0 → -z), so we add a 180° yaw so the runner faces its travel direction.
// If a user swaps in a GLB with a different forward axis, the runner would face the wrong
// way — this offset is the one model-orientation assumption, called out so it's greppable.
const MODEL_FACING_OFFSET = Math.PI;

// rig.state → { desired GLB clip, playback rate }. The clip is auto-routed to its
// in-place variant when it's a root-motion clip. Rates lean a touch fast so the gait
// reads energetic and foot-skate against the rig's move speed stays subtle.
const STATE_CLIP = {
  idle:  { clip: 'Idle',    timeScale: 1.0 },
  walk:  { clip: 'Walking', timeScale: 1.3 },
  run:   { clip: 'Running', timeScale: 1.5 },
  hover: { clip: 'Jump',    timeScale: 1.0 },
};

export default function PlayerAvatar({ rigRef }) {
  const { accent } = useCityPalette();
  const gltf = useGLTF(MODEL_URL);

  // SkeletonUtils.clone rebinds SkinnedMeshes to the cloned skeleton so the mixer
  // actually deforms the visible mesh (a plain scene.clone would animate bones the
  // rendered mesh no longer references). Memoized on the source scene.
  const scene = useMemo(() => SkeletonUtils.clone(gltf.scene), [gltf.scene]);

  // Append neutralized in-place variants of the root-motion clips so walk/run cycle
  // the legs without translating the model off the rig-driven position.
  const animations = useMemo(
    () => withInPlaceClips(gltf.animations, ROOT_MOTION_CLIPS, IN_PLACE_SUFFIX),
    [gltf.animations]
  );
  const { actions, names } = useAnimations(animations, scene);
  const hasClips = names.length > 0;

  const rootRef = useRef();
  const groundOffsetRef = useRef(-EYE_HEIGHT);
  const activeClipRef = useRef(null);
  const discMatRef = useRef();

  // Fit the model to TARGET_HEIGHT with feet at y=0 and centered on x/z, mutating the
  // scene directly. This MUST run in an effect (not a render-time useMemo): the bounding
  // box is only correct after useAnimations has set up the skeleton/mixer — measuring
  // during render sees an unposed rig and yields a wildly wrong (≈34×) size, shrinking the
  // model to an invisible speck. Frustum culling is off because animated poses (jump, arms
  // out) exceed the bind-pose box; shadows off to match the CoS avatar. Runs once per
  // loaded scene (absolute transform — re-running on state changes would pop the size).
  useEffect(() => {
    scene.traverse((obj) => {
      if (!obj.isMesh) return;
      obj.frustumCulled = false;
      obj.castShadow = false;
      obj.receiveShadow = false;
    });
    const box = new THREE.Box3().setFromObject(scene);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const scale = TARGET_HEIGHT / Math.max(size.y, 1e-3);
    scene.scale.setScalar(scale);
    scene.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
  }, [scene]);

  // Precompute each rig.state → the concrete clip present on the loaded GLB (root-motion →
  // in-place variant; fall back through the routed name → Idle → first clip). This only
  // depends on the loaded clip set, so resolving it once here keeps the per-frame loop to a
  // single object lookup instead of re-scanning `names` every frame.
  const clipByState = useMemo(() => {
    if (!hasClips) return null;
    const resolve = (state) => {
      const wanted = (STATE_CLIP[state] || STATE_CLIP.idle).clip;
      const routed = inPlaceClipName(wanted, ROOT_MOTION_CLIPS, IN_PLACE_SUFFIX);
      if (names.includes(routed)) return routed;
      if (names.includes('Idle')) return 'Idle';
      return names[0] || null;
    };
    return Object.fromEntries(Object.keys(STATE_CLIP).map((s) => [s, resolve(s)]));
  }, [hasClips, names]);

  // Crossfade to `clipName` at the given rate. No-op if it's already the active clip,
  // so this is safe to call every frame.
  const fadeTo = useCallback((clipName, timeScale) => {
    if (!clipName || clipName === activeClipRef.current) return;
    const next = actions[clipName];
    if (!next) return;
    const prev = actions[activeClipRef.current];
    next.reset();
    next.enabled = true;
    next.setEffectiveTimeScale(timeScale ?? 1);
    next.setEffectiveWeight(1);
    next.setLoop(THREE.LoopRepeat, Infinity);
    next.fadeIn(FADE).play();
    if (prev && prev !== next) prev.fadeOut(FADE);
    activeClipRef.current = clipName;
  }, [actions]);

  useFrame(({ clock }, delta) => {
    const root = rootRef.current;
    const rig = rigRef?.current;
    if (!root || !rig) return;
    const f = dampFactor(8, delta);
    const state = rig.state;
    const hovering = state === 'hover';

    // Root follows the rig: feet on the ground normally (rig.position.y is eye height, so
    // subtract EYE_HEIGHT to drop the feet to the plane); in hover the body floats up
    // toward the camera anchor with a gentle bob so a flyover reads as airborne.
    const t = clock.getElapsedTime();
    const targetOffset = hovering ? -1.05 : -EYE_HEIGHT;
    groundOffsetRef.current += (targetOffset - groundOffsetRef.current) * f;
    const bob = hovering ? Math.sin(t * 2.2) * 0.06 : 0;
    root.position.set(rig.position.x, rig.position.y + groundOffsetRef.current + bob, rig.position.z);

    // Face the travel direction (see MODEL_FACING_OFFSET); bank leans into turns.
    root.rotation.y = rig.facing + MODEL_FACING_OFFSET;
    root.rotation.z = rig.bank;

    // Drive the skeleton from the mutable rig state (crossfades only on change).
    if (clipByState) {
      const cfg = STATE_CLIP[state] || STATE_CLIP.idle;
      fadeTo(clipByState[state] || clipByState.idle, cfg.timeScale);
    }

    // Brighten the footprint disc slightly while flying.
    if (discMatRef.current) discMatRef.current.opacity = hovering ? 0.3 : 0.16;
  });

  return (
    <group ref={rootRef}>
      {/* scene carries its own fit scale/position (applied in the effect above).
          dispose={null}: the clone shares geometry/material refs with the useGLTF cache
          (SkeletonUtils.clone is shallow for those), so letting r3f dispose them on unmount
          would corrupt the cache for the next mount / the CoS Muse avatar. */}
      <primitive object={scene} dispose={null} />
      {/* Accent-tinted ground glow — the runner's neon footprint. Declared as JSX so R3F
          owns the geometry/material lifecycle; `color` tracks the theme reactively and the
          per-frame opacity write goes through discMatRef. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <circleGeometry args={[0.45, 18]} />
        <meshBasicMaterial
          ref={discMatRef}
          color={accent}
          transparent
          opacity={0.16}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  );
}

// Warm the loader cache once the URL is known (matches MuseCoSAvatar).
useGLTF.preload(MODEL_URL);
