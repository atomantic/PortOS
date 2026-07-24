import { Suspense, useEffect } from 'react';
import { Canvas } from '@react-three/fiber';
import { Bounds, OrbitControls, useGLTF } from '@react-three/drei';
import { Download, Rotate3d } from 'lucide-react';

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

function GlbModel({ src }) {
  const { scene } = useGLTF(src);
  // drei caches loaded GLTFs globally; clear this entry on unmount/src-change so a
  // re-render after a new generation doesn't show the stale cached mesh.
  useEffect(() => () => useGLTF.clear(src), [src]);
  return <primitive object={scene} />;
}

export default function GlbViewer({ src, downloadName, className = '' }) {
  if (!src) return null;
  const download = downloadName || filenameFromSrc(src);
  return (
    <div className={`overflow-hidden rounded-xl border border-port-border bg-port-bg ${className}`}>
      <div className="relative aspect-square w-full">
        {/* No environment/HDR preset here on purpose — those fetch from a CDN and
            would fail on an offline / air-gapped install. Two plain lights are
            enough to read an untextured or PBR mesh. */}
        <Canvas camera={{ position: [0, 0, 3], fov: 45 }} dpr={[1, 2]}>
          <ambientLight intensity={0.9} />
          <directionalLight position={[4, 6, 5]} intensity={1.1} />
          <directionalLight position={[-4, -2, -5]} intensity={0.4} />
          <Suspense fallback={null}>
            <Bounds fit clip observe margin={1.2}>
              <GlbModel src={src} />
            </Bounds>
          </Suspense>
          <OrbitControls makeDefault enablePan enableZoom enableRotate />
        </Canvas>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-port-border px-3 py-2">
        <span className="inline-flex items-center gap-1.5 text-xs text-gray-500">
          <Rotate3d className="h-3.5 w-3.5" /> Drag to orbit · scroll to zoom
        </span>
        <a
          href={src}
          download={download}
          className="inline-flex items-center gap-1.5 rounded-md bg-port-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-600"
        >
          <Download className="h-3.5 w-3.5" /> Download .glb
        </a>
      </div>
    </div>
  );
}
