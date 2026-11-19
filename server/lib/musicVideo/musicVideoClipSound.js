/**
 * Music Video — a song shot's own clip sound mixed over the music (`scene.clipSound`), such as a spoken line or an effect the video model made, and whether a shot asks its model for sound.
 *
 * The song is a video's soundtrack, so song shots render silent by default.
 * A director (or an autonomous run) may opt one shot in: its clip is then
 * generated with sound, and the final render plays that sound over the song
 * at `volume`, dipping the song to `musicLevel` for the shot's span so a line
 * stays intelligible. Absent or null is off. A cold-open shot (before the
 * song) has its own sound settings (musicVideoColdOpen.js) and ignores this.
 *
 * Peer sync: an additive optional field on the scene; an older peer keeps it
 * verbatim and renders the shot silent, as before, so no schema bump.
 */

import { isPreMusicShot, preMusicClipSound } from './musicVideoColdOpen.js';

export const CLIP_SOUND_VOLUME_RANGE = Object.freeze({ min: 0.05, max: 2 });
export const CLIP_SOUND_MUSIC_RANGE = Object.freeze({ min: 0, max: 1 });
export const CLIP_SOUND_DEFAULTS = Object.freeze({ volume: 1, musicLevel: 0.5 });

const round2 = (n) => Math.round(n * 100) / 100;
const clamp = (v, { min, max }, fallback) => (typeof v === 'number' && Number.isFinite(v) ? round2(Math.min(max, Math.max(min, v))) : fallback);

/** A shot's clip-sound settings, or null when its clip plays silent under the song. */
export function normalizeClipSound(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    volume: clamp(value.volume, CLIP_SOUND_VOLUME_RANGE, CLIP_SOUND_DEFAULTS.volume),
    musicLevel: clamp(value.musicLevel, CLIP_SOUND_MUSIC_RANGE, CLIP_SOUND_DEFAULTS.musicLevel),
  };
}

/** The clip-sound settings a song shot plays with, or null (off, or a cold-open shot). */
export const songClipSound = (scene) => (isPreMusicShot(scene) ? null : normalizeClipSound(scene?.clipSound));

/**
 * Whether a shot asks its video model for sound: a cold-open shot with Clip
 * sound on, or a song shot with clip sound over the music. Every other shot
 * renders silent.
 */
export const shotWantsClipSound = (scene) => preMusicClipSound(scene) || !!songClipSound(scene);

/** "Clip sound 100% · music 50%", or null when off. */
export function clipSoundSummary(scene) {
  const sound = songClipSound(scene);
  return sound ? `Clip sound ${Math.round(sound.volume * 100)}% · music ${Math.round(sound.musicLevel * 100)}%` : null;
}
