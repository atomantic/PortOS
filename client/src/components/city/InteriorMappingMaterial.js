import { MeshStandardMaterial, Color, Vector2, Vector3 } from 'three';

// Self-contained parallax interior-mapping material — a MeshStandardMaterial
// subclass that fakes furnished 3D rooms behind flat window planes via
// onBeforeCompile GLSL injection. Replaces the `three-fenestra` npm
// dependency (#1874) with an in-tree port trimmed to the subset of its API
// actually consumed by BuildingWindows.jsx: backAtlas/backAtlasCols/
// backAtlasRows/planeSize/instanced/depth/backScale/roughness/metalness/
// transparent/glassFresnelStrength/glassFresnelColor/emissiveVariation, plus
// the `instanceWindowId`/`instanceLod`/`instanceFade` instanced attributes.
// The original also supported a front PBR overlay atlas (albedo/normal/
// roughness/metalness), glass dirt/refraction/thickness, and a flat
// `interiorEmissive` fallback — none of which any PortOS caller uses, so
// they were not ported. Re-derive them from upstream if a future caller
// needs that surface: https://github.com/codedgar/three-fenestra
//
// The ported GLSL below is a derivative of three-fenestra@0.3.0
// (MIT License, Copyright (c) 2026 Edgar Perez):
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
// FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
// DEALINGS IN THE SOFTWARE.

// ── GLSL core ────────────────────────────────────────────────────────────
// imHash: deterministic per-window hash. Public seed contract (other shaders
// — e.g. a far-LOD impostor — can reproduce the exact same window from the
// same windowId by reusing these seeds): lit 3.71, tone 9.27, brightness 5.43.
// imWindowEmissive: lit/unlit + warm/cool tone + brightness jitter from the hash.
// imAtlasUV: seeded atlas-cell lookup (picks one cell of a cols x rows grid).
// imRoomBoxUV: the room-box ray-march — re-projects the view-ray exit point
// onto one room photo (back+side walls baked into a single atlas cell).
const glslCore = /* glsl */ `
  float imHash(vec3 p, float seed) {
    p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3) + seed);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  vec3 imWindowEmissive(vec3 windowId, float litRatio, vec3 warm, vec3 cool,
                        float coolChance, vec2 bright, vec3 dim) {
    float hLit    = imHash(windowId, 3.71);
    float hTone   = imHash(windowId, 9.27);
    float hBright = imHash(windowId, 5.43);
    if (hLit >= litRatio) return dim;
    vec3 tone = mix(warm, cool, step(1.0 - coolChance, hTone));
    return tone * (bright.x + bright.y * hBright);
  }

  vec2 imAtlasUV(vec2 cellUV, vec3 windowId, float cols, float rows, float seed) {
    float total = cols * rows;
    float idx   = floor(imHash(windowId, seed) * total);
    float col   = mod(idx, cols);
    float row   = floor(idx / cols);
    vec2 cellSize   = vec2(1.0 / cols, 1.0 / rows);
    vec2 inset      = cellSize * 0.001;
    vec2 cellOrigin = vec2(col * cellSize.x, 1.0 - (row + 1.0) * cellSize.y) + inset;
    return cellOrigin + clamp(cellUV, 0.0, 1.0) * (cellSize - 2.0 * inset);
  }

  vec2 imRoomBoxUV(vec3 camLocal, vec2 localXY, float depth, float backScale) {
    vec3 origin = vec3(localXY, 0.0);
    vec3 dir    = normalize(origin - camLocal);
    vec3 invDir = 1.0 / dir;
    vec3 tNear  = (vec3(-0.5, -0.5, -depth) - origin) * invDir;
    vec3 tFar   = (vec3(0.5, 0.5, 0.0) - origin) * invDir;
    vec3 tMax   = max(tNear, tFar);
    float t     = min(min(tMax.x, tMax.y), tMax.z);
    vec3 hit    = origin + dir * t;
    float bs      = clamp(backScale, 0.05, 0.999);
    float camDist = bs * depth / (1.0 - bs);
    float scale   = camDist / (camDist - hit.z);
    return hit.xy * scale + 0.5;
  }
`;

const vertexCommon = /* glsl */ `
  varying vec2 vInteriorLocalXY;
  varying vec3 vInteriorCameraLocal;
  varying vec3 vImWindowId;
  varying float vImLod;
  varying float vImFade;
  uniform vec2 uPlaneSize;
  uniform vec3 uWindowId;
  uniform float uLod;
  #ifdef IM_INSTANCED
    // one InstancedMesh = thousands of windows in a single draw call;
    // per-window identity/LOD/fade live in instanced attributes
    attribute vec3 instanceWindowId;
    attribute float instanceLod;
    attribute float instanceFade;
  #endif
`;

const vertexBody = /* glsl */ `
  vInteriorLocalXY = position.xy / uPlaneSize;
  #ifdef IM_INSTANCED
    mat4 _imModel = modelMatrix * instanceMatrix;
    vImWindowId = instanceWindowId;
    vImLod = instanceLod;
    vImFade = instanceFade;
  #else
    mat4 _imModel = modelMatrix;
    vImWindowId = uWindowId;
    vImLod = uLod;
    vImFade = 1.0;
  #endif
  vec3 _imCamLocal = (inverse(_imModel) * vec4(cameraPosition, 1.0)).xyz;
  vInteriorCameraLocal = vec3(
    _imCamLocal.xy / uPlaneSize,
    _imCamLocal.z / max(uPlaneSize.x, uPlaneSize.y)
  );
`;

const fragmentCommon = /* glsl */ `
  varying vec2 vInteriorLocalXY;
  varying vec3 vInteriorCameraLocal;
  varying vec3 vImWindowId;
  varying float vImLod;
  varying float vImFade;

  uniform sampler2D uBackAtlas;
  uniform float uBackAtlasCols;
  uniform float uBackAtlasRows;
  uniform float uDepth;
  uniform float uBackScale;
  uniform vec3  uWindowId;
  uniform float uGlassFresnelStrength;
  uniform vec3  uGlassFresnelColor;

  // LOD blend: 1 = full interior mapping + glass fresnel, 0 = flat impostor
  // (the back cell sampled straight onto the plane, no parallax/fresnel).
  // Drive by camera distance to crossfade against a cheap far-LOD shader
  // that samples the same atlas cell flat.
  uniform float uLod;

  // GPU-side per-window emissive variation (lit/unlit, warm/cool, brightness
  // jitter) derived from the window id so a far-LOD impostor shader can hash
  // the same id with the same seeds and reproduce the exact same window.
  uniform float uVarLitRatio;
  uniform vec3  uVarWarm;
  uniform vec3  uVarCool;
  uniform float uVarCoolChance;
  uniform vec2  uVarBright; // (min, range)
  uniform vec3  uVarDim;

  vec3 _imWindowEmissive() {
    return imWindowEmissive(vImWindowId, uVarLitRatio, uVarWarm, uVarCool,
                            uVarCoolChance, uVarBright, uVarDim);
  }

  vec3 _imInteriorRGB() {
    vec2 cellUV = imRoomBoxUV(vInteriorCameraLocal, vInteriorLocalXY, uDepth, uBackScale);
    // uLod = 0 collapses the room to a flat cell sample (LOD impostor match)
    cellUV = mix(vInteriorLocalXY + 0.5, cellUV, vImLod);
    vec2 atlasUV = imAtlasUV(cellUV, vImWindowId, uBackAtlasCols, uBackAtlasRows, 0.0);
    return texture2D(uBackAtlas, atlasUV).rgb;
  }
`;

// Replaces <map_fragment>. The window is opaque from the camera's
// perspective — the interior IS the back of the surface, not a transparent
// hole — so diffuseColor is forced to opaque black (no direct diffuse
// lighting should paint over the interior) and the already-lit interior
// color is stashed in a local that the output injection below adds back in
// AFTER PBR lighting runs, skipping the GGX BRDF entirely.
const fragmentMapReplacement = /* glsl */ `
  diffuseColor.rgb = vec3(0.0);
  diffuseColor.a = 1.0;
  vec3 _imInteriorEmissive = _imInteriorRGB() * _imWindowEmissive();
`;

// Injected BEFORE <tonemapping_fragment>: adds the linear-space interior on
// top of the lit (black) front layer so it receives the same tonemap + sRGB
// conversion as everything else, then layers a Schlick fresnel sheen at
// grazing angles — the primary "this is a pane of glass" cue.
const fragmentOutput = /* glsl */ `
  gl_FragColor.rgb += _imInteriorEmissive;
  gl_FragColor.a *= vImFade; // per-instance LOD fade (1.0 unless instanced)

  vec3 _imViewLocal = normalize(vInteriorCameraLocal - vec3(vInteriorLocalXY, 0.0));
  float _imNdotV   = clamp(_imViewLocal.z, 0.0, 1.0);
  float _imFresnel = pow(1.0 - _imNdotV, 5.0) * vImLod; // glass cue fades out with LOD
  gl_FragColor.rgb += uGlassFresnelColor * uGlassFresnelStrength * _imFresnel;
`;

/**
 * Parallax interior-mapping `MeshStandardMaterial` subclass — fakes a
 * furnished 3D room behind a flat window pane. Use with a single plane (set
 * `windowId`/`lod`) or with a `THREE.InstancedMesh` (`instanced: true`,
 * geometry carries `instanceWindowId`/`instanceLod`/`instanceFade`).
 */
export class InteriorMappingMaterial extends MeshStandardMaterial {
  /**
   * @param {object} params
   * @param {import('three').Texture} params.backAtlas - interior atlas (the rooms texture sampled by the ray-march).
   * @param {number} [params.backAtlasCols=4]
   * @param {number} [params.backAtlasRows=4]
   * @param {number} [params.depth=1.0] - apparent room depth in plane-local units.
   * @param {number} [params.backScale=0.66] - back-wall fill factor in [0.05, 0.999].
   * @param {import('three').Vector2} params.planeSize - plane size in world units (width, height); must match the geometry.
   * @param {import('three').Vector3} [params.windowId] - per-window seed (non-instanced mode only; instanced mode uses `instanceWindowId`).
   * @param {number} [params.lod=1.0] - LOD blend in [0,1] (non-instanced mode only; instanced mode uses `instanceLod`).
   * @param {number} [params.glassFresnelStrength=0.0] - Schlick fresnel sheen strength at grazing angles.
   * @param {import('three').Color} [params.glassFresnelColor] - tint of the fresnel sheen. Default cool white (0.85, 0.92, 1.0).
   * @param {object} [params.emissiveVariation] - GPU-side per-window emissive variation (lit/unlit, warm/cool, brightness jitter).
   * @param {number} [params.emissiveVariation.litRatio=0.5] - chance a window is lit, in [0,1].
   * @param {import('three').Color} [params.emissiveVariation.warm] - emissive tint of warm (incandescent) windows. Default (1.7, 1.35, 0.95).
   * @param {import('three').Color} [params.emissiveVariation.cool] - emissive tint of cool (fluorescent/TV) windows. Default (0.9, 1.15, 1.5).
   * @param {number} [params.emissiveVariation.coolChance=0.22] - chance a lit window uses the cool tone.
   * @param {number} [params.emissiveVariation.brightMin=0.3] - minimum brightness multiplier of a lit window.
   * @param {number} [params.emissiveVariation.brightRange=0.35] - random brightness range added on top of brightMin.
   * @param {import('three').Color} [params.emissiveVariation.dim] - emissive of unlit windows. Default (0.07, 0.08, 0.1).
   * @param {boolean} [params.instanced=false] - use with a THREE.InstancedMesh whose geometry carries
   *   InstancedBufferAttributes `instanceWindowId` (vec3), `instanceLod` (float) and `instanceFade` (float).
   */
  constructor(params) {
    const {
      backAtlas, backAtlasCols, backAtlasRows, planeSize, windowId, depth, backScale,
      glassFresnelStrength, glassFresnelColor, lod, emissiveVariation, instanced,
      ...std
    } = params;

    super(std);

    this._instanced = instanced ?? false;
    const ev = emissiveVariation;

    this.interiorUniforms = {
      uBackAtlas:            { value: backAtlas },
      uBackAtlasCols:        { value: backAtlasCols ?? 4 },
      uBackAtlasRows:        { value: backAtlasRows ?? 4 },
      uDepth:                { value: depth ?? 1.0 },
      uBackScale:            { value: backScale ?? 0.66 },
      uPlaneSize:            { value: planeSize.clone() },
      uWindowId:             { value: (windowId ?? new Vector3()).clone() },
      uGlassFresnelStrength: { value: glassFresnelStrength ?? 0.0 },
      uGlassFresnelColor:    { value: (glassFresnelColor ?? new Color(0.85, 0.92, 1.0)).clone() },
      uLod:                  { value: lod ?? 1.0 },
      uVarLitRatio:          { value: ev?.litRatio ?? 0.5 },
      uVarWarm:              { value: (ev?.warm ?? new Color(1.7, 1.35, 0.95)).clone() },
      uVarCool:              { value: (ev?.cool ?? new Color(0.9, 1.15, 1.5)).clone() },
      uVarCoolChance:        { value: ev?.coolChance ?? 0.22 },
      uVarBright:            { value: new Vector2(ev?.brightMin ?? 0.3, ev?.brightRange ?? 0.35) },
      uVarDim:               { value: (ev?.dim ?? new Color(0.07, 0.08, 0.1)).clone() },
    };

    // Toggles vertex/fragment shader between the instanced-attribute path
    // (uses instanceWindowId/instanceLod/instanceFade) and the uniform path
    // (uses uWindowId/uLod, flat per-material instead of per-instance).
    this.defines = this._instanced ? { IM_INSTANCED: '' } : {};
  }

  onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, this.interiorUniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${vertexCommon}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${vertexBody}`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${glslCore}\n${fragmentCommon}`)
      .replace('#include <map_fragment>', fragmentMapReplacement)
      .replace('#include <tonemapping_fragment>', `${fragmentOutput}\n#include <tonemapping_fragment>`);
  };
}
