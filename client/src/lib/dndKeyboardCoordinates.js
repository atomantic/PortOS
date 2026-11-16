/**
 * Keyboard coordinate getters for `@dnd-kit/core`'s `KeyboardSensor`.
 *
 * `@dnd-kit/sortable` ships `sortableKeyboardCoordinates` for a `SortableContext`, and a board with its own geometry writes a bespoke getter (`KanbanBoard.jsx`'s `kanbanKeyboardCoordinates`). What has no shipped answer
 * is a `DndContext` whose drop targets are FREE `useDroppable` zones (a folder list, a goal tree) with no sort order to interpolate against. dnd-kit's default getter nudges 25px per arrow press, so crossing a tall
 * zone takes a dozen presses and a zone shorter than the step can be skipped; this getter JUMPS to the adjacent drop zone in visual order, as a pointer user gets and the announcements describe.
 *
 * `keyboardAwareCollisionDetection` is the other half: the jump lands on a zone's centre, which `closestCenter` resolves and `rectIntersection` may not.
 */

import { closestCenter, rectIntersection } from '@dnd-kit/core';

/**
 * dnd-kit's default collision detection for pointer drags, `closestCenter` for keyboard ones. A keyboard drag needs `closestCenter` (the getters move the drag to a zone's centre; with `rectIntersection` a destination smaller
 * than the dragged item still resolves to no target). Applying it to POINTER drags too is the tempting version but a behavior change: it always finds a nearest target, so a drop over empty space would file into the closest zone.
 */
export function keyboardAwareCollisionDetection(args) {
  return args.pointerCoordinates ? rectIntersection(args) : closestCenter(args);
}

// Both axes traverse the same one-dimensional list of zones: these surfaces are
// vertical lists, and a user who reaches for Left/Right on one should not find
// the key dead.
const DIRECTIONS = {
  ArrowDown: 1,
  ArrowRight: 1,
  ArrowUp: -1,
  ArrowLeft: -1,
};

/**
 * Build a `coordinateGetter` that steps a keyboard drag between the enabled
 * droppables of a `DndContext`, ordered top-to-bottom then left-to-right.
 * @param {object} [options]
 * @param {(entry: { id: string|number, data: object, active: object|null }) => boolean} [options.isSkipped]
 *   Return true for a zone the drag must step OVER rather than land on — a
 *   target that would be a no-op, such as the dragged item's own row. Skipped
 *   zones are still traversed, so a run of them costs one keypress, not one
 *   per zone.
 * @returns {(event: KeyboardEvent, args: object) => ({ x: number, y: number } | undefined)}
 */
export function createFreeDroppableKeyboardCoordinates({ isSkipped } = {}) {
  return function freeDroppableKeyboardCoordinates(event, { active, context }) {
    const direction = DIRECTIONS[event.code];
    if (!direction) return undefined;

    const activeDescriptor = context?.active || active || null;
    const zones = (context?.droppableContainers?.getEnabled?.() || [])
      .map((container) => ({
        id: container.id,
        data: container.data?.current || {},
        rect: context.droppableRects?.get(container.id),
      }))
      .filter((zone) => zone.rect)
      .sort((left, right) => (left.rect.top - right.rect.top) || (left.rect.left - right.rect.left));
    if (zones.length === 0) return undefined;

    // No current target means the drag started over nothing (an empty or
    // scrolled-away region). Enter the list from the end the key points at
    // rather than making the first keypress do nothing.
    const currentIndex = zones.findIndex((zone) => zone.id === context?.over?.id);
    let index = currentIndex === -1
      ? (direction > 0 ? 0 : zones.length - 1)
      : currentIndex + direction;
    while (zones[index] && isSkipped?.({ ...zones[index], active: activeDescriptor })) index += direction;

    const target = zones[index];
    if (!target) return undefined;

    // KeyboardSensor reads the result as the dragged node's top-left corner.
    // Centering it on the zone keeps `closestCenter` from preferring a
    // neighbour when the destination is taller than the item being dragged.
    const activeRect = activeDescriptor?.rect?.current?.translated
      || activeDescriptor?.rect?.current?.initial;
    return {
      x: target.rect.left + (target.rect.width - (activeRect?.width || 0)) / 2,
      y: target.rect.top + (target.rect.height - (activeRect?.height || 0)) / 2,
    };
  };
}
