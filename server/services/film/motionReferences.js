/**
 * Motion references of a Blender film's shots: Media History clips a shot is reviewed against.
 *
 * A reference is for timing only. It lives in the install-local owner record (`motionReferences`,
 * like notes), is never read by a render, a cut or any staleness hash, and a source video that is
 * gone is reported as missing without touching the shot. Its strip is a regenerable JPEG under
 * `renders/<shot>/references/`, tiled on the grid of a contact sheet (same columns, same time
 * step scaled by the reference's speed) so the two read column for column.
 */
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '../../lib/fileCore.js';
import {
  MUSIC_VIDEO_BLENDER_MOTION_REFERENCE_LIMITS as LIMITS, MUSIC_VIDEO_BLENDER_SHEET_LIMITS as SHEET_LIMITS,
  blenderMotionReferenceTimes, blenderShotFrameRange, normalizeBlenderMotionReferences, normalizeBlenderRecord, normalizeBlenderSheetOptions,
} from '../../lib/musicVideo/musicVideoBlender.js';
import { resolveGalleryVideo } from '../../lib/pathSafety.js';
import { encodeBlenderMotionStrip } from './encode.js';
import { readBlenderManifest } from './manifest.js';
import { announceBlenderState } from './record.js';
import { blenderSheetsFile } from './renderIndex.js';
import { assertBlenderShotId, blenderMediaPath, blenderRefusal, blenderShotDir, readBlenderJson } from './workspace.js';

const referencesDir = (owner, shotId) => blenderShotDir(owner, shotId, 'references');
const stripFile = (owner, shotId, refId) => join(referencesDir(owner, shotId), `${refId}.jpg`);
const stripMetaFile = (owner, shotId, refId) => join(referencesDir(owner, shotId), `${refId}.json`);

const statFile = async (path) => {
  const info = await lstat(path).catch(() => null);
  return info?.isFile() ? info : null;
};

/** Size and mtime of a reference's source video, or null when it is no longer in Media History. */
async function sourceStat(ref) {
  const absolute = resolveGalleryVideo(ref.filename);
  const info = absolute ? await statFile(absolute) : null;
  return info ? { absolute, size: info.size, mtimeMs: info.mtimeMs } : null;
}

// What a strip was made from: any change here makes the stored strip out of date.
const stripSignature = ({ ref, source, grid, settings, shot }) => createHash('sha256').update(JSON.stringify([
  source?.size, source?.mtimeMs, ref.filename, ref.inSec, ref.outSec, ref.speed,
  grid.every, grid.columns, grid.firstFrame, grid.tiles, settings.fps, settings.width, settings.height, shot.start,
])).digest('hex').slice(0, 16);

/** `{ every, columns, firstFrame, tiles, sheet }` the strip tiles: the named or newest contact sheet, else the whole shot. */
async function stripGrid(owner, shot, settings, sheetFile) {
  const listed = await readBlenderJson(blenderSheetsFile(owner, shot.id), []);
  const sheets = (Array.isArray(listed) ? listed : []).filter((sheet) => typeof sheet?.file === 'string');
  const chosen = sheetFile
    ? sheets.find((sheet) => sheet.file === sheetFile.split('/').pop())
    : [...sheets].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  if (sheetFile && !chosen) throw blenderRefusal('That contact sheet is not on this machine', 'NOT_FOUND', 404);
  if (chosen && Number.isInteger(chosen.every) && Number.isInteger(chosen.columns) && Number.isInteger(chosen.firstFrame) && Number.isInteger(chosen.tiles) && chosen.tiles > 0) {
    return { every: chosen.every, columns: chosen.columns, firstFrame: chosen.firstFrame, tiles: chosen.tiles, sheet: chosen.file };
  }
  const { every, columns } = normalizeBlenderSheetOptions(null);
  const { startFrame, frameCount } = blenderShotFrameRange(shot, settings.fps);
  return { every, columns, firstFrame: startFrame, tiles: Math.max(1, Math.min(SHEET_LIMITS.maxTiles, Math.ceil(frameCount / every))), sheet: null };
}

/**
 * The strip of one reference, as the state shows it to the page and to an authoring agent:
 * `{ file, path, every, columns, tiles, sheet, current }`, or null before one was made.
 * `file` is the media-route path; `path` is where this machine keeps it.
 */
async function readStrip(owner, shot, ref, source, settings) {
  const meta = await readBlenderJson(stripMetaFile(owner, shot.id, ref.id), null);
  const absolute = stripFile(owner, shot.id, ref.id);
  if (!meta?.grid || !(await statFile(absolute))) return null;
  return {
    file: blenderMediaPath(owner, absolute), path: absolute,
    every: meta.grid.every, columns: meta.grid.columns, tiles: meta.grid.tiles, sheet: meta.grid.sheet ?? null,
    current: source !== null && meta.signature === stripSignature({ ref, source, grid: meta.grid, settings, shot }),
  };
}

/** `{ [shotId]: [reference + { missing, strip }] }` for the shots of the synced film; shots without one are left out. */
export async function readBlenderMotionReferences(owner, record, manifest) {
  const result = {};
  for (const shot of manifest?.shots || []) {
    const refs = record.motionReferences[shot.id];
    if (!refs?.length) continue;
    result[shot.id] = await Promise.all(refs.map(async (ref) => {
      const source = await sourceStat(ref);
      return { ...ref, missing: source === null, strip: await readStrip(owner, shot, ref, source, record.settings) };
    }));
  }
  return result;
}

async function requireManifestShot(owner, shotId) {
  assertBlenderShotId(shotId);
  const shot = (await readBlenderManifest(owner))?.shots.find((candidate) => candidate.id === shotId);
  if (!shot) throw blenderRefusal('That shot is not in the synced film; sync shots from scripts first', 'NOT_FOUND', 404);
  return shot;
}

/**
 * Tile `ref`'s strip for `shot`. `sheetFile` names the contact sheet to line up with (its media
 * path); without one the newest sheet is used, else the whole shot at the default step.
 */
async function buildStrip(owner, shot, ref, settings, sheetFile = null) {
  const source = await sourceStat(ref);
  if (!source) throw blenderRefusal('That reference video is no longer in Media History', 'MUSIC_VIDEO_BLENDER_REFERENCE_MISSING', 404);
  const grid = await stripGrid(owner, shot, settings, sheetFile);
  const times = blenderMotionReferenceTimes({ shot, ref, fps: settings.fps, every: grid.every, firstFrame: grid.firstFrame, tiles: grid.tiles });
  const count = times.filter((time) => time !== null).length;
  if (!count) throw blenderRefusal('The reference window ends before the first tile of this sheet', 'MUSIC_VIDEO_BLENDER_REFERENCE_OUT_OF_RANGE', 409);
  const output = stripFile(owner, shot.id, ref.id);
  await mkdir(referencesDir(owner, shot.id), { recursive: true });
  await encodeBlenderMotionStrip({
    video: source.absolute, startSec: times[0], stepSec: (grid.every / settings.fps) * ref.speed, count,
    columns: grid.columns, rows: Math.ceil(grid.tiles / grid.columns), width: settings.width, height: settings.height, output,
  });
  await atomicWrite(stripMetaFile(owner, shot.id, ref.id), { signature: stripSignature({ ref, source, grid, settings, shot }), grid });
  return { file: blenderMediaPath(owner, output), path: output, every: grid.every, columns: grid.columns, tiles: grid.tiles, sheet: grid.sheet, available: count, current: true };
}

const referenceOf = async (owner, shotId, refId) => {
  const record = normalizeBlenderRecord(await owner.readRecord());
  const ref = record.motionReferences[shotId]?.find((candidate) => candidate.id === refId);
  if (!ref) throw blenderRefusal('That motion reference is not on this shot', 'NOT_FOUND', 404);
  return { ref, settings: record.settings };
};

/** Make (or refresh) one reference's strip, lined up with `sheet` (a contact sheet's media path) when given. */
export async function makeBlenderMotionStrip(owner, shotId, refId, { sheet = null } = {}) {
  const shot = await requireManifestShot(owner, shotId);
  const { ref, settings } = await referenceOf(owner, shotId, refId);
  const strip = await buildStrip(owner, shot, ref, settings, sheet);
  announceBlenderState(owner);
  return strip;
}

/**
 * Replace a shot's motion references with `references` (at most three; an entry without an `id` is
 * new). A video that is not in Media History refuses the save. A removed reference loses its strip.
 */
export async function saveBlenderMotionReferences(owner, shotId, references) {
  const shot = await requireManifestShot(owner, shotId);
  const next = normalizeBlenderMotionReferences({
    [shotId]: references.map((ref) => ({ ...ref, id: ref.id ?? `mr-${randomBytes(4).toString('hex')}` })),
  })[shotId] || [];
  if (next.length !== references.length) {
    throw blenderRefusal(`A shot holds at most ${LIMITS.perShot} distinct references, each with a video and an out point after its in point`, 'MUSIC_VIDEO_BLENDER_REFERENCE_INVALID', 400);
  }
  for (const ref of next) {
    if (!resolveGalleryVideo(ref.filename)) {
      throw blenderRefusal(`"${ref.filename}" is not a video in Media History`, 'MUSIC_VIDEO_BLENDER_REFERENCE_INVALID', 400);
    }
  }
  const prior = normalizeBlenderRecord(await owner.readRecord()).motionReferences[shotId] || [];
  const record = await owner.writeRecord((current) => {
    const { [shotId]: _replaced, ...others } = normalizeBlenderRecord(current).motionReferences;
    return { motionReferences: next.length ? { ...others, [shotId]: next } : others };
  });
  const kept = new Set(next.map((ref) => ref.id));
  for (const ref of prior.filter((old) => !kept.has(old.id))) {
    await Promise.all([rm(stripFile(owner, shotId, ref.id), { force: true }), rm(stripMetaFile(owner, shotId, ref.id), { force: true })]);
  }
  const { settings } = normalizeBlenderRecord(record);
  // A strip lets an authoring agent look at the clip without the page; the save stands without it.
  await Promise.all(next.map((ref) => buildStrip(owner, shot, ref, settings).catch((error) => {
    console.log(`🎞️ Motion reference strip for ${shotId} was not made: ${error.message}`);
  })));
  announceBlenderState(owner);
  return record;
}
