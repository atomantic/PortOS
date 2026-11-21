/**
 * Music Video audio layers: extra audio files (a spoken line, a sound effect,
 * a riser) placed on the editor timeline over the song and mixed into the
 * preview and every render that mixes the song's sound bed.
 *
 * A layer is `{ id, filename, label, startSec, durationSec, volume, muted }`.
 * `filename` names an uploaded file under data/music/ (the same place a
 * vocal stem or an uploaded master lands, so it federates through the
 * project's `music` asset manifest). `startSec` is song time. A layer plays
 * from the start of its file for `durationSec` and never past the song's end:
 * the shared bed chain (videoTimeline/audioBedMix.js) keeps the master's length.
 *
 * Only the upload route creates a layer. A PATCH may move, re-level, mute,
 * rename, reorder or drop the layers the project already has, by id; it
 * cannot name a new file, so a client cannot point the render at an arbitrary
 * library file through a forged filename.
 *
 * Peer sync: `audioLayers` is an additive field on the whole-record LWW
 * project body. An older peer stores it verbatim and renders without it.
 */

import { randomUUID } from 'crypto';
import { isNonBlankStr } from '../../lib/textUtils.js';
import { isSafeMusicFilename } from '../pipeline/musicLibrary.js';
import {
  MUSIC_VIDEO_AUDIO_LAYER_LIMIT as AUDIO_LAYER_LIMIT,
  MUSIC_VIDEO_AUDIO_LAYER_MAX_START_SEC as AUDIO_LAYER_MAX_START_SEC,
  MUSIC_VIDEO_AUDIO_LAYER_MAX_VOLUME as AUDIO_LAYER_MAX_VOLUME,
} from '../../lib/musicVideo/musicVideoLimits.js';

export { AUDIO_LAYER_LIMIT };
const LABEL_MAX = 120;

const round3 = (n) => Math.round(n * 1000) / 1000;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

const clampStart = (v) => (finite(v) ? round3(Math.min(AUDIO_LAYER_MAX_START_SEC, Math.max(0, v))) : 0);
const clampVolume = (v) => (finite(v) ? Math.round(Math.min(AUDIO_LAYER_MAX_VOLUME, Math.max(0, v)) * 100) / 100 : 1);
const cleanLabel = (v, fallback) => (isNonBlankStr(v) ? v.trim().slice(0, LABEL_MAX) : fallback);

/** One stored layer, or null when it names no usable file. */
export function normalizeAudioLayer(raw) {
  if (!raw || typeof raw !== 'object' || !isNonBlankStr(raw.id) || !isSafeMusicFilename(raw.filename)) return null;
  return {
    id: raw.id.trim().slice(0, 64),
    filename: raw.filename,
    label: cleanLabel(raw.label, 'Audio'),
    startSec: clampStart(raw.startSec),
    durationSec: finite(raw.durationSec) && raw.durationSec > 0 ? round3(raw.durationSec) : null,
    volume: clampVolume(raw.volume),
    muted: raw.muted === true,
  };
}

/** The project's layers as stored: invalid entries and repeated ids dropped, at most AUDIO_LAYER_LIMIT. */
export function normalizeAudioLayers(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const layer = normalizeAudioLayer(raw);
    if (!layer || seen.has(layer.id)) continue;
    seen.add(layer.id);
    out.push(layer);
    if (out.length >= AUDIO_LAYER_LIMIT) break;
  }
  return out;
}

export const projectAudioLayers = (project) => normalizeAudioLayers(project?.audioLayers);

/**
 * A PATCH's `audioLayers` applied to the stored ones. Each entry names a
 * stored layer by id and may change its startSec, volume, muted or label; a
 * stored layer the patch leaves out is removed, and the patch's order is kept.
 * An id the project does not have is ignored (it cannot add a file).
 */
export function applyAudioLayersPatch(stored, patch) {
  const byId = new Map(normalizeAudioLayers(stored).map((layer) => [layer.id, layer]));
  const seen = new Set();
  const out = [];
  for (const entry of Array.isArray(patch) ? patch : []) {
    const current = entry && byId.get(entry.id);
    if (!current || seen.has(current.id)) continue;
    seen.add(current.id);
    out.push(normalizeAudioLayer({
      ...current,
      ...('startSec' in entry ? { startSec: entry.startSec } : {}),
      ...('volume' in entry ? { volume: entry.volume } : {}),
      ...('muted' in entry ? { muted: entry.muted } : {}),
      ...('label' in entry ? { label: entry.label } : {}),
    }));
  }
  return out;
}

/** A label from an uploaded file's name: its base name without the extension. */
export function audioLayerLabel(originalName) {
  const base = String(originalName || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  return cleanLabel(base, 'Audio');
}

/** A new layer for an uploaded file, appended after the stored ones. */
export function appendAudioLayer(stored, { filename, originalName, durationSec, startSec }) {
  const layers = normalizeAudioLayers(stored);
  const layer = normalizeAudioLayer({ id: randomUUID(), filename, label: audioLayerLabel(originalName), startSec, durationSec, volume: 1, muted: false });
  return { layers: [...layers, layer], layer };
}

/**
 * The layers a render mixes, as bed-chain entries on song time: muted layers
 * and layers starting at or after the song's end drop out, and each is cut
 * at the song's end. `resolvePath(filename)` answers the verified absolute
 * path; `durationOf(layer, path)` answers its length in seconds (or null).
 */
export async function audioLayerBeds(project, { songSec = null, resolvePath, durationOf }) {
  const beds = [];
  for (const layer of projectAudioLayers(project)) {
    if (layer.muted || layer.volume <= 0) continue;
    if (songSec != null && layer.startSec >= songSec) continue;
    const assetPath = resolvePath(layer.filename);
    const probed = await durationOf(layer, assetPath);
    const length = finite(probed) && probed > 0 ? probed : layer.durationSec;
    if (!(length > 0)) continue;
    const durationSec = songSec != null ? Math.min(length, songSec - layer.startSec) : length;
    if (!(durationSec > 0)) continue;
    beds.push({ layerId: layer.id, assetPath, offsetSec: 0, startSec: layer.startSec, durationSec: round3(durationSec), volume: layer.volume });
  }
  return beds;
}
