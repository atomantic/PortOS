// Pure focus-trail transitions for the Brain Graph's re-focus navigation.
// The trail is the breadcrumb path from the overview to the current focus:
// [] = overview, and the last entry is always the node currently focused.
// Kept side-effect-free so it can be unit-tested without React/three.

/**
 * Push a node onto the trail when focusing it. No-op (returns the same trail)
 * when it's already the current focus, so re-clicking the focused node doesn't
 * stack duplicates.
 * @param {{id:string,label:string}[]} trail
 * @param {{id:string,label?:string}} node
 */
export function pushFocus(trail, node) {
  if (!node?.id) return trail;
  if (trail.length && trail[trail.length - 1].id === node.id) return trail;
  return [...trail, { id: node.id, label: node.label || node.id }];
}

/**
 * Pop the current focus. Returns the trimmed trail and the focusId to load next
 * (the new last entry, or null for the overview).
 * @param {{id:string,label:string}[]} trail
 * @returns {{ trail: {id:string,label:string}[], focusId: string|null }}
 */
export function popFocus(trail) {
  const next = trail.slice(0, -1);
  return { trail: next, focusId: next.length ? next[next.length - 1].id : null };
}

/** The currently-focused node id, or null when showing the overview. */
export function currentFocusId(trail) {
  return trail.length ? trail[trail.length - 1].id : null;
}
