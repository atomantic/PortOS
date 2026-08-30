/** Lossless hand stitching and trim-aware chained-video assembly. */

import { existsSync } from 'fs';
import { unlink, writeFile } from 'fs/promises';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { spawn } from '../../lib/childProcess.js';
import { PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import {
  findFfmpeg, safeUnder, generateThumbnail, optimizeForStreaming,
  hasAudioStream, buildTrimConcatArgs, bt709TagFilter,
} from '../../lib/ffmpeg.js';
import { safeChildProcessOptions } from '../../lib/processEnv.js';
import { loadHistory, mutateVideoHistory } from './history.js';

// Fold the per-chunk DRAFTDECODE: reports into one claim, or none. Unanimity is
// on the `applied` verdict rather than deep equality: two chunks that both fell
// back agree about the clip's fidelity even if their failure reasons differ.
const unanimousDraftDecodeOutcome = (videos) => {
  const first = videos[0]?.draftDecodeApplied;
  if (first === undefined) return {};
  return videos.every((v) => v?.draftDecodeApplied?.applied === first.applied)
    ? { draftDecodeApplied: first }
    : {};
};

export async function stitchVideos(videoIds, opts = {}) {
  const {
    id = randomUUID(),
    filenamePrefix = 'stitched',
    historyKey = 'stitchedFrom',
    promptOverride = null,
    // Per-chunk prompt beats to record on the stitched entry (#3695) — chained
    // renders only; a hand-stitched clip has no beats.
    chunkPrompts = null,
    // Optional `Map<videoId, { startFrame, frames }>` — leading frames to drop
    // from an input, and the frame count it contributes once they're gone.
    //
    // A chained render's windowed chunks open with an echo of the tail window
    // they were conditioned on, which the timeline already holds. Cutting that
    // echo in this concat's filter graph costs nothing beyond the timeline
    // encode; pre-trimming each chunk file instead would add one full encode
    // per chunk and re-grade the trimmed chunks relative to their siblings.
    //
    // Both numbers are MEASUREMENTS of the file, which is why they have to
    // come from the caller: a history entry's own `numFrames` is the count the
    // clip was RENDERED at — a render parameter Remix reuses — and an extend
    // render's output is `source + extension`, so its file is materially
    // longer than that. `startFrame: 0` is therefore meaningful on its own:
    // "no cut, but here is the real length." Only a non-zero offset routes the
    // concat through the filter graph.
    trims = null,
  } = opts;
  if (!Array.isArray(videoIds) || videoIds.length < 2) {
    throw new ServerError('Need at least 2 videos to stitch', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new ServerError('ffmpeg not found on PATH', { status: 500, code: 'FFMPEG_MISSING' });

  const history = await loadHistory();
  const videos = videoIds.map((vid) => history.find((h) => h.id === vid)).filter(Boolean);
  if (videos.length < 2) throw new ServerError('Some videos not found', { status: 400, code: 'VALIDATION_ERROR' });

  // Validate every history-supplied filename through safeUnder before
  // letting it reach ffmpeg's concat manifest. Tampered history entries
  // could otherwise smuggle `..` segments into ffmpeg input.
  const videoPaths = videos.map((v) => safeUnder(PATHS.videos, v.filename));
  if (videoPaths.some((p) => !p)) {
    throw new ServerError('One or more video filenames failed validation', { status: 400, code: 'VALIDATION_ERROR' });
  }
  for (const p of videoPaths) {
    if (!existsSync(p)) throw new ServerError(`Missing: ${basename(p)}`, { status: 404, code: 'NOT_FOUND' });
  }

  // Measured cut + contribution per input, in `videos` order. A zero offset
  // means the input joins whole (the entry is then purely a length
  // measurement); any non-zero offset routes the whole concat through the
  // filter graph, since only that path can express a cut.
  const trimPlan = videos.map((v) => {
    const entry = trims?.get?.(v.id);
    if (!entry) return null;
    const frames = Number(entry.frames);
    return {
      startFrame: Math.max(0, Math.floor(Number(entry.startFrame) || 0)),
      frames: Number.isFinite(frames) && frames >= 0 ? frames : null,
    };
  });

  const listFile = join(tmpdir(), `concat-${id}.txt`);
  // Set before the write, not after: `writeFile` creates and truncates the
  // file before it writes, so a failure partway through still leaves one on
  // disk to clean up. Unlinking a file that was never created is a no-op here.
  let listFileWritten = false;
  const writeConcatList = async () => {
    // ffmpeg concat-demuxer escape: per its docs, single quotes in filenames
    // must be replaced with `'\''`. Inside quoted strings ffmpeg also treats
    // backslash as an escape character — on Windows where paths are
    // `C:\foo\bar.mp4`, that corrupts the path. Normalize to forward slashes
    // (which ffmpeg accepts on Windows just fine) before quoting.
    const escapeForConcat = (p) => p.replace(/\\/g, '/').replace(/'/g, "'\\''");
    listFileWritten = true;
    await writeFile(listFile, videoPaths.map((p) => `file '${escapeForConcat(p)}'`).join('\n'));
  };

  const outFilename = `${filenamePrefix}-${id}.mp4`;
  const outPath = join(PATHS.videos, outFilename);

  // `captureStderr` keeps the last line of ffmpeg's own diagnostics on the
  // error, so a failure reads as something other than a bare "Stitch failed" —
  // which can't tell a filter-graph parse error from a full disk. Split on \r
  // as well as \n: ffmpeg separates its progress lines with a bare carriage
  // return, so a failure mid-encode would otherwise trail a run of them behind
  // the line that matters.
  const runFfmpeg = (args, { captureStderr = false } = {}) => new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args, safeChildProcessOptions({ stdio: captureStderr ? ['ignore', 'ignore', 'pipe'] : 'ignore' }));
    let tail = '';
    proc.stderr?.on('data', (d) => { tail = `${tail}${d}`.slice(-400); });
    proc.on('close', (code) => code === 0
      ? resolve()
      : reject(new ServerError(`Stitch failed${tail ? `: ${tail.split(/[\r\n]+/).filter(Boolean).pop()?.trim() || ''}` : ''}`, { status: 500, code: 'FFMPEG_FAILED' })));
    proc.on('error', (err) => reject(new ServerError(`ffmpeg failed to spawn: ${err.message}`, { status: 500, code: 'FFMPEG_FAILED' })));
  });

  // Inputs with a real cut, as opposed to the measurement-only entries. Zero
  // means the demuxer can do the job.
  const cutCount = trimPlan.filter((t) => t?.startFrame > 0).length;
  // Tracks whether the cuts actually made it into the output, so `numFrames`
  // below reports the timeline that exists rather than the one we asked for.
  let trimsApplied = cutCount > 0;
  // Use a try/finally so the concat list temp file is cleaned up even when
  // ffmpeg rejects — otherwise it leaks one file per failed stitch.
  try {
    if (trimsApplied) {
      const args = buildTrimConcatArgs({
        inputs: videoPaths.map((path, i) => ({ path, startFrame: trimPlan[i]?.startFrame || 0 })),
        outPath,
        // Canonical geometry/rate for the graph's normalization filters. Taken
        // from the first input the same way modelId/seed are below — every
        // caller that reaches here stitches one model's own output.
        width: videos[0].width,
        height: videos[0].height,
        fps: videos[0].fps,
        // `concat=a=1` needs an audio leg from EVERY input; one silent clip in
        // the set makes the whole graph video-only.
        withAudio: (await Promise.all(videoPaths.map((p) => hasAudioStream(p)))).every(Boolean),
        // Pin BT.709 on the stitched output — this is the only re-encode a
        // chained render's timeline gets, so an untagged result here is what a
        // player would have to guess at. `null` on an ffmpeg without the
        // filter; the container flags ride along inside the builder regardless.
        colorTagFilter: await bt709TagFilter(),
      });
      const failure = args
        ? await runFfmpeg(args, { captureStderr: true }).then(() => null, (err) => err)
        : new Error('could not build the concat filter graph');
      if (failure) {
        // Degrade rather than throw away a whole chained render: the untrimmed
        // inputs were never re-encoded, so they're still in codec lockstep and
        // the stream-copy concat below can salvage the clip. The cost is the
        // echoed context replaying at each trimmed seam.
        console.log(`⚠️ Trimmed concat failed (${failure.message}) — falling back to a stream copy; ${cutCount} seam(s) will repeat their context`);
        trimsApplied = false;
      }
    }
    if (!trimsApplied) {
      await writeConcatList();
      // This one is fatal — its rejection is what the caller surfaces — so it
      // needs the cause even more than the survivable run above does.
      await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-y', outPath], { captureStderr: true });
    }
    await optimizeForStreaming(outPath);
  } finally {
    if (listFileWritten) await unlink(listFile).catch(() => {});
  }

  const thumb = await generateThumbnail(outPath, id);
  const stitchedMeta = {
    id,
    prompt: promptOverride != null
      ? promptOverride
      : `Stitched: ${videos.map((v) => v.prompt).join(' + ')}`,
    modelId: videos[0].modelId,
    seed: videos[0].seed ?? 0,
    width: videos[0].width,
    height: videos[0].height,
    // What each input actually contributes. A measured plan wins over the
    // entry's own `numFrames` either way — but when the cuts didn't make it
    // into the output, the input contributes its WHOLE measured length
    // (`startFrame + frames`), not the trimmed length we asked for.
    numFrames: videos.reduce((sum, v, i) => {
      const plan = trimPlan[i];
      const measured = plan?.frames == null
        ? null
        : (trimsApplied ? plan.frames : plan.startFrame + plan.frames);
      return sum + (measured ?? v.numFrames ?? 0);
    }, 0),
    fps: videos[0].fps,
    filename: outFilename,
    thumbnail: thumb,
    createdAt: new Date().toISOString(),
    [historyKey]: videoIds,
    ...(Array.isArray(chunkPrompts) ? { chunkPrompts } : {}),
    // The stitched clip is the chain's visible history row, so it must carry
    // the same render controls and provenance as the hidden chunks. Preserve
    // meaningful falsey values (guidance 0, audio enabled, empty conditioning)
    // while keeping legacy/partial entries free of explicit undefined fields.
    ...Object.fromEntries([
      'steps',
      'guidanceScale',
      'tiling',
      'disableAudio',
      'mode',
      'textEncoderId',
      'imageStrength',
      'i2vReferenceMode',
      'conditioning',
      'renderInputsVersion',
      // Speed profile (#4875) — the REQUESTED schedule and what the runner
      // actually applied. Inherited for a stronger reason than the dials above:
      // a chain's chunk entries are written `hidden: true`, so this stitched
      // record is the ONLY one the user ever sees. Without it the lightbox's
      // "Speed profile" row never renders for a chained render — including a
      // chain whose TeaCache or adapter was unavailable, which is exactly the
      // silent speed claim the feature exists to prevent — and a Remix quietly
      // reverts to Quality. A chain applies its profile to every chunk or to
      // none (resolveVideoSpeedProfileForModes), so videos[0] speaks for all.
      'speedProfileId',
      'speedProfileApplied',
      // Draft decode REQUEST (#5423) — chain-wide by construction: every chunk
      // is submitted with the same `draftDecode`, and the gate that resolves it
      // is mode-independent, so videos[0] speaks for all. Inherited for the same
      // reason as the speed profile above — the chunks are hidden, so without it
      // the stitched record could never say the clip was decoded at preview
      // fidelity, and a Remix would quietly revert to Full.
      'draftDecode',
    ].flatMap((key) => videos[0][key] === undefined ? [] : [[key, videos[0][key]]])),
    // The draft-decode OUTCOME is decided per child process — the runner falls
    // back to the full decoder on any load failure — so unlike the request
    // above, videos[0] does NOT speak for the chain. Inherited only when every
    // chunk agrees; on a mixed chain the field is omitted, which the lightbox
    // already renders as "outcome not reported". Asserting chunk 0's verdict
    // over a clip whose later chunks decoded differently would be exactly the
    // false fidelity claim this field exists to prevent.
    ...unanimousDraftDecodeOutcome(videos),
    // Inherit applied LoRAs from the first constituent clip (a chunk chain
    // shares one LoRA set across all chunks), so the visible stitched entry
    // round-trips LoRAs on Remix the same way a single render does — mirrors
    // how modelId/seed/width above are taken from videos[0].
    ...(Array.isArray(videos[0].loraFilenames) && videos[0].loraFilenames.length ? {
      loraFilenames: videos[0].loraFilenames,
      loraScales: videos[0].loraScales,
    } : {}),
  };
  // Serialized append against the shared history tail (re-reads the freshest
  // list inside the mutator) so a concurrent download/render write can't drop
  // this stitched entry.
  await mutateVideoHistory((history) => { history.unshift(stitchedMeta); return history; });
  console.log(`🎬 Stitched ${videos.length} videos → ${outFilename}`);
  return stitchedMeta;
}
