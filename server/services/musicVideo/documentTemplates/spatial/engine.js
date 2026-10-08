import * as toonWorld from './toonWorld.js';

export function mount(THREE) {

const mv = window.PORTOS_MV;
const authored = window.PORTOS_MV_GENERATED;
const canvas = document.getElementById('world');
const overlay = document.getElementById('type');
const text = overlay.getContext('2d');
// Canvas MSAA serves the untouched-lens path, which renders straight to it.
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.shadowMap.enabled = true;
// three r186 removed PCFSoftShadowMap; PCF plus light.shadow.radius is the soft path.
renderer.shadowMap.type = THREE.PCFShadowMap;
let width = mv.render.width;
let height = mv.render.height;
const ready = document.fonts.load('40px "MV Mono"');
const post = createPost(THREE, renderer);
function layout(size) {
  width = size.width; height = size.height;
  renderer.setSize(width, height, false);
  post.resize(width, height);
  overlay.width = width; overlay.height = height;
}
layout({ width, height });
function drawWords(t) {
  const cue = (mv.lyrics || []).find((line) => t >= line.startSec && t < (line.endSec ?? line.startSec + 4));
  if (!cue) return;
  text.save();
  text.font = `${Math.round(height * 0.04)}px "MV Mono"`;
  text.textAlign = 'center'; text.textBaseline = 'middle';
  const label = cue.text || (cue.words || []).map((word) => word.w).join(' ');
  text.lineWidth = height * 0.007; text.strokeStyle = '#080b12'; text.fillStyle = '#ffffff';
  text.strokeText(label, width / 2, height * 0.88, width * 0.8);
  text.fillText(label, width / 2, height * 0.88, width * 0.8);
  text.restore();
}
function drawEvents(state) {
  for (const event of state.activeEvents) {
    const label = event.kind === 'counter-change' ? `${event.text || event.name} ${Math.round(event.value)}`
      : event.kind === 'motif-transformation' ? `${event.motif || event.name}: ${event.progress < 0.5 ? event.before || 'Before' : event.after || 'After'}`
        : event.text || event.name;
    text.save();
    text.font = `${Math.round(height * 0.075)}px "MV Mono"`; text.textAlign = 'center';
    text.fillStyle = '#ffffff'; text.strokeStyle = '#080b12'; text.lineWidth = height * 0.006;
    text.globalAlpha = event.kind === 'reveal' ? Math.min(1, event.progress * 4) : 1;
    text.strokeText(label, width / 2, height / 2, width * 0.8);
    text.fillText(label, width / 2, height / 2, width * 0.8);
    text.restore();
  }
}
// Each seek owns a fresh world. The author receives no simulation clock or
// mutable world from a prior frame, including out-of-order subframe captures.
globalThis.portosComposition = {
  durationSec: mv.render.durationSec, fps: mv.render.fps, width, height, motionBlur: 1,
  formats: ['1920x1080', '1080x1920', '1080x1080'], layout,
  async seek(requested) {
    await ready;
    const state = window.PORTOS_MV_EVENT_STATE({ ...mv.song, sections: mv.song.narrativeSections }, requested, mv.render.fps);
    const t = state.hold ? state.t : requested;
    const section = authored.song.sections.find((item) => t >= item.startSec && t < item.endSec) || authored.song.sections.at(-1);
    const fn = authored.sections[section?.id];
    if (!fn) throw new Error('No authored scene for this song time');
    const scene = new THREE.Scene(); scene.background = new THREE.Color('#080b12');
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 200);
    camera.position.set(0, 2, 9); camera.lookAt(0, 1, 0);
    const lens = { ...LENS_DEFAULTS };
    text.reset();
    try {
      text.save();
      fn({ THREE, scene, camera, text, lens, toonWorld }, { t, localT: t - section.startSec, frame: Math.floor(t * mv.render.fps),
        width, height, song: authored.song, section, palette: authored.palette,
        safe: { x: width * 0.1, y: height * 0.1, w: width * 0.8, h: height * 0.8 },
        events: state.activeEvents || [], reactiveGain: state.reactiveGain ?? 1 });
      text.restore();
      post.render(scene, camera, lens, Math.floor(t * mv.render.fps));
      drawEvents(state);
      drawWords(t);
    } finally {
      const resources = new Set();
      scene.traverse((object) => {
        if (object.shadow) resources.add(object.shadow);
        if (object.geometry) resources.add(object.geometry);
        for (const material of [object.material].flat().filter(Boolean)) {
          resources.add(material);
          for (const value of Object.values(material)) if (value?.isTexture) resources.add(value);
        }
      });
      for (const value of [scene.background, scene.environment]) if (value?.isTexture) resources.add(value);
      for (const resource of resources) resource.dispose();
    }
  },
};

}

// A section may set any of these on ctx.lens for its frame. The defaults are
// inert, so a world that never touches the lens renders exactly as before,
// straight to the canvas; only HDR values above the threshold bloom.
// focus is a camera distance or a THREE.Vector3; aperture/maxBlur are pixels
// at 1080p, so a 0 aperture disables depth of field.
const LENS_DEFAULTS = Object.freeze({ focus: 10, aperture: 0, maxBlur: 16, bloom: 0, bloomThreshold: 1, exposure: 1, vignette: 0, grain: 0 });

// Persistent cinematic post stack: the scene renders once into an HDR target
// with depth, then a depth-aware gather DOF, a thresholded quarter-res bloom
// and a composite that compresses highlights (PBR Neutral shoulder), encodes sRGB and adds
// a vignette and frame-keyed grain. Every pass runs every frame so GPU
// resources are allocated once and seeks stay deterministic.
export function createPost(THREE, renderer) {
  const ink = toonWorld.createInkPass(THREE, renderer);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  const stage = new THREE.Scene(); stage.add(quad);
  const vertexShader = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }';
  const pass = (fragmentShader, uniforms) => new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms, depthTest: false, depthWrite: false, toneMapped: false });
  const dof = pass(/* glsl */`
    #include <packing>
    varying vec2 vUv; uniform sampler2D tColor, tDepth; uniform vec2 uRes;
    uniform float uNear, uFar, uFocus, uAperture, uMaxBlur;
    float linZ(vec2 uv){ return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, uNear, uFar); }
    float coc(float z){ return min(uAperture * abs(z - uFocus) / max(z, 1e-3), uMaxBlur); }
    void main(){
      vec3 acc = texture2D(tColor, vUv).rgb;
      if (uAperture <= 0. || uMaxBlur < .5) { gl_FragColor = vec4(acc, 1.); return; }
      float cz = linZ(vUv), cc = coc(cz), wsum = 1.;
      for (int i = 0; i < 56; i++) {
        float fi = float(i) + .5, r = sqrt(fi / 56.) * uMaxBlur, a = fi * 2.39996323;
        vec2 uv = vUv + vec2(cos(a), sin(a)) * r / uRes;
        float sz = linZ(uv), sc = coc(sz);
        if (sz > cz) sc = min(sc, cc * 1.5 + .5); // a sharp foreground never smears onto blurred background
        float w = smoothstep(r - 1.5, r + .5, sc);
        acc += texture2D(tColor, uv).rgb * w; wsum += w;
      }
      gl_FragColor = vec4(acc / wsum, 1.);
    }`, { tColor: { value: null }, tDepth: { value: null }, uRes: { value: new THREE.Vector2() }, uNear: { value: 0.1 }, uFar: { value: 200 }, uFocus: { value: 10 }, uAperture: { value: 0 }, uMaxBlur: { value: 0 } });
  const bright = pass(/* glsl */`
    varying vec2 vUv; uniform sampler2D tColor; uniform vec2 uTexel; uniform float uThreshold;
    void main(){
      vec3 c = vec3(0.);
      for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) c += texture2D(tColor, vUv + vec2(x, y) * uTexel).rgb;
      c /= 9.;
      float l = max(c.r, max(c.g, c.b));
      gl_FragColor = vec4(c * smoothstep(uThreshold, uThreshold * 1.25 + .05, l), 1.);
    }`, { tColor: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1 } });
  const blur = pass(/* glsl */`
    varying vec2 vUv; uniform sampler2D tColor; uniform vec2 uStep;
    void main(){
      vec3 c = texture2D(tColor, vUv).rgb * .2270270270;
      c += (texture2D(tColor, vUv + uStep * 1.3846153846).rgb + texture2D(tColor, vUv - uStep * 1.3846153846).rgb) * .3162162162;
      c += (texture2D(tColor, vUv + uStep * 3.2307692308).rgb + texture2D(tColor, vUv - uStep * 3.2307692308).rgb) * .0702702703;
      gl_FragColor = vec4(c, 1.);
    }`, { tColor: { value: null }, uStep: { value: new THREE.Vector2() } });
  const composite = pass(/* glsl */`
    ${toonWorld.inkShader}
    varying vec2 vUv; uniform sampler2D tColor, tBloom; uniform vec2 uRes;
    uniform float uBloom, uExposure, uVignette, uGrain, uFrame;
    // Khronos PBR Neutral's highlight shoulder without its toe offset, so
    // everything below .76 passes through and existing worlds keep their darks.
    vec3 neutral(vec3 c){
      float p = max(c.r, max(c.g, c.b)); if (p < .76) return c;
      float np = 1. - .0576 / (p - .52); c *= np / p;
      return mix(c, vec3(np), 1. - 1. / (.15 * (p - np) + 1.));
    }
    vec3 srgb(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(1. / 2.4)) - .055, step(.0031308, c)); }
    // The frame is wrapped so sin() stays in precise range late in a long song.
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      vec3 c = (applyInk(texture2D(tColor, vUv).rgb, vUv) + texture2D(tBloom, vUv).rgb * uBloom) * uExposure;
      c = srgb(clamp(neutral(max(c, 0.)), 0., 1.));
      vec2 q = vUv - .5; c *= 1. - dot(q, q) * uVignette * 1.8;
      c += (hash(vUv * uRes + mod(uFrame, 251.) * 7.13) - .5) * uGrain;
      gl_FragColor = vec4(clamp(c, 0., 1.), 1.);
    }`, { tColor: { value: null }, tBloom: { value: null }, uRes: { value: new THREE.Vector2() }, uBloom: { value: 0 }, uExposure: { value: 1 }, uVignette: { value: 0 }, uGrain: { value: 0 }, uFrame: { value: 0 }, ...ink.uniforms });
  let targets = [];
  let hdr, hdrDepth, colour, small, smallB, w = 1, h = 1;
  // A software rasterizer (CI, GPU-less hosts) multiplies every MSAA sample, so
  // it renders single-sampled; real GPUs keep 4x.
  const gl = renderer.getContext();
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const software = /swiftshader|llvmpipe|softpipe|software/i.test(String(gl.getParameter(debugInfo ? debugInfo.UNMASKED_RENDERER_WEBGL : gl.RENDERER)));
  const samples = software ? 0 : 4;
  const draw = (material, target) => { quad.material = material; renderer.setRenderTarget(target); renderer.render(stage, camera); };
  return {
    resize(width, height) {
      for (const target of targets) { target.depthTexture?.dispose(); target.dispose(); }
      w = width; h = height;
      const linear = { type: THREE.HalfFloatType, depthBuffer: false };
      // Depth is sampled for depth of field and visible-surface ink, so only that target carries a
      // depth texture (resolving one is a full extra copy every frame).
      hdr = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples });
      hdrDepth = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples, depthTexture: new THREE.DepthTexture(w, h, THREE.FloatType) });
      colour = new THREE.WebGLRenderTarget(w, h, linear);
      small = new THREE.WebGLRenderTarget(Math.ceil(w / 4), Math.ceil(h / 4), linear);
      smallB = new THREE.WebGLRenderTarget(Math.ceil(w / 4), Math.ceil(h / 4), linear);
      targets = [hdr, hdrDepth, colour, small, smallB];
      // Allocate every target now: passes a lens skips must not create GPU
      // textures on a later seek.
      for (const target of targets) renderer.initRenderTarget(target);
    },
    render(world, view, lens, frame) {
      const px = h / 1080;
      const num = (value, fallback, lo, hi) => Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : fallback;
      // The DOF shader compares view-space depth, so a focus point is projected
      // into camera space: off-axis subjects and rig-parented cameras both stay sharp.
      // renderer.render has not refreshed the camera or a rig it was just parented to.
      let focus;
      if (lens.focus?.isVector3) { view.updateWorldMatrix(true, false); focus = Math.max(0.01, -lens.focus.clone().applyMatrix4(view.matrixWorldInverse).z); }
      else focus = num(lens.focus, LENS_DEFAULTS.focus, 0.01, 1e5);
      const aperture = num(lens.aperture, 0, 0, 64) * px, maxBlur = num(lens.maxBlur, LENS_DEFAULTS.maxBlur, 0, 48) * px;
      const bloom = num(lens.bloom, LENS_DEFAULTS.bloom, 0, 4);
      const exposure = num(lens.exposure, 1, 0, 8), vignette = num(lens.vignette, LENS_DEFAULTS.vignette, 0, 1), grain = num(lens.grain, LENS_DEFAULTS.grain, 0, 0.2);
      // Software-rendered captures pay per full-screen pass, so a lens setting
      // that does nothing skips its pass outright, and an untouched lens skips
      // the HDR path entirely.
      const focusing = aperture > 0 && maxBlur >= 0.5;
      const inking = Boolean(lens.ink);
      if (!inking && !focusing && !bloom && !vignette && !grain && exposure === 1) {
        renderer.setRenderTarget(null); renderer.render(world, view);
        return;
      }
      const sceneTarget = focusing || inking ? hdrDepth : hdr;
      ink.configure(sceneTarget.depthTexture, view, w, h, { ...(typeof lens.ink === 'object' ? lens.ink : {}), enabled: inking });
      renderer.setRenderTarget(sceneTarget); renderer.clear(); renderer.render(world, view);
      let sharp = sceneTarget.texture;
      if (focusing) {
        dof.uniforms.tColor.value = sceneTarget.texture; dof.uniforms.tDepth.value = sceneTarget.depthTexture;
        dof.uniforms.uRes.value.set(w, h);
        dof.uniforms.uNear.value = view.near; dof.uniforms.uFar.value = view.far; dof.uniforms.uFocus.value = focus;
        dof.uniforms.uAperture.value = aperture; dof.uniforms.uMaxBlur.value = maxBlur;
        draw(dof, colour);
        sharp = colour.texture;
      }
      if (bloom > 0) {
        bright.uniforms.tColor.value = sharp; bright.uniforms.uTexel.value.set(2 / w, 2 / h);
        bright.uniforms.uThreshold.value = num(lens.bloomThreshold, LENS_DEFAULTS.bloomThreshold, 0, 16);
        draw(bright, small);
        for (let i = 0; i < 2; i++) {
          blur.uniforms.tColor.value = small.texture; blur.uniforms.uStep.value.set((i + 1) / small.width, 0); draw(blur, smallB);
          blur.uniforms.tColor.value = smallB.texture; blur.uniforms.uStep.value.set(0, (i + 1) / small.height); draw(blur, small);
        }
      }
      const u = composite.uniforms;
      u.tColor.value = sharp; u.tBloom.value = small.texture; u.uRes.value.set(w, h);
      u.uBloom.value = bloom; u.uExposure.value = exposure;
      u.uVignette.value = vignette; u.uGrain.value = grain;
      u.uFrame.value = frame;
      draw(composite, null);
    },
  };
}
