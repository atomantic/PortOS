export function getAdjacentMedia(items, item) {
  const list = Array.isArray(items) ? items : [];
  const key = item?.key;
  const index = key ? list.findIndex((candidate) => candidate?.key === key) : -1;

  if (index === -1) {
    return { previous: null, next: null, hasPrevious: false, hasNext: false };
  }

  const previous = index > 0 ? list[index - 1] : null;
  const next = index < list.length - 1 ? list[index + 1] : null;

  return {
    previous,
    next,
    hasPrevious: Boolean(previous),
    hasNext: Boolean(next),
  };
}

// Returns the four MediaLightbox nav props ready to spread, so call sites
// don't repeat the previous/next/hasPrevious/hasNext wiring.
export function getMediaNavProps(items, item, onSelect) {
  const nav = getAdjacentMedia(items, item);
  return {
    onPrevious: () => nav.previous && onSelect(nav.previous),
    onNext: () => nav.next && onSelect(nav.next),
    hasPrevious: nav.hasPrevious,
    hasNext: nav.hasNext,
  };
}
