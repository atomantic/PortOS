/**
 * Code Animation prompt builder (pure).
 *
 * Code Animation asks an LLM to write ONE self-contained HTML file that draws
 * an animated film procedurally — no image/font/library assets, every frame
 * produced by code. The art style comes from the universe's style guide (its
 * curated embrace/avoid tokens, style references, and tone notes), refined by a
 * mood board's notes/captions/analyses, reference images, optional per-film
 * style notes, and an audio track. A character design bible, when the brief
 * has one, becomes rigging instructions, and a fixed direction section and
 * self-review pass hold the output to a studio-short craft bar.
 *
 * The prompt also pins a small RUNTIME CONTRACT the PortOS preview host relies
 * on — a deterministic `renderFrame(t)`, `ANIMATION_META`, the audio URL hook,
 * and a postMessage recording handshake — so a generated page can be previewed,
 * scrubbed, and recorded to a WebM video without PortOS knowing anything else
 * about its internals. The page stays fully usable standalone (its own Record
 * button downloads the video) when the user pastes the prompt into an external
 * LLM instead.
 *
 * Everything here is deterministic string assembly over already-resolved
 * inputs; loading the universe/board and resolving file paths happens in
 * `index.js`.
 */

import { isNonBlankStr, trimTo } from '../../lib/textUtils.js';
import { moodBoardSection, universeStyleLines } from '../../lib/styleSourcePrompt.js';
import { renderFilmStyleGrammarPrompt } from '../../lib/filmStyleGrammars.js';

// The postMessage vocabulary between the preview host (parent) and the
// generated page (sandboxed iframe). Served to the client through the options
// endpoint so both halves read one definition.
export const CODE_ANIMATION_MESSAGES = Object.freeze({
  ready: 'code-animation:ready',
  record: 'code-animation:record',
  recorded: 'code-animation:recorded',
  progress: 'code-animation:progress',
  error: 'code-animation:error',
});

// The global the host sets (before any page script runs) to the audio track's
// URL. Absent when the user supplied no audio or opened the file standalone.
export const CODE_ANIMATION_AUDIO_GLOBAL = 'ANIMATION_AUDIO_URL';

// The global the frame-exact exporter sets to the soundtrack's measured beat
// grid ({ bpm, beats, downbeats, hits } — seconds), so audio-reactive motion
// can be a pure function of t with no live playback (#9078).
export const CODE_ANIMATION_SONG_GLOBAL = 'ANIMATION_SONG';

export const CODE_ANIMATION_ASPECT_RATIOS = Object.freeze({
  '16:9': { width: 16, height: 9 },
  '9:16': { width: 9, height: 16 },
  '1:1': { width: 1, height: 1 },
  '4:5': { width: 4, height: 5 },
  '4:3': { width: 4, height: 3 },
  '21:9': { width: 21, height: 9 },
});

// The SHORT side, in pixels. 1080p renders are the default; 720p keeps a heavy
// particle or oil-stroke style inside a real-time frame budget.
export const CODE_ANIMATION_RESOLUTIONS = Object.freeze({ '720p': 720, '1080p': 1080 });

export const CODE_ANIMATION_RENDERERS = Object.freeze(['auto', 'canvas2d', 'webgl', 'svg']);

export const CODE_ANIMATION_LIMITS = Object.freeze({
  durationMin: 3,
  durationMax: 180,
  fpsOptions: [24, 30, 60],
  titleMax: 200,
  seedIdeaMax: 2_000,
  conceptMax: 6_000,
  castMax: 4_000,
  textMax: 4_000,
  styleNotesMax: 2_000,
  referenceImagesMax: 8,
  referenceNoteMax: 300,
  audioNotesMax: 1_500,
});

const RENDERER_GUIDANCE = {
  auto: 'Pick the renderer that best serves the style: Canvas 2D for most illustrative looks, raw WebGL (no libraries) when you need thousands of primitives or shader effects.',
  canvas2d: 'Render with the Canvas 2D API.',
  webgl: 'Render with raw WebGL / WebGL2 and hand-written shaders (no libraries).',
  svg: 'Render with inline SVG driven from script, rasterized onto the recording canvas each frame (draw the serialized SVG via an Image) so recording still captures it.',
};

/** Even pixel dimensions for an aspect ratio at a short-side resolution. */
export function resolveFrameSize(aspectRatio, resolution) {
  const ratio = CODE_ANIMATION_ASPECT_RATIOS[aspectRatio] || CODE_ANIMATION_ASPECT_RATIOS['16:9'];
  const shortSide = CODE_ANIMATION_RESOLUTIONS[resolution] || CODE_ANIMATION_RESOLUTIONS['1080p'];
  const even = (n) => Math.round(n / 2) * 2;
  if (ratio.width >= ratio.height) {
    return { width: even((shortSide * ratio.width) / ratio.height), height: shortSide };
  }
  return { width: shortSide, height: even((shortSide * ratio.height) / ratio.width) };
}

const STYLE_GRAMMAR_PRECEDENCE = "Precedence: the universe style guide and mood board win on palette and subject content; the style grammar wins on rendering technique, motion stepping, camera moves and sound; the style refinements below refine both.";

// The art direction. The universe's style guide IS the look — the same curated
// tokens every other Create surface renders that world with — so the film
// matches the universe's stills and videos; the per-animation notes only
// refine it. The model's job is to translate that look into drawing code.
function artDirectionSection({ universe, styleNotes, styleGrammarId, hasMoodBoard }) {
  const lines = [];
  if (universe) {
    lines.push(`The art style comes from the universe "${universe.name}". Match its established look exactly — this film must sit beside the universe's other artwork as the same world.`);
    lines.push(...universeStyleLines(universe));
    if (isNonBlankStr(universe.styleNotes)) {
      lines.push(`Tone and staging notes (context for mood — do not depict entities they name unless the brief asks): ${universe.styleNotes}`);
    }
  }
  const grammar = styleGrammarId ? renderFilmStyleGrammarPrompt(styleGrammarId) : '';
  if (grammar) {
    lines.push(`STYLE GRAMMAR:\n${grammar}`);
    lines.push(STYLE_GRAMMAR_PRECEDENCE);
  }
  if (isNonBlankStr(styleNotes)) {
    lines.push(`${universe ? 'Refinements for this animation' : 'Style direction from the artist'}: ${trimTo(styleNotes, CODE_ANIMATION_LIMITS.styleNotesMax)}`);
  }
  if (!lines.length && !hasMoodBoard) {
    lines.push('No style was specified — choose a distinctive, cohesive art style that suits the brief and commit to it.');
  }
  if (lines.length || hasMoodBoard) {
    lines.push('Translate the style into drawing technique: decide how its medium, line quality, texture, palette, and lighting are produced procedurally (layered translucent fills for washes, pressure-modulated strokes for ink, low-res upscaling with dithering for pixel art, additive glow passes for neon, noise-driven grain for paper or film), then apply that technique consistently to every element.');
  }
  return lines.join('\n');
}

function referenceImagesSection(images, delivery) {
  if (!images.length) return '';
  const intro = {
    copy: 'Reference images are attached alongside this prompt, in this order:',
    api: 'Reference images are attached to this request, in this order:',
    cli: 'Reference images are on disk — open and study each one:',
  }[delivery] || 'Reference images, in order:';
  const rows = images.map((image, index) => {
    const where = delivery === 'cli' && image.path ? ` (${image.path})` : '';
    const note = isNonBlankStr(image.note) ? ` — ${trimTo(image.note, CODE_ANIMATION_LIMITS.referenceNoteMax)}` : '';
    const origin = { 'mood-board': ' [from the mood board]', universe: ' [universe style image]' }[image.origin] || '';
    return `${index + 1}. ${image.label}${origin}${where}${note}`;
  });
  return `${intro}\n${rows.join('\n')}\nUse them for palette, composition, silhouettes, texture, and lighting. Do NOT embed, fetch, or base64 them — recreate what matters procedurally in code.`;
}

function audioSection({ audio, soundtrack, durationSeconds }) {
  if (audio) {
    const lines = [
      `An audio track drives this animation: "${audio.name}"${audio.durationSeconds ? ` (${audio.durationSeconds.toFixed(1)}s long)` : ''}.`,
    ];
    if (isNonBlankStr(audio.notes)) lines.push(`What the artist says about the track (tempo, sections, cues): ${trimTo(audio.notes, CODE_ANIMATION_LIMITS.audioNotesMax)}`);
    lines.push(
      `- Read the track URL from \`window.${CODE_ANIMATION_AUDIO_GLOBAL}\` (set by the host before your script runs). Play it through an <audio> element routed into Web Audio (createMediaElementSource → AnalyserNode → destination).`,
      '- While audio plays, the timeline clock IS `audio.currentTime` so picture and sound never drift.',
      `- Make the picture dance from PRECOMPUTED song data as a function of t: when \`window.${CODE_ANIMATION_SONG_GLOBAL}\` is set (\`{ bpm, beats, downbeats, hits }\`, every entry a time in seconds; bpm may be null) derive pulses, cuts, scale, and color from the nearest beats/downbeats/hits before and after t. The frame-exact MP4 export renders renderFrame(t) with NO audio playing, so a live analyser reads silence there. Use the AnalyserNode's bass / mid / treble energy only as a preview fallback when \`window.${CODE_ANIMATION_SONG_GLOBAL}\` is absent.`,
      `- If \`window.${CODE_ANIMATION_AUDIO_GLOBAL}\` is unset (the file was opened on its own), show a small "Load audio" file input in the controls overlay and fall back to a silent clock until a file is chosen.`,
      `- The video lasts ${durationSeconds}s; if the track is longer, fade the audio out over the final second.`,
    );
    return lines.join('\n');
  }
  if (soundtrack === 'procedural') {
    return [
      'No audio file was supplied. Design an original procedural soundtrack with the Web Audio API (oscillators, FM, filtered noise, envelopes, a simple sequencer), scheduled from the same timeline as the picture so every sound lands on its frame. Start it on the first user gesture (Play/Record); resume a suspended AudioContext.',
      '- Voice: wordless characters get a small emotional vocabulary of synthesized chirps, boops, hums, or warbles (sine/FM tones with pitch bends) — e.g. a curious rising chirp, a happy trill, a worried wobble, a startled squeak, a grumpy buzz, a sigh — cued to their expressions.',
      '- Foley: motion has sound — servo whirs, footsteps or wheel crunch, cloth or spring creaks, clicks — matched to the moves that cause it.',
      '- Score: a light, loopable bed whose instrumentation or filter shifts with each scene or world, plus a distinct sound for the signature transition.',
      '- Silence is a beat: cut all audio for a freeze, a reveal, or a punchline, then bring the room tone back.',
    ].join('\n');
  }
  return 'The animation is silent — no audio.';
}

// The character bible turned into rigging instructions. A studio short lives or
// dies on its lead reading as the same character in every frame and every
// style, so the model builds the character once, as a parameterized rig, and
// animates that rig rather than redrawing a figure per shot.
function castSection(cast) {
  return `CHARACTERS — the design bible (non-negotiable; every frame must stay on-model):
${trimTo(cast, CODE_ANIMATION_LIMITS.castMax)}

Build each lead ONCE as a cutout rig (2D, or its equivalent in your renderer) before animating anything:
- A part hierarchy with pivots (root → body → head → face; limbs as segmented chains; appendages like antennae, tails, ears, or scarves as their own joints), drawn from functions that take pose parameters.
- A procedural face: eyes, lids, pupils, brows, and mouth driven by parameters (size, lid cuts, pupil position, highlight, squash/stretch, special shapes such as hearts, stars, spirals, flat lines). Implement every named expression as a parameter preset and blend between presets; blink in 3–4 frames.
- Secondary motion on damped springs — appendages, hair, cloth, suspension, head lag when the body accelerates or brakes — so nothing moves rigidly.
- Reusable cycles (move, idle breathing with blinks and twitches, react) and turnaround views for turns.
- A style/skin parameter (line weight, fill, texture, shading, outline boil) that restyles the rig without changing its geometry, so the character stays recognizable when the world changes style.
- Locomotion that is physically honest: wheels rotate by distance traveled, feet plant without sliding, stops land with weight.`;
}

// The pacing bar both halves hold a film to — the brief writer plans to it and
// the coding model stages to it — stated once so the two can't drift apart.
export const PACING_RULE = 'open cold, mid-action, and hook within two seconds; give the audience a new visual payoff every 3–5 seconds; vary each repeated device (direction, noise seed, timing) so it never feels copy-pasted';

// The craft bar. A one-shot HTML file can't run a multi-session render-and-
// review loop, so the loop is folded into how the model structures the code
// and what it checks before answering.
const DIRECTION = `DIRECTION — make it feel like a studio short, not a tech demo:
- Structure the code like a production: a shot/beat timeline (an array of { start, end, … } entries at the brief's timestamps; where it gives none, time the beats yourself: establish → develop → climax → resolve), a virtual camera (position, zoom, rotation, seeded handheld micro-shake, shake impulses, tilts, dolly moves, with shot scale varied between beats), a scene/world layer system shared by every shot, the character rigs, the transitions, and a final finish pass.
- Depth and scale (unless the art style is deliberately flat): at least four parallax layers per scene with atmospheric perspective (haze and desaturation with distance), a shallow-focus feel (blurred foreground elements), and a camera height chosen to sell the characters' scale.
- Lighting: key, fill, and rim on the characters (gradient overlays and multiplied shadow layers in 2D, shader terms in WebGL); glowing elements cast light on nearby surfaces. Finish the whole frame with a pass that suits the style (e.g. subtle grain and a gentle vignette).
- Motion with mass: drive moves with closed-form damped springs — a pure function of the time since the move started, e.g. 1 - exp(-ζω₀t)·(cos(ω_d t) + (ζω₀/ω_d)·sin(ω_d t)) — not fixed easing curves. When a value retargets several times, sum one spring per change (each starting at its own time) instead of restarting, so motion never pops and any frame can be drawn without simulating the ones before it. Tiny overshoot on UI and props, none on big type.
- Avoid the tells of generic AI video: a centered title on a gradient, everything fading in, corner labels or frame borders, glow on interface chrome, and generic particle bursts.
- Performance: anticipation, squash and stretch, overlap, easing, and deliberate holds — a held reaction (a one-second deadpan, a freeze) is what lets a gag land. Emotion reads through the eyes, posture, and signature appendage, never through captions.
- Pacing: ${PACING_RULE}.
- Readability: compose on thirds, and keep faces, eyes, and any text legible at phone size (about 360px wide); typed on-screen text types at a human rhythm with small pauses.
- Endings: the player loops the film — when the brief ends by returning to its opening, match the final frame's framing, lighting, and motion to t=0 so the cut back feels intentional.`;

// The critique pass the reference workflow runs on rendered stills, as a
// pre-answer check against the failures one-shot animation code shows most.
const SELF_REVIEW = `SELF-REVIEW before you answer: step through renderFrame at every beat's key frame in your head and score it honestly on character on-model, emotion readable from the face and body alone, story clear without sound, composition, depth, scale, lighting, and phone-size readability. Fix anything that would score below 8/10. Hunt especially for: stiff or dead secondary motion, sliding feet or wheels, faces that look like stickers, missing weight on stops and landings, identical-looking transitions, text overlapping during swaps, centered-on-gradient shots, muddy or unreadable text, off-model proportions, empty or static stretches, and beats the brief asked for that never made it on screen.`;

function runtimeContract({ width, height, fps, durationSeconds, interactive, hasAudio }) {
  const m = CODE_ANIMATION_MESSAGES;
  const audioTrack = hasAudio
    ? ' Mix the audio in: route the audio graph into a MediaStreamAudioDestinationNode and add its track to the recorded stream.'
    : '';
  const interaction = interactive
    ? '\n8. Interactivity: pointer movement/clicks and a few keys should perturb the scene in-style (e.g. attract particles, shift light, trigger an accent). Interaction is a live layer on top of the timeline — `renderFrame(t)` with no interaction must still reproduce the authored film exactly, and recording always uses that clean path.'
    : '';
  return `RUNTIME CONTRACT (required — the PortOS preview host depends on every item):
1. One <canvas> with an internal resolution of exactly ${width}×${height}px, CSS-scaled to fit the viewport with letterboxing on a black background. Every visible pixel of the film is drawn onto this canvas.
2. \`window.ANIMATION_META = { title, duration: ${durationSeconds}, fps: ${fps}, width: ${width}, height: ${height} }\`.
3. \`window.renderFrame(t)\` draws the frame at time t (seconds, 0 ≤ t ≤ ${durationSeconds}) DETERMINISTICALLY: use a seeded PRNG, never Math.random/Date.now/performance.now inside drawing, and derive all motion from t (audio-reactive values from the precomputed song data, never only from live playback). Scrubbing to the same t twice must look the same. PortOS exports the film frame-exactly by calling renderFrame(t) once per frame with its own clock, so renderFrame must fully draw frame t on its own, even when called out of order or slower than real time.
4. A requestAnimationFrame loop advances a clock and calls renderFrame(clock). The film loops back to 0 at the end unless it is recording.
5. A minimal controls overlay OUTSIDE the canvas (so it never appears in a recording): play/pause, restart, a scrub bar with the current time, and a Record button. Autoplay on load when the browser allows it; otherwise show a clear play prompt.
6. \`window.recordAnimation()\` returns a Promise<Blob>: restart at t=0, capture \`canvas.captureStream(${fps})\` with MediaRecorder (prefer "video/webm;codecs=vp9", fall back to "video/webm"), play exactly ${durationSeconds}s, stop, and resolve the Blob.${audioTrack} The Record button calls it; when embedded (window.parent !== window) it posts the result to the host exactly as item 7 does, otherwise it downloads the result as a .webm file.
7. postMessage handshake with the embedding host (always target "*"):
   - once ready: \`parent.postMessage({ type: '${m.ready}', meta: window.ANIMATION_META }, '*')\`
   - listen for \`{ type: '${m.record}' }\` → run recordAnimation(); while recording post \`{ type: '${m.progress}', t }\` about once per second; on success post \`{ type: '${m.recorded}', blob, mimeType }\`; on failure post \`{ type: '${m.error}', message }\`.${interaction}
${interactive ? '9' : '8'}. Self-contained: no external scripts, stylesheets, fonts, images, or network requests of any kind; system fonts only. It must run from a sandboxed iframe (scripts allowed, no same-origin) and as a local file.
${interactive ? '10' : '9'}. Hold ${fps}fps: pre-render static layers and textures to offscreen canvases once, reuse typed arrays, and avoid per-frame allocation.`;
}

/**
 * Build the Code Animation prompt.
 *
 * @param {object} input
 * @param {string} [input.title]
 * @param {string} input.concept - what happens in the film (required upstream)
 * @param {string} [input.cast] - the character design bible the rig is built from
 * @param {string} [input.onScreenText] - titles, captions, narration beats
 * @param {string} [input.styleNotes] - refinements on top of the universe style
 * @param {string|null} [input.styleGrammarId] - film style grammar id (#10253); unknown ids throw a 400
 * @param {{ durationSeconds: number, aspectRatio: string, resolution: string, fps: number }} input.format
 * @param {'auto'|'canvas2d'|'webgl'|'svg'} [input.renderer]
 * @param {boolean} [input.interactive]
 * @param {'none'|'procedural'} [input.soundtrack]
 * @param {{ name: string, durationSeconds?: number|null, notes?: string }|null} [input.audio]
 * @param {object|null} [input.universe] - `{ name, embrace, avoid, styleNotes, styleReferences }`
 * @param {object|null} [input.moodBoard] - `collectBoardStyleContext` output
 * @param {Array<{ label: string, origin: 'upload'|'universe'|'mood-board', note?: string, path?: string }>} [input.referenceImages]
 * @param {'copy'|'api'|'cli'} [input.delivery] - how reference images reach the model
 * @returns {string}
 */
export function buildCodeAnimationPrompt({
  title = '',
  concept,
  cast = '',
  onScreenText = '',
  styleNotes = '',
  styleGrammarId = null,
  format,
  renderer = 'auto',
  interactive = false,
  soundtrack = 'none',
  audio = null,
  universe = null,
  moodBoard = null,
  referenceImages = [],
  delivery = 'copy',
}) {
  const { width, height } = resolveFrameSize(format.aspectRatio, format.resolution);
  const { durationSeconds, fps } = format;
  const sections = [
    `You are the director, animator, rigger, compositor, sound designer, and render engineer of a ${durationSeconds}-second animated short made entirely in code. Write ONE complete, self-contained HTML file that renders it — no image, video, font, or library assets. Every shape, texture, character, and effect is drawn procedurally in the browser, in the art style below. The bar: it looks like a real studio short that people share, not a tech demo.`,
    `BRIEF${isNonBlankStr(title) ? ` — "${trimTo(title, 200)}"` : ''}:\n${trimTo(concept, CODE_ANIMATION_LIMITS.conceptMax)}`,
  ];
  if (isNonBlankStr(cast)) sections.push(castSection(cast));
  if (isNonBlankStr(onScreenText)) {
    sections.push(`ON-SCREEN TEXT / NARRATION BEATS (render typography procedurally, timed to the story; system fonts only):\n${trimTo(onScreenText, CODE_ANIMATION_LIMITS.textMax)}`);
  }
  sections.push(`ART DIRECTION:\n${artDirectionSection({ universe, styleNotes, styleGrammarId, hasMoodBoard: !!moodBoard })}`);
  const boardText = moodBoardSection(moodBoard);
  if (boardText) sections.push(boardText);
  const imagesText = referenceImagesSection(referenceImages, delivery);
  if (imagesText) sections.push(imagesText);
  sections.push(`SOUND:\n${audioSection({ audio, soundtrack, durationSeconds })}`);
  sections.push(`FORMAT: ${format.aspectRatio} at ${width}×${height}px, ${fps}fps, ${durationSeconds}s. ${RENDERER_GUIDANCE[renderer] || RENDERER_GUIDANCE.auto}`);
  sections.push(DIRECTION);
  sections.push(runtimeContract({ width, height, fps, durationSeconds, interactive, hasAudio: !!audio || soundtrack === 'procedural' }));
  sections.push(SELF_REVIEW);
  sections.push(`OUTPUT: Return ONLY the finished HTML document in a single \`\`\`html fenced code block, starting with <!DOCTYPE html>. No explanation before or after it.${delivery === 'cli' ? ' Do not create or edit any files — print the document as your final answer.' : ''}`);
  return sections.join('\n\n');
}

/**
 * Pull the HTML document out of a model response: a ```html fence first, then
 * any fence holding a document, then a bare `<!DOCTYPE html>…</html>` / `<html…>`
 * span. Returns null when the response holds no HTML document.
 */
export function extractAnimationHtml(text) {
  if (!isNonBlankStr(text)) return null;
  const looksLikeDocument = (value) => /<html[\s>]/i.test(value) || /<!doctype html/i.test(value);
  const fences = [...text.matchAll(/```([a-z]*)[^\n]*\n([\s\S]*?)```/gi)];
  const htmlFence = fences.find(([, lang, body]) => lang.toLowerCase() === 'html' && looksLikeDocument(body))
    || fences.find(([, , body]) => looksLikeDocument(body));
  if (htmlFence) return htmlFence[2].trim();
  const start = text.search(/<!doctype html|<html[\s>]/i);
  if (start === -1) return null;
  const endMatch = text.slice(start).match(/<\/html>/i);
  const end = endMatch ? start + endMatch.index + endMatch[0].length : text.length;
  return text.slice(start, end).trim();
}

const CODE_VIDEO_RULES = `RUNTIME CONTRACT (the host already supplies this — write only the section functions):
- globalThis.portosComposition.seek(t) covers the whole song. The page reads the inlined song.json document (the same JSON written beside index.html). You do not fetch it.
- One function per section id: \`function render(ctx, env) { ... }\`. env is { t, localT, frame, width, height, song, palette, section, safe, karaoke }.
- Use the shared palette (env.palette) and the safe rect (env.safe, 10% inset). Do not draw lyric text — the host paints karaoke after your function, inside the title-safe area, so every active line stays readable.
- Karaoke, enforced by the host: a word may brighten at most 0.4s before its startSec, and the highlight never begins before startSec.
- Determinism: no Math.random, Date.now, performance.now, getRandomValues, fetch, WebSocket, XMLHttpRequest, import, or require. Per-frame jitter must use env.frame (the integer frame index), never continuous env.t, so motion-blur sub-frames stay coherent.
- Canvas 2D only. No external assets, fonts, or network.`;

// Share the studio craft bar with section authors without asking them to own
// playback, redraw the lyric pass, or invent analyzed musical events.
const MUSIC_VIDEO_DIRECTION = DIRECTION
  .replace("where it gives none, time the beats yourself: establish → develop → climax → resolve", "use the supplied section, beat, downbeat and lyric-word times; choose authored action spans within them without inventing analyzed events")
  .replace("- Endings: the player loops the film — when the brief ends by returning to its opening, match the final frame's framing, lighting, and motion to t=0 so the cut back feels intentional.", "- Endings: resolve the authored action at the supplied song ending; match the opening only when the approved brief requests a loop.");
const MUSIC_VIDEO_SELF_REVIEW = SELF_REVIEW
  .replace("step through renderFrame at every beat's key frame", 'step through render(ctx, env) on the host timeline at every supplied anchor and action key frame')
  .replace('empty or static stretches', 'unmotivated empty or static stretches');
const MUSIC_VIDEO_CHOREOGRAPHY = `MUSICAL CHOREOGRAPHY — author a timed performance, not a looping backdrop:
- Follow the reviewed energy target and give each section a time-based action plan: what the subject does, how props respond, how the camera stages or reveals it, and how permitted non-lyric typography supports it. Use env.t/localT with explicit anticipation, action, follow-through and settling spans. Preserve the host's lyric pass as the authority: never redraw lyric words or event labels; stage the world around their readable space.
- Ground meaningful actions and reveals in the supplied beats, downbeats and timed lyric words (startSec/endSec). Use supplied band onsets for actual accents; never invent a kick, snare, drop, word timing or missing event. If only a line timing exists, treat it as a line anchor, not separate invented word timings.
- When song.features is present, envelopes.rms/low/mid/high are normalized 0..1 energy channels on envelopes.fps; runtime sample i is at i/fps seconds. Use those measured channels to shape bounded subject/prop amplitude, camera intensity and permitted typography emphasis. The prompt snapshot may evenly sample envelopes: sample k is at k*sampleStride/fps, while runtime env.song keeps the original grid. Listed onsets are measured times, not envelope peaks inferred by the author. Respect truncatedAtSec and do not extend missing measurements.
- When song.features is null, audio feature data is unavailable: use only supplied beat/lyric/section anchors and explicitly authored motion, with no claimed spectral or instrumental reaction. Feature names alone are not measurements. Missing anchors stay missing; never fabricate analyzer results.
- Repeated choruses keep a recognizable motif but escalate or deliberately change subject action, prop interaction, staging, camera reveal or scale. Vary the narrative consequence, not merely the particle color or animation seed.
- The 3–5 second visual-payoff pacing rule does not require rapid cuts or constant motion. A change of expression, a prop consequence, a reveal or intentional stillness can carry the beat. Hold for tenderness, anticipation or silence when the music and approved direction call for it; make each hold purposeful, with a legible entry and release. Reactive accents must respect env.reactiveGain when supplied and never defeat a host silence hold.`;

function promptFeatures(features) {
  if (!features?.envelopes || !features?.onsets) return null;
  const channels = ['rms', 'low', 'mid', 'high'];
  const stride = Math.max(1, Math.ceil(Math.max(...channels.map(key => features.envelopes[key]?.length || 0)) / 240));
  return {
    envelopes: { fps: features.envelopes.fps, sampleStride: stride,
      ...Object.fromEntries(channels.map(key => [key, (features.envelopes[key] || []).filter((_, index) => index % stride === 0).slice(0, 240)])),
    },
    onsets: Object.fromEntries(['low', 'mid', 'high'].map(key => [key, (features.onsets[key] || []).slice(0, 200)])),
    onsetTimesTruncated: ['low', 'mid', 'high'].some(key => features.onsets[key]?.length > 200),
    truncatedAtSec: features.truncatedAtSec ?? null,
  };
}

function promptSong(song) {
  return {
    durationSec: song.durationSec,
    fps: song.fps,
    sections: song.sections,
    lyrics: (song.lyrics || []).slice(0, 400),
    beats: (song.beats || []).slice(0, 400),
    downbeats: (song.downbeats || []).slice(0, 200),
    featureNames: (song.featureNames || []).slice(0, 40),
    features: promptFeatures(song.features),
    narrativeEvents: song.narrativeEvents || [],
    reactiveSections: song.reactiveSections || [],
  };
}

/**
 * Music-video variant of the code-animation contract (#9076). Asks for one
 * render function per section (or just `onlySectionId` when regenerating).
 * The host assembles the page; the model does not return a full HTML document.
 */
export function buildMusicVideoCodePrompt({ title = '', palette, song, styleLines = [], onlySectionId = null, directionContext = '' }) {
  const wanted = (song.sections || []).filter((section) => !onlySectionId || section.id === onlySectionId);
  const brief = wanted.map((section) => `- ${section.id} [${section.startSec}s, ${section.endSec}s) ${section.label || ''}${section.lyric ? ` — lyric: ${section.lyric}` : ' — instrumental'}`).join('\n');
  const scope = onlySectionId
    ? `Return a function for section "${onlySectionId}" only. The host keeps every other section.`
    : 'Return one function for every section id listed.';
  return [
    `You write Canvas 2D section functions for a code-rendered music video${title ? ` titled "${trimTo(title, 200)}"` : ''}. The host seeks them against the song. No footage generation.`,
    CODE_VIDEO_RULES,
    MUSIC_VIDEO_DIRECTION,
    MUSIC_VIDEO_CHOREOGRAPHY,
    `PALETTE:\n${JSON.stringify(palette)}`,
    styleLines.length ? `STYLE SOURCE:\n${styleLines.join('\n')}` : '',
    directionContext ? `APPROVED CAST & SETS DEFINITIONS AND RULES:\n${directionContext}` : '',
    `SONG (song.json):\n${JSON.stringify(promptSong(song))}`,
    `SECTIONS:\n${brief}`,
    scope,
    MUSIC_VIDEO_SELF_REVIEW,
    'OUTPUT: Return ONLY a ```json fence of the form {"sections":[{"id":"...","source":"function render(ctx, env) { ... }"}]}. No HTML document, no explanation.',
  ].filter(Boolean).join('\n\n');
}

/** Pull `{ sections: [{ id, source }] }` out of a model response. `[]` when absent. */
export function extractCodeSections(text) {
  if (!isNonBlankStr(text)) return [];
  const fences = [...text.matchAll(/```(?:json)?[^\n]*\n([\s\S]*?)```/gi)].map((match) => match[1]);
  const candidates = fences.length ? fences : [text];
  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1));
      if (!Array.isArray(parsed?.sections)) continue;
      return parsed.sections.filter((section) => section && typeof section.id === 'string' && typeof section.source === 'string');
    } catch { /* the next fence may be the document */ }
  }
  return [];
}

/** Author only bounded drawing functions; the host owns the page and media. */
export function buildMixedMediaDocumentPrompt({ title, song, palette, treatment, visualSpec, scenes, styleLines = [], onlySectionId = null, sharedStyle = null, directionContext = '', renderer = 'canvas', mediaMode = 'code-images-video' }) {
  const sections = (song.sections || []).filter((section) => !onlySectionId || section.id === onlySectionId);
  return [
    `MEDIA POLICY: ${mediaMode}. Code always authors composition, staging, characters, camera, text, motion and timing. Never generate guide images in code-only mode.`,
    renderer === 'three' ? `Write complete authored Three.js worlds, one function render(ctx, env) per section. ctx = { THREE, scene, camera, text }; THREE is the installed locally packaged library; scene is a fresh Scene on EACH seek, camera a PerspectiveCamera, text a transparent Canvas2D overlay with local MV Mono font. Build modeled characters with articulated limbs and expressive poses, environments with depth/lighting/shadows, props, narrative action and camera choreography. Position every object analytically from env.t/localT; no simulation accumulation. Add geometry/lights to ctx.scene and set ctx.camera explicitly. Use ctx.text for designed typography. Render fills the whole frame; a particle field or text overlays alone are not a scene. Do not create a renderer, DOM elements, textures loaded from files, or another clock. env provides t, localT, frame, width, height, song, section, palette, safe, events and reactiveGain. No imports, require, fetch, Math.random, Date, performance, globalThis, window, document or external assets. The host draws aligned subtitles after your text; reserve lower title-safe space. Use reusable local functions within each section for anatomy and world construction.` : `Write original Canvas 2D section functions for a mixed-media music-video document titled ${JSON.stringify(trimTo(title, 200))}. The host owns the document, song clock, selected local media and lyric pass. Return code functions only; do not request or generate image/video assets.`,
    renderer === 'three' ? '' : CODE_VIDEO_RULES.replace('- Canvas 2D only. No external assets, fonts, or network.', '- Canvas 2D only. No network, remote URLs, filesystem paths or font loading. The host binds only the listed selected project assets; draw over footage/stills without obscuring them, and draw the entire authored world for card scenes, including characters, environments, camera staging, lighting and narrative actions. Local packaged fonts MV Mono, MV Cond and MV Stencil are available; authored titles are allowed, but do not duplicate host subtitles.'),
    MUSIC_VIDEO_DIRECTION,
    MUSIC_VIDEO_CHOREOGRAPHY,
    renderer === 'three' ? 'The authored Three.js world receives no selected-media handles; all visual staging uses geometry and the host text overlay.' : 'env additionally has mediaKind (video, image or null) and visualLayer (footage, still or card). The host has already drawn the selected media at its in/out time. Do not read DOM or load assets in a section function. Use seeded arithmetic from env.frame for visual motion. Keep repeated hooks related but deliberately vary their action.',
    'NARRATIVE CLOCK: song.narrativeEvents are resolved absolute startFrame/endFrame bindings. env.events supplies active events with progress and counter value; env.reactiveGain is bounded by the section gain/maxGain and is zero during silence. The host freezes song time, media and graphics for silence, and draws exact event text/counters/motif labels after your function. Use the narrativeFunction, motif and mediumRationale to motivate your graphic actions; do not duplicate event text or infer new onsets. Prefer code/stills/selected media for exact text and graphics. Footage is for actions that need it and must already be selected.',
    `SHARED STYLE CONTRACT:\n${JSON.stringify(sharedStyle || { palette, treatment: { brief: treatment?.brief || null, motifs: treatment?.arc?.motifs || [], styleLook: treatment?.styleLook || null }, visualSpec, styleLines })}`,
    directionContext ? `APPROVED CAST & SETS DEFINITIONS AND RULES:\n${directionContext}` : '',
    `SONG AND LYRIC TIMING:\n${JSON.stringify(promptSong(song))}`,
    `APPROVED SCENE ASSIGNMENTS AND LOCAL ASSET IDS:\n${JSON.stringify(scenes)}`,
    `SECTIONS TO AUTHOR:\n${JSON.stringify(sections)}`,
    onlySectionId ? `Revise only section ${JSON.stringify(onlySectionId)}. Preserve the shared style contract and other sections.` : 'Return one function for each listed section id. Describe a specific visual action for each scene and a distinct entry/exit transition in its function.',
    MUSIC_VIDEO_SELF_REVIEW,
    'OUTPUT: Return ONLY a ```json fence of the form {"sections":[{"id":"...","source":"function render(ctx, env) { ... }"}]}. No HTML, no assets, no explanation.',
  ].filter(Boolean).join('\n\n');
}
