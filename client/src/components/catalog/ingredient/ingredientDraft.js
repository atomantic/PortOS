// Value helpers shared by the catalog ingredient editor's draft, dirty check
// and revision diff.

// Canon types whose records carry alternate ages/looks (`payload.forms`).
export const FORM_TYPES = new Set(['character', 'place', 'object']);

// Compare JSON-shaped editor values by value while ignoring object-key order.
// A catalog payload can arrive from a peer with the same fields in a different
// order; that is not an edit the user needs to save.
function stableSerialize(value) {
  return JSON.stringify(value, (_key, current) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return current;
    return Object.keys(current).sort().reduce((sorted, key) => {
      sorted[key] = current[key];
      return sorted;
    }, {});
  });
}

export function sameValue(left, right) {
  return stableSerialize(left) === stableSerialize(right);
}

export function ingredientPayload(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
