/**
 * Single-video YouTube URL detection — MIRROR of `YOUTUBE_VIDEO_URL_RE` in
 * `server/lib/youtubeUrl.js` (authoritative there).
 *
 * The Quick Capture box swaps its whole submit path (brain capture → YouTube
 * ingest) based on this predicate, and reveals the ingest options panel from it,
 * so a looser client answer would offer options for a URL the server refuses.
 * Port any change from the server copy verbatim.
 *
 * Deliberately narrow: playlists, channels, and `/@handle` pages are NOT
 * matched — a paste that would have yt-dlp pull 300 videos should fall through
 * to normal link capture, not silently start a batch download.
 */

const SINGLE_VIDEO_RE =
  /^https?:\/\/(www\.|m\.|music\.)?(youtube\.com\/(watch\?[^\s#]*\bv=[\w-]{6,}|shorts\/[\w-]{6,}|live\/[\w-]{6,}|embed\/[\w-]{6,})|youtu\.be\/[\w-]{6,})/i;

/** The video id in a YouTube URL, or null. Mirrors `youtubeVideoIdFromUrl` in `server/lib/youtubeUrl.js`. */
export function youtubeVideoId(url) {
  if (!url) return null;
  const s = String(url).trim();
  const vParam = /[?&]v=([A-Za-z0-9_-]{6,20})/.exec(s);
  if (vParam) return vParam[1];
  const pathId = /(?:youtu\.be\/|\/shorts\/|\/embed\/|\/live\/|\/v\/)([A-Za-z0-9_-]{6,20})/.exec(s);
  return pathId ? pathId[1] : null;
}

/** True when `text` is a single-video YouTube URL the ingest endpoint accepts. */
export function isYoutubeVideoUrl(text) {
  const trimmed = (text ?? '').trim();
  return SINGLE_VIDEO_RE.test(trimmed) && !!youtubeVideoId(trimmed);
}

/**
 * The three artifacts an ingest can produce, as ONE table.
 *
 * `key` is the request field the server reads, `settingKey` the
 * `youtube-ingest-settings.json` field holding its default, and `fallback` what
 * to use before those settings load. Everything that enumerates the switches —
 * the checkbox row, the initial state, the settings-seed mapping, the
 * "pick at least one" guard, the summary line, and the settings form — derives
 * from this, so adding a fourth artifact is one row plus the server field rather
 * than seven edit sites that silently half-work if one is missed.
 */
export const INGEST_OPTIONS = [
  {
    key: 'captureTranscript',
    settingKey: 'defaultCaptureTranscript',
    fallback: true,
    label: 'Transcript',
    hint: 'Captions → note in your Obsidian vault',
  },
  {
    key: 'downloadVideo',
    settingKey: 'defaultDownloadVideo',
    fallback: false,
    label: 'Video',
    hint: 'Full video into the media library',
  },
  {
    key: 'ingestAudio',
    settingKey: 'defaultIngestAudio',
    fallback: false,
    label: 'Audio',
    hint: 'mp3 kept next to the transcript',
  },
];

/** The `{ captureTranscript, downloadVideo, ingestAudio }` bag before settings load. */
export const defaultIngestOptions = () =>
  Object.fromEntries(INGEST_OPTIONS.map((o) => [o.key, o.fallback]));

/** Map a saved settings object onto the same bag, falling back per option. */
export const ingestOptionsFromSettings = (settings) =>
  Object.fromEntries(INGEST_OPTIONS.map((o) => [
    o.key,
    typeof settings?.[o.settingKey] === 'boolean' ? settings[o.settingKey] : o.fallback,
  ]));
