/** Discover FFmpeg and FFprobe binaries and cache the installed build's capabilities. */

import { existsSync, statSync } from 'fs';
import { dirname, join, resolve as resolvePath } from 'path';
import { promisify } from 'util';
import { execFile } from '../childProcess.js';
import { safeChildProcessOptions, whichFirst } from '../processEnv.js';

const execFileAsync = promisify(execFile);
const isWindows = () => process.platform === 'win32';

// Replace the whole cache so work already in flight cannot repopulate it after an upgrade.
const createDiscoveryCache = () => ({
  cachedFfmpegPath: undefined,
  cachedFfprobePath: undefined,
  // Keyed by normalized binary path, with the file identity and encoder set as values.
  encoderCapabilityCache: new Map(),
  vfrSyncProbes: new Map(),
  // An unavailable binary or failed probe leaves this unset for a later retry.
  setparamsAvailable: null,
});
let discoveryCache = createDiscoveryCache();
let testPlatformCandidates = null;

/** Test hook: override platform candidate paths for isolated testing. */
export const __setPlatformCandidatesForTest = (candidates) => {
  testPlatformCandidates = Array.isArray(candidates) ? [...candidates] : null;
};

/**
 * Reset ffmpeg discovery and capability caches.
 * Allows newly-installed binaries or in-place upgrades to be recognized without server restart.
 */
export const resetFfmpegCache = () => {
  discoveryCache = createDiscoveryCache();
  testPlatformCandidates = null;
};
export const _probeEncoderCapability = (bin, requiredEncoder, options) => probeEncoderCapability(bin, requiredEncoder, options);
export const _enumerateFfmpegCandidates = () => enumerateFfmpegCandidates();

/**
 * Probe a candidate ffmpeg executable for supported encoders.
 * Distinguishes supported, unsupported, and inconclusive results.
 * Caches successful capability evidence against binary identity (path + mtimeMs + size + ino).
 * Inconclusive results (probe failure / timeout) are NEVER cached.
 *
 * @param {string} bin
 * @param {string} requiredEncoder
 * @returns {Promise<{ supported: boolean, inconclusive: boolean, timedOut?: boolean, reason?: string, fromCache?: boolean }>}
 */
async function probeEncoderCapability(bin, requiredEncoder, { timeoutMs = 5000 } = {}, encoderCapabilityCache = discoveryCache.encoderCapabilityCache) {
  if (!bin || typeof bin !== 'string') {
    return { supported: false, inconclusive: false, reason: 'invalid binary' };
  }
  const win = isWindows();
  const binKey = win ? resolvePath(bin).toLowerCase() : resolvePath(bin);

  let st;
  try {
    st = statSync(bin);
  } catch (err) {
    return { supported: false, inconclusive: false, reason: `binary inaccessible: ${err.message}` };
  }

  const identityKey = `${binKey}:${st.mtimeMs}:${st.size}:${st.ino}`;
  const cached = encoderCapabilityCache.get(binKey);
  if (cached && cached.identityKey === identityKey) {
    const supported = cached.encoders.has(requiredEncoder.toLowerCase());
    return { supported, inconclusive: false, fromCache: true };
  }

  let stdout;
  try {
    const res = await execFileAsync(bin, ['-hide_banner', '-encoders'], safeChildProcessOptions({
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    }));
    stdout = String(res?.stdout || '');
  } catch (err) {
    const isTimeout = Boolean(err.killed || err.code === 'ETIMEDOUT' || /timed\s*out/i.test(String(err.message || '')));
    return {
      supported: false,
      inconclusive: true,
      timedOut: isTimeout,
      reason: isTimeout ? 'probe timed out' : `probe failed: ${err.message}`,
      fromCache: false,
    };
  }

  const encoders = new Set();
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*[a-zA-Z.]{6}\s+([a-zA-Z0-9_-]+)/);
    if (match) {
      encoders.add(match[1].toLowerCase());
    }
  }

  // Cache successful capability evidence against binary identity
  encoderCapabilityCache.set(binKey, { identityKey, encoders });

  const supported = encoders.has(requiredEncoder.toLowerCase());
  return { supported, inconclusive: false, fromCache: false };
}

/**
 * Enumerate potential ffmpeg candidates in existing precedence order:
 * 1. Fixed platform candidate paths (Windows or POSIX)
 * 2. PATH resolution via whichFirst('ffmpeg')
 * 3. Any additional candidates in PATH directories
 * Deduplicated by normalized path.
 */
async function enumerateFfmpegCandidates() {
  if (testPlatformCandidates) return [...testPlatformCandidates];
  const win = isWindows();
  const platformCandidates = win
    ? ['C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe']
    : ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];

  const candidates = [];
  const seen = new Set();

  const addCandidate = (p) => {
    if (!p || typeof p !== 'string') return;
    const key = win ? resolvePath(p).toLowerCase() : resolvePath(p);
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(p);
    }
  };

  for (const c of platformCandidates) addCandidate(c);

  const whichHit = await whichFirst('ffmpeg').catch(() => null);
  if (whichHit) addCandidate(whichHit);

  const pathVal = process.env.PATH || '';
  const delimiter = win ? ';' : ':';
  const dirs = pathVal.split(delimiter).filter(Boolean);
  const exeName = win ? 'ffmpeg.exe' : 'ffmpeg';
  for (const rawDir of dirs) {
    const dir = rawDir.replace(/^"(.*)"$/, '$1');
    addCandidate(join(dir, exeName));
  }

  return candidates;
}

/**
 * Discover an ffmpeg binary on the host.
 *
 * When `requiredEncoder` is omitted:
 * Chooses the first existing platform candidate, falling back to PATH.
 * Free for decoding, audio and copy-only callers without imposing codec requirements.
 *
 * When `requiredEncoder` is specified:
 * Probes candidates in precedence order and selects the first one whose encoder listing
 * contains the requested codec.
 * If no candidate satisfies the requirement, yields an actionable prerequisite error:
 * - 'ffmpeg not found on PATH' if no ffmpeg binary exists
 * - 'ffmpeg build does not support required encoder: <codec>' if inspected binaries lack the codec
 * - 'ffmpeg encoder capability probe timed out' / 'probe failed' if an inconclusive probe occurred
 *
 * @param {{ requiredEncoder?: string }} [options]
 * @returns {Promise<string|null>}
 */
export const findFfmpeg = async ({ requiredEncoder, timeoutMs = 5000, candidates: customCandidates } = {}) => {
  const cache = discoveryCache;
  const candidatesList = customCandidates || (testPlatformCandidates ? [...testPlatformCandidates] : null);
  const win = isWindows();
  const platformCandidates = testPlatformCandidates || (win
    ? ['C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe']
    : ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']);

  if (!requiredEncoder) {
    if (candidatesList) {
      for (const p of candidatesList) {
        if (existsSync(p)) return p;
      }
      return null;
    }

    if (cache.cachedFfmpegPath && existsSync(cache.cachedFfmpegPath)) {
      let hasHigherPriority = false;
      const cachedKey = win ? resolvePath(cache.cachedFfmpegPath).toLowerCase() : resolvePath(cache.cachedFfmpegPath);
      for (const p of platformCandidates) {
        const pKey = win ? resolvePath(p).toLowerCase() : resolvePath(p);
        if (pKey === cachedKey) break;
        if (existsSync(p)) {
          hasHigherPriority = true;
          cache.cachedFfmpegPath = p;
          return p;
        }
      }
      if (!hasHigherPriority) return cache.cachedFfmpegPath;
    }

    for (const p of platformCandidates) {
      if (existsSync(p)) {
        cache.cachedFfmpegPath = p;
        return p;
      }
    }

    const found = await whichFirst('ffmpeg').catch(() => null);
    if (found && existsSync(found)) {
      cache.cachedFfmpegPath = found;
      return found;
    }

    const pathVal = process.env.PATH || '';
    const delimiter = win ? ';' : ':';
    const dirs = pathVal.split(delimiter).filter(Boolean);
    const exeName = win ? 'ffmpeg.exe' : 'ffmpeg';
    for (const rawDir of dirs) {
      const dir = rawDir.replace(/^"(.*)"$/, '$1');
      const candidate = join(dir, exeName);
      if (existsSync(candidate)) {
        cache.cachedFfmpegPath = candidate;
        return candidate;
      }
    }

    cache.cachedFfmpegPath = undefined;
    return null;
  }

  const reqEnc = String(requiredEncoder).trim();
  const candidates = candidatesList || await enumerateFfmpegCandidates();

  let inconclusiveFailure = null;
  let existingCandidateCount = 0;
  const inspected = [];

  for (const bin of candidates) {
    if (!existsSync(bin)) continue;
    existingCandidateCount++;
    inspected.push(bin);

    const probe = await probeEncoderCapability(bin, reqEnc, { timeoutMs }, cache.encoderCapabilityCache);
    if (probe.supported) {
      return bin;
    }
    if (probe.inconclusive && !inconclusiveFailure) {
      inconclusiveFailure = probe;
    }
  }

  if (existingCandidateCount === 0) {
    throw Object.assign(new Error('ffmpeg not found on PATH'), { code: 'FFMPEG_MISSING' });
  }

  if (inconclusiveFailure) {
    const msg = inconclusiveFailure.timedOut
      ? 'ffmpeg encoder capability probe timed out'
      : `ffmpeg encoder capability probe failed: ${inconclusiveFailure.reason}`;
    throw Object.assign(new Error(msg), {
      code: inconclusiveFailure.timedOut ? 'FFMPEG_PROBE_TIMED_OUT' : 'FFMPEG_PROBE_FAILED',
      details: inconclusiveFailure,
    });
  }

  throw Object.assign(new Error(`ffmpeg build does not support required encoder: ${reqEnc}`), {
    code: 'FFMPEG_CODEC_MISSING',
    inspected,
  });
};

const CURRENT_VFR_ARGS = Object.freeze(['-fps_mode', 'vfr']);
const LEGACY_VFR_ARGS = Object.freeze(['-vsync', 'vfr']);

// fps_mode replaced the global vsync option in 5.1; 9 removes vsync. Probe
// capabilities rather than imposing a new version floor on older installs.
// Like the setparams probe, an inconclusive result stays uncached.
export const vfrSyncArgs = async (bin) => {
  const { vfrSyncProbes } = discoveryCache;
  if (vfrSyncProbes.has(bin)) return vfrSyncProbes.get(bin);
  const probe = execFileAsync(bin, ['-hide_banner', '-h', 'full'], safeChildProcessOptions({
    timeout: 5000, maxBuffer: 4 * 1024 * 1024,
  })).then(({ stdout }) => {
    const listing = String(stdout || '');
    if (/^\s*-fps_mode(?:\s|\[|$)/m.test(listing)) return CURRENT_VFR_ARGS;
    if (/^\s*-vsync(?:\s|$)/m.test(listing)) return LEGACY_VFR_ARGS;
    vfrSyncProbes.delete(bin);
    return CURRENT_VFR_ARGS;
  }, () => {
    vfrSyncProbes.delete(bin);
    return CURRENT_VFR_ARGS;
  });
  vfrSyncProbes.set(bin, probe);
  return probe;
};

// ffprobe sits next to ffmpeg in standard distributions — derive the path
// from the cached ffmpeg discovery so we don't shell out twice.
export const findFfprobe = async () => {
  const cache = discoveryCache;
  if (cache.cachedFfprobePath !== undefined) return cache.cachedFfprobePath;
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) { cache.cachedFfprobePath = null; return null; }
  // Derive ffprobe from ffmpeg's directory rather than regex-replacing the
  // basename. A case-sensitive replace would silently miss `FFMPEG.EXE` on
  // Windows and let callers spawn ffmpeg as if it were ffprobe (audio
  // probing then always reports "no audio"). dirname-based join sidesteps
  // the casing question entirely.
  const probe = join(dirname(ffmpeg), isWindows() ? 'ffprobe.exe' : 'ffprobe');
  if (existsSync(probe)) { cache.cachedFfprobePath = probe; return probe; }
  cache.cachedFfprobePath = await whichFirst('ffprobe');
  return cache.cachedFfprobePath;
};

// BT.709 color tagging for re-encodes.
//
// Untagged H.264 makes each player guess a color space, and the common guess
// for HD content differs from the one for SD — so a stitched clip that carries
// no tags decodes washed-out (or over-saturated) depending on where it's
// opened. The renders these helpers re-encode are BT.709 in practice; the fix
// is to SAY so on the output.
//
// It takes both halves to stick. The container flags below write the tags into
// the MP4's `colr` atom, but from ffmpeg 8 the encoder reads its color
// properties off the FRAMES coming down the filter graph — and those inherit
// the (usually unspecified) values of the decoded input, silently overriding
// the flags. `setparams` stamps the frame properties themselves, so the
// encoder and the container agree.
export const BT709_TAG_FILTER = 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709';
export const BT709_CONTAINER_ARGS = Object.freeze([
  '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
]);

// Test seam — resets the capability cache between cases.
export const __resetSetparamsProbe = () => { discoveryCache.setparamsAvailable = null; };

// Does this ffmpeg build carry the `setparams` filter? It landed in ffmpeg 4.3;
// older builds (still common in distro packages) parse it as an unknown filter
// and abort the whole run, which would turn a color-tagging nicety into a
// failed render. Reuse a successful answer until discovery is reset.
export const supportsSetparamsFilter = async () => {
  const cache = discoveryCache;
  if (cache.setparamsAvailable !== null) return cache.setparamsAvailable;
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return false;
  const listing = await execFileAsync(ffmpeg, ['-hide_banner', '-filters'], safeChildProcessOptions({
    maxBuffer: 4 * 1024 * 1024,
  })).then((r) => String(r.stdout || ''), () => null);
  if (listing === null) return false;
  cache.setparamsAvailable = /(^|\s)setparams(\s|$)/m.test(listing);
  if (!cache.setparamsAvailable) {
    console.log('⚠️ ffmpeg has no setparams filter — BT.709 tags will ride the container flags only');
  }
  return cache.setparamsAvailable;
};

// The filter string to append to a re-encode's video chain, or `null` when this
// ffmpeg build can't take it. Callers still spread `BT709_CONTAINER_ARGS`
// unconditionally — those flags are accepted by every build worth supporting.
export const bt709TagFilter = async () => (await supportsSetparamsFilter() ? BT709_TAG_FILTER : null);
