/**
 * Music Video publishing (#9282) — what each platform posts, built from the
 * project's publishing kit (#9281). Pure: project + kit + the director's
 * per-platform options in, a payload of text and file NAMES out (the service
 * resolves names to paths), or a 422 naming what is missing.
 */
import { ServerError } from '../../../lib/errorHandler.js';
import { chaptersText } from '../publishKitText.js';
import { musicVideoDependencyChanges } from '../../../lib/musicVideoDependencies.js';

const TITLE_LIMITS = { youtube: 100, shorts: 100, reddit: 300, stackerNews: 80 };
const DEFAULT_SUBREDDIT = 'aivideo';

const missing = (message) => new ServerError(message, { status: 422, code: 'PUBLISH_ASSET_MISSING' });
const stale = () => new ServerError('The publishing kit was built from an earlier render — rebuild the kit before filling this draft', { status: 409, code: 'PUBLISH_KIT_STALE' });
const text = (v) => (typeof v === 'string' ? v.trim() : '');
const kitOf = (project) => (project?.publishKit && typeof project.publishKit === 'object' ? project.publishKit : {});

/** Refuse a kit whose master came from a different render than the project's current one. */
function requireFreshKit(project, kit) {
  if ((kit.master?.renderHistoryId ?? null) !== (project?.renderHistoryId ?? null)) throw stale();
}

const VERTICAL_NEEDS = 'Render a 9:16 social cut on the Review stage (or rebuild the publishing kit for a 16:9 render) first';
const isVerticalCut = (e) => e?.status === 'complete' && e.aspect === '9:16' && e.filename;

/**
 * The vertical cuts a director can post (#10150), newest last: finished 9:16
 * excerpts flagged stale when the project changed since, plus the kit's
 * center-crop 9:16 encode (16:9 renders) while the kit is fresh.
 */
function verticalCuts(project) {
  const kit = kitOf(project);
  const cuts = (project?.excerpts || []).filter(isVerticalCut)
    .map((e) => ({ id: e.id ?? null, filename: e.filename, startSec: e.startSec, endSec: e.endSec, stale: musicVideoDependencyChanges(project, e.dependencies).length > 0 }));
  const crop = (kit.exports || []).find((e) => e.kind === 'vertical-9x16' && e.filename);
  if (crop && (kit.master?.renderHistoryId ?? null) === (project?.renderHistoryId ?? null)) {
    cuts.unshift({ id: 'kit-vertical', filename: crop.filename, startSec: crop.startSec ?? 0, endSec: crop.endSec ?? 0, stale: false });
  }
  return cuts;
}

/** The cut the director picked (`options.cutId`), else the newest non-stale one; a stale pick is refused. */
function pickVerticalCut(project, options) {
  const cuts = verticalCuts(project);
  const wanted = text(options?.cutId);
  if (wanted) {
    const cut = cuts.find((c) => c.id === wanted);
    if (!cut) throw missing('That vertical cut no longer exists — pick another');
    if (cut.stale) throw new ServerError('That vertical cut was rendered before the project changed — render a fresh one', { status: 409, code: 'PUBLISH_CUT_STALE' });
    return cut;
  }
  const fresh = cuts.filter((c) => !c.stale);
  if (fresh.length) return fresh[fresh.length - 1];
  if (cuts.length) throw new ServerError('Every 9:16 cut was rendered before the project changed — render a fresh one', { status: 409, code: 'PUBLISH_CUT_STALE' });
  throw missing(VERTICAL_NEEDS);
}

/** The full video's public link: the recorded YouTube post, else the one the director gave the kit. */
const fullVideoUrl = (kit) => text(kit.posts?.youtube?.url) || text(kit.links?.youtube) || '';
const songUrl = (kit, options) => text(options?.songUrl) || text(kit.posts?.suno?.url) || text(kit.links?.song) || '';

function requireTitle(platform, title) {
  if (!title) throw missing(`Write the ${platform} title in the release copy first`);
  const max = TITLE_LIMITS[platform];
  if (max && title.length > max) throw missing(`The ${platform} title is ${title.length} characters; the limit is ${max}`);
  return title;
}

function youtubeDescription(kit) {
  const body = text(kit.copy?.youtube?.description);
  // YouTube makes chapters from the description's timestamps; add them unless the copy already has them.
  const chapters = Array.isArray(kit.chapters) && kit.chapters.length && !/(^|\n)0:00\s/.test(body) ? `\n\nChapters\n${chaptersText(kit.chapters)}` : '';
  return `${body}${chapters}`.trim();
}

// A typed "@" on Instagram opens the mention picker, which swallows the next word.
const instagramSafe = (caption) => caption.replace(/@(\w)/g, '$1');

const BUILDERS = {
  youtube: (project, kit) => {
    if (!kit.master?.filename) throw missing('Build the publishing kit first — it names the final render to upload');
    requireFreshKit(project, kit);
    return {
      video: { dir: 'videos', name: kit.master.filename },
      title: requireTitle('youtube', text(kit.copy?.youtube?.title)),
      description: youtubeDescription(kit),
      tags: (kit.copy?.youtube?.tags || []).map(text).filter(Boolean),
      thumbnail: kit.thumbnail ? { dir: 'videoThumbnails', name: kit.thumbnail } : null,
      captions: kit.captionsFilename ? { dir: 'videos', name: kit.captionsFilename } : null,
    };
  },
  shorts: (project, kit, options = {}) => {
    const cut = pickVerticalCut(project, options);
    const url = fullVideoUrl(kit);
    const description = [text(kit.copy?.shorts?.description), url && !text(kit.copy?.shorts?.description).includes(url) ? `Full video: ${url}` : ''].filter(Boolean).join('\n\n');
    return { video: { dir: 'videos', name: cut.filename }, title: requireTitle('shorts', text(kit.copy?.shorts?.title)), description, tags: [], thumbnail: null, captions: null };
  },
  tiktok: (project, kit, options = {}) => {
    const cut = pickVerticalCut(project, options);
    return { video: { dir: 'videos', name: cut.filename }, caption: text(kit.copy?.tiktok?.caption), coverAtSec: Math.max(0, (cut.endSec - cut.startSec) / 2) };
  },
  instagram: (project, kit, options = {}) => {
    const cut = pickVerticalCut(project, options);
    return { video: { dir: 'videos', name: cut.filename }, caption: instagramSafe(text(kit.copy?.instagram?.caption)) };
  },
  x: (project, kit, options = {}) => {
    const hook = text(kit.copy?.x?.hook);
    if (!hook) throw missing('Write the X hook post in the release copy first');
    const clip = (kit.exports || []).find((e) => e.kind === 'x-1080p')?.filename;
    if (!clip) throw missing('Build the publishing kit first — the X post carries its 1080p encode');
    requireFreshKit(project, kit);
    const links = [
      songUrl(kit, options) ? `The song: ${songUrl(kit, options)}` : '',
      // X builds a post's link card from its LAST link, so the full video goes last.
      fullVideoUrl(kit) ? `Full video: ${fullVideoUrl(kit)}` : '',
    ].filter(Boolean).join('\n');
    const posts = [
      { text: hook, media: { dir: 'videos', name: clip } },
      text(kit.copy?.x?.story) ? { text: text(kit.copy.x.story), media: options.storyImage ? { dir: 'videoThumbnails', name: options.storyImage } : null } : null,
      text(options.prompt) ? { text: text(options.prompt), media: null } : null,
      links ? { text: links, media: null } : null,
    ].filter(Boolean);
    return { posts };
  },
  reddit: (project, kit, options = {}) => {
    // r/aivideo is the default (#9307): a native video post, title + flair, no
    // body. Showcase posts to tool-support subs (r/ClaudeAI, r/SunoAI) landed poorly.
    const subreddit = (text(options.subreddit) || DEFAULT_SUBREDDIT).replace(/^\/?r\//i, '');
    if (!/^[A-Za-z0-9_]{2,21}$/.test(subreddit)) throw missing('Name the subreddit to post in');
    const kind = ['self', 'link', 'video'].includes(options.kind) ? options.kind : 'video';
    const title = requireTitle('reddit', text(kit.copy?.reddit?.title));
    // r/SunoAI removes song posts whose title doesn't open with the genre in brackets.
    if (subreddit.toLowerCase() === 'sunoai' && !/^\[[^\]]+\]/.test(title)) throw missing('r/SunoAI titles must start with the genre in brackets, e.g. [Electropop] Song Name');
    // r/aivideo removes posts whose title doesn't name the video.
    if (subreddit.toLowerCase() === 'aivideo' && project?.name && !title.toLowerCase().includes(String(project.name).toLowerCase())) {
      throw missing(`r/aivideo titles must include the video's name ("${project.name}")`);
    }
    let video = null;
    if (kind === 'video') {
      if (!kit.master?.filename) throw missing('Build the publishing kit first — a Reddit video post uploads the final render');
      requireFreshKit(project, kit);
      video = { dir: 'videos', name: kit.master.filename };
    }
    const url = kind === 'link' ? (text(options.url) || fullVideoUrl(kit)) : '';
    if (kind === 'link' && !url) throw missing('A Reddit link post needs the full video URL');
    return {
      subreddit, kind, title, body: kind === 'video' ? '' : text(kit.copy?.reddit?.body), url, video,
      flairId: text(options.flairId) || null, flairText: text(options.flairText) || null, firstComment: text(options.firstComment) || null,
    };
  },
  stackerNews: (project, kit, options = {}) => {
    const url = fullVideoUrl(kit);
    if (!url) throw missing('Stacker News posts link to the full video: publish to YouTube first, or add its URL to the kit');
    const territory = text(options.territory || 'art').replace(/^~/, '');
    if (!/^[A-Za-z0-9_]{1,32}$/.test(territory)) throw missing('Name the Stacker News territory');
    return { territory, title: requireTitle('stackerNews', text(kit.copy?.stackerNews?.title)), url, body: text(kit.copy?.stackerNews?.body), firstComment: text(options.firstComment) || null };
  },
  suno: (project, kit, options = {}) => {
    const song = songUrl(kit, options);
    if (!/^https:\/\/(www\.)?suno\.com\/song\/[\w-]+/.test(song)) throw missing('Give the Suno song URL to publish (suno.com/song/…)');
    const video = fullVideoUrl(kit);
    const lead = text(kit.copy?.youtube?.description).split(/\n\s*\n/)[0] || '';
    const caption = [lead, video ? `Music video: ${video}` : ''].filter(Boolean).join(' ').slice(0, 500);
    return { songUrl: song, caption, cover: kit.thumbnail ? { dir: 'videoThumbnails', name: kit.thumbnail } : null, pin: options.pin !== false };
  },
  // The song as a single for Spotify and the other stores. The service adds the
  // project's source audio; the cover is the approved single artwork (#10331), else cut square from the kit's thumbnail.
  distrokid: (project, kit, options = {}) => {
    const title = text(project?.name);
    if (!title) throw missing('Name the project first: it is the song title on Spotify');
    const artist = text(options.artistName);
    if (!artist) throw missing('Give the artist name the song is released under (or set it as the DistroKid account under Where you post)');
    const songwriter = { first: text(options.songwriterFirst), last: text(options.songwriterLast) };
    if (!songwriter.first || !songwriter.last) throw missing("DistroKid needs the songwriter's real first and last name");
    // #10331: the approved single artwork is the cover; the video thumbnail is only a warned fallback.
    const art = kit.singleArtwork;
    const approved = !!(art?.approvedImageId && art.composedPath && art.composedOptionId === art.approvedImageId);
    if (!approved && !kit.thumbnail) throw missing('Approve the single artwork (or pick a thumbnail) in the publishing kit first: it becomes the cover art');
    const releaseDate = text(options.releaseDate);
    if (releaseDate && !/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) throw missing('Give the release date as YYYY-MM-DD');
    const hasLyrics = (project?.lyricCues || []).some((cue) => text(cue?.text));
    return {
      title, artist, songwriter, releaseDate: releaseDate || null,
      explicit: options.explicit === true,
      instrumental: typeof options.instrumental === 'boolean' ? options.instrumental : !hasLyrics,
      ai: { lyrics: options.aiLyrics === true, music: options.aiMusic !== false, vocals: options.aiVocals !== false },
      cover: approved ? { dir: 'videoThumbnails', name: art.composedPath, approved: true } : { dir: 'videoThumbnails', name: kit.thumbnail },
      warnings: approved ? [] : ['No single artwork is approved: the cover is cut from the video thumbnail. Approve a single artwork in the publishing kit for proper cover art.'],
    };
  },
};

/** The payload one platform posts, or a 422 naming the first missing piece. */
export function buildPublishPayload(platform, project, options = {}) {
  const build = BUILDERS[platform];
  if (!build) throw new ServerError(`Unknown publish target: ${platform}`, { status: 400, code: 'VALIDATION_ERROR' });
  return build(project, kitOf(project), options || {});
}
