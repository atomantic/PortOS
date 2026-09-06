/** Video frame extraction and evaluation-frame sampling. */

import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn } from '../../lib/childProcess.js';
import { ensureDir, PATHS, UUID_RE, tryReadFile, copyFileGuarded, writeFileGuarded, unlinkGuarded, rmGuarded } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import {
  findFfmpeg, safeUnder, extractEvaluationFrames, runFfmpegProcess,
} from '../../lib/ffmpeg.js';
import {
  TAIL_WINDOW_SECONDS, CANDIDATE_FPS, MAX_CANDIDATES, pickBestFrame,
} from '../../lib/frameQuality.js';
import { safeChildProcessOptions } from '../../lib/processEnv.js';
import { loadHistory } from './history.js';

const UPLOADED_HISTORY_ID_RE = /^upload-[a-f0-9]{8}$/i;

const UNSCANNED_ANCHOR = 'last-frame-unscanned';

// Decode the tail-window candidates for `extractLastFrame` into a temp dir and
// return their paths in timeline order (oldest first).
//
// One ffmpeg pass: seek to TAIL_WINDOW_SECONDS before EOF, decimate to
// CANDIDATE_FPS, and let the image2 muxer write numbered PNGs. A clip shorter
// than the window simply yields fewer files — the caller degrades to whatever
// exists. Returns [] on any failure; a scan that can't run must never abort a
// render the user already paid GPU time for.
async function decodeTailCandidates(ffmpeg, videoPath, candidateDir) {
  // Clear first: a crashed prior run can leave a longer numbered run behind,
  // and the by-name enumeration below would read those stale frames as this
  // clip's candidates.
  await rmGuarded(candidateDir, { recursive: true, force: true }).catch(() => {});
  await ensureDir(candidateDir);
  const outPattern = join(candidateDir, 'cand-%03d.png');
  // Through the catalog helper rather than a hand-rolled spawn: it already
  // translates spawn errors into a reason string instead of an unhandled
  // 'error' event, matching every other extraction path in this file.
  const scan = await runFfmpegProcess({
    bin: ffmpeg,
    args: [
      '-sseof', `-${TAIL_WINDOW_SECONDS.toFixed(2)}`, '-i', videoPath,
      '-vf', `fps=${CANDIDATE_FPS}`, '-vsync', 'vfr',
      '-frames:v', String(MAX_CANDIDATES), '-y', outPattern,
    ],
    stderrTailBytes: 0,
  });
  if (!scan.ok && scan.reason?.startsWith('spawn failed: ')) {
    console.log(`⚠️ Anchor candidate scan failed to spawn: ${scan.reason.slice('spawn failed: '.length)}`);
  }
  // The muxer numbers sequentially from 1, so the first gap is the end of the
  // run — enumerate by name rather than reading the directory back. The exit
  // code is deliberately not consulted: a partial run still wrote usable
  // frames, and the scorer rejects whatever didn't decode.
  const paths = [];
  for (let i = 1; i <= MAX_CANDIDATES; i++) {
    const p = join(candidateDir, `cand-${String(i).padStart(3, '0')}.png`);
    if (!existsSync(p)) break;
    paths.push(p);
  }
  // `complete` = the run reached EOF, which is what lets the caller read the
  // newest candidate as "one grid interval before the cut". A truncated run
  // numbers from the OLDEST frame just the same, so without this the caller
  // cannot tell "short clip" (candidates end at EOF) from "ffmpeg died partway"
  // (candidates end wherever it stopped) and would name the wrong offset.
  return { paths, complete: scan.ok };
}

// Extract a continuation anchor frame from the tail of a video as a PNG into
// data/images/ — used to chain a clip into the next render, and to feed the
// "continue from last frame" remix UX.
//
// The anchor is CHOSEN, not seeked to: several frames from the final
// TAIL_WINDOW_SECONDS are decoded and scored on focus, exposure, and recency
// (see lib/frameQuality.js), and the winner is installed. A single `-sseof`
// seek returns whichever frame lands first after the seek, which on
// motion-heavy local output is routinely a motion-blurred or mid-fade frame —
// and in a multi-chunk chain the next chunk inherits that blur as the scene's
// actual content, compounding through every subsequent hop.
//
// When no candidate carries any signal at all (a genuinely black or flat
// tail) or nothing decodes, this falls back to the original single-seek
// behavior and says so: a degraded anchor still beats failing the chain.
export async function extractLastFrame(historyId) {
  // Keep this service safe for callers outside the route layer too. Shared
  // gallery uploads deliberately use `upload-<uuid8>` ids, while generated
  // clips retain UUID ids.
  if (typeof historyId !== 'string' || (!UUID_RE.test(historyId) && !UPLOADED_HISTORY_ID_RE.test(historyId))) {
    throw new ServerError('Invalid history id', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const history = await loadHistory();
  const item = history.find((h) => h.id === historyId);
  if (!item) throw new ServerError('Video not found', { status: 404, code: 'NOT_FOUND' });
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new ServerError('ffmpeg not found on PATH', { status: 500, code: 'FFMPEG_MISSING' });
  // Validate against tampered history entries — without this, a `../...`
  // filename could make ffmpeg read arbitrary files outside data/videos.
  const videoPath = safeUnder(PATHS.videos, item.filename);
  if (!videoPath) throw new ServerError('Invalid video filename', { status: 400, code: 'VALIDATION_ERROR' });
  if (!existsSync(videoPath)) throw new ServerError('Video file not found on disk', { status: 404, code: 'NOT_FOUND' });

  await ensureDir(PATHS.images);
  // Same path-traversal concern as `item.filename` above — `item.id` could
  // contain path separators or `..` if history.json was tampered with.
  // Generated clips use UUID ids and uploads use `upload-<uuid8>`; both forms
  // are filename-safe. Do not trust a tampered stored record simply because
  // the caller's id passed validation above.
  if (typeof item.id !== 'string' || (!UUID_RE.test(item.id) && !UPLOADED_HISTORY_ID_RE.test(item.id))) {
    throw new ServerError('Invalid history id', { status: 400, code: 'VALIDATION_ERROR' });
  }
  // `anchor-` rather than the historical `lastframe-`: the file's contents are
  // now policy-dependent (a scored pick, not a fixed seek), so reusing the old
  // name would serve every pre-change file forever from the cache hit below
  // and make the improvement invisible on any clip a user already continued.
  // No migration needed — the new name simply misses once per clip.
  const frameFilename = `anchor-${item.id}.png`;
  const framePath = join(PATHS.images, frameFilename);
  // Cache hit: ffmpeg-extracted frames are deterministic for a given video,
  // so a file already on disk is reusable. UI clicks "Continue" repeatedly
  // (palette → continue, gallery → continue, etc.) and re-extracting on
  // every click was wasting 1–2s per click + spawning ffmpeg children.
  // Validate non-zero size — a prior ffmpeg crash could leave a 0-byte
  // placeholder, which would otherwise be served as a broken image forever.
  // Treat ANY stat failure (EACCES, EIO, etc.) as a cache miss rather than
  // letting it abort the request.
  const safeStatSize = (path) => {
    try {
      const s = statSync(path, { throwIfNoEntry: false });
      return s ? s.size : null;
    } catch {
      return null;
    }
  };
  // Sidecar carries the source video's prompt + provenance so the extracted
  // frame surfaces in the gallery with searchable metadata. Cache-hit path
  // calls this too so frames extracted before this change get backfilled.
  // `wx` flag makes the create-if-missing race-free — EEXIST is the no-op.
  const sidecarPath = join(PATHS.images, frameFilename.replace('.png', '.metadata.json'));
  // `extractedAt` names the offset the anchor actually came from, so the
  // gallery record says what it is instead of the fixed string 'last-frame'
  // (which was never true — the old seek landed somewhere in the final second).
  // The cache-hit and fallback paths genuinely don't know the offset, so they
  // keep the legacy value.
  const writeSidecar = async (extractedAt = 'last-frame') => {
    const meta = {
      filename: frameFilename,
      prompt: item.prompt,
      negativePrompt: item.negativePrompt,
      modelId: item.modelId,
      width: item.width,
      height: item.height,
      seed: item.seed,
      extractedFromVideoId: item.id,
      extractedFromVideoFilename: item.filename,
      extractedAt,
      kind: 'extracted-frame',
      createdAt: new Date().toISOString(),
    };
    await writeFileGuarded(sidecarPath, JSON.stringify(meta, null, 2), { flag: 'wx' }).catch(() => {});
  };

  // A cached anchor the fallback produced WITHOUT a scan is provisional: serving
  // it from the size>0 hit would pin a one-off ffmpeg or tmpdir failure to this
  // clip permanently, with no retry short of deleting the file by hand. An
  // absent or unparseable sidecar is NOT evidence of that — legacy files have
  // none — so only the explicit marker triggers a re-scan.
  const cachedIsProvisional = async () => {
    const raw = await tryReadFile(sidecarPath);
    if (!raw) return false;
    const parsed = JSON.parse(raw.toString());
    return parsed?.extractedAt === UNSCANNED_ANCHOR;
  };

  const cachedSize = safeStatSize(framePath);
  if (cachedSize != null && cachedSize > 0
      && !await cachedIsProvisional().catch(() => false)) {
    await writeSidecar();
    return { filename: frameFilename, path: `/data/images/${frameFilename}` };
  }
  if (cachedSize === 0) await unlinkGuarded(framePath).catch(() => {});

  // ── Scored pick over the tail window ──────────────────────────────────────
  // Everything here degrades to the single-seek fallback below rather than
  // throwing: this runs mid-chain, and a scan failure must not lose a render.
  const candidateDir = join(tmpdir(), `anchorcand-${item.id}`);
  const { paths: candidates, complete: scanComplete } = await decodeTailCandidates(ffmpeg, videoPath, candidateDir)
    .catch((err) => {
      console.log(`⚠️ Anchor candidate scan failed: ${err.message}`);
      return { paths: [], complete: false };
    });
  const best = candidates.length
    ? await pickBestFrame(candidates).catch((err) => {
        console.log(`⚠️ Anchor scoring failed: ${err.message}`);
        return null;
      })
    : null;
  // Copy straight to framePath and verify the result, rather than staging a
  // `.tmp` alongside it: PATHS.images is enumerated by the peer media-library
  // manifest, which skips only `.json`, so a staging file there would federate
  // as an image asset. A short copy is caught by the size check and unlinked,
  // so a truncated PNG can't be served forever by the size>0 cache hit above.
  // (A hard crash mid-copy can still leave one — the same exposure the fallback
  // ffmpeg write below has always had, not a new class.)
  const expectedSize = best ? safeStatSize(best.path) : null;
  const installed = best
    ? await copyFileGuarded(best.path, framePath).then(() => {
        const written = safeStatSize(framePath);
        if (written && (expectedSize == null || written === expectedSize)) return true;
        console.log(`⚠️ Anchor install wrote ${written ?? 'nothing'} of ${expectedSize ?? '?'} bytes — discarding`);
        return false;
      }).catch((err) => {
        console.log(`⚠️ Anchor install failed: ${err.message}`);
        return false;
      })
    : false;
  if (best && !installed) await unlinkGuarded(framePath).catch(() => {});
  // Drop the whole candidate dir either way — they're temp decodes and the
  // winner is already copied into data/images/ by now. `item.id` is validated
  // UUID/`upload-<uuid8>` above, so the recursive remove can't escape tmpdir.
  await rmGuarded(candidateDir, { recursive: true, force: true }).catch(() => {});

  // Both extraction paths below know the truth about this anchor, so they must
  // be able to REPLACE a sidecar written by an earlier attempt — `wx` alone
  // would leave a stale provisional marker in place and re-scan forever. This
  // is the extraction path (the cache hit already returned), so an unconditional
  // drop is right: whatever is written next is authoritative.
  await unlinkGuarded(sidecarPath).catch(() => {});

  if (installed) {
    // Offset derived from the candidates actually decoded, not from a nominal
    // window start: `-sseof` clamps to the file start on a clip shorter than
    // the window, so TAIL_WINDOW_SECONDS would name an offset the frame does
    // not have. The fps grid stops one interval short of EOF, so the newest
    // candidate is ~1/CANDIDATE_FPS from the end, not at it — hence
    // `length - index` rather than `length - 1 - index`. Accurate to within
    // one sampling interval, which is what the sidecar claims.
    // Only meaningful when the run reached EOF. A truncated scan's candidates
    // end wherever ffmpeg stopped, so the distance to the cut is unknown —
    // name the candidate instead of inventing a time.
    const offset = (candidates.length - best.index) / CANDIDATE_FPS;
    const where = scanComplete
      ? `-${offset.toFixed(2)}s`
      : `tail-candidate ${best.index + 1}/${candidates.length}`;
    await writeSidecar(where);
    console.log(`🎞️ Anchor frame ${best.index + 1}/${candidates.length} at ${where} (focus ${best.focus.toFixed(2)}): ${frameFilename}`);
    return { filename: frameFilename, path: `/data/images/${frameFilename}` };
  }
  if (candidates.length && !best) {
    console.log(`⚠️ No usable anchor among ${candidates.length} tail candidates for ${item.id.slice(0, 8)} — falling back to the end seek`);
  }

  return new Promise((resolve, reject) => {
    // -sseof -1.0 seeks 1s before end. The previous -0.1 was too tight on
    // videos with audio (B-frames + AV mux push the last keyframe earlier
    // than 100 ms from EOF), and ffmpeg silently returned 0 frames while
    // sometimes still exiting 0 — leaving a phantom-success log + missing
    // file. The output file gets a -update 1 flag so ffmpeg overwrites
    // any partial file from a prior failed run instead of erroring.
    const proc = spawn(ffmpeg, ['-sseof', '-1.0', '-i', videoPath, '-update', '1', '-vframes', '1', '-q:v', '2', '-y', framePath], safeChildProcessOptions({ stdio: 'ignore' }));
    proc.on('close', async (code) => {
      // Wrap the body so a throw (e.g. writeSidecar) routes to reject() instead
      // of leaking an unhandled rejection AND leaving this Promise forever
      // pending — the executor only settles via the explicit resolve/reject.
      try {
        // safeStatSize swallows throws so the async handler can't leak an
        // unhandled rejection on transient stat errors — null is treated as
        // "extraction failed".
        const writtenSize = safeStatSize(framePath);
        if (code !== 0 || writtenSize == null || writtenSize === 0) {
          // A 0-byte file is a partial extraction, not a cache-worthy result —
          // delete it so the next call retries instead of returning a broken
          // image from the cache hit above.
          if (writtenSize === 0) await unlinkGuarded(framePath).catch(() => {});
          return reject(new ServerError('Failed to extract last frame', { status: 500, code: 'FFMPEG_FAILED' }));
        }
        // A scan that RAN and found nothing usable is a property of the clip —
        // cache it. Everything else reaching here is transient (the scan could
        // not run, or a winner was found and the install failed), and caching it
        // would pin this degraded frame forever behind the size>0 cache hit.
        // Key on what actually happened, not merely on candidate count.
        await writeSidecar(candidates.length && !best ? 'last-frame' : UNSCANNED_ANCHOR);
        console.log(`🎞️ Anchor frame via end-seek fallback: ${frameFilename}`);
        resolve({ filename: frameFilename, path: `/data/images/${frameFilename}` });
      } catch (err) {
        reject(err instanceof ServerError ? err : new ServerError(`Failed to extract last frame: ${err.message}`, { status: 500, code: 'FFMPEG_FAILED' }));
      }
    });
    proc.on('error', (err) => {
      reject(new ServerError(`ffmpeg failed to spawn: ${err.message}`, { status: 500, code: 'FFMPEG_FAILED' }));
    });
  });
}

// Sample N evenly-spaced frames from a video for multi-frame LLM evaluation.
// Thin wrapper around the canonical lib/ffmpeg.js helper `extractEvaluationFrames`
// that derives the video path from the jobId so call-sites don't need to know
// the storage layout. Returns [] on any failure — callers fall back to the
// single-thumbnail prompt path.
export async function sampleEvaluationFrames(jobId, count = 5) {
  const videoPath = join(PATHS.videos, `${jobId}.mp4`);
  if (!existsSync(videoPath)) return [];
  const filenames = await extractEvaluationFrames(videoPath, jobId, count);
  if (filenames.length) console.log(`🎞️ CD sampled ${filenames.length} evaluation frames for ${jobId.slice(0, 8)}`);
  return filenames;
}

// Concat selected videos (preserving order) into a single MP4. Uses ffmpeg's
// concat demuxer with a stream copy, so it's fast and lossless — but the
// inputs must then share codec/resolution. The Media History page already only
// lets users stitch from a single model so this holds in practice.
//
// A caller that needs leading frames dropped from some inputs passes `trims`
// instead; that switches to a concat FILTER GRAPH, which applies the cuts and
// the concat in one encode. Nothing else reaches the filter graph, so the
// hand-stitch path from Media History keeps its stream-copy fast path.
//
// `opts` lets the chained-render code reuse the same ffmpeg path with a
// different identity (id, filename prefix, history-link key, prompt, per-chunk
// beats) without duplicating the validation + concat-manifest plumbing.
