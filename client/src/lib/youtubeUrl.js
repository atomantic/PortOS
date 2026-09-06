/**
 * The YouTube ingest options Quick Capture offers, over the canonical
 * single-video URL rule in `server/lib/youtubeUrl.js`.
 *
 * `isYoutubeVideoUrl` / `youtubeVideoId` are re-exported from that leaf rather
 * than copied. Quick Capture swaps its whole submit path (brain capture →
 * YouTube ingest) on the predicate and reveals the options panel from it, so a
 * looser client answer would offer options for a URL the server refuses. The
 * throwing form the routes use lives in `server/lib/youtubeUrlAssert.js`, which
 * this deliberately does not reach for.
 */
export { isYoutubeVideoUrl, youtubeVideoId } from '../../../server/lib/youtubeUrl.js';

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
