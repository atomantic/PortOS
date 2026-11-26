/**
 * Serialize a drag transform to rounded pixel translations and unrounded scales.
 *
 * @param {{x: number, y: number, scaleX: number, scaleY: number}|null|undefined} transform
 * @returns {string|undefined} e.g. `translate3d(4px, 0px, 0) scaleX(1) scaleY(1)`
 */
export function dndTransformToCss(transform) {
  if (!transform) return undefined;
  const { x, y, scaleX, scaleY } = transform;
  return `translate3d(${x ? Math.round(x) : 0}px, ${y ? Math.round(y) : 0}px, 0) scaleX(${scaleX}) scaleY(${scaleY})`;
}
