/**
 * The shot manifest a Blender film's `describe(ctx)` returns: what the server
 * accepts from it, what it says about the film's coverage of the song, and the
 * synced copy in the workspace (manifest.json). The scripts are the source of
 * truth for the shot list; this is the gate between them and everything PortOS
 * does with it (Board scenes, render jobs, cut assembly).
 */
import { atomicWrite } from '../../lib/fileCore.js';
import {
  MUSIC_VIDEO_BLENDER_MAX_CHOICES, MUSIC_VIDEO_BLENDER_MAX_OPTIONS, MUSIC_VIDEO_BLENDER_MAX_SHOTS, MUSIC_VIDEO_BLENDER_OPTION_KEY,
  MUSIC_VIDEO_BLENDER_OPTION_TYPES, MUSIC_VIDEO_BLENDER_SHOT_ID, MUSIC_VIDEO_BLENDER_SOURCE_PATH, blenderOptionValueProblem,
} from '../../lib/musicVideoBlender.js';
import { blenderManifestFile, readBlenderJson } from './workspace.js';

// How far a boundary may sit from a frame boundary and still be snapped onto it.
const GRID_TOLERANCE_SEC = 1e-3;
const TEXT_FIELDS = ['summary', 'action', 'staging', 'camera', 'transition'];
const TEXT_MAX = 4000;
const MAX_DEPS = 64;
const MAX_ERRORS = 40;

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const seconds = (value) => `${Number(value.toFixed(3))} s`;
const isDict = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const shortText = (value, max) => typeof value === 'string' && value.length <= max;

// The choices of a `choice` option as `[{ value, label }]`, or null when they break the contract.
function optionChoices(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > MUSIC_VIDEO_BLENDER_MAX_CHOICES) return null;
  const choices = [];
  for (const entry of raw) {
    if (!isDict(entry) || !shortText(entry.value, 80) || !entry.value || choices.some((choice) => choice.value === entry.value)) return null;
    if (entry.label != null && !shortText(entry.label, 80)) return null;
    choices.push({ value: entry.value, label: entry.label?.trim() || entry.value });
  }
  return choices;
}

/**
 * Check the `options` a film declares. Returns the stored form
 * `[{ key, label, type, default, help?, choices?, min?, max?, step? }]`;
 * every problem goes to `fail`.
 */
function validateBlenderOptions(raw, fail) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) { fail('"options" must be a list'); return []; }
  if (raw.length > MUSIC_VIDEO_BLENDER_MAX_OPTIONS) fail(`A film can declare at most ${MUSIC_VIDEO_BLENDER_MAX_OPTIONS} options (this one declares ${raw.length})`);
  const seen = new Set();
  const options = [];
  for (const [index, entry] of raw.slice(0, MUSIC_VIDEO_BLENDER_MAX_OPTIONS).entries()) {
    const name = typeof entry?.key === 'string' && entry.key ? `Option ${entry.key}` : `Option ${index + 1}`;
    if (!isDict(entry)) { fail(`${name} must be a dict`); continue; }
    if (typeof entry.key !== 'string' || !MUSIC_VIDEO_BLENDER_OPTION_KEY.test(entry.key)) {
      fail(`${name}: "key" must be 1-40 letters, digits, "_" or "-", starting with a letter or digit`);
      continue;
    }
    if (seen.has(entry.key.toLowerCase())) { fail(`${name}: the key is used twice`); continue; }
    seen.add(entry.key.toLowerCase());
    if (!MUSIC_VIDEO_BLENDER_OPTION_TYPES.includes(entry.type)) {
      fail(`${name}: "type" must be one of ${MUSIC_VIDEO_BLENDER_OPTION_TYPES.join(', ')}`);
      continue;
    }
    const option = { key: entry.key, label: entry.key, type: entry.type };
    let valid = true;
    const refuse = (message) => { valid = false; fail(`${name}: ${message}`); };
    for (const [key, max] of [['label', 80], ['help', 400]]) {
      if (entry[key] == null) continue;
      if (!shortText(entry[key], max)) refuse(`"${key}" must be text of at most ${max} characters`);
      else if (entry[key].trim()) option[key] = entry[key].trim();
    }
    if (entry.type === 'choice') {
      option.choices = optionChoices(entry.choices);
      if (!option.choices) refuse(`"choices" must list 1-${MUSIC_VIDEO_BLENDER_MAX_CHOICES} dicts with a unique text "value" (and an optional "label")`);
    }
    if (entry.type === 'number') {
      for (const key of ['min', 'max', 'step']) {
        if (entry[key] == null) continue;
        if (!isNumber(entry[key])) refuse(`"${key}" must be a number`);
        else option[key] = entry[key];
      }
      if (isNumber(option.min) && isNumber(option.max) && option.min > option.max) refuse('"min" must not be above "max"');
      if (isNumber(option.step) && option.step <= 0) refuse('"step" must be above 0');
    }
    if (!valid) continue;
    const problem = entry.default === undefined ? 'is required' : blenderOptionValueProblem(option, entry.default);
    if (problem) { fail(`${name}: "default" ${problem}`); continue; }
    options.push({ ...option, default: entry.default });
  }
  return options;
}

/**
 * Check a raw `describe` result against the film contract. Returns
 * `{ manifest, errors }`: `manifest` is `{ title, shots }` with every boundary
 * snapped onto the frame grid when `errors` is empty, else null.
 */
export function validateBlenderManifest(raw, { durationSec, fps }) {
  const errors = [];
  const fail = (message) => { if (errors.length < MAX_ERRORS) errors.push(message); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.shots)) {
    return { manifest: null, errors: ['describe(ctx) must return a dict with a "shots" list'] };
  }
  if (raw.title != null && typeof raw.title !== 'string') fail('"title" must be a string');
  const options = validateBlenderOptions(raw.options, fail);
  if (!raw.shots.length) fail('The film lists no shots');
  if (raw.shots.length > MUSIC_VIDEO_BLENDER_MAX_SHOTS) fail(`A film can list at most ${MUSIC_VIDEO_BLENDER_MAX_SHOTS} shots (this one lists ${raw.shots.length})`);

  // A song rarely ends on a frame boundary. The last shot may run to the boundary just after it,
  // so the picture covers the whole song instead of ending a fraction of a frame early.
  const songEnd = Math.ceil(durationSec * fps - 1e-9) / fps;
  const seen = new Set();
  const shots = [];
  let previous = null;
  for (const [index, entry] of raw.shots.slice(0, MUSIC_VIDEO_BLENDER_MAX_SHOTS).entries()) {
    const name = typeof entry?.id === 'string' && entry.id ? `Shot ${entry.id}` : `Shot ${index + 1}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { fail(`${name} must be a dict`); continue; }
    if (typeof entry.id !== 'string' || !MUSIC_VIDEO_BLENDER_SHOT_ID.test(entry.id)) {
      fail(`${name}: "id" must be 1-40 letters, digits, "_" or "-", starting with a letter or digit`);
      continue;
    }
    // Shot ids name folders; a case-insensitive disk would merge "S010" and "s010".
    if (seen.has(entry.id.toLowerCase())) { fail(`${name}: the id is used twice`); continue; }
    seen.add(entry.id.toLowerCase());
    if (!isNumber(entry.start) || !isNumber(entry.end)) { fail(`${name}: "start" and "end" must be numbers (seconds on the song)`); continue; }
    const snap = (value) => Math.round(value * fps) / fps;
    const offGrid = ['start', 'end'].filter((key) => Math.abs(snap(entry[key]) - entry[key]) > GRID_TOLERANCE_SEC);
    if (offGrid.length) { fail(`${name}: ${offGrid.join(' and ')} must fall on a frame boundary (a multiple of 1/${fps} s)`); continue; }
    const start = Number(snap(entry.start).toFixed(6));
    const end = Number(snap(entry.end).toFixed(6));
    if (start < 0 || end <= start) { fail(`${name}: needs 0 <= start < end (got ${seconds(start)} to ${seconds(end)})`); continue; }
    if (end > songEnd + 1e-6) { fail(`${name}: ends at ${seconds(end)}, after the song ends (${seconds(durationSec)})`); continue; }
    if (previous && start < previous.end - 1e-9) {
      fail(`${name}: starts at ${seconds(start)}, before shot ${previous.id} ends (${seconds(previous.end)}); shots are listed in time order and never overlap`);
      continue;
    }
    const shot = { id: entry.id, label: entry.id, start, end };
    for (const [key, max] of [['label', 120], ['set', 120], ...TEXT_FIELDS.map((field) => [field, TEXT_MAX])]) {
      if (entry[key] == null) continue;
      if (typeof entry[key] !== 'string' || entry[key].length > max) { fail(`${name}: "${key}" must be text of at most ${max} characters`); continue; }
      if (entry[key].trim()) shot[key] = entry[key].trim();
    }
    if (entry.deps != null) {
      const valid = Array.isArray(entry.deps) && entry.deps.length <= MAX_DEPS
        && entry.deps.every((dep) => typeof dep === 'string' && MUSIC_VIDEO_BLENDER_SOURCE_PATH.test(dep));
      if (!valid) fail(`${name}: "deps" must list at most ${MAX_DEPS} files or folders relative to src/`);
      else if (entry.deps.length) shot.deps = [...new Set(entry.deps)];
    }
    shots.push(shot);
    previous = shot;
  }
  if (errors.length) return { manifest: null, errors };
  return { manifest: { title: typeof raw.title === 'string' ? raw.title.trim().slice(0, 200) : '', shots, options }, errors };
}

// Where the shots leave song frames uncovered, or extend past the current song.
function coverageProblems(shots, { durationSec, fps }) {
  if (!shots.length) return ['The film lists no shots.'];
  const songEnd = Math.ceil(durationSec * fps - 1e-9) / fps;
  const problems = [];
  if (Math.round(shots[0].start * fps) > 0) problems.push(`No shot covers the first ${seconds(shots[0].start)} of the song (shot ${shots[0].id} starts there).`);
  for (let index = 1; index < shots.length; index += 1) {
    const gap = shots[index].start - shots[index - 1].end;
    if (gap > 1e-9) problems.push(`No shot covers ${seconds(shots[index - 1].end)} to ${seconds(shots[index].start)} (between ${shots[index - 1].id} and ${shots[index].id}).`);
  }
  const last = shots[shots.length - 1];
  if (Math.round(last.end * fps) < Math.round(songEnd * fps)) problems.push(`No shot covers the song after ${seconds(last.end)} (it runs to ${seconds(durationSec)}).`);
  if (Math.round(last.end * fps) > Math.round(songEnd * fps)) problems.push(`The last shot ends at ${seconds(last.end)}, after the current song ends (${seconds(durationSec)}). Sync shots from scripts again.`);
  return problems;
}

/**
 * What keeps a synced film from being final, as director-facing sentences: a
 * frame rate changed since the sync, a song that is not analyzed, and every
 * stretch of the song no shot covers. Empty means the film tiles the song.
 */
export function blenderFilmProblems(manifest, { fps, durationSec }) {
  const stale = manifest.fps === fps ? [] : [`The frame rate changed from ${manifest.fps} to ${fps} since the last sync. Sync shots from scripts again.`];
  if (!(durationSec > 0)) return [...stale, 'Analyze the song: the film cannot be checked against it yet.'];
  return [...stale, ...coverageProblems(manifest.shots, { durationSec, fps })];
}

/** The last synced manifest, or null before the first sync. */
export async function readBlenderManifest(owner) {
  const stored = await readBlenderJson(blenderManifestFile(owner));
  if (!stored || !Array.isArray(stored.shots)) return null;
  // A manifest synced before films could declare options has none.
  return { ...stored, options: Array.isArray(stored.options) ? stored.options.filter(isDict) : [] };
}

export const writeBlenderManifest = (owner, manifest) => atomicWrite(blenderManifestFile(owner), manifest);
