/**
 * Music Video — the cover-art helpers the YouTube thumbnail shares (#17579).
 * coverArt.js and youtubeThumbnail.js both sit above this leaf, so neither
 * imports the other.
 */
import { basename } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS } from '../../lib/fileUtils.js';
import { safeUnder } from '../../lib/ffmpeg.js';
import { resolveGalleryImage } from '../../lib/pathSafety.js';
import { trimTo } from '../../lib/textUtils.js';
import { QUEUEABLE_IMAGE_MODES } from '../../lib/generationModes.js';
import { RENDER_TARGET } from '../../lib/renderTargets.js';
import { mutateProjectRecord } from './projects.js';
import { projectPublishKit } from './publishKit.js';

const defaults = {
  getPlatforms: async () => (await import('./publish/platforms.js')).getPublishPlatforms(),
  artistStyle: async (name) => (await import('./publish/artistStyles.js')).artistStyleFor(name),
};
let deps = { ...defaults };
/** Test seam: replaces the platform and artist-style lookups; omitted keys restore the defaults. */
export function __setCoverArtSharedDepsForTests(overrides = {}) {
  deps = { ...defaults, ...(overrides.getPlatforms ? { getPlatforms: overrides.getPlatforms } : {}), ...(overrides.artistStyle ? { artistStyle: overrides.artistStyle } : {}) };
}
export const artistStyleFor = (name) => deps.artistStyle(name);

/**
 * The install's own image generator for music videos: the Music Video render
 * default, else the PortOS image default (local, Codex, Grok, …). Null when
 * that backend cannot take a queued job or its cloud toggle is off.
 */
export async function defaultImageRoute(settings) {
  const { resolveRenderTargetConfig } = await import('../imageGen/cloudProviderConfig.js');
  const resolved = resolveRenderTargetConfig(settings, RENDER_TARGET.MUSIC_VIDEO, { usableInstallFallback: true });
  if (!QUEUEABLE_IMAGE_MODES.includes(resolved.mode) || (resolved.cloud && !resolved.cloud.enabled)) return null;
  return { mode: resolved.mode, model: null };
}

export const coverError = (status, code, message) => new ServerError(message, { status, code });
export const projectCoverArt = (project) => {
  const art = projectPublishKit(project).coverArt;
  return art && typeof art === 'object' ? art : {};
};

export const writeCoverArt = (projectId, update) => mutateProjectRecord(projectId, (current) => {
  const kit = projectPublishKit(current);
  const art = projectCoverArt(current);
  return { project: { ...current, publishKit: { ...kit, coverArt: { ...art, ...update(art) } } } };
});

/** A source's file on disk: a thumbnail this kit cut, or a gallery image. */
export function sourcePath(project, source) {
  const name = basename(String(source?.filename || ''));
  if (source?.kind === 'thumbnail') {
    const kit = projectPublishKit(project);
    const held = [kit.coverArt, kit.youtubeThumbnail, ...(kit.youtubeThumbnailTests || [])]
      .filter(asset => asset?.source?.kind === 'thumbnail').map(asset => asset.source.filename);
    if (![...(kit.thumbnails || []), ...(kit.frames || []), ...held].includes(name)) throw coverError(422, 'VALIDATION_ERROR', 'That thumbnail is not one this kit built');
    const path = safeUnder(PATHS.videoThumbnails, name);
    if (path) return path;
  } else if (source?.kind === 'image') {
    const path = resolveGalleryImage(name);
    if (path) return path;
  }
  throw coverError(422, 'PUBLISH_ASSET_MISSING', `The cover source image is missing (${name || 'none'})`);
}

/** The artist tag: what the director set, else the DistroKid account under Where you post. */
export async function defaultTag() {
  const platforms = await deps.getPlatforms().catch(() => null);
  return trimTo(platforms?.distrokid?.account, 24) || '';
}

/**
 * The design a song's lettering is set in, or null for the plain look. A song
 * with no design of its own takes the artist's saved style and keeps it as its
 * design, so the Lettering preview and every later re-set show what was
 * rendered. `tag` is the artist on the cover (default: the last cover's, else
 * the DistroKid account).
 */
export async function songCoverDesign(projectId, art, { tag } = {}) {
  if (art.design) return art.design;
  const style = await deps.artistStyle(tag ?? art.tag ?? await defaultTag()).catch(() => null);
  if (!style?.design) return null;
  await writeCoverArt(projectId, (current) => (current.design ? {} : { design: style.design }));
  console.log(`🖼️ Music Video cover art ${String(projectId).slice(3, 11)}: lettering starts from the artist style (${style.name})`);
  return style.design;
}

