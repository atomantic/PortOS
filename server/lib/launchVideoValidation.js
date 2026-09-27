import { extname } from 'node:path';
import { ServerError } from './errorHandler.js';
import { PII_PATTERNS, redactPii } from './piiRedactionPatterns.js';
import { scrubSecretTokens } from './secretText.js';
import { launchVideoOptionsSchema, launchVideoStoryboardSchema, validateRequest } from './validation.js';

const TEXT_TYPES = new Set(['.html', '.css', '.js', '.json', '.svg', '.md', '.txt']);
const fail = message => { throw new ServerError(message, { status: 400, code: 'LAUNCH_VIDEO_INVALID' }); };
const safeName = name => redactPii(scrubSecretTokens(name));

/** Check the exact in-memory assets the browser will consume, before any script runs. */
export function validateLaunchVideoAssets(assets, options, compositionMusic) {
  const { targetDurationSec } = validateRequest(launchVideoOptionsSchema, options);
  const texts = new Map();
  for (const [name, bytes] of assets) {
    const filename = safeName(name);
    if (filename !== name) fail(`Private filename: ${filename}`);
    const type = extname(name).toLowerCase();
    // Only local fonts and a canonical synthesized PCM soundtrack are binary.
    // Raster screenshots/video could
    // contain private records that text detectors cannot inspect.
    if (type === '.woff' || type === '.woff2') {
      if (bytes.subarray(0, 4).toString('ascii') !== (type === '.woff' ? 'wOFF' : 'wOF2')) fail(`Invalid font: ${filename}`);
      continue;
    }
    if (name === '/soundtrack.wav' && compositionMusic === 'soundtrack.wav') {
      // Reject metadata chunks and non-PCM containers, including disguised playlists.
      if (bytes.length < 48 || bytes.toString('ascii', 0, 4) !== 'RIFF'
        || bytes.readUInt32LE(4) !== bytes.length - 8 || bytes.toString('ascii', 8, 16) !== 'WAVEfmt '
        || bytes.readUInt32LE(16) !== 16 || bytes.readUInt16LE(20) !== 1
        || ![1, 2].includes(bytes.readUInt16LE(22)) || ![44100, 48000].includes(bytes.readUInt32LE(24))
        || bytes.readUInt16LE(34) !== 16 || bytes.toString('ascii', 36, 40) !== 'data'
        || bytes.readUInt32LE(40) !== bytes.length - 44
        || bytes.readUInt16LE(32) !== bytes.readUInt16LE(22) * 2
        || bytes.readUInt32LE(28) !== bytes.readUInt32LE(24) * bytes.readUInt16LE(32)
        || (bytes.length - 44) % bytes.readUInt16LE(32)) fail('Invalid canonical PCM soundtrack.wav');
      const duration = (bytes.length - 44) / bytes.readUInt32LE(28);
      if (duration < 0.25 || duration > 120) fail('soundtrack.wav must contain 0.25–120 seconds of audio');
      let peak = 0;
      for (let offset = 44; offset < bytes.length; offset += 2) {
        peak = Math.max(peak, Math.abs(bytes.readInt16LE(offset)));
        if (peak >= 32767) fail('soundtrack.wav samples must not clip');
      }
      if (peak < 32) fail('soundtrack.wav must contain audible samples');
      continue;
    }
    if (!TEXT_TYPES.has(type)) fail(`Unsupported launch-video asset: ${filename}`);
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes) || text.includes('\0')) fail(`Text must be UTF-8: ${filename}`);
    for (const { code, pattern } of PII_PATTERNS) {
      if (pattern.test(text)) fail(`${code} in ${filename}`);
    }
    if (scrubSecretTokens(text) !== text) fail(`secret-token in ${filename}`);
    texts.set(name, text);
  }
  for (const name of ['/index.html', '/plan.md', '/storyboard.json', '/caption.txt']) {
    if (!texts.get(name)?.trim()) fail(`Missing or empty ${name}`);
  }
  // JSON.parse's native message can quote private source text. Keep failures bounded.
  let raw;
  try { raw = JSON.parse(texts.get('/storyboard.json')); } catch { fail('Invalid JSON in /storyboard.json'); }
  const parsed = launchVideoStoryboardSchema.safeParse(raw);
  if (!parsed.success) fail(`Invalid storyboard.json field: ${parsed.error.issues[0].path.join('.')}`);
  const storyboard = parsed.data;
  const durationSec = storyboard.scenes.reduce((sum, scene) => sum + scene.durationSec, 0);
  if (durationSec < 15 || durationSec > 120 || Math.abs(durationSec - targetDurationSec) > 2) {
    fail('storyboard.json scene durations must total 15–120s and match targetDurationSec within 2s');
  }
  if (storyboard.posterSec >= durationSec) fail('storyboard.json posterSec must be inside the video');
  storyboard.scenes.forEach((scene, sceneIndex) => scene.lines.forEach((line, lineIndex) => {
    const label = `storyboard.json scene ${sceneIndex + 1} line ${lineIndex + 1}`;
    const words = line.text.split(/\s+/u).length;
    if (line.wordCount !== words) fail(`${label}: wordCount must match the text`);
    if (line.holdSec < Math.max(0.8, 0.3 * words) || line.holdSec > scene.durationSec) {
      fail(`${label}: holdSec must allow reading time and fit inside its scene`);
    }
  }));
  return { durationSec, posterSec: storyboard.posterSec };
}
