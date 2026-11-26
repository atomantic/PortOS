// Rank enabled drop targets by center distance or by the fraction of area shared with the dragged rectangle.

function ranked({ collisionRect, droppableRects, droppableContainers }, score, descending) {
  const hits = [];
  for (const container of droppableContainers) {
    const rect = droppableRects.get(container.id);
    if (!rect) continue;
    const value = score(collisionRect, rect);
    if (value != null) hits.push({ id: container.id, data: { droppableContainer: container, value } });
  }
  return hits.sort((a, b) => descending ? b.data.value - a.data.value : a.data.value - b.data.value);
}

export function closestCenter(args) {
  return ranked(args, (a, b) => Math.hypot(
    a.left - b.left + (a.width - b.width) / 2,
    a.top - b.top + (a.height - b.height) / 2,
  ), false);
}

export function rectIntersection(args) {
  return ranked(args, (a, b) => {
    const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (width <= 0 || height <= 0) return null;
    const overlap = width * height;
    return overlap / (a.width * a.height + b.width * b.height - overlap);
  }, true);
}
