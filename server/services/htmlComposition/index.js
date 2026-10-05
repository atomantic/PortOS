import { maintenance } from '../../lib/maintenanceAdmission.js';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { cp, lstat, mkdtemp, open, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { PATHS, ensureDir, unlinkGuarded } from '../../lib/fileUtils.js';
import { LAUNCH_VIDEO_FORMATS, LAUNCH_VIDEO_FORMAT_SIZES, htmlCompositionContractSchema, htmlCompositionContractSchemaFor, htmlCompositionRenderSchema, validateRequest } from '../../lib/validation.js';
import { generateThumbnail } from '../../lib/ffmpeg.js';
import { videoGenEvents } from '../videoGen/events.js';
import { mutateVideoHistory } from '../videoGen/history.js';
import { resolveMusicTrackPath } from '../pipeline/audioMux.js';
import { openComposition } from './browser.js';
import { encodeComposition, encodeContactSheet, proofTimes, synthesizeCompositionMusic } from './encode.js';
import { validateLaunchVideoAssets } from '../../lib/launchVideoValidation.js';

const active = new Map();
// A music-video owner may run as long as its song, and no longer than this.
const MUSIC_VIDEO_DURATION_CAP_SEC = 900;
const MUSIC_VIDEO_OWNER = 'music-video';

function insideData(root, path) {
  const rel = relative(root, path);
  return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith('../') && !isAbsolute(rel);
}

// A missing feature block is null. An array (including []) is not a feature
// track — #9073's block is an object, and "not analyzed" must not look like
// a measured empty track.
function normalizeSongDocument(song) {
  const source = song && typeof song === 'object' && !Array.isArray(song) ? song : {};
  const features = source.features;
  return {
    beats: Array.isArray(source.beats) ? source.beats : [],
    downbeats: Array.isArray(source.downbeats) ? source.downbeats : [],
    sections: Array.isArray(source.sections) ? source.sections : [],
    features: features !== null && typeof features === 'object' && !Array.isArray(features) ? features : null,
    words: Array.isArray(source.words) ? source.words : null,
  };
}

async function resolveMusicVideoOwner({ owner, audio, maxDurationSec }) {
  if (owner == null) return null;
  if (owner !== MUSIC_VIDEO_OWNER) throw new Error('Unknown composition owner');
  if (!audio || typeof audio.path !== 'string' || !audio.path || audio.path.includes('\0')) {
    throw new Error('Music-video renders require an audio master path');
  }
  const startSec = audio.startSec ?? 0;
  if (!Number.isFinite(startSec) || startSec < 0) throw new Error('audio.startSec must be a non-negative number');
  if (!Number.isFinite(maxDurationSec) || maxDurationSec < 1) throw new Error('maxDurationSec must be the song duration');
  let info;
  try { info = await stat(audio.path); } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Music-video audio master is missing');
    throw error;
  }
  if (!info.isFile()) throw new Error('Music-video audio master must be a regular file');
  return {
    audio: { path: audio.path, startSec },
    maxDurationSec: Math.min(MUSIC_VIDEO_DURATION_CAP_SEC, maxDurationSec),
  };
}

export const MUSIC_VIDEO_SCRATCH_DIR = 'music-video-song-renders';

// Copy the composition into this job's scratch directory and write song.json
// before openComposition freezes the snapshot. The page fetches it by relative
// URL, so the network-refusing sandbox stays unchanged. `prepare(dir)` lets a
// caller add job files (a music-video document's portos-mv.js and scene media)
// to the private copy before the snapshot; the caller removes `scratchRoot`.
export async function stageMusicVideoComposition(sourceDirectory, jobId, song, { prepare } = {}) {
  if (typeof jobId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(jobId)) throw new Error('Invalid composition job id');
  const root = await realpath(PATHS.data);
  const source = await realpath(resolve(root, sourceDirectory));
  if (!insideData(root, source)) throw new Error('directory must be inside data');
  const scratchRoot = join(root, MUSIC_VIDEO_SCRATCH_DIR, jobId);
  try {
    await rm(scratchRoot, { recursive: true, force: true });
    const compositionDir = join(scratchRoot, 'composition');
    await ensureDir(scratchRoot);
    await cp(source, compositionDir, { recursive: true, verbatimSymlinks: true });
    await writeFile(join(compositionDir, 'song.json'), `${JSON.stringify(normalizeSongDocument(song))}\n`);
    if (prepare) await prepare(compositionDir);
    return { directory: `${MUSIC_VIDEO_SCRATCH_DIR}/${jobId}/composition`, scratchRoot };
  } catch (error) {
    await rm(scratchRoot, { recursive: true, force: true }).catch(cleanupError => {
      maintenance.markCurrentUnsettled();
      throw cleanupError;
    });
    throw error;
  }
}

export function cancel(jobId) {
  const job = active.get(jobId);
  if (!job || job.committing) return false;
  job.controller.abort(new Error('Render canceled'));
  return true;
}

// The frame fields a render publishes; `formats`/`layout` describe the source only.
// Render-time motion-blur presets (#9080), in the contract's own motionBlur shape.
const MOTION_BLUR_PRESETS = { off: 1, light: { shutter: 0.25, samples: 'auto', tolerance: 2 }, film: { shutter: 0.5, samples: 'auto', tolerance: 2 } };

const frameOf = ({ durationSec, fps, width, height, motionBlur }) => ({ durationSec, fps, width, height, motionBlur });

/**
 * The frames one job renders from a single timeline (#8960). Without requested
 * formats it is the composition's own size under the job id, exactly as before.
 * A named format other than the composition's own size must be declared in
 * portosComposition.formats, so a fixed-layout scene is never squeezed into a
 * frame it was not written for. Duration, fps and timing are shared by all.
 */
function renderTargets(contract, jobId, formats) {
  if (!formats) return [{ id: jobId, format: null, contract }];
  const own = `${contract.width}x${contract.height}`;
  return LAUNCH_VIDEO_FORMATS.filter(format => formats.includes(format)).map(format => {
    const size = LAUNCH_VIDEO_FORMAT_SIZES[format];
    if (size !== own && !contract.formats?.includes(size)) {
      throw new Error(`portosComposition.formats must include ${size} to render ${format}`);
    }
    const [width, height] = size.split('x').map(Number);
    return { id: `${jobId}-${format}`, format, contract: { ...contract, width, height } };
  });
}

// Every name deliver() will exclusively create for this run, single- and
// multi-format alike, in the same write order as the delivery loop below.
function deliveryNames(targets) {
  const names = ['plan.md', 'storyboard.json', 'caption.txt'];
  for (const target of targets) {
    const suffix = target.format ? `-${target.format}` : '';
    names.push(`video${suffix}.mp4`, `poster${suffix}.jpg`);
  }
  return names;
}

export async function renderComposition(options) {
  return maintenance.run('composition', options.jobId, () => renderCompositionAdmitted(options), { continuation: true });
}

async function renderCompositionAdmitted({ jobId, owner, audio, maxDurationSec, song, ...input }) {
  const job = { controller: new AbortController(), committing: false };
  active.set(jobId, job);
  const { signal } = job.controller;
  let page;
  let audioDirectory;
  let scratchRoot;
  let success = false;
  let result;
  let failure;
  // Every file this job creates, recorded before its first byte, so a failure
  // or cancellation removes all formats' partial output.
  const ownedPaths = [];
  const deliver = async (target, write) => {
    const handle = await open(target, 'wx');
    // Record ownership after exclusive creation, before any fallible I/O.
    ownedPaths.push(target);
    try { await write(handle); } finally { await handle.close(); }
  };
  try {
    const musicVideo = await resolveMusicVideoOwner({ owner, audio, maxDurationSec });
    const parsedInput = validateRequest(htmlCompositionRenderSchema, input);
    let { directory } = parsedInput;
    const sourceDirectory = directory;
    const { musicTrack, launchVideo, synthesizeMusic, proof, formats, motionBlur: blurChoice, masterLoudness } = parsedInput;
    // A music-video render may still ask for the extra frames its contract
    // declares in portosComposition.formats (renderTargets enforces that).
    if (musicVideo && (launchVideo || synthesizeMusic || musicTrack || proof)) {
      throw new Error('A music-video composition render cannot use launch-video, proof, or library-music options');
    }
    let musicPath = musicTrack ? await resolveMusicTrackPath(musicTrack) : null;
    if (musicTrack && !musicPath) throw new Error('musicTrack is missing from the Music library');
    signal.throwIfAborted();
    let launchPlan;
    let launchAssets;
    let deliveryRoot;
    if (launchVideo?.appId) {
      const expected = `launch-videos/${launchVideo.appId}/${launchVideo.runId}/composition`;
      if (directory !== expected) throw new Error('Launch-video directory does not match its app and run');
      const dataRoot = await realpath(PATHS.data);
      if (await realpath(join(dataRoot, directory)) !== resolve(dataRoot, directory)) throw new Error('Launch-video directory must not be a symlink');
      deliveryRoot = join(dataRoot, 'launch-videos', launchVideo.appId, launchVideo.runId);
    }
    const needsLaunchGate = launchVideo || directory.split('/')[0] === 'launch-videos';
    // One page and one frozen snapshot per job: the privacy and storyboard
    // gates run once however many formats render from it.
    if (musicVideo) {
      const staged = await stageMusicVideoComposition(directory, jobId, song);
      directory = staged.directory;
      scratchRoot = staged.scratchRoot;
      signal.throwIfAborted();
    }
    page = await openComposition(directory, { signal, validateAssets: needsLaunchGate
      ? assets => { launchPlan = validateLaunchVideoAssets(assets, launchVideo); launchAssets = assets; }
      : undefined });
    const metadata = await page.evaluate(`(() => {
      const c = globalThis.portosComposition;
      if (!c || typeof c.seek !== 'function') throw new Error('portosComposition.seek is required');
      return { durationSec: c.durationSec, fps: c.fps, width: c.width, height: c.height, motionBlur: c.motionBlur,
        formats: c.formats, layout: typeof c.layout === 'function' };
    })()`);
    const contractSchema = musicVideo
      ? htmlCompositionContractSchemaFor(musicVideo.maxDurationSec)
      : htmlCompositionContractSchema;
    const parsed = contractSchema.safeParse(metadata);
    if (!parsed.success) throw new Error(parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '));
    const contract = blurChoice ? { ...parsed.data, motionBlur: MOTION_BLUR_PRESETS[blurChoice] } : parsed.data;
    if (launchPlan && Math.abs(contract.durationSec - launchPlan.durationSec) > 1e-8) {
      throw new Error('Composition durationSec must match storyboard.json');
    }
    if (proof) {
      const [target] = renderTargets(contract, jobId, proof.format && [proof.format]);
      // Launch runs keep their proofs beside the run so the iteration history
      // stays with the take; other compositions share one proofs directory.
      // The result names the sheet relative to the data directory, never an
      // absolute host path: job results are visible to API and SSE clients.
      const proofName = `contact-${jobId}.png`;
      const proofFile = deliveryRoot ? `launch-videos/${launchVideo.appId}/${launchVideo.runId}/proofs/${proofName}` : `composition-proofs/${proofName}`;
      const proofPath = deliveryRoot ? join(deliveryRoot, 'proofs', proofName) : join(PATHS.data, proofFile);
      await ensureDir(dirname(proofPath));
      const times = proofTimes(contract.durationSec, proof.everySec);
      ownedPaths.push(proofPath);
      const { columns } = await encodeContactSheet(page, target.contract, proofPath, { times, signal });
      page.check();
      await page.close({ verify: true });
      page = null;
      signal.throwIfAborted();
      success = true;
      result = { generationId: jobId, id: jobId, proof: { file: proofFile, url: `/data/${proofFile}`, times, columns,
        ...(target.format ? { format: target.format } : {}), ...frameOf(target.contract) } };
    } else {
      const targets = renderTargets(contract, jobId, formats);
      if (deliveryRoot) {
        // Refuse before spending a capture. deliver()'s exclusive open('wx')
        // below is still the race-safe authority; this only saves the retry
        // a full render before it learns what that open would have told it.
        // lstat also refuses a symlinked delivery name.
        for (const name of deliveryNames(targets)) {
          const target = join(deliveryRoot, name);
          let exists = true;
          try { await lstat(target); } catch (error) { if (error.code !== 'ENOENT') throw error; exists = false; }
          if (exists) {
            const error = new Error(`EEXIST: file already exists, open '${target}'`);
            error.code = 'EEXIST';
            throw error;
          }
        }
      }
      if (synthesizeMusic) {
        // One score for every format: they share the timeline and duration.
        const wav = await synthesizeCompositionMusic(page, contract.durationSec);
        page.check();
        audioDirectory = await mkdtemp(join(tmpdir(), 'portos-composition-audio-'));
        musicPath = join(audioDirectory, 'score.wav');
        await writeFile(musicPath, wav, { flag: 'wx' });
      }
      await ensureDir(PATHS.videos);
      const frameCount = (item) => Math.round(item.durationSec * item.fps);
      const framesTotal = targets.reduce((sum, target) => sum + frameCount(target.contract), 0);
      let framesDone = 0;
      const startedAt = Date.now();
      const rendered = [];
      for (const target of targets) {
        const filename = `composition-${target.id}.mp4`;
        const outputPath = join(PATHS.videos, filename);
        const targetFrames = frameCount(target.contract);
        ownedPaths.push(outputPath, join(PATHS.videoThumbnails, `${target.id}.jpg`));
        const { sampleHistogram, loudness } = await encodeComposition(page, target.contract, outputPath, {
          musicPath: musicVideo ? null : musicPath,
          master: masterLoudness !== false,
          audio: musicVideo?.audio,
          signal,
          onProgress: (fraction, detail) => {
            const done = framesDone + (detail?.frame ?? Math.round(fraction * targetFrames));
            const elapsed = Date.now() - startedAt;
            const etaMs = done > 0 && done < framesTotal && elapsed > 0
              ? Math.max(1, Math.round(elapsed * (framesTotal - done) / done))
              : undefined;
            videoGenEvents.emit('progress', {
              generationId: jobId,
              progress: framesTotal ? (done / framesTotal) * 0.95 : 0,
              step: done,
              totalSteps: framesTotal,
              ...(etaMs != null ? { etaMs } : {}),
              message: `Rendering frame ${done}/${framesTotal}`,
            });
          },
        });
        framesDone += targetFrames;
        page.check();
        rendered.push({ ...target, filename, outputPath, sampleHistogram, loudness });
      }
      // End script execution before post-processing and publishing the result.
      await page.close({ verify: true });
      page = null;
      signal.throwIfAborted();
      for (const video of rendered) {
        video.thumbnail = await generateThumbnail(video.outputPath, video.id, launchPlan ? { atSec: launchPlan.posterSec } : undefined);
        if (!video.thumbnail) throw new Error('Composition thumbnail generation failed');
        signal.throwIfAborted();
      }
      let launchMetadata;
      if (deliveryRoot) {
        // Exclusive creation refuses pre-existing files/symlinks. Publish only the
        // validated snapshot, never re-read source prose after rendering.
        for (const name of ['plan.md', 'storyboard.json', 'caption.txt']) {
          await deliver(join(deliveryRoot, name), handle => handle.writeFile(launchAssets.get(`/${name}`)));
        }
        // A multi-format run names each file by its frame; a single-format
        // render keeps the original video.mp4/poster.jpg names.
        for (const video of rendered) {
          const suffix = video.format ? `-${video.format}` : '';
          for (const [source, name] of [[video.outputPath, `video${suffix}.mp4`], [join(PATHS.videoThumbnails, video.thumbnail), `poster${suffix}.jpg`]]) {
            await deliver(join(deliveryRoot, name), handle => pipeline(createReadStream(source), handle.createWriteStream()));
          }
        }
        launchMetadata = { appId: launchVideo.appId, runId: launchVideo.runId,
          ...(launchVideo.sourceVideoId ? { sourceVideoId: launchVideo.sourceVideoId } : {}),
          musicTrack: musicTrack ?? null, synthesizeMusic: Boolean(synthesizeMusic),
          caption: launchAssets.get('/caption.txt').toString('utf8').trim(), posterSec: launchPlan.posterSec };
      }
      signal.throwIfAborted();
      // Once the shared history write starts, cancellation must be refused.
      job.committing = true;
      const createdAt = new Date().toISOString();
      // One Media History entry per format, linked by launchVideo.runId and
      // written in a single mutation so a run registers all formats or none.
      const metas = rendered.map(video => ({
        id: video.id, prompt: `HTML composition: ${sourceDirectory}`, modelId: 'html-composition', seed: 0,
        ...frameOf(video.contract), numFrames: Math.round(contract.durationSec * contract.fps),
        ...(launchMetadata ? { launchVideo: launchMetadata, appId: launchMetadata.appId, posterSec: launchPlan.posterSec } : {}),
        ...(video.sampleHistogram ? { sampleHistogram: video.sampleHistogram } : {}),
        ...(video.loudness ? { loudness: video.loudness } : {}),
        filename: video.filename, thumbnail: video.thumbnail, createdAt,
      }));
      await mutateVideoHistory(history => { history.unshift(...metas); return history; });
      success = true;
      // `id`/`filename` name a real history entry (the first format); `generationId`
      // is the job. A single-format render keeps id === generationId as before.
      // A shutter-blur render reports how many output frames took each
      // sub-frame count, so the user can see where the render time went.
      const summary = ({ id, filename, thumbnail, sampleHistogram, loudness }) => ({ id, filename, thumbnail, path: `/data/videos/${filename}`,
        ...(sampleHistogram ? { sampleHistogram } : {}), ...(loudness ? { loudness } : {}) });
      const [first] = rendered;
      result = { ...(launchMetadata ? { appId: launchMetadata.appId } : {}), generationId: jobId, ...summary(first),
        ...(formats ? { videos: rendered.map(video => ({ format: video.format, ...summary(video) })) } : {}) };
    }
  } catch (error) {
    if (job.committing) maintenance.markCurrentUnsettled();
    failure = error;
  } finally {
    if (page) await page.close().catch(error => {
      maintenance.markCurrentUnsettled();
      failure ||= error;
    });
    if (audioDirectory) await rm(audioDirectory, { recursive: true, force: true }).catch(() => {
      maintenance.markCurrentUnsettled();
      console.warn('⚠️ Could not remove temporary composition audio');
    });
    if (scratchRoot) await rm(scratchRoot, { recursive: true, force: true }).catch(() => {
      maintenance.markCurrentUnsettled();
      console.warn('⚠️ Could not remove temporary music-video composition');
    });
    if (!success) {
      for (const path of ownedPaths) await unlinkGuarded(path).catch(error => { if (error.code !== 'ENOENT') maintenance.markCurrentUnsettled(); });
    }
    active.delete(jobId);
  }
  // Cleanup precedes the terminal event, so the queue cannot advance early.
  if (failure) throw failure;
  videoGenEvents.emit('completed', result);
  return result;
}
