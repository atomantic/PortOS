import { Suspense, useEffect, useId, useLayoutEffect, useMemo, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import {
  Bounds,
  Environment,
  OrbitControls,
  useGLTF,
} from '@react-three/drei';
import { AlertTriangle, Download, RefreshCw, Rotate3d, SlidersHorizontal } from 'lucide-react';
import ErrorBoundary from '../ErrorBoundary';
import { GltfPrimitive } from '../../hooks/useClonedGltf';
import { glbErrorText, glbFailureHint } from '../../lib/glbFailure';

const DEFAULT_BACKGROUND = '#050505';
const ENVIRONMENT_HDRI = '/hdri/studio-small-08-1k.hdr';
const ENVIRONMENT_BACKGROUND_BLUR = 0.2;

// Reusable viewer for a generated `.glb` mesh: drei `useGLTF` loads the model,
// `Bounds fit` frames it regardless of the source's scale, `OrbitControls` lets
// the user rotate/zoom, and a Download button saves the raw `.glb`. Deliberately
// backend-agnostic — it takes a plain `src` URL, so the image→3D generate flow
// (#2952) and any future detail route can mount it by pointing at the landed
// asset. Renders nothing without a `src`.

// Derive a friendly download filename from the asset URL when the caller doesn't
// supply one (`/data/models3d/robot-a1b2.glb` → `robot-a1b2.glb`).
function filenameFromSrc(src) {
  const tail = String(src || '').split('?')[0].split('#')[0].split('/').pop();
  return tail && tail.toLowerCase().endsWith('.glb') ? tail : 'model.glb';
}

const opaqueMaterial = (material) => {
  if (!material?.clone) return material;
  const clone = material.clone();
  clone.transparent = false;
  clone.opacity = 1;
  clone.alphaTest = 0;
  clone.depthWrite = true;
  clone.needsUpdate = true;
  return clone;
};

// GLBs generated before the server-side opaque-export fix remain in users'
// libraries. Clone before overriding their materials so drei's URL-keyed cache
// stays pristine for any other consumer that intentionally wants alpha.
export function cloneGlbSceneWithOpaqueMaterials(scene) {
  const clone = scene.clone(true);
  clone.traverse((object) => {
    if (!object?.isMesh || !object.material) return;
    object.material = Array.isArray(object.material)
      ? object.material.map(opaqueMaterial)
      : opaqueMaterial(object.material);
  });
  return clone;
}

function GlbModel({ src, forceOpaque, onSceneLoaded }) {
  // `useGLTF` keys drei's global cache on the URL, so a new generation (a new
  // `src`) parses fresh while revisiting the same mesh reuses the cache — no
  // manual cache-clear needed (clearing on unmount would force a full multi-MB
  // re-fetch every time the viewer remounts for the same URL).
  const { scene } = useGLTF(src);
  const renderedScene = useMemo(
    () => (forceOpaque ? cloneGlbSceneWithOpaqueMaterials(scene) : scene),
    [forceOpaque, scene],
  );
  useEffect(() => {
    if (!forceOpaque) return undefined;
    return () => {
      renderedScene.traverse((object) => {
        if (!object?.isMesh || !object.material) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => material.dispose?.());
      });
    };
  }, [forceOpaque, renderedScene]);
  // Hand the DISPLAYED graph (post force-opaque clone) to the parent, so a
  // consumer that re-serializes it — the AR/USDZ export — ships what the user is
  // actually looking at rather than a differently-materialed original. Cleared on
  // unmount/src change because the effect above disposes this clone's materials:
  // a retained handle would then serialize a scene whose textures are gone.
  useEffect(() => {
    onSceneLoaded?.(renderedScene);
    return () => onSceneLoaded?.(null);
  }, [onSceneLoaded, renderedScene]);
  return <GltfPrimitive object={renderedScene} />;
}

// r3f prefixes every loader failure with "Could not load <url>", so this is what
// separates "the bytes never arrived" from a failure thrown after the mesh was
// already parsed (context loss, a throw downstream of the load). Only the former
// justifies evicting drei's cache on retry — see retryLoad.
const isLoadFailure = (error) => /^Could not load/i.test(glbErrorText(error));

function GlbLoadFailure({ error, onRetry }) {
  const hint = glbFailureHint(error);
  return (
    // `.port-media-overlay` (not `bg-black/NN` + `text-gray-200`) because this
    // panel floats over the canvas surface, whose backdrop is a user-picked
    // color: on a day theme the hardcoded light ink is remapped to dark and the
    // heading renders near-invisible. See "Media overlay chrome" in index.css.
    // Deliberately not `ui/Banner`: its `bg-port-error/10` tint is built to sit
    // on a page, not over an arbitrary canvas backdrop.
    <div
      data-testid="glb-load-error"
      role="alert"
      className="port-media-overlay absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center"
    >
      <AlertTriangle className="h-6 w-6 text-port-error" aria-hidden="true" />
      <p className="text-sm font-medium">This 3D model could not be loaded</p>
      {hint && <p className="max-w-sm text-xs text-port-text-muted">{hint}</p>}
      <p className="max-w-full break-all font-mono text-[10px] leading-snug text-port-text-muted">
        {glbErrorText(error)}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="port-media-overlay-item mt-1 inline-flex items-center gap-1.5 rounded-md border border-port-border px-3 py-1.5 text-xs font-medium"
      >
        <RefreshCw className="h-3.5 w-3.5" /> Retry
      </button>
    </div>
  );
}

// Own `scene.environmentIntensity` directly rather than passing drei's
// `environmentIntensity` prop: drei applies it from an effect that doesn't
// declare it as a dependency. drei's `applyProps` skips `undefined`, so omitting
// the prop leaves this write untouched when its effect applies.
//
// `reassertOn` exists because its *cleanup* does not: drei snapshots
// `scene.environmentIntensity` before we ever write it (so the snapshot is
// three's default 1) and restores that snapshot unconditionally when its effect
// re-runs. Its only remaining live dependency is `background`, so pass the same
// toggle here — otherwise ticking "Show HDRI background" silently returns the
// IBL to full strength while the slider still reads the user's value.
function EnvironmentIntensity({ value, reassertOn }) {
  const scene = useThree((state) => state.scene);
  useLayoutEffect(() => {
    scene.environmentIntensity = value;
  }, [scene, value, reassertOn]);
  return null;
}

function LightingControl({ label, max, value, onChange }) {
  return (
    <label className="flex items-center gap-2">
      <span className="w-20">{label}</span>
      <input
        type="range"
        min="0"
        max={max}
        step="0.1"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label={`${label} light`}
        className="min-w-0 flex-1 accent-port-accent"
      />
      <output className="w-7 text-right tabular-nums text-gray-300">{value.toFixed(1)}</output>
    </label>
  );
}

// `downloadHref` (optional) overrides where the Download button points — pass a
// dedicated asset endpoint that sets its own `Content-Disposition` filename, so
// the server owns the name instead of the client re-deriving it. Falls back to
// `src` with a filename inferred from the URL.
export default function GlbViewer({
  src,
  downloadHref,
  downloadName,
  className = '',
  forceOpaque = false,
  initialBackground = DEFAULT_BACKGROUND,
  // Called with the loaded three.js object graph once the GLB parses, and with
  // `null` when it unloads. Must be referentially stable (a `useState` setter or a
  // `useCallback`) — an inline arrow re-fires the effect on every render.
  onSceneLoaded,
}) {
  const backgroundInputId = useId();
  const controlsPanelId = useId();
  const [background, setBackground] = useState(initialBackground);
  const [ambientIntensity, setAmbientIntensity] = useState(0.6);
  const [keyIntensity, setKeyIntensity] = useState(1.2);
  const [fillIntensity, setFillIntensity] = useState(0.4);
  // The image-based lighting is strong enough to flatten the three light
  // sliders when left at full strength — exposing it as its own control is what
  // makes Ambient/Key/Fill visibly matter (dial it to 0 for lights-only).
  const [environmentIntensity, setEnvironmentIntensity] = useState(0.6);
  const [showEnvironmentBackground, setShowEnvironmentBackground] = useState(true);
  const [controlsOpen, setControlsOpen] = useState(false);
  // A load failure is stored WITH the src it belongs to, so pointing the viewer
  // at a different mesh drops the panel without an effect — and one record's
  // failure never sticks to the next one.
  const [failure, setFailure] = useState(null);
  // The HDRI degrades on its own (see the boundary around <Environment>), but the
  // two controls that drive it would keep sitting in the panel doing nothing —
  // exactly the dead-knob shape this change exists to remove.
  const [environmentFailed, setEnvironmentFailed] = useState(false);
  if (!src) return null;
  const loadError = failure?.src === src ? failure.error : null;
  const retryLoad = () => {
    // suspend-react (under drei's useGLTF) caches the REJECTION against the URL
    // and re-throws it on every later render, so clearing the panel alone would
    // show the same error straight back — drop the cache entry first. Dropping
    // the panel is what remounts the boundary and the canvas.
    //
    // Only for a load failure: the same call evicts a SUCCESSFULLY parsed scene
    // just as readily, so clearing after (say) a lost WebGL context would throw
    // away a good multi-MB mesh and re-download it.
    if (isLoadFailure(loadError)) useGLTF.clear(src);
    setFailure(null);
  };
  const href = downloadHref || src;
  // With an explicit download endpoint the server's Content-Disposition wins, so
  // a bare `download` attribute is enough; otherwise infer a name from the URL.
  const download = downloadHref ? '' : (downloadName || filenameFromSrc(src));
  return (
    <div className={`overflow-hidden rounded-xl border border-port-border bg-port-bg ${className}`}>
      <div
        data-testid="glb-preview-surface"
        className="relative aspect-square w-full"
        style={{ backgroundColor: background }}
      >
        {/* Settings live in a collapsed strip BELOW the canvas, not an overlay —
            an always-on panel covered the upper-right quadrant of the model.
            `aria-controls` is set only while the panel is mounted; the collapsed
            state removes it, and a dangling IDREF is invalid ARIA. Gone while the
            failure panel is up: it is `z-10` over that panel, and every control
            behind it drives a canvas that is no longer mounted. */}
        {!loadError && (
          <button
            type="button"
            onClick={() => setControlsOpen((open) => !open)}
            aria-expanded={controlsOpen}
            aria-controls={controlsOpen ? controlsPanelId : undefined}
            aria-label="Preview display settings"
            title="Preview display settings"
            className={`port-media-overlay-strong port-media-overlay-item absolute right-2 top-2 z-10 inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border border-port-border focus-visible:ring-2 focus-visible:ring-port-accent sm:min-h-0 sm:min-w-0 sm:p-1.5 ${controlsOpen ? 'ring-1 ring-port-accent' : ''}`}
          >
            <SlidersHorizontal className="h-4 w-4" />
          </button>
        )}
        {/* No `<color attach="background">`: r3f canvases are alpha-clear, so the
            surface's CSS color already IS the backdrop. A scene-level color only
            duplicates it while racing Environment's own scene.background
            save/restore whenever the HDRI toggle or the picker changes. */}
        {/* A mesh that fails to load must not take the page with it. Anything
            thrown inside an r3f `<Canvas>` — a 404 on the .glb, a non-glTF body
            reaching the parser, a WebGL context failure — is caught by the Canvas
            and re-thrown from its OWN render (`if (error) throw error`), so with
            no boundary here the nearest one is the router's errorElement and the
            whole route becomes "PortOS could not load this page". `fallback={null}`
            degrades the scene (the shared boundary's documented r3f mode) while
            `onError` hands the failure to this component, which owns the DOM
            chrome and swaps in the panel. */}
        {loadError ? (
          <GlbLoadFailure error={loadError} onRetry={retryLoad} />
        ) : (
          <ErrorBoundary fallback={null} onError={(error) => setFailure({ src, error })}>
            <Canvas camera={{ position: [0, 0, 3], fov: 45 }} dpr={[1, 2]}>
              <ambientLight intensity={ambientIntensity} />
              <directionalLight position={[4, 6, 5]} intensity={keyIntensity} />
              <directionalLight position={[-4, -2, -5]} intensity={fillIntensity} />
              {/* The HDRI gets its OWN boundary + Suspense, not the mesh's. Sharing
                  one meant a missing or corrupt .hdr (a partial checkout, a stale
                  service-worker cache) reported "This 3D model could not be
                  loaded" and took the mesh down with it — while the file is only
                  image-based LIGHTING, which the three lights below already
                  stand in for. Same shape OpenWorldScene documents for its
                  galaxy spheremap: degrade to lights-only, keep the scene. */}
              <ErrorBoundary fallback={null} onError={() => setEnvironmentFailed(true)}>
                <Suspense fallback={null}>
                  {/* Keep the HDRI in public/ instead of using drei's remote presets:
                      preview lighting and the default backdrop must work offline. */}
                  <Environment
                    files={ENVIRONMENT_HDRI}
                    background={showEnvironmentBackground}
                    backgroundBlurriness={ENVIRONMENT_BACKGROUND_BLUR}
                  />
                  <EnvironmentIntensity value={environmentIntensity} reassertOn={showEnvironmentBackground} />
                </Suspense>
              </ErrorBoundary>
              <Suspense fallback={null}>
                <Bounds fit clip observe margin={1.2}>
                  <GlbModel src={src} forceOpaque={forceOpaque} onSceneLoaded={onSceneLoaded} />
                </Bounds>
              </Suspense>
              <OrbitControls makeDefault enablePan enableZoom enableRotate />
            </Canvas>
          </ErrorBoundary>
        )}
      </div>
      {controlsOpen && !loadError && (
        <div
          id={controlsPanelId}
          className="grid gap-x-6 gap-y-2 border-t border-port-border bg-port-card px-3 py-2.5 text-xs text-gray-200 sm:grid-cols-2"
        >
          <LightingControl label="Ambient" max={2} value={ambientIntensity} onChange={setAmbientIntensity} />
          <LightingControl label="Key" max={3} value={keyIntensity} onChange={setKeyIntensity} />
          <LightingControl label="Fill" max={2} value={fillIntensity} onChange={setFillIntensity} />
          {environmentFailed ? (
            <p className="text-xs text-port-text-muted">
              Environment lighting unavailable — the HDRI could not be loaded, so the scene is lit by the sliders alone.
            </p>
          ) : (
            <LightingControl
              label="Environment"
              max={2}
              value={environmentIntensity}
              onChange={setEnvironmentIntensity}
            />
          )}
          <div className="flex items-center gap-2">
            <label htmlFor={backgroundInputId} className="w-20">Background</label>
            <input
              id={backgroundInputId}
              type="color"
              value={background}
              onChange={(event) => setBackground(event.target.value)}
              aria-label="Mesh preview background"
              className="h-7 w-10 cursor-pointer rounded border border-port-border bg-transparent p-0.5"
            />
          </div>
          {!environmentFailed && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={showEnvironmentBackground}
                onChange={(event) => setShowEnvironmentBackground(event.target.checked)}
                className="accent-port-accent"
              />
              Show HDRI background
            </label>
          )}
        </div>
      )}
      <div className="flex items-center justify-between gap-2 border-t border-port-border px-3 py-2">
        {/* Kept mounted while errored so `justify-between` still parks the
            download link on the right — the orbit hint is what drops out. */}
        <span className="inline-flex items-center gap-1.5 text-xs text-gray-500">
          {!loadError && <><Rotate3d className="h-3.5 w-3.5" /> Drag to orbit · scroll to zoom</>}
        </span>
        <a
          href={href}
          download={download}
          className="inline-flex items-center gap-1.5 rounded-md bg-port-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-600"
        >
          <Download className="h-3.5 w-3.5" /> Download .glb
        </a>
      </div>
    </div>
  );
}
