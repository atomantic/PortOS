// Shared music-library filename validation and supported audio extensions.

import { assertSafeFilename, isSafeFilename } from './fileUtils.js';


export const SUPPORTED_AUDIO_EXTENSIONS = Object.freeze(['.mp3', '.wav', '.m4a', '.ogg', '.flac']);

/**
 * Validate a stored music filename — same pattern as the rest of the codebase.
 * Rejects path traversal, separators, and disallowed extensions.
 */
export function assertSafeMusicFilename(filename) {
  assertSafeFilename(filename, {
    extensions: [...SUPPORTED_AUDIO_EXTENSIONS],
    subject: 'music filename',
  });
}

/**
 * The same rule as a predicate, for read-only callers that must treat a bad
 * stored filename as data. `sanitizeTrack` only `trimTo`s the top-level
 * `audioFilename` (unlike `renders[]`, which goes through
 * `trackAudioFilename`), so a legacy or peer-synced track can carry an
 * unsupported name — a preflight has to report that as one blocked asset, not
 * 400 the whole sweep via `assertSafeMusicFilename`.
 */
export const isSafeMusicFilename = (filename) =>
  isSafeFilename(filename, SUPPORTED_AUDIO_EXTENSIONS);
