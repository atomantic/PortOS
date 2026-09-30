/**
 * Loudness fingerprints of a stretch of a song (#9266).
 *
 * A lip-sync take is valid for the audio it was cut from, not for the whole
 * file: a re-mastered song that only changes bars outside a take's window must
 * not invalidate the take. The fingerprint is a 100 Hz RMS envelope in integer
 * dBFS (−90..0), laid on the SONG's own frame grid (frame k covers
 * [k/100, (k+1)/100) s), so one decode of a master serves every take and two
 * fingerprints of the same song time line up frame for frame.
 *
 * Stored shape: `{ version, rateHz, startFrame, db }` where `db` is base64 of an
 * Int8Array — at most 3,000 bytes for a 30 s window.
 *
 * What it answers is "did the timing of this window's sound change?" — which
 * is what mouth motion follows (syllable onsets, holds, breaths). A change that
 * keeps the 10 ms loudness contour intact to r ≥ 0.98 and ≤ 1.5 dB (pitch
 * correction, an EQ tweak, a re-encode) is deliberately NOT a change. It is not
 * a content hash: a different vocal performed with an identical 10 ms
 * dynamic contour would pass, which no real re-master produces.
 */

import { spawn } from './childProcess.js';
import { findFfmpeg } from './ffmpeg.js';
import { safeChildProcessOptions } from './processEnv.js';

export const AUDIO_FINGERPRINT_VERSION = 1;
export const FINGERPRINT_RATE_HZ = 100;
const DECODE_RATE_HZ = 8000;
const SAMPLES_PER_FRAME = DECODE_RATE_HZ / FINGERPRINT_RATE_HZ;
const FLOOR_DB = -90;
// Below this level the envelope is codec noise and dither, which a re-encode
// moves by tens of dB without anything audible changing — compare above it.
const COMPARE_FLOOR_DB = -60;
// A window whose envelope barely moves (sustained tone, silence) has no shape
// to correlate; the mean level difference alone judges it.
const MIN_SHAPE_STD_DB = 1;
export const FINGERPRINT_MIN_CORRELATION = 0.98;
export const FINGERPRINT_MAX_MEAN_DELTA_DB = 1.5;

/**
 * Decode `path` to 8 kHz mono and return its whole 100 Hz RMS envelope as an
 * Int8Array of dBFS. The PCM is folded into frames as it streams, so memory is
 * one byte per 10 ms whatever the song length. Throws when ffmpeg is missing
 * or the decode fails.
 */
export async function computeRmsEnvelope(path) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new Error('ffmpeg is required to fingerprint audio');
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, [
      '-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', String(DECODE_RATE_HZ), '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1',
    ], safeChildProcessOptions({ stdio: ['ignore', 'pipe', 'pipe'] }));
    const frames = [];
    let sumSq = 0;
    let count = 0;
    let carry = null;
    let stderr = '';
    const pushFrame = () => {
      const rms = Math.sqrt(sumSq / count) / 32768;
      frames.push(rms > 0 ? Math.max(FLOOR_DB, Math.min(0, Math.round(20 * Math.log10(rms)))) : FLOOR_DB);
      sumSq = 0;
      count = 0;
    };
    proc.stdout.on('data', (chunk) => {
      const buf = carry ? Buffer.concat([carry, chunk]) : chunk;
      const whole = buf.length - (buf.length % 2);
      carry = whole < buf.length ? buf.subarray(whole) : null;
      for (let at = 0; at < whole; at += 2) {
        const s = buf.readInt16LE(at);
        sumSq += s * s;
        if (++count === SAMPLES_PER_FRAME) pushFrame();
      }
    });
    proc.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-500); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) { reject(new Error(`ffmpeg could not decode the audio: ${stderr.trim() || `exit ${code}`}`)); return; }
      resolve(Int8Array.from(frames));
    });
  });
}

// Whole frames inside [startSec, endSec).
const windowFrames = ({ startSec, endSec }) => {
  const start = Math.ceil(startSec * FINGERPRINT_RATE_HZ - 1e-6);
  const end = Math.floor(endSec * FINGERPRINT_RATE_HZ + 1e-6);
  return { start, end };
};

/** The stored fingerprint of `window` cut from a whole-song envelope, or null when the song is shorter than the window. */
export function windowFingerprint(envelope, window) {
  const { start, end } = windowFrames(window);
  if (!(end > start) || end > envelope.length) return null;
  const db = envelope.slice(start, end);
  return {
    version: AUDIO_FINGERPRINT_VERSION,
    rateHz: FINGERPRINT_RATE_HZ,
    startFrame: start,
    db: Buffer.from(db.buffer, db.byteOffset, db.byteLength).toString('base64'),
  };
}

const decodeFingerprint = (fingerprint) => {
  if (fingerprint?.version !== AUDIO_FINGERPRINT_VERSION || fingerprint.rateHz !== FINGERPRINT_RATE_HZ) return null;
  if (!Number.isInteger(fingerprint.startFrame) || fingerprint.startFrame < 0 || typeof fingerprint.db !== 'string') return null;
  const bytes = Buffer.from(fingerprint.db, 'base64');
  return bytes.length > 0 ? new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length) : null;
};

/**
 * Does `envelope` (a whole song) still carry the audio a stored fingerprint
 * recorded? Returns `{ same, correlation, meanDeltaDb }`; `same` is false when
 * the fingerprint is unreadable or the song no longer reaches the window.
 * Pearson correlation below 0.98 or a mean |ΔdB| above 1.5 dB is a change.
 */
export function compareWindowFingerprint(fingerprint, envelope) {
  const stored = decodeFingerprint(fingerprint);
  if (!stored || fingerprint.startFrame + stored.length > envelope.length) return { same: false, correlation: null, meanDeltaDb: null };
  const n = stored.length;
  const a = new Float64Array(n);
  const b = new Float64Array(n);
  let sumA = 0;
  let sumB = 0;
  let sumDelta = 0;
  for (let i = 0; i < n; i++) {
    a[i] = Math.max(COMPARE_FLOOR_DB, stored[i]);
    b[i] = Math.max(COMPARE_FLOOR_DB, envelope[fingerprint.startFrame + i]);
    sumA += a[i];
    sumB += b[i];
    sumDelta += Math.abs(a[i] - b[i]);
  }
  const meanA = sumA / n;
  const meanB = sumB / n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    cov += (a[i] - meanA) * (b[i] - meanB);
    varA += (a[i] - meanA) ** 2;
    varB += (b[i] - meanB) ** 2;
  }
  const shaped = Math.sqrt(varA / n) >= MIN_SHAPE_STD_DB && Math.sqrt(varB / n) >= MIN_SHAPE_STD_DB;
  const correlation = shaped ? cov / Math.sqrt(varA * varB) : null;
  const meanDeltaDb = sumDelta / n;
  const same = meanDeltaDb <= FINGERPRINT_MAX_MEAN_DELTA_DB && (correlation == null || correlation >= FINGERPRINT_MIN_CORRELATION);
  return { same, correlation, meanDeltaDb };
}
