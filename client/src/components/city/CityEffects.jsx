import { useRef, useEffect } from 'react';
import { useThree, useFrame, extend } from '@react-three/fiber';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import * as THREE from 'three';
import { cityDayMix } from './cityConstants';

extend({ EffectComposer, RenderPass, UnrealBloomPass, ShaderPass });

// Exposure/brightness lift shader -- applied after bloom so it brightens the scene
// without feeding extra luminosity into the bloom pass.
// Uses a reverse power curve: shadows lift dramatically, highlights barely change.
const ExposureShader = {
  uniforms: {
    tDiffuse: { value: null },
    uExposure: { value: 1.0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uExposure;
    varying vec2 vUv;
    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      // Reverse power curve: lifts shadows/midtones, preserves highlights; higher uExposure -> brighter
      float safeExposure = max(uExposure, 0.001);
      color.rgb = 1.0 - pow(max(1.0 - color.rgb, 0.0), vec3(safeExposure));
      gl_FragColor = color;
    }
  `,
};

// Chromatic Aberration shader -- offset R/B channels at screen edges
const ChromaticAberrationShader = {
  uniforms: {
    tDiffuse: { value: null },
    uStrength: { value: 0.003 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uStrength;
    varying vec2 vUv;
    void main() {
      vec2 center = vec2(0.5);
      vec2 dir = vUv - center;
      float dist = length(dir);
      float offset = dist * uStrength;
      float r = texture2D(tDiffuse, vUv + dir * offset).r;
      float g = texture2D(tDiffuse, vUv).g;
      float b = texture2D(tDiffuse, vUv - dir * offset).b;
      gl_FragColor = vec4(r, g, b, 1.0);
    }
  `,
};

// Film Grain shader -- animated noise overlay
const FilmGrainShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uIntensity: { value: 0.04 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uIntensity;
    varying vec2 vUv;
    float rand(vec2 co) {
      return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
    }
    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      float noise = rand(vUv * uTime) * uIntensity;
      color.rgb += noise - uIntensity * 0.5;
      gl_FragColor = color;
    }
  `,
};

// Color Grading shader -- at night push shadows blue, midtones cyan, highlights
// warm (cyberpunk). uDay (0=night, 1=day) fades those tints out and swaps in a
// bright, lightly-warm, more saturated daytime grade so noon reads as real daylight
// instead of dusk.
const ColorGradingShader = {
  uniforms: {
    tDiffuse: { value: null },
    uDay: { value: 0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uDay;
    varying vec2 vUv;
    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      float lum = dot(color.rgb, vec3(0.299, 0.587, 0.114));
      // Night tints (faded out by day)
      vec3 shadowTint = vec3(0.051, 0.051, 0.169); // deep blue
      vec3 midTint = vec3(0.024, 0.714, 0.831);    // cyan
      vec3 highTint = vec3(1.0, 0.95, 0.9);         // warm white
      float shadowWeight = smoothstep(0.0, 0.3, lum) * (1.0 - smoothstep(0.0, 0.4, lum));
      float midWeight = smoothstep(0.2, 0.5, lum) * (1.0 - smoothstep(0.5, 0.8, lum));
      float highWeight = smoothstep(0.6, 1.0, lum);
      float night = 1.0 - uDay;
      color.rgb = mix(color.rgb, color.rgb * shadowTint * 3.0, shadowWeight * 0.12 * night);
      color.rgb = mix(color.rgb, color.rgb * midTint * 1.4, midWeight * 0.15 * night);
      color.rgb = mix(color.rgb, color.rgb * highTint, highWeight * 0.1);
      // Brightness lift: the night grade lifts dark areas (+1.1/+0.015). Daylight is
      // already bright, so the lift backs off to neutral to avoid clipping to white.
      color.rgb = color.rgb * mix(1.1, 0.99, uDay) + mix(0.015, 0.0, uDay);
      // Daytime warmth + gentle saturation so colors feel sunlit rather than washed.
      vec3 warm = color.rgb * vec3(1.03, 1.0, 0.96);
      float gray = dot(warm, vec3(0.299, 0.587, 0.114));
      vec3 sat = mix(vec3(gray), warm, 1.08);
      color.rgb = mix(color.rgb, sat, uDay);
      gl_FragColor = color;
    }
  `,
};

export default function CityEffects({ settings }) {
  const composerRef = useRef();
  const grainPassRef = useRef();
  const exposurePassRef = useRef();
  const bloomPassRef = useRef();
  const caPassRef = useRef();
  const cgPassRef = useRef();
  const { gl, scene, camera, size } = useThree();

  const bloomEnabled = settings?.bloomEnabled ?? true;
  const bloomStrength = settings?.bloomStrength ?? 0.5;
  const sceneExposure = settings?.sceneExposure ?? 1.0;
  const chromaticAberration = settings?.chromaticAberration ?? true;
  const filmGrain = settings?.filmGrain ?? true;
  const colorGrading = settings?.colorGrading ?? true;
  // Daytime fades the heavy night atmospherics (bloom, grain, chromatic aberration,
  // blue grade) so noon reads as clear daylight rather than a hazy dusk.
  const dayMix = cityDayMix(settings);
  const effectiveExposure = sceneExposure * (1 + (1 - dayMix) * 0.55);
  const caBase = bloomStrength >= 0.6 ? 0.005 : 0.003;

  useEffect(() => {
    const composer = new EffectComposer(gl);
    composer.setSize(size.width, size.height);
    composer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));

    const renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);

    if (bloomEnabled) {
      const bloomPass = new UnrealBloomPass(
        new THREE.Vector2(size.width, size.height),
        bloomStrength,
        0.4,  // radius — tighter glow around emissive elements
        0.45  // threshold — only genuinely bright/emissive surfaces bloom
      );
      bloomPassRef.current = bloomPass;
      composer.addPass(bloomPass);
    } else {
      bloomPassRef.current = null;
    }

    // Exposure pass — always added, enabled/disabled via ref to avoid
    // recreating the composer when the slider is dragged
    const exposurePass = new ShaderPass(ExposureShader);
    exposurePass.enabled = effectiveExposure !== 1.0;
    exposurePass.uniforms.uExposure.value = effectiveExposure;
    exposurePassRef.current = exposurePass;
    composer.addPass(exposurePass);

    if (colorGrading) {
      const cgPass = new ShaderPass(ColorGradingShader);
      cgPassRef.current = cgPass;
      composer.addPass(cgPass);
    } else {
      cgPassRef.current = null;
    }

    if (chromaticAberration) {
      const caPass = new ShaderPass(ChromaticAberrationShader);
      caPass.uniforms.uStrength.value = caBase;
      caPassRef.current = caPass;
      composer.addPass(caPass);
    } else {
      caPassRef.current = null;
    }

    if (filmGrain) {
      const fgPass = new ShaderPass(FilmGrainShader);
      grainPassRef.current = fgPass;
      composer.addPass(fgPass);
    } else {
      grainPassRef.current = null;
    }

    composerRef.current = composer;

    return () => {
      composer.dispose();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- effectiveExposure intentionally omitted; updated via exposurePassRef in useFrame to avoid recreating the composer on slider drag
  }, [gl, scene, camera, size.width, size.height, bloomEnabled, bloomStrength, chromaticAberration, filmGrain, colorGrading]);

  useFrame(({ clock }) => {
    if (exposurePassRef.current) {
      exposurePassRef.current.enabled = effectiveExposure !== 1.0;
      exposurePassRef.current.uniforms.uExposure.value = effectiveExposure;
    }
    if (grainPassRef.current) {
      grainPassRef.current.uniforms.uTime.value = clock.getElapsedTime();
      // Grain is a night-film affectation — fade it out in daylight.
      grainPassRef.current.uniforms.uIntensity.value = 0.04 * (1 - dayMix);
    }
    if (cgPassRef.current) {
      cgPassRef.current.uniforms.uDay.value = dayMix;
    }
    if (bloomPassRef.current) {
      // Bloom is a night-neon effect. In daylight the whole scene sits above the
      // bloom threshold, so any bloom blooms EVERYTHING into a white-out — fade the
      // strength to ~0 and raise the threshold so only true highlights (the sun) glow.
      bloomPassRef.current.strength = bloomStrength * (1 - dayMix);
      bloomPassRef.current.threshold = 0.45 + dayMix * 0.45;
    }
    if (caPassRef.current) {
      caPassRef.current.uniforms.uStrength.value = caBase * (1 - dayMix);
    }
    if (composerRef.current) {
      composerRef.current.render();
    }
  }, 1);

  return null;
}
