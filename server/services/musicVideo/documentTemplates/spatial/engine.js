export function mount(THREE) {

const mv = window.PORTOS_MV;
const authored = window.PORTOS_MV_GENERATED;
const canvas = document.getElementById('world');
const overlay = document.getElementById('type');
const text = overlay.getContext('2d');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
let width = mv.render.width;
let height = mv.render.height;
const ready = document.fonts.load('40px "MV Mono"');
function layout(size) {
  width = size.width; height = size.height;
  renderer.setSize(width, height, false);
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
    text.reset();
    try {
      text.save();
      fn({ THREE, scene, camera, text }, { t, localT: t - section.startSec, frame: Math.floor(t * mv.render.fps),
        width, height, song: authored.song, section, palette: authored.palette,
        safe: { x: width * 0.1, y: height * 0.1, w: width * 0.8, h: height * 0.8 },
        events: state.activeEvents || [], reactiveGain: state.reactiveGain ?? 1 });
      text.restore();
      renderer.render(scene, camera);
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
