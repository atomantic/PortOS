/**
 * Section windows for a code-rendered music video (#9076).
 *
 * The windows come from the treatment arc, otherwise the analyzed sections,
 * otherwise the scenes, otherwise one window for the whole song. The picture
 * starts at song time 0 — the same timebase as a footage render. Each later
 * boundary snaps to the beat at or before the first word of that section's
 * first lyric line, or to the nearest downbeat when the section has no lyric.
 * Word timings are used when a line carries them (`w` from alignment, or
 * `text` on an already-normalized cue); otherwise the line start is the only cue.
 */

import { CODE_FPS } from './codeFrame.js';

const round3 = (n) => Math.round(n * 1000) / 1000;

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function beatGrid(values) {
  return (Array.isArray(values) ? values : []).filter((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
}

function beatAtOrBefore(beats, t) {
  let best = null;
  for (const beat of beats) {
    if (beat > t + 1e-6) break;
    best = beat;
  }
  return best;
}

function nearest(points, t) {
  let best = null;
  let bestDist = Infinity;
  for (const point of points) {
    const dist = Math.abs(point - t);
    if (dist < bestDist - 1e-9) { best = point; bestDist = dist; }
  }
  return best;
}

function songDuration(project) {
  const analysis = project.audioAnalysis || {};
  const ends = [finite(analysis.durationSec)];
  for (const section of analysis.sections || []) ends.push(finite(section?.endSec));
  for (const beat of project.treatment?.arc?.beats || []) ends.push(finite(beat?.endSec));
  for (const scene of project.scenes || []) ends.push(finite(scene?.endSec));
  for (const cue of project.lyricCues || []) ends.push(finite(cue?.endSec), finite(cue?.startSec));
  for (const beat of beatGrid(analysis.beats)) ends.push(beat);
  const duration = ends.reduce((max, value) => (value != null ? Math.max(max, value) : max), 0);
  return duration > 0 ? duration : 0;
}

function windowsFrom(items, idOf, labelOf) {
  return (Array.isArray(items) ? items : [])
    .map((item, index) => {
      const startSec = finite(item?.startSec);
      const endSec = finite(item?.endSec);
      if (startSec == null || endSec == null || endSec <= startSec) return null;
      return {
        id: idOf(item, index),
        label: labelOf(item, index),
        sceneId: item.sceneId || null,
        startSec,
        endSec,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.startSec - b.startSec);
}

function nominalWindows(project, duration) {
  const treatment = windowsFrom(
    project.treatment?.arc?.beats,
    (beat, index) => (typeof beat.id === 'string' && beat.id ? beat.id : `beat-${index}`),
    (beat, index) => beat.label || beat.role || `Section ${index + 1}`,
  );
  if (treatment.length) return treatment;
  const analyzed = windowsFrom(
    project.audioAnalysis?.sections,
    (section, index) => (typeof section.id === 'string' && section.id ? section.id : `analysis-${index}`),
    (section, index) => section.label || `Section ${index + 1}`,
  );
  if (analyzed.length) return analyzed;
  const scenes = windowsFrom(
    project.scenes,
    (scene, index) => scene.sceneId || `scene-${index}`,
    (scene, index) => scene.label || scene.sectionLabel || `Scene ${index + 1}`,
  );
  if (scenes.length) return scenes.map((scene) => ({ ...scene, sceneId: scene.id }));
  if (duration > 0) return [{ id: 'song', label: 'Song', sceneId: null, startSec: 0, endSec: duration }];
  return [];
}

function lyricLines(project) {
  return (project.lyricCues || [])
    .filter((cue) => cue && typeof cue.text === 'string' && cue.text.trim() && finite(cue.startSec) != null)
    .map((cue) => ({ ...cue, text: cue.text.trim() }))
    .sort((a, b) => a.startSec - b.startSec);
}

function wordLabel(word) {
  if (typeof word?.text === 'string' && word.text.trim()) return word.text.trim();
  if (typeof word?.w === 'string' && word.w.trim()) return word.w.trim();
  return null;
}

function wordsOf(line) {
  const words = Array.isArray(line.words) ? line.words.flatMap((word) => {
    const text = wordLabel(word);
    const startSec = finite(word?.startSec);
    if (!text || startSec == null) return [];
    const endSec = finite(word.endSec) != null && word.endSec > startSec ? word.endSec : null;
    return [{ text, startSec, endSec }];
  }) : [];
  if (words.length) return words;
  const startSec = line.startSec;
  const endSec = finite(line.endSec) != null && line.endSec > startSec ? line.endSec : null;
  return [{ text: line.text, startSec, endSec }];
}

function firstLyric(lines, window) {
  return lines.find((line) => line.startSec >= window.startSec - 1e-6 && line.startSec < window.endSec - 1e-6) || null;
}

function anchorOf(line) {
  const words = wordsOf(line);
  return words[0]?.startSec ?? line.startSec;
}

/**
 * Quantize a span up to a whole frame so the encoded file covers it and
 * `duration × fps` is a whole number of frames (the composition encoder's
 * contract). The extra time is strictly under one frame.
 */
export function quantizeSongDuration(durationSec, fps = CODE_FPS) {
  if (!(durationSec > 0) || !Number.isFinite(durationSec)) return { frames: 0, durationSec: 0, fps };
  const frames = Math.max(1, Math.ceil(durationSec * fps - 1e-9));
  let seconds = frames / fps;
  if (Math.round(seconds * fps) !== frames) seconds = (frames - 0.5) / fps + 1 / fps;
  return { frames, durationSec: frames / fps, fps };
}

export function paletteFromProject(project) {
  const colors = (project.visualSpec?.palette || [])
    .filter((color) => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color))
    .map((color) => color.toLowerCase());
  return {
    background: colors[0] || '#12141c',
    ink: colors[1] || '#f4f1ea',
    accent: colors[2] || '#e0a458',
    mute: colors[3] || '#8a8f98',
    font: project.composition?.style?.font || 'sans',
    colors,
  };
}

export const CODE_FRAME_SIZES = Object.freeze({
  '16:9': Object.freeze({ width: 1280, height: 720 }),
  '9:16': Object.freeze({ width: 1080, height: 1920 }),
  '1:1': Object.freeze({ width: 1080, height: 1080 }),
});

export function codeFrameSize(aspectRatio) {
  return CODE_FRAME_SIZES[aspectRatio] || CODE_FRAME_SIZES['16:9'];
}

/**
 * Section windows on the song timebase. Interior boundaries are beat times.
 * The first section starts at 0 and the last ends at the song duration.
 */
export function buildCodeTimeline(project, { fps = CODE_FPS } = {}) {
  const duration = songDuration(project);
  const beats = beatGrid(project.audioAnalysis?.beats);
  const downbeats = beatGrid(project.audioAnalysis?.downbeats);
  const lines = lyricLines(project);
  const windows = nominalWindows(project, duration);
  const snapped = windows.map((window) => {
    const lyric = firstLyric(lines, window);
    if (lyric) {
      const anchor = anchorOf(lyric);
      const beat = beatAtOrBefore(beats, anchor);
      return { ...window, snap: beat ?? anchor, snapKind: beat == null ? 'lyric' : 'beat', lyricId: lyric.id || null };
    }
    const down = nearest(downbeats, window.startSec);
    if (down != null) return { ...window, snap: down, snapKind: 'downbeat', lyricId: null };
    const beat = nearest(beats, window.startSec);
    return { ...window, snap: beat ?? window.startSec, snapKind: beat == null ? 'nominal' : 'beat', lyricId: null };
  }).sort((a, b) => a.snap - b.snap || a.startSec - b.startSec);

  const minSpan = 1 / fps;
  const sections = [];
  for (const window of snapped) {
    const startSec = sections.length === 0 ? 0 : window.snap;
    if (!(startSec < duration - 1e-6)) continue;
    if (sections.length && startSec < sections[sections.length - 1].startSec + minSpan - 1e-9) continue;
    sections.push({
      id: window.id,
      label: window.label,
      sceneId: window.sceneId,
      startSec: round3(startSec),
      endSec: round3(duration),
      snapKind: sections.length === 0 ? 'start' : window.snapKind,
      lyricId: window.lyricId,
    });
    if (sections.length > 1) sections[sections.length - 2].endSec = round3(startSec);
  }
  if (!sections.length && duration > 0) {
    sections.push({ id: 'song', label: 'Song', sceneId: null, startSec: 0, endSec: round3(duration), snapKind: 'start', lyricId: null });
  }
  return { durationSec: round3(duration), fps, sections, beats, downbeats };
}

/** The song.json document the composition seeks. Words fall back to the line. */
export function buildSongDocument(project, timeline = buildCodeTimeline(project)) {
  const quantized = quantizeSongDuration(timeline.durationSec, timeline.fps);
  const lines = lyricLines(project).map((line) => ({
    id: typeof line.id === 'string' ? line.id : null,
    text: line.text,
    startSec: line.startSec,
    endSec: finite(line.endSec),
    words: wordsOf(line),
  }));
  const sections = timeline.sections.map((section, index) => {
    const endSec = index === timeline.sections.length - 1 ? quantized.durationSec : section.endSec;
    const lyric = lines.find((line) => line.startSec >= section.startSec - 1e-6 && line.startSec < endSec - 1e-6) || null;
    return {
      id: section.id,
      label: section.label,
      sceneId: section.sceneId,
      startSec: section.startSec,
      endSec,
      snapKind: section.snapKind,
      lyric: lyric ? lyric.text : null,
    };
  });
  return {
    durationSec: quantized.durationSec,
    frames: quantized.frames,
    fps: timeline.fps,
    beats: timeline.beats,
    downbeats: timeline.downbeats,
    sections,
    lyrics: lines,
  };
}
