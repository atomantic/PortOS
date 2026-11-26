// Compute keyboard destinations and sibling displacement from the measured layout of a sortable group.

export function arrayMove(items, from, to) {
  const result = items.slice();
  const [item] = result.splice(from, 1);
  result.splice(to < 0 ? items.length + to : to, 0, item);
  return result;
}

const axes = {
  ArrowUp: ['top', -1], ArrowDown: ['top', 1],
  ArrowLeft: ['left', -1], ArrowRight: ['left', 1],
};

export function sortableKeyboardCoordinates(event, { context }) {
  const direction = axes[event.code];
  if (!direction) return undefined;
  const current = context.over?.rect ?? context.active.rect.current.translated;
  const [axis, sign] = direction;
  let distance = Infinity;
  let next;
  for (const candidate of context.droppableContainers.getEnabled()) {
    const rect = context.droppableRects.get(candidate.id);
    if (!rect || (rect[axis] - current[axis]) * sign <= 0) continue;
    const d = Math.hypot(rect.left - current.left + (rect.width - current.width) / 2,
      rect.top - current.top + (rect.height - current.height) / 2);
    if (d < distance) { distance = d; next = rect; }
  }
  if (!next) return undefined;
  const active = context.active.rect.current.initial;
  return { x: next.left + (next.width - active.width) / 2, y: next.top + (next.height - active.height) / 2 };
}

function listDisplacement(axis, size, { rects, index, from, to }) {
  const active = rects[from];
  const here = rects[index];
  const forward = from < to;
  const neighbour = rects[index + (forward ? -1 : 1)];
  if (!active || !here || !neighbour) return null;
  const gap = forward ? here[axis] - neighbour[axis] - neighbour[size] : neighbour[axis] - here[axis] - here[size];
  const offset = (active[size] + gap) * (forward ? -1 : 1);
  return { x: axis === 'left' ? offset : 0, y: axis === 'top' ? offset : 0, scaleX: 1, scaleY: 1 };
}

export const verticalListSortingStrategy = args => listDisplacement('top', 'height', args);
export const horizontalListSortingStrategy = args => listDisplacement('left', 'width', args);

export function rectSortingStrategy({ rects, index, from, to }) {
  const here = rects[index];
  const dest = rects[index + (from < to ? -1 : 1)];
  if (!here || !dest) return null;
  return { x: dest.left - here.left, y: dest.top - here.top, scaleX: here.width ? dest.width / here.width : 1, scaleY: here.height ? dest.height / here.height : 1 };
}
