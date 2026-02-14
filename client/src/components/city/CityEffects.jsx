import { useRef, useEffect } from 'react';
import { useThree, useFrame, extend } from '@react-three/fiber';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import * as THREE from 'three';

extend({ EffectComposer, RenderPass, UnrealBloomPass, ShaderPass });

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

// Color Grading shader -- push shadows blue, midtones cyan, highlights warm
const ColorGradingShader = {
  uniforms: {
    tDiffuse: { value: null },
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
    varying vec2 vUv;
    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      float lum = dot(color.rgb, vec3(0.299, 0.587, 0.114));
      // Shadows -> deep blue (#0d0d2b)
      vec3 shadowTint = vec3(0.051, 0.051, 0.169);
      // Midtones -> cyan
      vec3 midTint = vec3(0.024, 0.714, 0.831);
      // Highlights -> warm white
      vec3 highTint = vec3(1.0, 0.95, 0.9);
      float shadowWeight = smoothstep(0.0, 0.3, lum) * (1.0 - smoothstep(0.0, 0.4, lum));
      float midWeight = smoothstep(0.2, 0.5, lum) * (1.0 - smoothstep(0.5, 0.8, lum));
      float highWeight = smoothstep(0.6, 1.0, lum);
      color.rgb = mix(color.rgb, color.rgb * shadowTint * 3.0, shadowWeight * 0.12);
      color.rgb = mix(color.rgb, color.rgb * midTint * 1.4, midWeight * 0.15);
      color.rgb = mix(color.rgb, color.rgb * highTint, highWeight * 0.1);
      // Slight brightness lift for dark areas
      color.rgb = color.rgb * 1.1 + 0.015;
      gl_FragColor = color;
    }
  `,
};

export default function CityEffects({ settings }) {
  const composerRef = useRef();
  const grainPassRef = useRef();
  const { gl, scene, camera, size } = useThree();

  const bloomEnabled = settings?.bloomEnabled ?? true;
  const bloomStrength = settings?.bloomStrength ?? 0.5;
  const chromaticAberration = settings?.chromaticAberration ?? true;
  const filmGrain = settings?.filmGrain ?? true;
  const colorGrading = settings?.colorGrading ?? true;

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
      composer.addPass(bloomPass);
    }

    if (colorGrading) {
      const cgPass = new ShaderPass(ColorGradingShader);
      composer.addPass(cgPass);
    }

    if (chromaticAberration) {
      const caPass = new ShaderPass(ChromaticAberrationShader);
      caPass.uniforms.uStrength.value = bloomStrength >= 0.6 ? 0.005 : 0.003;
      composer.addPass(caPass);
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
  }, [gl, scene, camera, size.width, size.height, bloomEnabled, bloomStrength, chromaticAberration, filmGrain, colorGrading]);

  useFrame(({ clock }) => {
    if (grainPassRef.current) {
      grainPassRef.current.uniforms.uTime.value = clock.getElapsedTime();
    }
    if (composerRef.current) {
      composerRef.current.render();
    }
  }, 1);

  return null;
}
