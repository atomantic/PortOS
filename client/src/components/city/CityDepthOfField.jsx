import { useEffect, useMemo } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { getDofParams } from '../../utils/cityPhotoMode';

// Depth-of-field postprocessing for photo mode (roadmap 3.3). CyberCity ships NO postprocessing
// library — the city's "bloom" is hand-tuned emissive/additive materials, not a composer pass —
// so DoF is the first composited effect. Rather than add a new npm dependency
// (`@react-three/postprocessing`) or hand-roll a circle-of-confusion shader, this uses the
// BokehPass + EffectComposer that already ship inside three's addons (`three/addons/*`), so it
// adds depth-of-field with zero new packages.
//
// This component is mounted ONLY while photo mode is active (see CityScene), so the live dashboard
// frameloop never pays for the extra render targets. While mounted it takes over the render loop
// via a positive-priority useFrame (React Three Fiber then skips its own auto-render) and drives
// the scene through a RenderPass → BokehPass → OutputPass chain. The focal plane is derived per
// framing preset (`getDofParams`) so whatever the shot is pointed at stays sharp while nearer and
// farther geometry falls off softly.
//
// `enabled` toggles only the BokehPass — the composer keeps driving the frame either way (with the
// pass off the image matches the plain RenderPass → OutputPass output), so flipping DoF on/off in
// photo mode never churns the render-loop ownership or strands a frozen demand-mode frame.
export default function CityDepthOfField({ presetId, enabled = true, composerRef }) {
  const { gl, scene, camera, size, invalidate } = useThree();

  // Build the composer + passes once. BokehPass reads camera.near/far/aspect each render, so the
  // camera-fly mutating the shared camera needs no extra wiring here.
  const { composer, bokehPass } = useMemo(() => {
    const comp = new EffectComposer(gl);
    comp.addPass(new RenderPass(scene, camera));
    const params = getDofParams(presetId);
    const bokeh = new BokehPass(scene, camera, {
      focus: params.focus,
      aperture: params.aperture,
      maxblur: params.maxblur,
    });
    comp.addPass(bokeh);
    // OutputPass applies tone mapping + sRGB conversion so the composited frame matches the
    // renderer's normal output (RenderPass writes a linear HDR buffer; without this the postcard
    // would look dark/washed compared to the live view).
    comp.addPass(new OutputPass());
    return { composer: comp, bokehPass: bokeh };
    // gl/scene/camera are stable for the lifetime of this mount; presetId is applied via the
    // effect below so changing it doesn't rebuild the whole composer.
  }, [gl, scene, camera]);

  // Expose the composer so the capture path (CityPhotoCamera) renders the DoF frame too, instead
  // of bypassing it with a plain gl.render. Cleared on unmount so capture falls back to direct
  // rendering the moment photo mode (and this component) goes away.
  useEffect(() => {
    if (!composerRef) return undefined;
    composerRef.current = composer;
    return () => {
      if (composerRef.current === composer) composerRef.current = null;
    };
  }, [composer, composerRef]);

  // Keep the composer sized to the canvas (and at the renderer's pixel ratio) on resize.
  useEffect(() => {
    composer.setPixelRatio(gl.getPixelRatio());
    composer.setSize(size.width, size.height);
    invalidate();
  }, [composer, gl, size.width, size.height, invalidate]);

  // Re-tune the focal plane + blur when the framing preset changes, and toggle the bokeh pass.
  // invalidate() pumps the demand-mode loop so the change shows immediately on a frozen scene.
  useEffect(() => {
    const params = getDofParams(presetId);
    bokehPass.uniforms.focus.value = params.focus;
    bokehPass.uniforms.aperture.value = params.aperture;
    bokehPass.uniforms.maxblur.value = params.maxblur;
    bokehPass.enabled = enabled;
    invalidate();
  }, [bokehPass, presetId, enabled, invalidate]);

  // Free GPU resources when photo mode exits. EffectComposer.dispose() only frees the composer's
  // own read/write targets + internal copy pass — NOT the passes you added — so dispose each pass
  // (BokehPass owns a depth render target + materials + a full-screen quad; OutputPass owns a
  // material + quad) before disposing the composer. The Canvas key-remount tears the WebGL context
  // down on exit too, but disposing explicitly keeps this correct if that remount ever changes.
  useEffect(() => () => {
    for (const pass of composer.passes) pass.dispose?.();
    composer.dispose();
  }, [composer]);

  // Positive priority makes R3F hand the render loop to us: drive the scene through the composer
  // instead of the default renderer. In photo mode's frameloop="demand" this runs only when
  // something invalidates (the camera-fly, a resize, a preset/toggle change), so the scene still
  // freezes for a clean still once the fly settles.
  useFrame(() => {
    composer.render();
  }, 1);

  return null;
}
