// Owned replacement for `@dnd-kit/utilities`' `CSS.Transform.toString()`.
// dnd-kit's `useSortable` hands back a `{ x, y, scaleX, scaleY }` transform (or
// `null` when the node isn't being dragged); every PortOS call site feeds that
// straight into a `style.transform`. That one call shape was the only reason the
// package was a dependency, so we own the ~10 lines instead.
//
// Behavior matches @dnd-kit/utilities 3.2.2 exactly: `undefined` for a nullish
// transform (so React omits the property), translations rounded to whole pixels,
// scales emitted verbatim.

/**
 * Render a dnd-kit transform as a CSS `transform` value.
 * @param {{x: number, y: number, scaleX: number, scaleY: number}|null|undefined} transform
 * @returns {string|undefined} e.g. `translate3d(4px, 0px, 0) scaleX(1) scaleY(1)`
 */
export function dndTransformToCss(transform) {
  if (!transform) return undefined;
  const { x, y, scaleX, scaleY } = transform;
  return `translate3d(${x ? Math.round(x) : 0}px, ${y ? Math.round(y) : 0}px, 0) scaleX(${scaleX}) scaleY(${scaleY})`;
}
