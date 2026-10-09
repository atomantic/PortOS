/**
 * Music Video publishing (#9282) — what each platform posts, built from the
 * project's publishing kit (#9281). Pure: project + kit + the director's
 * per-platform options in, a payload of text and file NAMES out (the service
 * resolves names to paths), or a 422 naming what is missing.
 */
import { ServerError } from '../../../lib/errorHandler.js';
import { chaptersText } from '../publishKitText.js';
import { musicVideoDependencyChanges } from '../../../lib/musicVideoDependencies.js';
import { suggestDistrokidGenres } from '../../../lib/distrokidGenres.js';
import { suggestSocialCuts } from '../socialCuts.js';

const TITLE_LIMITS = { youtube: 100, shorts: 100, reddit: 300, stackerNews: 80, substack: 100 };
const DEFAULT_SUBREDDIT = 'aivideo';

const missing = (message) => new ServerError(message, { status: 422, code: 'PUBLISH_ASSET_MISSING' });
const stale = () => new ServerError('The publishing kit was built from an earlier render — rebuild the kit before filling this draft', { status: 409, code: 'PUBLISH_KIT_STALE' });
const text = (v) => (typeof v === 'string' ? v.trim() : '');
const titleCase = (name) => name.replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
const kitOf = (project) => (project?.publishKit && typeof project.publishKit === 'object' ? project.publishKit : {});

/** Refuse a kit whose master came from a different render than the project's current one. */
function requireFreshKit(project, kit) {
  if ((kit.master?.renderHistoryId ?? null) !== (project?.renderHistoryId ?? null)) throw stale();
}

const SUNO_SONG_URL = /^https:\/\/(?:www\.)?suno\.com\/song\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const VERTICAL_NEEDS = 'Render a 9:16 social cut on the Review stage (or rebuild the publishing kit for a 16:9 render) first';
const isVerticalCut = (e) => e?.status === 'complete' && e.aspect === '9:16' && e.filename;

/**
 * The vertical cuts a director can post (#10150), newest last: finished 9:16
 * excerpts flagged stale when the project changed since, plus the kit's
 * fit-with-blurred-fill 9:16 encode (16:9 renders) while the kit is fresh.
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

/**
 * The publication's host from what the director typed: a bare name means
 * name.substack.com; a custom domain or a pasted URL keeps only its host.
 */
function substackPublication(value) {
  const address = text(value).toLowerCase().replace(/^https?:\/\//, '');
  // A share link (open.substack.com/pub/name/p/…) names the publication in its path.
  const shared = address.match(/^open\.substack\.com\/pub\/([a-z0-9-]{1,63})(?:[/?#]|$)/)?.[1];
  if (shared) return `${shared}.substack.com`;
  const host = address.split(/[/?#]/)[0];
  if (/^[a-z0-9-]{1,63}$/.test(host)) return `${host}.substack.com`;
  // substack.com itself (a profile link like substack.com/@name) is not a publication.
  if (/^(?:(?:www|open)\.)?substack\.com$/.test(host)) return null;
  return /^(?:[a-z0-9-]{1,63}\.)+[a-z]{2,}$/.test(host) ? host : null;
}

// The release cover: the composed cover art when there is one (already square,
// with the title set), else the kit's thumbnail (cut square at post time).
const releaseCover = (kit) => {
  if (kit.coverArt?.filename) return { dir: 'videoThumbnails', name: kit.coverArt.filename, square: true };
  return kit.thumbnail ? { dir: 'videoThumbnails', name: kit.thumbnail } : null;
};

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
  substack: (project, kit, options = {}) => {
    const publication = substackPublication(options.publication);
    if (!publication) throw missing('Name your Substack publication (name.substack.com) under Where you post');
    const videoUrl = fullVideoUrl(kit);
    if (!videoUrl) throw missing('Substack posts embed the full video: publish to YouTube first, or add its URL to the kit');
    return {
      publication, videoUrl,
      title: requireTitle('substack', text(kit.copy?.substack?.title)),
      subtitle: text(kit.copy?.substack?.subtitle), body: text(kit.copy?.substack?.body),
    };
  },
  suno: (project, kit, options = {}) => {
    const song = songUrl(kit, options);
    // The adapter finds the song's own menu by its id, so the URL must carry it.
    if (!/^https:\/\/(www\.)?suno\.com\/song\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(song)) throw missing('Give the Suno song URL to publish (suno.com/song/…)');
    const video = fullVideoUrl(kit);
    const lead = text(kit.copy?.youtube?.description).split(/\n\s*\n/)[0] || '';
    const caption = [lead, video ? `Music video: ${video}` : ''].filter(Boolean).join(' ').slice(0, 500);
    return { songUrl: song, caption, cover: releaseCover(kit), pin: options.pin !== false };
  },
  // A Suno Hook (#10375): the vertical cut set to a window of the project's song.
  sunoHook: (project, kit, options = {}) => {
    const song = songUrl(kit, options);
    const songId = song.match(SUNO_SONG_URL)?.[1]?.toLowerCase();
    if (!songId) throw missing('Give the Suno song URL the Hook plays (suno.com/song/…)');
    const cut = pickVerticalCut(project, options);
    const caption = text(kit.copy?.tiktok?.caption) || text(kit.copy?.shorts?.description).slice(0, 300);
    const duration = Number(project?.audioAnalysis?.durationSec);
    return {
      video: { dir: 'videos', name: cut.filename }, songUrl: song, songId, title: text(project?.name),
      durationSec: Number.isFinite(duration) && duration > 0 ? duration : null,
      // The audio window opens where the cut's own audio does.
      startSec: Math.max(0, Number(cut.startSec) || 0),
      caption, showLyrics: options.showLyrics === true,
    };
  },
  // The song as a single for Spotify and the other stores. The service adds the
  // project's source audio; the cover is the kit's cover art, else its thumbnail cut square.
  distrokid: (project, kit, options = {}) => {
    const title = text(project?.name);
    if (!title) throw missing('Name the project first: it is the song title in the stores');
    const artist = text(options.artistName);
    if (!artist) throw missing('Give the artist name the song is released under (or set it as the DistroKid account under Where you post)');
    const songwriter = { first: text(options.songwriterFirst), last: text(options.songwriterLast) };
    if (!songwriter.first || !songwriter.last) throw missing("DistroKid needs the songwriter's real first and last name");
    const cover = releaseCover(kit);
    if (!cover) throw missing('Make the cover art in the publishing kit first (or pick a thumbnail)');
    const releaseDate = text(options.releaseDate);
    if (releaseDate && !/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) throw missing('Give the release date as YYYY-MM-DD');
    const hasLyrics = (project?.lyricCues || []).some((cue) => text(cue?.text));
    const instrumental = typeof options.instrumental === 'boolean' ? options.instrumental : !hasLyrics;
    const suggested = suggestDistrokidGenres(project);
    const genre = text(options.genre) || suggested.primary;
    const secondary = text(options.secondaryGenre) || suggested.secondary;
    const fullName = `${songwriter.first} ${songwriter.last}`;
    // The store preview (and TikTok clip) opens on the song's strongest hook.
    // A pick at 0:00 (no hook signal, or a song too short to choose) says
    // nothing DistroKid's own default doesn't, so the question stays untouched.
    const hookSec = suggestSocialCuts(project, { count: 1 })[0]?.startSec;
    const previewStartSec = Number.isFinite(options.previewStartSec) ? options.previewStartSec : (hookSec > 0 ? hookSec : null);
    return {
      title, artist, songwriter, releaseDate: releaseDate || null,
      songwriterRole: options.songwriterRole || (instrumental ? 'music' : 'both'),
      explicit: options.explicit === true,
      instrumental,
      ai: { lyrics: options.aiLyrics === true, music: options.aiMusic !== false, vocals: options.aiVocals !== false },
      genre: genre || null,
      secondaryGenre: secondary && secondary !== genre ? secondary : null,
      language: text(options.language) || 'English',
      // DistroKid title-cases names unless told the capitalization is deliberate ("atomantic", "DJ Example").
      preserveCaps: typeof options.preserveCaps === 'boolean' ? options.preserveCaps : artist !== titleCase(artist),
      // Store profiles: a first release asks for new ones; otherwise the director links the existing ones.
      newArtistProfile: options.newArtistProfile === true,
      // Apple Music requires a performer and a producer credit (real names).
      credits: {
        performer: text(options.performerName) || fullName,
        performerRole: text(options.performerRole) || null,
        producer: text(options.producerName) || fullName,
      },
      previewStartSec: previewStartSec != null ? Math.max(0, Math.floor(previewStartSec)) : null,
      cover,
    };
  },
};

/** The payload one platform posts, or a 422 naming the first missing piece. */
export function buildPublishPayload(platform, project, options = {}) {
  const build = BUILDERS[platform];
  if (!build) throw new ServerError(`Unknown publish target: ${platform}`, { status: 400, code: 'VALIDATION_ERROR' });
  return build(project, kitOf(project), options || {});
}

const clock = (sec) => {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const yesNo = (v) => (v ? 'Yes' : 'No');

/** The 9:16 cut a payload posts, in words ("9:16 cut 0:40–1:10"). */
function cutLabel(project, video) {
  const cut = verticalCuts(project).find((c) => c.filename === video?.name);
  return cut ? `${cut.id === 'kit-vertical' ? 'Kit vertical (fit)' : '9:16 cut'} ${clock(cut.startSec)}–${clock(cut.endSec)}` : '9:16 cut';
}

/**
 * What one platform's post will say, as `[{ label, text }]` rows the director
 * reads before Fill draft: every word PortOS types (titles, captions, the
 * links it adds, the chapters it appends) and which file goes with it. Built
 * from the same payload Fill draft posts, so the two cannot disagree.
 */
export function publishPreviewParts(platform, project, payload) {
  const rows = [];
  const add = (label, value) => { if (value != null && value !== '') rows.push({ label, text: String(value) }); };
  const p = payload || {};
  switch (platform) {
    case 'youtube':
      add('Video', 'The final render');
      add('Title', p.title); add('Description', p.description);
      add('Tags', p.tags?.length ? p.tags.join(', ') : 'None');
      add('Thumbnail', p.thumbnail ? 'The one picked under Release assets' : 'None');
      add('Captions', p.captions ? 'Lyric captions (SRT)' : 'None');
      break;
    case 'shorts':
      add('Video', cutLabel(project, p.video)); add('Title', p.title); add('Description', p.description);
      break;
    case 'tiktok':
    case 'instagram':
      add('Video', cutLabel(project, p.video)); add('Caption', p.caption || '(empty)');
      break;
    case 'x':
      (p.posts || []).forEach((post, i) => {
        const media = post.media ? (post.media.dir === 'videos' ? ' · with the 1080p video' : ' · with an image') : '';
        add(i === 0 ? `Post${media}` : `Reply ${i}${media}`, post.text);
      });
      break;
    case 'reddit':
      add('Where', `r/${p.subreddit}`);
      add('Type', { video: 'Video upload (the final render)', self: 'Text post', link: 'Link post' }[p.kind]);
      add('Title', p.title); add('Body', p.body); add('Link', p.url); add('First comment', p.firstComment);
      break;
    case 'stackerNews':
      add('Where', `~${p.territory}`); add('Title', p.title); add('Link', p.url); add('Body', p.body); add('First comment', p.firstComment);
      break;
    case 'substack':
      add('Publication', p.publication); add('Video at the top', p.videoUrl); add('Title', p.title); add('Subtitle', p.subtitle); add('Body', p.body);
      add('Saved as', 'A draft in Substack (you choose who gets it)');
      break;
    case 'suno':
      add('Song', p.songUrl); add('Caption', p.caption || '(empty)');
      add('Cover', p.cover ? (p.cover.square ? 'The cover art' : 'The thumbnail, cut square') : 'None');
      add('Pin to profile', yesNo(p.pin));
      break;
    case 'sunoHook':
      add('Song', p.songUrl); add('Video', cutLabel(project, p.video));
      add('Song window', `From ${clock(p.startSec)}`);
      add('Caption', p.caption || '(empty)'); add("Suno's lyrics", p.showLyrics ? 'Shown' : 'Hidden');
      break;
    case 'distrokid': {
      const ai = [p.ai?.music && 'music', p.ai?.vocals && 'all of the audio', p.ai?.lyrics && 'lyrics'].filter(Boolean);
      add('Song title', p.title); add('Artist', p.artist);
      add('Songwriter', `${p.songwriter?.first} ${p.songwriter?.last} (${{ both: 'music and lyrics', music: 'music', lyrics: 'lyrics' }[p.songwriterRole] || p.songwriterRole})`);
      add('Release date', p.releaseDate || 'As soon as possible');
      add('Genre', [p.genre || 'Not picked', p.secondaryGenre].filter(Boolean).join(' · '));
      add('Language', p.language);
      add('Explicit', yesNo(p.explicit)); add('Instrumental', yesNo(p.instrumental));
      add('Made with AI', ai.length ? ai.join(', ') : 'Nothing');
      add('Apple credits', `Performer ${p.credits?.performer}${p.credits?.performerRole ? ` (${p.credits.performerRole})` : ''} · Producer ${p.credits?.producer}`);
      add('Cover', p.cover?.square ? 'The cover art' : 'The thumbnail, cut square');
      if (p.previewStartSec != null) add('Store preview from', clock(p.previewStartSec));
      break;
    }
    default:
      break;
  }
  return rows;
}
