/** Free Topaz request estimates; a quote never accepts or uploads a video. */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { registerStaging, cleanupTopazStaging, topazPreparedPath } from './topazStaging.js';
import { ServerError } from '../../lib/errorHandler.js';
import { UUID_RE } from '../../lib/fileUtils.js';
import { probeVideoStreamInfo, probeFrameCount, probeVideoDuration, probeVideoPixelAspect, probeSquareVideoPixels } from '../../lib/ffmpeg.js';
import { getSettings } from '../settings.js';
import { resolveHistoryItem, resolveSourcePath } from './upscaleVideo.js';
import { padSourceForUpscale } from './upscaleFfmpeg.js';

export const TOPAZ_MODELS = Object.freeze({ proteus: 'prob-4', starlight: 'slf-2' });
const quotes = new Map();
const QUOTE_TTL_MS = 15 * 60 * 1000;

export async function topazKey() {
  const settings = await getSettings();
  const key = (settings?.videoGen?.topaz?.apiKey || process.env.TOPAZ_API_KEY || '').trim();
  if (!key) throw new ServerError('Configure a Topaz API key in Settings → Credentials.', { status: 400, code: 'TOPAZ_KEY_MISSING' });
  return key;
}

// Never forward the provider's response body or a fetch exception: either can
// contain a credential, request body, or a signed URL.
export async function topazRequest(path, { method = 'GET', body, key, signal } = {}) {
  const response = await fetch(`https://api.topazlabs.com${path}`, {
    method, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000), redirect: 'error', headers: { 'X-API-Key': key, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).catch(() => { throw new ServerError('Topaz could not be reached.', { status: 502, code: 'TOPAZ_UNAVAILABLE' }); });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new ServerError('Topaz rejected the API key or access.', { status: 400, code: 'TOPAZ_AUTH' });
    throw new ServerError(`Topaz request failed (HTTP ${response.status}).`, { status: 502, code: 'TOPAZ_REQUEST_FAILED' });
  }
  if (response.status === 204) return {};
  return response.json().catch(() => { throw new ServerError('Topaz returned an invalid response.', { status: 502, code: 'TOPAZ_INVALID_RESPONSE' }); });
}

// Pad to a 16:9 canvas without cropping or stretching. The cloud receives
// that copy; the original audio is attached locally after processing.
function deliveryPadding(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return null;
  const scale = Math.ceil(Math.max(width / 16, height / 9) / 2) * 2;
  return { width: 16 * scale, height: 9 * scale };
}

// Scale to even square-pixel dimensions without changing the display ratio.
function squareDisplayDimensions(width, height, aspect) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || !aspect) return null;
  const x = width * aspect.numerator;
  const y = height * aspect.denominator;
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x <= 0 || y <= 0) return null;
  const gcd = (a, b) => b ? gcd(b, a % b) : a;
  const divisor = gcd(x, y);
  const w = x / divisor; const h = y / divisor;
  let scale = Math.ceil(height / h);
  if ((w * scale) % 2 || (h * scale) % 2) scale++;
  const result = { width: w * scale, height: h * scale };
  return result.width <= 16384 && result.height <= 16384 ? result : null;
}

export const topazKeyFingerprint = key => createHash('sha256').update(key).digest('hex');
export async function hashTopazFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function quoteTopaz(historyId, model = 'proteus') {
  if (!Object.hasOwn(TOPAZ_MODELS, model)) throw new ServerError('Unknown Topaz model.', { status: 400, code: 'VALIDATION_ERROR' });
  const key = await topazKey();
  const item = await resolveHistoryItem(historyId);
  if (item.upscaledFrom) throw new ServerError('Cannot upscale an already-upscaled video.', { status: 400, code: 'ALREADY_UPSCALED' });
  const path = resolveSourcePath(item);
  const [info, stream, duration, pixelAspect] = await Promise.all([stat(path), probeVideoStreamInfo(path), probeVideoDuration(path), probeVideoPixelAspect(path)]);
  const sourceDigest = await hashTopazFile(path);
  const frameCount = stream.frameCount ?? await probeFrameCount(path);
  if (!Number.isSafeInteger(stream.width) || !Number.isSafeInteger(stream.height) || stream.width <= 0 || stream.height <= 0 || !Number.isFinite(stream.fps) || !(stream.fps > 0) || !Number.isFinite(duration) || !(duration > 0) || !Number.isSafeInteger(frameCount) || frameCount <= 0 || !info.size) {
    throw new ServerError('The source dimensions, frame rate or duration could not be measured.', { status: 400, code: 'TOPAZ_INVALID_DIMENSIONS' });
  }
  const normalized = squareDisplayDimensions(stream.width, stream.height, pixelAspect);
  const padding = normalized && deliveryPadding(normalized.width, normalized.height);
  if (!normalized || !padding || padding.width > 16384 || padding.height > 16384) throw new ServerError('The source pixel aspect is unknown or cannot be represented within supported dimensions.', { status: 400, code: 'TOPAZ_PIXEL_ASPECT_UNSUPPORTED' });
  const preparedId = randomUUID();
  const preparedPath = topazPreparedPath(preparedId);
  await registerStaging(preparedId).catch(() => { throw new ServerError('Could not prepare Topaz staging.', { status: 500, code: 'TOPAZ_PREPARE_FAILED' }); });
  let retained = false;
  try {
    const prepared = await padSourceForUpscale(path, preparedPath, { ...padding, fps: stream.fps, squareWidth: normalized.width, squareHeight: normalized.height }).catch(() => ({ ok: false }));
    if (!prepared.ok) {
      throw new ServerError('Could not prepare the full-frame source for Topaz.', { status: 500, code: 'TOPAZ_PREPARE_FAILED' });
    }
    const preparedInfo = await stat(preparedPath).catch(() => {
      throw new ServerError('Could not inspect the prepared source.', { status: 500, code: 'TOPAZ_PREPARE_FAILED' });
    });
    const [preparedStream, preparedSquare, sourceAfter, sourceDigestAfter, preparedDigest] = await Promise.all([probeVideoStreamInfo(preparedPath), probeSquareVideoPixels(preparedPath), stat(path), hashTopazFile(path), hashTopazFile(preparedPath)]).catch(() => {
      throw new ServerError('Could not verify the prepared source.', { status: 500, code: 'TOPAZ_PREPARE_FAILED' });
    });
    const preparedFrames = preparedStream.frameCount ?? await probeFrameCount(preparedPath).catch(() => { throw new ServerError('Could not verify the prepared source.', { status: 500, code: 'TOPAZ_PREPARE_FAILED' }); });
    if (sourceAfter.size !== info.size || sourceAfter.mtimeMs !== info.mtimeMs || sourceDigestAfter !== sourceDigest || preparedStream.width !== padding.width || preparedStream.height !== padding.height || preparedSquare !== true || preparedFrames !== frameCount || !(preparedStream.fps > 0) || Math.abs(preparedStream.fps - stream.fps) > 0.01 || preparedInfo.size <= 0 || preparedInfo.size >= 100_000_000_000) {
      throw new ServerError('The source changed or could not be prepared without changing its timeline.', { status: 409, code: 'TOPAZ_SOURCE_CHANGED' });
    }
    const target = { width: 1920, height: 1080 };
    const source = { resolution: padding, container: 'mp4', size: preparedInfo.size, duration, frameRate: stream.fps, frameCount };
    const output = { resolution: target, container: 'mp4', frameRate: stream.fps, audioTransfer: 'None', cropToFit: false };
    const created = await topazRequest('/video/', { method: 'POST', key, body: { source, output, filters: [{ model: TOPAZ_MODELS[model] }] } });
    const cost = created?.estimates?.cost;
    if (!UUID_RE.test(created?.requestId || '') || !Array.isArray(cost) || cost.length !== 2 || cost.some(n => !Number.isSafeInteger(n) || n < 0) || cost[0] > cost[1]) {
      throw new ServerError('Topaz did not return a usable credit estimate.', { status: 502, code: 'TOPAZ_QUOTE_FAILED' });
    }
    const token = randomUUID();
    const now = Date.now();
    const reportCleanup = () => console.error('❌ Expired Topaz staging cleanup failed; owned files were retained.');
    for (const [id, quote] of quotes) if (quote.expiresAt < now) { quotes.delete(id); void cleanupTopazStaging(quote.preparedId).catch(reportCleanup); }
    quotes.set(token, { historyId, filename: item.filename, size: info.size, mtimeMs: info.mtimeMs, sourceDigest, preparedDigest, preparedId, source, target, model, requestId: created.requestId, keyFingerprint: topazKeyFingerprint(key), expiresAt: now + QUOTE_TTL_MS });
    const expiry = setTimeout(() => { const stale = quotes.get(token); if (stale) { quotes.delete(token); void cleanupTopazStaging(stale.preparedId).catch(reportCleanup); } }, QUOTE_TTL_MS);
    expiry.unref();
    retained = true;
    return { token, source: { ...source, resolution: { width: stream.width, height: stream.height } }, pixelAspect, normalized, padding, target, model, credits: cost, expiresAt: now + QUOTE_TTL_MS };
  } finally {
    if (!retained) await cleanupTopazStaging(preparedId).catch(() => { throw new ServerError('Could not clean Topaz staging; the owned files were retained for recovery.', { status: 500, code: 'TOPAZ_CLEANUP_FAILED' }); });
  }
}

export function consumeTopazQuote(token, historyId) {
  const quote = quotes.get(token);
  if (!quote || quote.historyId !== historyId || quote.expiresAt < Date.now()) throw new ServerError('Topaz estimate expired; request a new estimate.', { status: 409, code: 'TOPAZ_QUOTE_EXPIRED' });
  quotes.delete(token);
  return quote;
}
