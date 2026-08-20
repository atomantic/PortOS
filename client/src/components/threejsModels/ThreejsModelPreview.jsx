import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bounds, OrbitControls, useBounds } from '@react-three/drei';
import * as THREE from 'three';
import { createSculptBufferGeometry, needsSculptBufferGeometry, sculptMaterialProps } from '../../lib/threejsSculpt';
import { createSculptEnvironmentTexture, resolveSculptEnvironment, THREEJS_RENDER_PROFILE } from '../../lib/threejsEnvironment';
import {
  collectThreejsCues,
  evaluateThreejsClipPose,
  getThreejsClipDuration,
  listThreejsClips,
  listThreejsCues,
  resolveThreejsClip,
} from '../../lib/threejsAnimation';
import { buildPartSelectionIndex, computeExplodeLayout, isReliefPart } from '../../lib/threejsExplode';
import { summarizeThreejsArticulation } from '../../lib/threejsRig';
import ThreejsClipTransport from './ThreejsClipTransport';
import {
  createRenderBudget,
  getEffectiveTier,
  recordFrame,
  resetRenderBudget,
} from '../../utils/openWorldRenderBudget';

const radians = (degrees = 0) => THREE.MathUtils.degToRad(degrees);
const rotation = (degrees = [0, 0, 0]) => degrees.map(radians);

const HIGHLIGHT_COLOR = '#38bdf8';
const HIGHLIGHT_EMISSIVE_INTENSITY = 0.9;

// These settings change only the renderer's presentation cost. The generated
// spec remains the source of truth for geometry, materials, lights, and export.
const PREVIEW_QUALITY = Object.freeze({
  low: { dpr: [0.75, 1], shadows: 'basic' },
  medium: { dpr: [1, 1], shadows: 'percentage' },
  high: { dpr: [1, 1.5], shadows: 'soft' },
  ultra: { dpr: [1, 2], shadows: 'soft' },
});

const PREVIEW_QUALITY_TIERS = Object.keys(PREVIEW_QUALITY);

const BACKGROUND_PRESETS = [
  { id: 'black', label: 'Black', value: '#000000' },
  { id: 'white', label: 'White', value: '#ffffff' },
  { id: 'transparent', label: 'Transparent', value: null },
  { id: 'green', label: 'Green screen', value: '#00ff00' },
];

const AUDIT_CAMERAS = [
  { id: 'authored', label: 'Authored' },
  { id: 'near', label: 'Near' },
  { id: 'far', label: 'Far' },
  { id: 'family', label: 'Family review' },
];

const AUDIT_RENDER_MODES = [
  { id: 'final', label: 'Final' },
  { id: 'neutral', label: 'Neutral' },
  { id: 'normals', label: 'Normals' },
  { id: 'wireframe', label: 'Wireframe' },
  { id: 'boundaries', label: 'Part boundaries' },
];

const isAuditCamera = (value) => AUDIT_CAMERAS.some((camera) => camera.id === value);
const isAuditRenderMode = (value) => AUDIT_RENDER_MODES.some((mode) => mode.id === value);

const auditPartColor = (partId) => {
  const hue = [...String(partId)].reduce((total, char) => ((total * 31) + char.charCodeAt(0)) % 360, 0);
  return `hsl(${hue} 72% 58%)`;
};

// Camera bookmarks intentionally derive only from the validated scene camera.
// This keeps the inspector deterministic for a saved scene while avoiding a
// second provider-authored camera contract just for review.
function getAuditCameraPosition(spec, auditCamera) {
  const target = Array.isArray(spec?.camera?.target) ? spec.camera.target : [0, 0, 0];
  const authored = Array.isArray(spec?.camera?.position) ? spec.camera.position : [0, 0, 3];
  const offset = authored.map((value, axis) => value - target[axis]);
  const direction = Math.hypot(...offset) > 0 ? offset : [0, 0, 3];
  const scale = auditCamera === 'near' ? 0.6 : auditCamera === 'far' ? 1.7 : 1;
  const familyOffset = auditCamera === 'family'
    ? [
      (direction[0] * Math.SQRT1_2) + (direction[2] * Math.SQRT1_2),
      direction[1],
      (-direction[0] * Math.SQRT1_2) + (direction[2] * Math.SQRT1_2),
    ]
    : direction;
  return target.map((value, axis) => value + (familyOffset[axis] * scale));
}

const checkerboardStyle = {
  backgroundColor: '#191919',
  backgroundImage: [
    'linear-gradient(45deg, #2e2e2e 25%, transparent 25%)',
    'linear-gradient(-45deg, #2e2e2e 25%, transparent 25%)',
    'linear-gradient(45deg, transparent 75%, #2e2e2e 75%)',
    'linear-gradient(-45deg, transparent 75%, #2e2e2e 75%)',
  ].join(', '),
  backgroundSize: '16px 16px',
  backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0',
};

function SculptBufferGeometry({ definition }) {
  const geometry = useMemo(() => createSculptBufferGeometry(definition), [definition]);
  useEffect(() => () => geometry?.dispose(), [geometry]);
  if (!geometry) return null;
  return <primitive object={geometry} attach="geometry" />;
}

function Geometry({ definition }) {
  if (needsSculptBufferGeometry(definition)) return <SculptBufferGeometry definition={definition} />;
  switch (definition.type) {
    case 'box':
      return <boxGeometry args={[definition.width, definition.height, definition.depth]} />;
    case 'sphere':
      return <sphereGeometry args={[definition.radius, definition.widthSegments, definition.heightSegments]} />;
    case 'cylinder':
      return <cylinderGeometry args={[definition.radiusTop, definition.radiusBottom, definition.height, definition.radialSegments]} />;
    case 'cone':
      return <coneGeometry args={[definition.radius, definition.height, definition.radialSegments]} />;
    case 'torus':
      return <torusGeometry args={[definition.radius, definition.tube, definition.radialSegments, definition.tubularSegments, radians(definition.arcDegrees)]} />;
    case 'capsule':
      return <capsuleGeometry args={[definition.radius, definition.length, definition.capSegments, definition.radialSegments]} />;
    case 'lathe':
      return <latheGeometry args={[definition.points.map(([x, y]) => new THREE.Vector2(x, y)), definition.segments]} />;
    default:
      return null;
  }
}

function Material({ definition, highlighted = false, auditMode = 'final', partId, opacity, envMapIntensity = 1 }) {
  if (auditMode === 'normals') return <meshNormalMaterial />;
  if (auditMode === 'wireframe') return <meshBasicMaterial color="#cbd5e1" wireframe />;
  if (auditMode === 'boundaries') {
    return <meshStandardMaterial color={auditPartColor(partId)} metalness={0} roughness={0.62} />;
  }
  if (auditMode === 'neutral') return <meshStandardMaterial color="#a8b0bd" metalness={0} roughness={0.72} />;
  const authored = sculptMaterialProps(definition, envMapIntensity);
  // A clip's opacity channel overrides the authored value for as long as the
  // clip drives it. `transparent` has to come with it — Three.js ignores an
  // opacity below 1 on an opaque material — but the authored flag still wins
  // when the material was already transparent.
  const props = typeof opacity === 'number'
    ? { ...authored, opacity, transparent: authored.transparent || opacity < 1 }
    : authored;
  // Basic materials are unlit and have no emissive channel, so the only way to
  // show them as selected is the base color.
  if (definition.type === 'basic') {
    return <meshBasicMaterial {...props} color={highlighted ? HIGHLIGHT_COLOR : props.color} />;
  }
  const lit = highlighted
    ? { ...props, emissive: HIGHLIGHT_COLOR, emissiveIntensity: HIGHLIGHT_EMISSIVE_INTENSITY }
    : props;
  if (definition.type === 'physical') return <meshPhysicalMaterial {...lit} />;
  return <meshStandardMaterial {...lit} />;
}

// Part ids are provider-authored and the schema accepts `toString`, so a bare
// lookup can hand back an inherited function; only a real triple is an offset.
const offsetPosition = (position = [0, 0, 0], offset) =>
  (Array.isArray(offset) ? position.map((value, axis) => value + offset[axis]) : position);

function Part({ part, materials, layout, selection, selectedId, onSelect, auditMode, pose, envMapIntensity }) {
  // The clip's pose for this part, or nothing — a part no sequence drives keeps
  // exactly the transform the spec authored, which is also what every part of a
  // model with no clips at all gets.
  const posed = pose[part.id];
  const transform = {
    name: part.name,
    position: offsetPosition(posed?.position || part.position, layout.offsets[part.id]),
    rotation: rotation(posed?.rotationDegrees || part.rotationDegrees),
    scale: posed?.scale || part.scale,
    // Hides the whole subtree, which is what a retracted or destroyed component
    // means — its relief and children go with it.
    visible: posed?.visible !== false,
  };
  // The whole selected subtree lights up, so selecting a container reads as one
  // component rather than one lonely mesh inside it.
  const highlighted = Boolean(selectedId) && (selection.ancestry[part.id] || []).includes(selectedId);
  const select = (event) => {
    // Without this the ray keeps going and every part behind the click selects too.
    event.stopPropagation();
    onSelect(selection.owners[part.id] || part.id);
  };
  // Relief rides this part's own geometry, so both sit inside the mesh offset
  // when this part is a container that moves its shell independently of its
  // children. Everything else is a part in its own right and stays outside it.
  const own = (
    <>
      {part.geometry && (
        <mesh castShadow={part.castShadow} receiveShadow={part.receiveShadow} onClick={select}>
          <Geometry definition={part.geometry} />
          <Material definition={materials[part.material]} highlighted={highlighted} auditMode={auditMode} partId={part.id} opacity={posed?.opacity} envMapIntensity={envMapIntensity} />
        </mesh>
      )}
      {part.children.filter(isReliefPart).map((child) => (
        <Part key={child.id} part={child} materials={materials} layout={layout} selection={selection} selectedId={selectedId} onSelect={onSelect} auditMode={auditMode} pose={pose} envMapIntensity={envMapIntensity} />
      ))}
    </>
  );
  const meshOffset = layout.meshOffsets[part.id];
  return (
    <group {...transform}>
      {Array.isArray(meshOffset) ? <group position={meshOffset}>{own}</group> : own}
      {part.children.filter((child) => !isReliefPart(child)).map((child) => (
        <Part
          key={child.id}
          part={child}
          materials={materials}
          layout={layout}
          selection={selection}
          selectedId={selectedId}
          onSelect={onSelect}
          auditMode={auditMode}
          pose={pose}
          envMapIntensity={envMapIntensity}
        />
      ))}
    </group>
  );
}

// <Bounds> only measures its children when it is told to. Exploding moves parts
// without remounting anything, so re-fit whenever the layout ACTUALLY grew —
// measured from the moved parts, not guessed from the slider — and the camera
// frames the disassembly instead of clipping it.
//
// Opening a different clip is the other discrete moment worth re-framing on: its
// starting pose can sit well outside the assembled one. Playing or scrubbing is
// deliberately NOT one — re-fitting on every posed frame turns the camera into
// something that chases the mechanism, which is far worse to watch than a part
// that swings past the edge of a frame the viewer chose.
function SceneRefit({ growth, clipId }) {
  const bounds = useBounds();
  useEffect(() => {
    bounds?.refresh().clip().fit();
  }, [bounds, growth, clipId]);
  return null;
}

// The preview owns only the R3F sampling boundary; the quality decisions stay in
// openWorldRenderBudget so its warm-up, hysteresis, cooldown, and gap handling remain
// deterministic and shared with OpenWorld.
function PreviewAdaptiveQuality({ enabled, resetToken, onTierChange }) {
  const stateRef = useRef(null);
  if (stateRef.current === null) stateRef.current = createRenderBudget('high', 0);

  useEffect(() => {
    if (!enabled) return;
    const now = typeof performance === 'undefined' ? 0 : performance.now();
    stateRef.current = resetRenderBudget(stateRef.current, 'high', now);
    onTierChange(getEffectiveTier(stateRef.current));
  }, [enabled, resetToken, onTierChange]);

  useFrame((_, delta) => {
    if (!enabled) return;
    const now = typeof performance === 'undefined' ? 0 : performance.now();
    const previousTier = getEffectiveTier(stateRef.current);
    stateRef.current = recordFrame(stateRef.current, { now, dt: delta * 1000 });
    const nextTier = getEffectiveTier(stateRef.current);
    if (nextTier !== previousTier) onTierChange(nextTier);
  });

  return null;
}

function SceneLight({ light }) {
  if (light.type === 'ambient') {
    return <ambientLight color={light.color} intensity={light.intensity} />;
  }
  if (light.type === 'hemisphere') {
    return <hemisphereLight color={light.color} groundColor={light.groundColor} intensity={light.intensity} position={light.position} />;
  }
  if (light.type === 'point') {
    return <pointLight color={light.color} intensity={light.intensity} position={light.position} castShadow />;
  }
  if (light.type === 'spot') {
    return (
      <spotLight
        color={light.color}
        intensity={light.intensity}
        position={light.position}
        angle={radians(light.angleDegrees)}
        penumbra={light.penumbra}
        castShadow
      />
    );
  }
  return <directionalLight color={light.color} intensity={light.intensity} position={light.position} castShadow />;
}

// The image-based lighting `spec.lights` cannot supply. Punctual lights light a
// surface; only an environment gives it something to REFLECT, so without this a
// physically plausible conductor renders near-black and transmission, clearcoat
// and iridescence do nothing — and the next refinement pass "fixes" that by
// authoring implausible values back in.
//
// Assigned imperatively rather than through drei's <Environment preset=…>, which
// fetches an HDR from a CDN: rendering a local model must make no outbound
// request. The texture is owned here, so switching presets or unmounting
// releases the GPU memory the PMREM pass allocated.
function SceneEnvironment({ preset }) {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  useEffect(() => {
    if (!scene) return undefined;
    const texture = preset === 'none' ? null : createSculptEnvironmentTexture(gl, preset);
    scene.environment = texture;
    return () => {
      // Only clear what this effect set — a later effect may already have
      // installed the next preset's texture.
      if (scene.environment === texture) scene.environment = null;
      texture?.dispose();
    };
  }, [gl, scene, preset]);
  return null;
}

function ProceduralScene({ spec, background, layout, selection, selectedId, onSelect, auditMode, pose, clipId }) {
  const environment = resolveSculptEnvironment(spec);
  return (
    <>
      {background && <color attach="background" args={[background]} />}
      <SceneEnvironment preset={environment.preset} />
      {spec.lights.map((light, index) => <SceneLight key={`${light.type}-${index}`} light={light} />)}
      <Bounds fit clip observe margin={1.25}>
        <SceneRefit growth={layout.growth} clipId={clipId} />
        {/* Clicking past the model clears the selection, the way a file list
            does — but only when there is one, so a stray click on empty canvas
            doesn't push a URL write and re-render the page around us. */}
        <group name={spec.name} onPointerMissed={() => { if (selectedId) onSelect(null); }}>
          {spec.parts.map((part) => (
            <Part
              key={part.id}
              part={part}
              materials={spec.materials}
              layout={layout}
              selection={selection}
              selectedId={selectedId}
              onSelect={onSelect}
              auditMode={auditMode}
              pose={pose}
              envMapIntensity={environment.intensity}
            />
          ))}
        </group>
      </Bounds>
      <gridHelper args={[20, 20, '#4b5563', '#252b38']} position={[0, -0.01, 0]} />
      <OrbitControls
        makeDefault
        target={spec.camera.target}
        enableDamping
        dampingFactor={0.08}
        minDistance={0.1}
        maxDistance={500}
      />
    </>
  );
}

/**
 * Playhead for one declared clip.
 *
 * The time lives in a ref as well as in state because the play loop needs the
 * PREVIOUS frame's time to ask which cues it just crossed — deriving that inside
 * a state updater would make firing a cue a side effect of rendering, which
 * double-fires the moment React replays the updater.
 *
 * Scrubbing moves the same playhead and fires nothing: only this loop collects
 * cues, which is the entire difference between silent scrubbing and playback.
 */
function useClipPlayback({ clip, cuesById, onCue }) {
  const [timeSeconds, setTimeSeconds] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const timeRef = useRef(0);
  const onCueRef = useRef(onCue);
  const duration = getThreejsClipDuration(clip);

  const setPlayhead = useCallback((value) => {
    timeRef.current = value;
    setTimeSeconds(value);
  }, []);

  // A different clip starts at its own beginning, stopped — carrying a playhead
  // across clips would drop the model into a pose the new clip never authored.
  //
  // Keyed on the clip's CONTENT, not its id: a refinement can hand back a
  // rewritten `deploy` whose sequences and duration are new, and evaluating that
  // at the old playhead would pose the model mid-nowhere and fire the new clip's
  // cues from the middle. The detail page re-fetches the record every 2s while a
  // generation runs, so an equivalent snapshot must NOT reset it — which is why
  // this compares the content rather than the object identity, the same way the
  // part and model signatures above do.
  const clipSignature = useMemo(() => JSON.stringify(clip ?? null), [clip]);
  useEffect(() => {
    setPlaying(false);
    setPlayhead(0);
  }, [clipSignature, setPlayhead]);

  // Held in a ref so a caller passing an inline handler cannot restart the loop
  // on every render.
  useEffect(() => {
    onCueRef.current = onCue;
  }, [onCue]);

  useEffect(() => {
    if (!playing || !clip || !(duration > 0)) return undefined;
    let frame = 0;
    let last = performance.now();
    const fire = (from, to) => {
      const handler = onCueRef.current;
      if (!handler) return;
      for (const crossed of collectThreejsCues(clip, from, to)) {
        // The handler runs outside React's render and outside any request
        // lifecycle: an uncaught throw here would break the rAF chain and stop
        // playback dead with no way to restart it.
        try {
          handler({ ...crossed, clipId: clip.id, cue: cuesById[crossed.cueId] || null });
        } catch (error) {
          console.error(`❌ Three.js clip cue handler failed: ${error.message}`);
        }
      }
    };
    const step = (now) => {
      const delta = Math.max(0, (now - last) / 1000) * speed;
      last = now;
      const from = timeRef.current;
      const raw = from + delta;
      if (raw < duration) {
        fire(from, raw);
        setPlayhead(raw);
      } else if (clip.loop) {
        const wrapped = raw % duration;
        if (raw - from >= duration) {
          // A frame gap longer than the whole clip — a backgrounded tab, a stall
          // — crossed every cue in it. Fire each of them ONCE for the gap
          // instead of replaying a backlog per skipped cycle: a resumed tab must
          // not burst N copies of the same sound, and dropping the skipped
          // cycles entirely would silently under-fire the contract.
          fire(0, duration);
        } else {
          fire(from, duration);
          fire(0, wrapped);
        }
        setPlayhead(wrapped);
      } else {
        fire(from, duration);
        setPlayhead(duration);
        setPlaying(false);
        return;
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playing, clip, duration, speed, cuesById, setPlayhead]);

  const togglePlay = useCallback(() => {
    // Pressing play on a finished clip replays it rather than sitting on the
    // last frame doing nothing. Read from state rather than an updater — moving
    // the playhead from inside one makes it a side effect React may replay.
    if (!playing && timeRef.current >= duration) setPlayhead(0);
    setPlaying(!playing);
  }, [playing, duration, setPlayhead]);

  const stop = useCallback(() => {
    setPlaying(false);
    setPlayhead(0);
  }, [setPlayhead]);

  return { timeSeconds, playing, speed, setSpeed, togglePlay, stop, setPlayhead, duration };
}

export default function ThreejsModelPreview({ spec, family = null, className = '', onCue = null }) {
  const [background, setBackground] = useState(() => spec?.background || '#000000');
  const [explode, setExplode] = useState(0);
  const [qualityMode, setQualityMode] = useState('auto');
  const [autoTier, setAutoTier] = useState('high');
  const [fixedTier, setFixedTier] = useState('high');
  const [searchParams, setSearchParams] = useSearchParams();
  const explodeSliderId = useId();
  const qualitySelectId = useId();

  // Keyed on the authored background, not on `spec` — the detail page re-fetches
  // the record every 2s while a generation runs, and a fresh object with the
  // same content would throw away the background the user just picked.
  const authoredBackground = spec?.background;
  useEffect(() => {
    setBackground(authoredBackground || '#000000');
  }, [authoredBackground]);

  const parts = spec?.parts;
  const articulation = useMemo(() => summarizeThreejsArticulation(spec), [spec]);
  const selection = useMemo(() => buildPartSelectionIndex(parts || []), [parts]);
  const layout = useMemo(() => computeExplodeLayout(parts || [], explode), [parts, explode]);

  // Same reason: reset the disassembly only when the part set actually changes,
  // not on every poll that hands back an equivalent spec.
  const partSignature = useMemo(() => Object.keys(selection.names).join('|'), [selection]);
  useEffect(() => {
    setExplode(0);
  }, [partSignature]);

  // Equivalent polling snapshots should not reset adaptation, but any authored
  // model change must start a fresh measurement window instead of borrowing the
  // previous model's pressure history.
  const modelSignature = useMemo(() => JSON.stringify(spec), [spec]);
  const effectiveTier = qualityMode === 'auto' ? autoTier : fixedTier;
  const quality = PREVIEW_QUALITY[effectiveTier];
  const handleAutoTierChange = useCallback((tier) => {
    setAutoTier((previous) => previous === tier ? previous : tier);
  }, []);
  const handleQualityChange = (event) => {
    const next = event.target.value;
    if (next === 'auto') {
      setQualityMode('auto');
      return;
    }
    setFixedTier(next);
    setQualityMode('fixed');
  };

  // The URL is the source of truth for what is selected, so a picked part is
  // shareable and reload-safe; an id the current model doesn't have degrades to
  // no selection instead of an empty label.
  const requestedPartId = searchParams.get('part');
  const selectedId = requestedPartId && selection.names[requestedPartId] ? requestedPartId : null;
  const requestedAuditCamera = searchParams.get('auditCamera');
  const auditCamera = isAuditCamera(requestedAuditCamera) ? requestedAuditCamera : 'authored';
  const requestedAuditMode = searchParams.get('auditMode');
  const auditMode = isAuditRenderMode(requestedAuditMode) ? requestedAuditMode : 'final';
  const auditCameraPosition = getAuditCameraPosition(spec, auditCamera);
  // Which clip is open is part of what the URL describes, the same way the audit
  // camera and inspection mode are — a clip a model does not declare degrades to
  // its first one rather than to an empty transport.
  const clips = useMemo(() => listThreejsClips(spec), [spec]);
  // Keyed on the requested id rather than the params object: picking a part
  // rewrites the URL, and a fresh `searchParams` identity would hand the play
  // loop a new clip object and restart it mid-playback.
  const requestedClipId = searchParams.get('clip');
  const clip = useMemo(() => resolveThreejsClip(spec, requestedClipId), [spec, requestedClipId]);
  const cuesById = useMemo(() => {
    // Null-prototype: cue ids are provider-authored and the id schema accepts
    // `toString`, so a bare lookup on a plain object can hand back a function.
    const map = Object.create(null);
    for (const cue of listThreejsCues(spec)) map[cue.id] = cue;
    return map;
  }, [spec]);
  const playback = useClipPlayback({ clip, cuesById, onCue });
  const { pose, activeSequenceIds } = useMemo(
    () => evaluateThreejsClipPose(clip, playback.timeSeconds),
    [clip, playback.timeSeconds],
  );
  const activeSequenceNames = (clip?.sequences || [])
    .filter((sequence) => activeSequenceIds.includes(sequence.id))
    .map((sequence) => sequence.name);
  const handleSelect = useCallback((partId) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      if (partId) next.set('part', partId);
      else next.delete('part');
      return next;
    }, { replace: true });
  }, [setSearchParams]);
  const setPreviewParam = useCallback((key, value) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set(key, value);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  if (!spec) {
    return (
      <div className={`flex items-center justify-center bg-port-bg text-gray-500 ${className}`}>
        No generated model yet
      </div>
    );
  }
  const transparent = background === null;
  const selectedPreset = BACKGROUND_PRESETS.find((preset) => preset.value === background)?.id || 'custom';
  return (
    <div
      className={`relative overflow-hidden bg-port-bg ${className}`}
      style={transparent ? checkerboardStyle : undefined}
    >
      <Canvas
        key={`${spec.name}-${spec.schemaVersion}-${transparent ? 'transparent' : background}-${auditCamera}-${auditMode}`}
        shadows={quality.shadows}
        camera={{ position: auditCameraPosition, fov: spec.camera.fov, near: 0.01, far: 10_000 }}
        dpr={quality.dpr}
        // The colour-management half of the render profile the export stamps on
        // every model. outputColorSpace and toneMapping come from r3f own
        // defaults for linear={false} flat={false} — so neither flag is passed
        // here — while exposure is the one r3f leaves to three, stated outright
        // rather than inherited so the exported claim stays true.
        gl={{ alpha: transparent, toneMappingExposure: THREEJS_RENDER_PROFILE.toneMappingExposure }}
      >
        <PreviewAdaptiveQuality
          enabled={qualityMode === 'auto'}
          resetToken={modelSignature}
          onTierChange={handleAutoTierChange}
        />
        <ProceduralScene
          spec={spec}
          background={background}
          layout={layout}
          selection={selection}
          selectedId={selectedId}
          onSelect={handleSelect}
          auditMode={auditMode}
          pose={pose}
          clipId={clip?.id || null}
        />
      </Canvas>
      <div className="port-media-overlay absolute left-2 top-2 flex max-w-[calc(100%-1rem)] flex-wrap items-center gap-1.5 rounded-lg px-2 py-1.5 text-[10px]">
        <span className="mr-1 whitespace-nowrap text-port-text-muted">Background</span>
        <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Preview background">
          {BACKGROUND_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              aria-label={preset.label}
              aria-pressed={selectedPreset === preset.id}
              onClick={() => setBackground(preset.value)}
              className="port-media-overlay-item rounded px-1.5 py-1"
            >
              {preset.label}
            </button>
          ))}
        </div>
        <label className="port-media-overlay-item flex items-center gap-1 rounded px-1.5 py-1">
          Custom
          <input
            type="color"
            aria-label="Custom preview background color"
            value={background || '#000000'}
            onChange={(event) => setBackground(event.target.value)}
            className="h-4 w-5 rounded border-0 bg-transparent p-0"
          />
        </label>
        <span className="port-media-overlay-divider mx-1 hidden h-3 w-px sm:block" />
        <label htmlFor={qualitySelectId} className="whitespace-nowrap text-port-text-muted">
          Quality
        </label>
        <select
          id={qualitySelectId}
          value={qualityMode === 'auto' ? 'auto' : fixedTier}
          onChange={handleQualityChange}
          className="port-media-overlay-item rounded px-1.5 py-1 text-[10px]"
        >
          <option value="auto">Auto</option>
          {PREVIEW_QUALITY_TIERS.map((tier) => <option key={tier} value={tier}>{tier}</option>)}
        </select>
        <span className="whitespace-nowrap text-port-text-muted">
          {qualityMode === 'auto' ? `Auto · ${effectiveTier}` : `Fixed · ${effectiveTier}`}
        </span>
        <span className="port-media-overlay-divider mx-1 hidden h-3 w-px sm:block" />
        <label htmlFor={explodeSliderId} className="whitespace-nowrap text-port-text-muted">
          Explode
        </label>
        <input
          id={explodeSliderId}
          type="range"
          min="0"
          max="1"
          step="0.02"
          value={explode}
          disabled={layout.unitIds.length < 2}
          onChange={(event) => setExplode(Number(event.target.value))}
          className="h-1 w-20 cursor-pointer accent-port-accent disabled:cursor-not-allowed disabled:opacity-40 sm:w-28"
        />
        <span className="w-8 tabular-nums text-port-text-muted">{Math.round(explode * 100)}%</span>
        {explode > 0 && (
          <button
            type="button"
            onClick={() => setExplode(0)}
            className="port-media-overlay-item rounded px-1.5 py-1"
          >
            Reassemble
          </button>
        )}
        <span className="port-media-overlay-divider mx-1 hidden h-3 w-px sm:block" />
        <span className="whitespace-nowrap text-port-text-muted">Audit camera</span>
        <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Audit camera">
          {AUDIT_CAMERAS.map((camera) => {
            const unavailable = camera.id === 'family' && !family;
            return (
              <button
                key={camera.id}
                type="button"
                aria-label={camera.label}
                aria-pressed={auditCamera === camera.id}
                disabled={unavailable}
                title={unavailable ? 'Choose a subject family to enable family review' : undefined}
                onClick={() => setPreviewParam('auditCamera', camera.id)}
                className="port-media-overlay-item rounded px-1.5 py-1 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {camera.label}
              </button>
            );
          })}
        </div>
        <span className="port-media-overlay-divider mx-1 hidden h-3 w-px sm:block" />
        <span className="whitespace-nowrap text-port-text-muted">Inspection</span>
        <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Inspection mode">
          {AUDIT_RENDER_MODES.map((mode) => (
            <button
              key={mode.id}
              type="button"
              aria-label={mode.label}
              aria-pressed={auditMode === mode.id}
              onClick={() => setPreviewParam('auditMode', mode.id)}
              className="port-media-overlay-item rounded px-1.5 py-1"
            >
              {mode.label}
            </button>
          ))}
        </div>
      </div>
      {selectedId && (
        <div className="port-media-overlay absolute right-2 top-2 flex max-w-[calc(100%-1rem)] items-center gap-2 rounded-lg px-2 py-1.5 text-[10px]">
          <span className="truncate font-medium">{selection.names[selectedId] || selectedId}</span>
          <code className="truncate text-port-text-muted">{selectedId}</code>
          {/* Which declared joint (if any) drives the picked part — the diagnostic
              that turns "it says articulation-ready" into something checkable. */}
          {articulation.jointsByPartId[selectedId] && (
            <span className="truncate text-port-accent">
              joint {articulation.jointsByPartId[selectedId].id}
              {articulation.jointsByPartId[selectedId].pivotSocket
                ? ` · pivot ${articulation.jointsByPartId[selectedId].pivotSocket}`
                : ' · no pivot'}
            </span>
          )}
          <button
            type="button"
            aria-label="Clear part selection"
            onClick={() => handleSelect(null)}
            className="port-media-overlay-item rounded px-1.5 py-0.5"
          >
            Clear
          </button>
        </div>
      )}
      <div className="pointer-events-none absolute bottom-2 left-2 flex max-w-[calc(100%-1rem)] flex-wrap items-center gap-1.5 text-[10px]">
        <ThreejsClipTransport
          clips={clips}
          clip={clip}
          duration={playback.duration}
          time={playback.timeSeconds}
          playing={playback.playing}
          speed={playback.speed}
          activeSequenceNames={activeSequenceNames}
          onSelectClip={(clipId) => setPreviewParam('clip', clipId)}
          onTogglePlay={playback.togglePlay}
          onStop={playback.stop}
          onScrub={playback.setPlayhead}
          onSpeedChange={playback.setSpeed}
        />
        <span className="port-media-overlay rounded px-2 py-1">
          Drag to orbit · scroll to zoom · click a part to identify it · audit controls never change the saved model
        </span>
        {family && (
          <span className="port-media-overlay rounded px-2 py-1 text-port-text-muted">
            Family review: {(family.orbitViews || []).join(', ') || 'review the authored subject'}
            {family.reviewAxes?.length > 0 ? ` · ${family.reviewAxes.join('; ')}` : ''}
          </span>
        )}
        {/* Never "animation-ready": nothing here is skinned. The badge says only
            whether the spec declared a usable articulation graph, and a model
            that predates the contract has none and reads as a static assembly. */}
        <span
          className={articulation.articulationReady
            ? 'port-media-overlay rounded px-2 py-1 text-port-success'
            : 'port-media-overlay rounded px-2 py-1 text-port-text-muted'}
        >
          {articulation.articulationReady
            ? `Articulation-ready · ${articulation.jointCount} joints · ${articulation.socketCount} pivot${articulation.socketCount === 1 ? '' : 's'}`
            : `Static assembly${articulation.jointCount > 0 ? ` · ${articulation.jointCount} joints declared` : ''}`}
        </span>
      </div>
    </div>
  );
}
