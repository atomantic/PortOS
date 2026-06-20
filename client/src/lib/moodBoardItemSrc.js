// Resolve a mood-board item to a display image src (issue #911 / #1455).
//
// A board item is renderable as an image when it carries either an explicit
// `imageUrl` (external or absolute app path) or a pinned `image:<file>`
// media-key — the served bytes live at `/data/images/<file>`. A `video:<id>`
// media-key has no derivable thumbnail path (the id isn't the thumbnail
// filename), so a video pin renders only when the pin also stored an
// `imageUrl` thumbnail (the cross-surface pin flow does this). Returns null
// when there's nothing renderable.
//
// Shared by MoodBoardDetail (the canvas) and MoodBoardReferenceStrip (the
// creation-flow picker) so the two can't diverge on how a pin resolves.

const IMAGE_PREFIX = 'image:';

export function moodBoardItemSrc(item) {
  if (item?.imageUrl) return item.imageUrl;
  if (typeof item?.mediaKey === 'string' && item.mediaKey.startsWith(IMAGE_PREFIX)) {
    return `/data/images/${encodeURIComponent(item.mediaKey.slice(IMAGE_PREFIX.length))}`;
  }
  return null;
}
