/**
 * Music Video — load a project's audio→MIDI transcription (`project.midiTranscription`)
 * as the prompt-ready digest the planner and Cast & Sets direction quote
 * (lib/musicVideo/musicVideoMidiDigest.js).
 *
 * Transcribing is the optional step: a project without a transcription plans
 * from the beat analysis alone, exactly as before. A missing or unreadable
 * file degrades the same way and is logged, never thrown, so a bad .mid can
 * not stop a plan. Parsed digests are cached per file path, size and mtime.
 */

import { readFile, stat } from 'fs/promises';
import { PATHS } from '../../lib/fileUtils.js';
import { safeUnder } from '../../lib/ffmpeg.js';
import { parseMidiFile } from '../../lib/midiFile.js';
import { buildMidiDigest, midiSongSummary, midiWindowFacts } from '../../lib/musicVideo/musicVideoMidiDigest.js';

const cache = new Map();
const CACHE_MAX = 8;

/** The project's MIDI digest, or null when it has no usable transcription. */
export async function loadProjectMidiDigest(project) {
  const filename = project?.midiTranscription?.filename;
  if (!filename) return null;
  const path = safeUnder(PATHS.music, filename);
  const info = path ? await stat(path).catch(() => null) : null;
  if (!info?.isFile()) {
    console.log(`🎹 Music Video ${project.id}: MIDI transcription ${filename} is missing, planning without it`);
    return null;
  }
  const key = `${path}:${info.size}:${info.mtimeMs}`;
  if (cache.has(key)) return cache.get(key);
  let digest = null;
  try {
    digest = buildMidiDigest(parseMidiFile(await readFile(path)));
  } catch (err) {
    console.warn(`⚠️ Music Video ${project.id}: MIDI transcription ${filename} is unreadable (${err.message}), planning without it`);
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, digest);
  return digest;
}

/**
 * What planning reads from the transcription, as shown on the Track panel:
 * the song line plus one line per analyzed section. Null without a digest.
 */
export async function projectMidiPlanningFacts(project) {
  const digest = await loadProjectMidiDigest(project);
  if (!digest) return null;
  const sections = (project.audioAnalysis?.sections || []).filter((s) => Number.isFinite(s?.startSec) && s.endSec > s.startSec);
  return {
    summary: midiSongSummary(digest),
    sections: sections.map((s, index) => ({ index, label: s.label || `Section ${index + 1}`, startSec: s.startSec, endSec: s.endSec, facts: midiWindowFacts(digest, s.startSec, s.endSec) })),
  };
}
