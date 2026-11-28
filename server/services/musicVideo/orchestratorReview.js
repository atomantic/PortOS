/** Run provider review and capture evidence for the operator-started Music Video checkpoints. */
/**
 * Orchestrated autonomous music video — the orchestrator's review prompts, the
 * verdict parser, and the one provider call every checkpoint shares.
 *
 * An orchestrated run (`brief.orchestrator`, lib/musicVideo/musicVideoAutonomous.js) asks
 * this reviewer at each point a director would otherwise stop the run: it
 * judges the output against the operator's idea and either approves it or
 * returns a concrete revision (rewritten lyrics, a sharper style line, edited
 * art direction, shot notes). The run applies a revision and asks again,
 * bounded by `limits.maxReviewAttempts` (autonomousService.js owns the loop).
 *
 * Everything the model sees here — the idea, lyrics, drafts, frames — is data
 * the run produced, so every prompt marks it untrusted. The parser is strict
 * about shape and lenient about prose around the JSON; an answer with no
 * usable verdict throws, which fails the stage so Retry asks again.
 *
 * Runs only inside an orchestrated run the operator started (AI Provider Usage
 * Policy: a user-started automation, never boot-time work).
 */

import { ServerError } from '../../lib/errorHandler.js';
import { isVisionCapableCliProvider } from '../../lib/localModelHeuristics.js';
import { PROVIDERS_PAGE_BREADCRUMB } from '../../lib/navManifest.js';

export {
  buildArtReviewPrompt, buildFinalReviewPrompt, buildLyricsReviewPrompt, buildSongReviewPrompt,
  buildStillsReviewPrompt, buildStoryboardReviewPrompt, buildStyleReviewPrompt,
} from './orchestratorReviewPrompts.js';
export { ORCHESTRATOR_ART_FIELDS, parseOrchestratorVerdict } from './orchestratorReviewVerdict.js';

const canSeeImages = (provider) => provider?.type === 'api' || isVisionCapableCliProvider(provider);

/**
 * Ask the orchestrator one review. Images ride along only when its provider can
 * read them; otherwise the review is text-only and says so (`visual: false`).
 * The pinned provider must be the one that answers — no silent fallback to a
 * different reviewer. Returns `{ text, route: { providerId, model }, visual }`.
 */
export async function askOrchestrator({ orchestrator, prompt, images = [], source }) {
  const { resolveProviderAndModel, runPromptThroughProvider, assertVisionRunUsedImages } = await import('../promptRunner.js');
  const { provider, selectedModel } = await resolveProviderAndModel(orchestrator || {});
  if (!provider || provider.enabled === false || (orchestrator?.providerId && provider.id !== orchestrator.providerId)) {
    throw new ServerError(`The orchestrator provider is not available. Pick another one in ${PROVIDERS_PAGE_BREADCRUMB}, then retry.`, { status: 503, code: 'ORCHESTRATOR_UNAVAILABLE' });
  }
  const effort = orchestrator?.effort || undefined;
  const visual = images.length > 0 && canSeeImages(provider);
  const route = { providerId: provider.id, model: selectedModel || null, ...(effort ? { effort } : {}) };
  if (visual && provider.type !== 'api') {
    const { describeImagesFromPaths } = await import('../visionCli.js');
    const result = await describeImagesFromPaths({ provider, imagePaths: images, prompt, model: selectedModel, effort, timeout: provider.timeout || 300_000 });
    return { text: result.text, route, visual };
  }
  const result = await runPromptThroughProvider({
    provider, model: selectedModel, ...(effort ? { effort } : {}), prompt, source,
    ...(visual ? { screenshots: images } : {}), allowFallback: false,
  });
  if (visual) assertVisionRunUsedImages(result, provider);
  return { text: result.text || '', route: { ...route, model: result.model || route.model }, visual };
}

const FINAL_FRAMES = 24;
const SHEET_TILES = 12;

/**
 * Sample the final render for the orchestrator's last look: `FINAL_FRAMES`
 * frames spread evenly over the film, tiled into 4x3 contact sheets. Returns
 * `{ images, frameTimes, facts, cleanup }`; a missing file or a failed sheet
 * yields fewer (or no) images and the review says what it could not see.
 */
export async function captureFinalReviewFrames(jobId) {
  const { existsSync } = await import('fs');
  const { unlink } = await import('fs/promises');
  const { join } = await import('path');
  const { PATHS, ensureDir } = await import('../../lib/fileUtils.js');
  const { probeVideoDuration, probeVideoStreamInfo, safeUnder } = await import('../../lib/ffmpeg.js');
  const { getHistoryItem } = await import('../videoGen/history.js');
  const item = await getHistoryItem(jobId).catch(() => null);
  const videoPath = item?.filename ? safeUnder(PATHS.videos, item.filename) : null;
  const none = (error) => ({ images: [], frameTimes: [], facts: { error }, cleanup: async () => {} });
  if (!videoPath || !existsSync(videoPath)) return none('The final video file is missing');
  const [info, durationSec] = await Promise.all([
    probeVideoStreamInfo(videoPath).catch(() => ({})),
    probeVideoDuration(videoPath).catch(() => null),
  ]);
  const facts = { durationSec: durationSec ? Math.round(durationSec * 10) / 10 : null, width: info.width ?? null, height: info.height ?? null,
    fps: info.fps ? Math.round(info.fps * 100) / 100 : null };
  if (!(durationSec > 0)) return { ...none('The final video duration could not be read'), facts: { ...facts, error: 'The final video duration could not be read' } };
  const { encodeFileContactSheetAtTimes } = await import('../htmlComposition/encode.js');
  await ensureDir(PATHS.videoThumbnails);
  const times = Array.from({ length: FINAL_FRAMES }, (_, i) => Math.round(((i + 0.5) * durationSec / FINAL_FRAMES) * 1000) / 1000);
  const images = [];
  const frameTimes = [];
  for (let i = 0; i * SHEET_TILES < times.length; i += 1) {
    const chunk = times.slice(i * SHEET_TILES, (i + 1) * SHEET_TILES);
    const out = join(PATHS.videoThumbnails, `${jobId}-orchestrator-s${i + 1}.jpg`);
    const ok = await encodeFileContactSheetAtTimes(videoPath, out, chunk, { width: info.width, height: info.height, fps: info.fps > 0 ? info.fps : 24, columns: 4 })
      .then(() => true, () => false);
    if (ok && existsSync(out)) { images.push(out); frameTimes.push(...chunk); }
  }
  return { images, frameTimes, facts, cleanup: () => Promise.all(images.map((p) => unlink(p).catch(() => {}))) };
}
