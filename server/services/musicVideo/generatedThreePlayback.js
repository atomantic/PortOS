/** New Three candidates keep the spatial renderer behind the shared producer. */
import { installGeneratedPlayback } from './generatedCanvasPlayback.js';
import { installLayeredPreviewPlayback } from './previewPlaybackRuntime.js';

const BRIDGE = `
const draw = composition.draw;
delete composition.draw;
const stagedWorld = document.createElement('canvas');
const staging = stagedWorld.getContext('2d');
globalThis.portosComposition = composition;
(${installGeneratedPlayback.toString()})(globalThis.portosComposition, {
  get ready() { return Promise.all([ready, globalThis.__portosTitleCard?.ready?.()]); },
  duration: mv.render.durationSec, fps: mv.render.fps,
  state(requested) {
    const state = window.PORTOS_MV_EVENT_STATE({ ...mv.song, sections: mv.song.narrativeSections }, requested, mv.render.fps);
    // Spatial authoring uses continuous time outside narrative holds, including
    // exact shutter subframes. The event state's frame remains quantized.
    return { ...state, t: state.hold ? state.t : requested };
  },
  scene: t => authored.song.sections.find(item => t >= item.startSec && t < item.endSec) || authored.song.sections.at(-1),
  needsSource: () => false, source: () => null, videos: () => [],
  playback: on => globalThis.__portosFilmLook?.playback(on),
  draw(...args) {
    draw(...args);
    if (stagedWorld.width !== width) stagedWorld.width = width;
    if (stagedWorld.height !== height) stagedWorld.height = height;
    // Resolve the WebGL drawing buffer privately, so its copy cost belongs to
    // drawing's freshness check rather than advancing visible pixels afterward.
    staging.globalCompositeOperation = 'copy';
    staging.drawImage(canvas, 0, 0);
  },
  finish(songTime) {
    globalThis.__portosFilmLook?.frame(Math.round(songTime * mv.render.fps));
    globalThis.__portosTitleCard?.draw(songTime);
  },
  commit() {
    for (const [front, back] of [[frontWorld, stagedWorld], [frontType, overlay]]) {
      const context = front.getContext('2d');
      context.globalCompositeOperation = 'copy';
      context.drawImage(back, 0, 0);
    }
  },
  dispose() {
    post.dispose(); renderer.dispose();
    canvas.width = 0; canvas.height = 0; overlay.width = 0; overlay.height = 0;
    stagedWorld.width = 0; stagedWorld.height = 0;
  },
}, ${installLayeredPreviewPlayback.toString()});
`;

/** Adapt only the canonical engine copied into a deliberately new candidate. */
export function generatedThreePlaybackEngine(original) {
  let source = original.toString();
  for (const [from, to] of [
    ["const canvas = document.getElementById('world');", "const frontWorld = document.getElementById('world');\nconst canvas = document.createElement('canvas');"],
    ["const overlay = document.getElementById('type');", "const frontType = document.getElementById('type');\nconst overlay = document.createElement('canvas');"],
    ['  overlay.width = width; overlay.height = height;', '  overlay.width = width; overlay.height = height;\n  frontWorld.width = width; frontWorld.height = height; frontType.width = width; frontType.height = height;'],
    ['globalThis.portosComposition = {', 'const composition = {'],
    [`  async seek(requested) {
    await ready;
    const state = window.PORTOS_MV_EVENT_STATE({ ...mv.song, sections: mv.song.narrativeSections }, requested, mv.render.fps);
    const t = state.hold ? state.t : requested;
    const section = authored.song.sections.find((item) => t >= item.startSec && t < item.endSec) || authored.song.sections.at(-1);`,
    '  draw(t, section, _source, state) {'],
    ['      fn({ THREE, scene, camera, text, lens, toonWorld },', '      const drawing = fn({ THREE, scene, camera, text, lens, toonWorld },'],
    ['        events: state.activeEvents || [], reactiveGain: state.reactiveGain ?? 1 });', "        events: state.activeEvents || [], reactiveGain: state.reactiveGain ?? 1 });\n      if (drawing && typeof drawing.then === 'function') { Promise.resolve(drawing).catch(() => {}); throw new Error('Generated sections must draw synchronously'); }"],
    ['\n};\n\n}\n', `\n};\n${BRIDGE}\n}\n`],
    ['  return {\n    resize(width, height) {', `  return {
    dispose() {
      for (const target of targets) { target.depthTexture?.dispose(); target.dispose(); }
      for (const material of [dof, bright, blur, composite, inkOnly]) material.dispose();
      quad.geometry.dispose(); ink.dispose();
    },
    resize(width, height) {`],
  ]) {
    if (source.split(from).length !== 2) throw new Error('Generated Three playback host seam changed');
    source = source.replace(from, () => to);
  }
  return Buffer.from(source);
}
