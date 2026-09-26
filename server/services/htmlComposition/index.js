import { join, resolve } from 'node:path';
import { open, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { PATHS, ensureDir, unlinkGuarded } from '../../lib/fileUtils.js';
import { htmlCompositionContractSchema, htmlCompositionRenderSchema, validateRequest } from '../../lib/validation.js';
import { generateThumbnail } from '../../lib/ffmpeg.js';
import { videoGenEvents } from '../videoGen/events.js';
import { mutateVideoHistory } from '../videoGen/history.js';
import { resolveMusicTrackPath } from '../pipeline/audioMux.js';
import { openComposition } from './browser.js';
import { encodeComposition } from './encode.js';
import { validateLaunchVideoAssets } from '../../lib/launchVideoValidation.js';

const active = new Map();

export function cancel(jobId) {
  const job = active.get(jobId);
  if (!job || job.committing) return false;
  job.controller.abort(new Error('Render canceled'));
  return true;
}

export async function renderComposition({ jobId, ...input }) {
  const job = { controller: new AbortController(), committing: false };
  active.set(jobId, job);
  const { signal } = job.controller;
  const filename = `composition-${jobId}.mp4`;
  const outputPath = join(PATHS.videos, filename);
  let page;
  let success = false;
  let result;
  let failure;
  const deliveredPaths = [];
  const deliver = async (target, write) => {
    const handle = await open(target, 'wx');
    // Record ownership after exclusive creation, before any fallible I/O.
    deliveredPaths.push(target);
    try { await write(handle); } finally { await handle.close(); }
  };
  try {
    const { directory, musicTrack, launchVideo } = validateRequest(htmlCompositionRenderSchema, input);
    const musicPath = musicTrack ? await resolveMusicTrackPath(musicTrack) : null;
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
    page = await openComposition(directory, { signal, validateAssets: needsLaunchGate
      ? assets => { launchPlan = validateLaunchVideoAssets(assets, launchVideo); launchAssets = assets; }
      : undefined });
    const metadata = await page.evaluate(`(() => {
      const c = globalThis.portosComposition;
      if (!c || typeof c.seek !== 'function') throw new Error('portosComposition.seek is required');
      return { durationSec: c.durationSec, fps: c.fps, width: c.width, height: c.height };
    })()`);
    const parsed = htmlCompositionContractSchema.safeParse(metadata);
    if (!parsed.success) throw new Error(parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '));
    const contract = parsed.data;
    if (launchPlan && Math.abs(contract.durationSec - launchPlan.durationSec) > 1e-8) {
      throw new Error('Composition durationSec must match storyboard.json');
    }
    await ensureDir(PATHS.videos);
    await encodeComposition(page, contract, outputPath, { musicPath, signal, onProgress: progress => {
      videoGenEvents.emit('progress', { generationId: jobId, progress: progress * 0.95 });
    } });
    // End script execution before post-processing and publishing the result.
    page.check();
    await page.close({ verify: true });
    page = null;
    signal.throwIfAborted();
    const thumbnail = await generateThumbnail(outputPath, jobId, launchPlan ? { atSec: launchPlan.posterSec } : undefined);
    if (!thumbnail) throw new Error('Composition thumbnail generation failed');
    signal.throwIfAborted();
    let launchMetadata;
    if (deliveryRoot) {
      // Exclusive creation refuses pre-existing files/symlinks. Publish only the
      // validated snapshot, never re-read source prose after rendering.
      for (const name of ['plan.md', 'storyboard.json', 'caption.txt']) {
        const target = join(deliveryRoot, name);
        await deliver(target, handle => handle.writeFile(launchAssets.get(`/${name}`)));
      }
      for (const [source, name] of [[outputPath, 'video.mp4'], [join(PATHS.videoThumbnails, thumbnail), 'poster.jpg']]) {
        const target = join(deliveryRoot, name);
        await deliver(target, handle => pipeline(createReadStream(source), handle.createWriteStream()));
      }
      launchMetadata = { appId: launchVideo.appId, runId: launchVideo.runId,
        caption: launchAssets.get('/caption.txt').toString('utf8').trim(), posterSec: launchPlan.posterSec };
    }
    signal.throwIfAborted();
    // Once the shared history write starts, cancellation must be refused.
    job.committing = true;
    const meta = {
      id: jobId, prompt: `HTML composition: ${directory}`, modelId: 'html-composition', seed: 0,
      ...contract, numFrames: Math.round(contract.durationSec * contract.fps),
      ...(launchMetadata ? { launchVideo: launchMetadata, appId: launchMetadata.appId, posterSec: launchPlan.posterSec } : {}),
      filename, thumbnail, createdAt: new Date().toISOString(),
    };
    await mutateVideoHistory(history => { history.unshift(meta); return history; });
    success = true;
    result = { ...(launchMetadata ? { appId: launchMetadata.appId } : {}), generationId: jobId, id: jobId, filename, thumbnail, path: `/data/videos/${filename}` };
  } catch (error) {
    failure = error;
  } finally {
    await page?.close();
    if (!success) {
      for (const path of deliveredPaths) await unlinkGuarded(path).catch(() => {});
      await unlinkGuarded(outputPath).catch(() => {});
      await unlinkGuarded(join(PATHS.videoThumbnails, `${jobId}.jpg`)).catch(() => {});
    }
    active.delete(jobId);
  }
  // Cleanup precedes the terminal event, so the queue cannot advance early.
  if (failure) throw failure;
  videoGenEvents.emit('completed', result);
  return result;
}
