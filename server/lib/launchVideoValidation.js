import { extname } from 'node:path';
import { ServerError } from './errorHandler.js';
import { PII_PATTERNS, redactPii } from './piiRedactionPatterns.js';
import { scrubSecretTokens } from './secretText.js';
import { launchVideoOptionsSchema, launchVideoStoryboardSchema, validateRequest } from './validation.js';

const TEXT_TYPES = new Set(['.html', '.css', '.js', '.json', '.svg', '.md', '.txt']);
const fail = message => { throw new ServerError(message, { status: 400, code: 'LAUNCH_VIDEO_INVALID' }); };
const safeName = name => redactPii(scrubSecretTokens(name));

/** Check the exact in-memory assets the browser will consume, before any script runs. */
export function validateLaunchVideoAssets(assets, options) {
  const { targetDurationSec } = validateRequest(launchVideoOptionsSchema, options);
  const texts = new Map();
  for (const [name, bytes] of assets) {
    const filename = safeName(name);
    if (filename !== name) fail(`Private filename: ${filename}`);
    const type = extname(name).toLowerCase();
    // Font bytes are the sole non-text input. Raster screenshots/video could
    // contain private records that text detectors cannot inspect.
    if (type === '.woff' || type === '.woff2') {
      if (bytes.subarray(0, 4).toString('ascii') !== (type === '.woff' ? 'wOFF' : 'wOF2')) fail(`Invalid font: ${filename}`);
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
  if (durationSec < 15 || durationSec > 25 || Math.abs(durationSec - targetDurationSec) > 2) {
    fail('storyboard.json scene durations must total 15–25s and match targetDurationSec within 2s');
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
