/**
 * Reverse-engineer an image-gen and/or video-gen prompt from a still or clip.
 *
 * One vision call, any vision-capable provider:
 *   - API (Ollama VLM, LM Studio, OpenAI-compatible) → runPromptThroughProvider
 *     with screenshots + effort
 *   - Vision CLI (codex / claude) → describeImagesFromPaths with the same
 *     files + effort
 *
 * Source resolution:
 *   - gallery image  → PATHS.images basename
 *   - gallery video  → ffmpeg-sampled frames under PATHS.video-thumbnails
 *   - generic upload → PATHS.uploads (image as-is, video sampled the same way)
 */

import { existsSync } from 'fs';
import { extname, join } from 'path';
import { randomUUID } from 'crypto';

import { ServerError } from '../lib/errorHandler.js';
import { extractJson } from '../lib/jsonExtract.js';
import { PATHS, resolveGalleryImage } from '../lib/fileUtils.js';
import { extractEvaluationFrames, safeUnder } from '../lib/ffmpeg.js';
import { isVisionCapableCliProvider } from '../lib/localModelHeuristics.js';
import {
  assertVisionRunUsedImages,
  resolveEffectiveModel,
  runPromptThroughProvider,
} from '../lib/promptRunner.js';
import { getProviderById } from './providers.js';
import { loadHistory } from './videoGen/history.js';
import { describeImagesFromPaths } from './visionCli.js';

const MAX_PROMPT_LEN = 8000;
const MAX_REASON_LEN = 1200;
const MAX_FRAMES = 5;
const VISION_TIMEOUT_MS = 180000;
const VIDEO_ID_RE = /^[a-f0-9-]{36}$/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)$/i;
const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|mkv)$/i;

const trimString = (value, max = MAX_PROMPT_LEN) =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

const isPlaceholderPrompt = (s) => typeof s === 'string' && /^\s*<.+>\s*$/.test(s);

export const PROMPT_FROM_MEDIA_TARGETS = Object.freeze(['image', 'video']);

/**
 * Build the vision prompt. `targets` decides which JSON fields the model
 * must fill; `mediaKind` + `frameCount` tell it whether it's looking at a
 * still or a chronological frame set.
 */
export function buildPromptFromMediaPrompt({ targets, mediaKind, frameCount }) {
  const wantImage = targets.includes('image');
  const wantVideo = targets.includes('video');
  const lookingAt = mediaKind === 'video'
    ? (frameCount > 1
      ? `${frameCount} frames sampled in chronological order from a short video`
      : 'a representative frame from a short video')
    : 'a still image';

  const fields = [];
  if (wantImage) {
    fields.push(
      '  "imagePrompt": "<full ready-to-render image-generation prompt>",',
      '  "imageNegativePrompt": "<what an image model should avoid, or empty string>",',
    );
  }
  if (wantVideo) {
    fields.push(
      '  "videoPrompt": "<full ready-to-render video-generation prompt, including motion>",',
      '  "videoNegativePrompt": "<what a video model should avoid, or empty string>",',
    );
  }
  fields.push('  "rationale": "<one concise sentence about the look and, if video, the motion>"');

  const rules = [
    '- Output ONLY valid JSON. Replace every <…> with real content; do NOT emit the literal angle-bracket text.',
    '- Each prompt field must be the COMPLETE ready-to-render text, paragraph-style — not a summary, not a caption of the file, not a list of changes.',
    '- Describe what is actually visible: subject, setting, materials, lighting, color, composition, camera, mood, style.',
    '- Do not invent brands, logos, or named characters that are not visible.',
  ];
  if (wantImage) {
    rules.push('- imagePrompt: a still-image prompt (composition, lighting, textures, lens/look). No motion language.');
  }
  if (wantVideo) {
    rules.push('- videoPrompt: a moving-image prompt. Include subject action, camera move, pacing, and how light or atmosphere changes across the clip.');
    if (mediaKind === 'video' && frameCount > 1) {
      rules.push('- The frames are chronological. Infer motion from what changes between them; do not describe each frame separately.');
    }
  }

  return `You are a senior prompt engineer for generative image and video models.

You are looking at ${lookingAt}. Write the prompt(s) that would make a generator produce something like this — not a caption of the file, the actual render prompt.

Return ONLY valid JSON in this schema:
{
${fields.join('\n')}
}

Rules:
${rules.join('\n')}`;
}

/**
 * Parse the model's JSON into the requested prompt fields. Walks balanced
 * blocks so a CLI banner / schema echo does not win over the real object.
 */
export function parsePromptFromMediaJson(raw, targets) {
  const wantImage = targets.includes('image');
  const wantVideo = targets.includes('video');
  const { value, lastError } = extractJson(String(raw || ''), {
    shapePredicate: (v) => {
      if (!v || typeof v !== 'object') return false;
      if (wantImage && (typeof v.imagePrompt !== 'string' || isPlaceholderPrompt(v.imagePrompt))) return false;
      if (wantVideo && (typeof v.videoPrompt !== 'string' || isPlaceholderPrompt(v.videoPrompt))) return false;
      return (wantImage ? trimString(v.imagePrompt) : true) && (wantVideo ? trimString(v.videoPrompt) : true);
    },
  });
  if (!value) {
    throw new Error(lastError?.message || 'Invalid JSON in AI response');
  }

  const imagePrompt = wantImage ? trimString(value.imagePrompt) : '';
  const videoPrompt = wantVideo ? trimString(value.videoPrompt) : '';
  if (wantImage && (isPlaceholderPrompt(value.imagePrompt) || !imagePrompt)) {
    throw new Error('LLM returned an empty image prompt');
  }
  if (wantVideo && (isPlaceholderPrompt(value.videoPrompt) || !videoPrompt)) {
    throw new Error('LLM returned an empty video prompt');
  }

  return {
    ...(wantImage ? {
      imagePrompt,
      imageNegativePrompt: trimString(value.imageNegativePrompt),
    } : {}),
    ...(wantVideo ? {
      videoPrompt,
      videoNegativePrompt: trimString(value.videoNegativePrompt),
    } : {}),
    rationale: trimString(value.rationale, MAX_REASON_LEN),
  };
}

function assertVisionProvider(provider) {
  if (!provider) {
    throw new ServerError('Provider not found', { status: 404, code: 'PROVIDER_NOT_FOUND' });
  }
  if (provider.enabled === false) {
    throw new ServerError(
      `Provider "${provider.name || provider.id}" is disabled — enable it in Settings → Providers first`,
      { status: 400, code: 'PROVIDER_DISABLED' },
    );
  }
  if (provider.type === 'api') return 'api';
  if (isVisionCapableCliProvider(provider)) return 'cli';
  throw new ServerError(
    `Provider "${provider.name || provider.id}" cannot read images. Pick a vision-capable API model (Ollama/LM Studio VLM, gpt-4o, grok, …) or a vision CLI (Claude Code, Codex).`,
    { status: 400, code: 'NOT_VISION_CAPABLE' },
  );
}

async function resolveImagePath(filename) {
  const imagePath = resolveGalleryImage(filename);
  if (!imagePath) {
    throw new ServerError(`Gallery image not found: ${filename}`, {
      status: 400,
      code: 'GALLERY_IMAGE_NOT_FOUND',
    });
  }
  return { mediaKind: 'image', screenshots: [imagePath] };
}

async function sampleVideoFrames(videoPath, extractId) {
  const names = await extractEvaluationFrames(videoPath, extractId, MAX_FRAMES);
  const screenshots = names
    .map((name) => join(PATHS.videoThumbnails, name))
    .filter((p) => existsSync(p));
  if (!screenshots.length) {
    throw new ServerError(
      'Could not extract frames from this video (is ffmpeg installed?)',
      { status: 502, code: 'VIDEO_FRAMES_FAILED' },
    );
  }
  return { mediaKind: 'video', screenshots };
}

async function resolveVideoSource(videoId) {
  if (!VIDEO_ID_RE.test(videoId)) {
    throw new ServerError('Invalid video id', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const history = await loadHistory();
  const item = (Array.isArray(history) ? history : []).find((h) => h.id === videoId);
  if (!item) {
    throw new ServerError('Video not found', { status: 404, code: 'NOT_FOUND' });
  }
  const videoPath = safeUnder(PATHS.videos, item.filename);
  if (!videoPath || !existsSync(videoPath)) {
    throw new ServerError('Video file not found on disk', { status: 404, code: 'NOT_FOUND' });
  }
  return sampleVideoFrames(videoPath, `pfm-${videoId}`);
}

// A mood-board video item (#4188) references its clip by on-disk FILENAME
// (`video:<file>.mp4` — see isVideoItemMediaKey), not by history id, so the
// board's analyze flow resolves a gallery video directly by filename instead
// of a history lookup. safeUnder guards traversal; the extension gate keeps
// this to actual clip files. The extraction id is STABLE (derived from the
// filename stem, like the id-based path's `pfm-<videoId>`) so re-analyzing
// the same clip overwrites its frames instead of accumulating new sets under
// data/video-thumbnails.
async function resolveVideoFilename(filename) {
  if (!VIDEO_EXT_RE.test(filename || '')) {
    throw new ServerError(`Not a gallery video filename: ${filename}`, {
      status: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  const videoPath = safeUnder(PATHS.videos, filename);
  if (!videoPath || !existsSync(videoPath)) {
    throw new ServerError('Video file not found on disk', { status: 404, code: 'NOT_FOUND' });
  }
  const stem = filename.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
  return sampleVideoFrames(videoPath, `pfm-vf-${stem}`);
}

async function resolveUploadSource(filename) {
  const uploadPath = safeUnder(PATHS.uploads, filename);
  if (!uploadPath || !existsSync(uploadPath)) {
    throw new ServerError(`Upload not found: ${filename}`, {
      status: 400,
      code: 'UPLOAD_NOT_FOUND',
    });
  }
  if (IMAGE_EXT_RE.test(filename)) {
    return { mediaKind: 'image', screenshots: [uploadPath] };
  }
  if (VIDEO_EXT_RE.test(filename)) {
    return sampleVideoFrames(uploadPath, `pfm-up-${randomUUID()}`);
  }
  throw new ServerError(
    `Unsupported upload type "${extname(filename) || filename}" — use an image or video`,
    { status: 400, code: 'VALIDATION_ERROR' },
  );
}

async function resolvePromptFromMediaSource({ sourceKind, filename, videoId }) {
  if (sourceKind === 'image') return resolveImagePath(filename);
  if (sourceKind === 'video') return videoId ? resolveVideoSource(videoId) : resolveVideoFilename(filename);
  if (sourceKind === 'upload') return resolveUploadSource(filename);
  throw new ServerError(`Unsupported sourceKind "${sourceKind}"`, {
    status: 400,
    code: 'VALIDATION_ERROR',
  });
}

async function runVision({ provider, kind, model, effort, prompt, screenshots }) {
  const timeout = provider.timeout || VISION_TIMEOUT_MS;
  if (kind === 'cli') {
    const result = await describeImagesFromPaths({
      provider,
      imagePaths: screenshots,
      prompt,
      model,
      effort,
      timeout,
    });
    return { text: result.text, model, ranProvider: provider };
  }

  const result = await runPromptThroughProvider({
    provider,
    prompt,
    source: 'media-prompt-from-media',
    model,
    effort,
    screenshots,
    timeout,
  }).catch((err) => {
    throw new ServerError(err?.message || 'Vision prompt failed', {
      status: 502,
      code: 'PROMPT_FROM_MEDIA_FAILED',
    });
  });
  const ranProvider = assertVisionRunUsedImages(result, provider);
  return { text: result.text, model: result.model || model, ranProvider };
}

export async function promptFromMedia({
  sourceKind,
  filename,
  videoId,
  targets,
  providerId,
  model,
  effort,
}) {
  const wanted = [...new Set((Array.isArray(targets) ? targets : []).filter((t) => PROMPT_FROM_MEDIA_TARGETS.includes(t)))];
  if (!wanted.length) {
    throw new ServerError('Select at least one of image or video prompt', {
      status: 400,
      code: 'VALIDATION_ERROR',
    });
  }

  const provider = await getProviderById(providerId);
  const kind = assertVisionProvider(provider);
  const selectedModel = resolveEffectiveModel(provider, model) || '';
  if (!selectedModel && provider.type === 'api') {
    throw new ServerError('Model is required', { status: 400, code: 'MODEL_REQUIRED' });
  }

  const { mediaKind, screenshots } = await resolvePromptFromMediaSource({
    sourceKind, filename, videoId,
  });

  const llmPrompt = buildPromptFromMediaPrompt({
    targets: wanted,
    mediaKind,
    frameCount: screenshots.length,
  });

  const { text, model: ranModel, ranProvider } = await runVision({
    provider,
    kind,
    model: selectedModel || undefined,
    effort,
    prompt: llmPrompt,
    screenshots,
  });

  let parsed;
  try {
    parsed = parsePromptFromMediaJson(text || '', wanted);
  } catch (e) {
    console.warn(`⚠️ media-prompt-from-media [${provider.id}/${selectedModel || 'default'}] parse failed: ${e.message} (response size: ${(text || '').length} chars)`);
    throw new ServerError(e.message, { status: 502, code: 'PROMPT_FROM_MEDIA_BAD_JSON' });
  }

  return {
    ...parsed,
    mediaKind,
    frameCount: screenshots.length,
    targets: wanted,
    providerId: ranProvider.id || provider.id,
    model: ranModel || selectedModel,
  };
}
