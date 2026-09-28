import { dirname, join, resolve } from 'node:path';
import { lstat, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { PATHS, ensureDir, unlinkGuarded } from '../../lib/fileUtils.js';
import { LAUNCH_VIDEO_FORMATS, LAUNCH_VIDEO_FORMAT_SIZES, htmlCompositionContractSchema, htmlCompositionRenderSchema, validateRequest } from '../../lib/validation.js';
import { generateThumbnail } from '../../lib/ffmpeg.js';
import { videoGenEvents } from '../videoGen/events.js';
import { mutateVideoHistory } from '../videoGen/history.js';
import { resolveMusicTrackPath } from '../pipeline/audioMux.js';
import { openComposition } from './browser.js';
import { encodeComposition, encodeContactSheet, proofTimes, synthesizeCompositionMusic } from './encode.js';
import { validateLaunchVideoAssets } from '../../lib/launchVideoValidation.js';

const active = new Map();

export function cancel(jobId) {
  const job = active.get(jobId);
  if (!job || job.committing) return false;
  job.controller.abort(new Error('Render canceled'));
  return true;
}

// The frame fields a render publishes; `formats`/`layout` describe the source only.
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

export async function renderComposition({ jobId, ...input }) {
  const job = { controller: new AbortController(), committing: false };
  active.set(jobId, job);
  const { signal } = job.controller;
  let page;
  let audioDirectory;
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
    const { directory, musicTrack, launchVideo, synthesizeMusic, proof, formats } = validateRequest(htmlCompositionRenderSchema, input);
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
    page = await openComposition(directory, { signal, validateAssets: needsLaunchGate
      ? assets => { launchPlan = validateLaunchVideoAssets(assets, launchVideo); launchAssets = assets; }
      : undefined });
    const metadata = await page.evaluate(`(() => {
      const c = globalThis.portosComposition;
      if (!c || typeof c.seek !== 'function') throw new Error('portosComposition.seek is required');
      return { durationSec: c.durationSec, fps: c.fps, width: c.width, height: c.height, motionBlur: c.motionBlur,
        formats: c.formats, layout: typeof c.layout === 'function' };
    })()`);
    const parsed = htmlCompositionContractSchema.safeParse(metadata);
    if (!parsed.success) throw new Error(parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '));
    const contract = parsed.data;
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
      const rendered = [];
      for (const [index, target] of targets.entries()) {
        const filename = `composition-${target.id}.mp4`;
        const outputPath = join(PATHS.videos, filename);
        ownedPaths.push(outputPath, join(PATHS.videoThumbnails, `${target.id}.jpg`));
        await encodeComposition(page, target.contract, outputPath, { musicPath, signal, onProgress: progress => {
          videoGenEvents.emit('progress', { generationId: jobId, progress: (index + progress) / targets.length * 0.95 });
        } });
        page.check();
        rendered.push({ ...target, filename, outputPath });
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
        id: video.id, prompt: `HTML composition: ${directory}`, modelId: 'html-composition', seed: 0,
        ...frameOf(video.contract), numFrames: Math.round(contract.durationSec * contract.fps),
        ...(launchMetadata ? { launchVideo: launchMetadata, appId: launchMetadata.appId, posterSec: launchPlan.posterSec } : {}),
        filename: video.filename, thumbnail: video.thumbnail, createdAt,
      }));
      await mutateVideoHistory(history => { history.unshift(...metas); return history; });
      success = true;
      // `id`/`filename` name a real history entry (the first format); `generationId`
      // is the job. A single-format render keeps id === generationId as before.
      const summary = ({ id, filename, thumbnail }) => ({ id, filename, thumbnail, path: `/data/videos/${filename}` });
      const [first] = rendered;
      result = { ...(launchMetadata ? { appId: launchMetadata.appId } : {}), generationId: jobId, ...summary(first),
        ...(formats ? { videos: rendered.map(video => ({ format: video.format, ...summary(video) })) } : {}) };
    }
  } catch (error) {
    failure = error;
  } finally {
    await page?.close();
    if (audioDirectory) await rm(audioDirectory, { recursive: true, force: true }).catch(() => {
      console.warn('⚠️ Could not remove temporary composition audio');
    });
    if (!success) {
      for (const path of ownedPaths) await unlinkGuarded(path).catch(() => {});
    }
    active.delete(jobId);
  }
  // Cleanup precedes the terminal event, so the queue cannot advance early.
  if (failure) throw failure;
  videoGenEvents.emit('completed', result);
  return result;
}
