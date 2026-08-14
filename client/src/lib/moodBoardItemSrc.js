// Resolve a mood-board item to display sources (issue #911 / #1455 / #4188).
//
// A board item is renderable as an image when it carries either an explicit
// `imageUrl` (external or absolute app path) or a pinned `image:<file>`
// media-key — the served bytes live at `/data/images/<file>`.
//
// A `type: 'video'` item (#4188) stores its media-key as `video:<filename>`
// (the ref IS the on-disk filename, extension included), so playback resolves
// to `/data/videos/<filename>` and the poster falls back to the derived
// thumbnail `/data/video-thumbnails/<stem>.jpg` — the same name the sender's
// upload/generation wrote and a receiving peer's asset pull regenerates.
// Legacy `video:<id>` pins on IMAGE items (the cross-surface pin flow) render
// only via their stored `imageUrl` thumbnail, as before.
//
// Shared by MoodBoardDetail (the canvas) and MoodBoardReferenceStrip (the
// creation-flow picker) so the two can't diverge on how a pin resolves.

const IMAGE_PREFIX = 'image:';
const VIDEO_PREFIX = 'video:';

export function moodBoardItemSrc(item) {
  if (item?.imageUrl) return item.imageUrl;
  if (typeof item?.mediaKey === 'string' && item.mediaKey.startsWith(IMAGE_PREFIX)) {
    return `/data/images/${encodeURIComponent(item.mediaKey.slice(IMAGE_PREFIX.length))}`;
  }
  if (item?.type === 'video' && typeof item?.mediaKey === 'string' && item.mediaKey.startsWith(VIDEO_PREFIX)) {
    const stem = item.mediaKey.slice(VIDEO_PREFIX.length).replace(/\.[a-z0-9]+$/i, '');
    if (stem) return `/data/video-thumbnails/${encodeURIComponent(stem)}.jpg`;
  }
  return null;
}

// Playback URL for a `type: 'video'` item; null for anything else (including
// legacy `video:<id>` pins on image items, whose ref is not a filename).
export function moodBoardItemVideoSrc(item) {
  if (item?.type !== 'video') return null;
  if (typeof item?.mediaKey === 'string' && item.mediaKey.startsWith(VIDEO_PREFIX)) {
    const filename = item.mediaKey.slice(VIDEO_PREFIX.length);
    if (filename) return `/data/videos/${encodeURIComponent(filename)}`;
  }
  return null;
}
