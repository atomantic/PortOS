/**
 * Code Animation prompt builder (pure).
 *
 * Code Animation asks an LLM to write ONE self-contained HTML file that draws
 * an animated film procedurally — no image/font/library assets, every frame
 * produced by code. The art style comes from the universe's style guide (its
 * curated embrace/avoid tokens, style references, and tone notes), refined by a
 * mood board's notes/captions/analyses, reference images, optional per-film
 * style notes, and an audio track.
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
  conceptMax: 6_000,
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

const bulletList = (values) => values.map((value) => `- ${value}`).join('\n');

// The art direction. The universe's style guide IS the look — the same curated
// tokens every other Create surface renders that world with — so the film
// matches the universe's stills and videos; the per-animation notes only
// refine it. The model's job is to translate that look into drawing code.
function artDirectionSection({ universe, styleNotes, hasMoodBoard }) {
  const lines = [];
  if (universe) {
    lines.push(`The art style comes from the universe "${universe.name}". Match its established look exactly — this film must sit beside the universe's other artwork as the same world.`);
    if (universe.embrace?.length) lines.push(`Visual style to embrace: ${universe.embrace.join(', ')}`);
    if (universe.avoid?.length) lines.push(`Visual style to avoid: ${universe.avoid.join(', ')}`);
    if (universe.styleReferences?.length) {
      lines.push('Style references curated for this universe:');
      lines.push(bulletList(universe.styleReferences.map((ref) => (ref.title ? `${ref.title}: ${ref.prompt}` : ref.prompt))));
    }
    if (isNonBlankStr(universe.styleNotes)) {
      lines.push(`Tone and staging notes (context for mood — do not depict entities they name unless the brief asks): ${universe.styleNotes}`);
    }
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

/** The board's style context as prompt text (`''` when there is no board). */
export function moodBoardSection(board) {
  if (!board) return '';
  const lines = [`Mood board: "${board.name || 'Untitled board'}" — distill its through-line (palette, texture, lighting, rhythm, mood), not any single item.`];
  if (isNonBlankStr(board.description)) lines.push(`Board description: ${board.description}`);
  const fragments = (board.items || []).map((item) => {
    const parts = [];
    if (item.note) parts.push(`note: ${item.note}`);
    if (item.caption) parts.push(`caption: ${item.caption}`);
    if (item.analyzedPrompt) parts.push(`visual analysis: ${item.analyzedPrompt}`);
    if (item.analyzedNegative) parts.push(`avoid: ${item.analyzedNegative}`);
    return parts.join('; ');
  }).filter(Boolean);
  if (fragments.length) lines.push(bulletList(fragments));
  if (board.droppedItems) lines.push(`(${board.droppedItems} more board items omitted for length.)`);
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
      '- While audio plays, the timeline clock IS `audio.currentTime` so picture and sound never drift. Map the analyser\'s bass / mid / treble energy and detected onsets onto motion, scale, color, and cuts so the picture visibly dances to the music.',
      `- If \`window.${CODE_ANIMATION_AUDIO_GLOBAL}\` is unset (the file was opened on its own), show a small "Load audio" file input in the controls overlay and fall back to a silent clock until a file is chosen.`,
      `- The video lasts ${durationSeconds}s; if the track is longer, fade the audio out over the final second.`,
    );
    return lines.join('\n');
  }
  if (soundtrack === 'procedural') {
    return 'No audio file was supplied. Compose a procedural soundtrack with the Web Audio API (oscillators, noise, envelopes, a simple sequencer) that matches the mood and is synchronized to the visual beats. Start it on the first user gesture (Play/Record); resume a suspended AudioContext.';
  }
  return 'The animation is silent — no audio.';
}

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
3. \`window.renderFrame(t)\` draws the frame at time t (seconds, 0 ≤ t ≤ ${durationSeconds}) DETERMINISTICALLY: use a seeded PRNG, never Math.random/Date.now/performance.now inside drawing, and derive all motion from t (plus audio analysis while audio plays). Scrubbing to the same t twice must look the same.
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
 * @param {string} [input.onScreenText] - titles, captions, narration beats
 * @param {string} [input.styleNotes] - refinements on top of the universe style
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
  onScreenText = '',
  styleNotes = '',
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
    `You are an award-winning creative coder and motion designer. Write ONE complete, self-contained HTML file that renders a ${durationSeconds}-second animated film entirely in code — no image, video, font, or library assets. Every shape, texture, character, and effect is drawn procedurally in the browser, in the art style below, with the craft of a finished title sequence rather than a tech demo.`,
    `BRIEF${isNonBlankStr(title) ? ` — "${trimTo(title, 200)}"` : ''}:\n${trimTo(concept, CODE_ANIMATION_LIMITS.conceptMax)}`,
  ];
  if (isNonBlankStr(onScreenText)) {
    sections.push(`ON-SCREEN TEXT / NARRATION BEATS (render typography procedurally, timed to the story; system fonts only):\n${trimTo(onScreenText, CODE_ANIMATION_LIMITS.textMax)}`);
  }
  sections.push(`ART DIRECTION:\n${artDirectionSection({ universe, styleNotes, hasMoodBoard: !!moodBoard })}`);
  const boardText = moodBoardSection(moodBoard);
  if (boardText) sections.push(boardText);
  const imagesText = referenceImagesSection(referenceImages, delivery);
  if (imagesText) sections.push(imagesText);
  sections.push(`SOUND:\n${audioSection({ audio, soundtrack, durationSeconds })}`);
  sections.push(`FORMAT: ${format.aspectRatio} at ${width}×${height}px, ${fps}fps, ${durationSeconds}s. ${RENDERER_GUIDANCE[renderer] || RENDERER_GUIDANCE.auto}
Plan the film as a sequence of beats with clear timestamps (establish → develop → climax → resolve) and build smooth transitions between them. Use easing curves, anticipation, overlap, and secondary motion; vary shot scale and camera movement (pan, zoom, parallax) so it feels directed.`);
  sections.push(runtimeContract({ width, height, fps, durationSeconds, interactive, hasAudio: !!audio }));
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
