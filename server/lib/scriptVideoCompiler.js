/**
 * Pure compiler that turns a scene script into beat-level video clip specs
 * for continuous chained video generation (issue #6217's Script-to-Beats
 * Compiler slice). Each beat becomes one clip request: a duration snapped to
 * a target frame grid, and a prompt carrying byte-stable "Bible" descriptors
 * for the cast/locations/style referenced in that beat plus formatted
 * dialogue clauses.
 *
 * Byte-stability matters more than prose quality here: `server/services/
 * videoGen/chainedVideo.js` already handles low-level chunk stitching, but
 * chained video models mutate character faces/clothing/environment when a
 * descriptor is reworded between clips. This module never rewrites a
 * descriptor — it looks the same bible entry up verbatim for every beat that
 * references it.
 *
 * Deliberately does NOT decide clip framing/camera language or write the
 * "Hard cut to <framing>:" opener continuing clips need — that is authored
 * content (or an LLM step) which `videoPromptLinter.js` (#6226) then checks
 * for. This module only decides WHERE a chain must break (`cutType`).
 *
 * No I/O, no video-backend awareness — `continuousVideo.js` (#6227) composes
 * this with the linter and the backend submission.
 */

export const BEAT_MAX_WORDS = 35;
export const BEAT_MAX_SPEAKERS = 2;
export const MAX_CHAIN_LENGTH = 6;
export const WORDS_PER_SECOND = 2.5;
export const AIR_SECONDS = 1.5;
export const DEFAULT_FPS = 24;

// The MiniMax H3 family's VAE decodes only frame counts on a 17n+5 grid (see
// h3FrameGrid in mediaModels.js) — a beat targeting that runtime needs its
// duration snapped to the same grid rather than a plain per-frame ceiling.
// Duplicated rather than imported: mediaModels.js is a large registry module
// (2000+ lines, 15 imports) this compiler has no other reason to pull in for
// two constants — see the "widely-reached module" import-scoping rule in
// server/AGENTS.md.
export const H3_FRAME_STEP = 17;
export const H3_FRAME_OFFSET = 5;

const countWords = (text) => {
  const t = (text || '').trim();
  return t ? t.split(/\s+/).length : 0;
};

/** Total words across a beat's action + dialogue lines. */
export const beatWordCount = (beat) => (beat?.lines || []).reduce((sum, l) => sum + countWords(l.text), 0);

/**
 * Spoken-pace duration estimate: word count / WORDS_PER_SECOND, plus a fixed
 * AIR_SECONDS pad so a clip doesn't cut the instant the last word lands.
 */
export const estimateBeatSeconds = (beat) => (beatWordCount(beat) / WORDS_PER_SECOND) + AIR_SECONDS;

/**
 * Snap a duration to a target frame grid.
 *
 * `grid: 'uniform'` (default) just ceilings to the nearest whole frame at
 * `fps`. `grid: '17n+5'` snaps UP to the nearest H3-family frame count,
 * mirroring `h3FrameGrid` in mediaModels.js.
 *
 * Always rounds UP — a beat's dialogue must fully fit inside the rendered
 * clip, so under-snapping (truncating speech) is never acceptable while a
 * slightly longer clip is.
 */
export function snapFramesToGrid({ seconds, fps = DEFAULT_FPS, grid = 'uniform' } = {}) {
  const s = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const f = Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_FPS;
  const wantFrames = Math.max(1, Math.ceil(s * f));
  if (grid === '17n+5') {
    const n = Math.max(0, Math.ceil((wantFrames - H3_FRAME_OFFSET) / H3_FRAME_STEP));
    const frames = (n * H3_FRAME_STEP) + H3_FRAME_OFFSET;
    return { frames, seconds: frames / f, fps: f };
  }
  return { frames: wantFrames, seconds: wantFrames / f, fps: f };
}

/**
 * Explicit speaker clause: `S1 (Speaker, voice): "..."`. `index` is the
 * clip-local speaker ordinal (1-based) — callers assign it per beat, not
 * globally, so a two-speaker beat is always `S1`/`S2`.
 */
export const formatDialogueLine = ({ index, speaker, voice, text }) => (
  `S${index} (${speaker}${voice ? `, ${voice}` : ''}): "${(text || '').trim()}"`
);

/**
 * Partition script lines into beats of <= maxWords words and <= maxSpeakers
 * distinct dialogue speakers. A beat never splits a single line — a line
 * longer than maxWords on its own still becomes (and closes) its own beat,
 * so no dialogue/action text is ever truncated.
 *
 * @param {Array<{type: 'action'|'dialogue', speaker?: string, voice?: string, text: string}>} lines
 */
export function partitionLinesIntoBeats(lines, { maxWords = BEAT_MAX_WORDS, maxSpeakers = BEAT_MAX_SPEAKERS } = {}) {
  const beats = [];
  let current = null;
  let currentWordCount = 0;

  const openBeat = () => {
    current = { lines: [], speakers: [] };
    currentWordCount = 0;
    beats.push(current);
  };

  for (const line of lines || []) {
    const words = countWords(line.text);
    const speaker = line.type === 'dialogue' ? line.speaker : null;
    if (!current) openBeat();

    const nextWordCount = currentWordCount + words;
    const nextSpeakerCount = current.speakers.length + (speaker && !current.speakers.includes(speaker) ? 1 : 0);

    const wouldOverflow = current.lines.length > 0
      && (nextWordCount > maxWords || nextSpeakerCount > maxSpeakers);
    if (wouldOverflow) {
      openBeat();
      if (speaker) current.speakers.push(speaker);
    } else if (speaker && !current.speakers.includes(speaker)) {
      current.speakers.push(speaker);
    }
    current.lines.push(line);
    currentWordCount += words;
  }

  return beats;
}

/**
 * Look up a bible descriptor by kind ('cast' | 'locations') and id. Returns
 * the SAME string every time for the same id — the caller must never
 * paraphrase it — or `null` when the bible has no entry for it.
 */
export const resolveBibleDescriptor = (bible, kind, id) => bible?.[kind]?.[id]?.descriptor ?? null;

/**
 * Compose one beat's clip prompt: style descriptor, the scene's location
 * descriptor, then the byte-stable cast descriptor for every speaker in the
 * beat (deduped, first-seen order), followed by the beat's action text and
 * formatted dialogue clauses.
 */
export function buildBeatPrompt({ beat, bible, locationId }) {
  const fragments = [];
  if (bible?.styleDescriptor) fragments.push(bible.styleDescriptor);
  const locationDescriptor = locationId ? resolveBibleDescriptor(bible, 'locations', locationId) : null;
  if (locationDescriptor) fragments.push(locationDescriptor);
  for (const speaker of beat.speakers) {
    const castDescriptor = resolveBibleDescriptor(bible, 'cast', speaker);
    if (castDescriptor) fragments.push(castDescriptor);
  }

  const body = [];
  let speakerIndex = 0;
  const speakerOrdinal = new Map();
  for (const line of beat.lines) {
    if (line.type === 'dialogue') {
      if (!speakerOrdinal.has(line.speaker)) {
        speakerIndex += 1;
        speakerOrdinal.set(line.speaker, speakerIndex);
      }
      body.push(formatDialogueLine({
        index: speakerOrdinal.get(line.speaker),
        speaker: line.speaker,
        voice: line.voice,
        text: line.text,
      }));
    } else if (line.text) {
      body.push(line.text.trim());
    }
  }

  return [...fragments, ...body].filter(Boolean).join(' ');
}

/**
 * Compile a script (an array of scenes, each `{ sceneId, location, lines }`)
 * against a bible into an ordered array of clip specs.
 *
 * Chain rule: the first beat of every scene is always `cutType: 'fresh'`
 * (a scene boundary is a natural re-establish point). Within a scene, a
 * chain of `continue` clips runs until `maxChainLength` clips have been
 * emitted since the last fresh cut, at which point the next beat is forced
 * back to `fresh` and the count restarts.
 */
export function compileScriptToClips({
  scenes,
  bible,
  maxWords = BEAT_MAX_WORDS,
  maxSpeakers = BEAT_MAX_SPEAKERS,
  maxChainLength = MAX_CHAIN_LENGTH,
  fps = DEFAULT_FPS,
  frameGrid = 'uniform',
} = {}) {
  const clips = [];

  (scenes || []).forEach((scene, sceneIndex) => {
    const beats = partitionLinesIntoBeats(scene.lines, { maxWords, maxSpeakers });
    let chainPosition = 0;

    beats.forEach((beat, beatIndex) => {
      let cutType;
      if (beatIndex === 0 || chainPosition >= maxChainLength) {
        cutType = 'fresh';
        chainPosition = 1;
      } else {
        cutType = 'continue';
        chainPosition += 1;
      }

      const seconds = estimateBeatSeconds(beat);
      const { frames, seconds: snappedSeconds } = snapFramesToGrid({ seconds, fps, grid: frameGrid });
      const prompt = buildBeatPrompt({ beat, bible, locationId: scene.location });

      clips.push({
        sceneIndex,
        sceneId: scene.sceneId ?? null,
        beatIndex,
        cutType,
        chainPosition,
        speakers: [...beat.speakers],
        fps,
        frames,
        durationSeconds: snappedSeconds,
        prompt,
      });
    });
  });

  return clips;
}
