/**
 * Keeps a stored-but-no-longer-listed pin selectable in a `<select>`.
 *
 * A `<select>` whose `value` matches no `<option>` renders unselected — which
 * reads as "nothing pinned" while the server is still honouring the pin, and
 * a save from that state silently drops it. Returns `list` unchanged when
 * `value` is blank or already present under `key`; otherwise prepends
 * `makeOption(value)` so the pin renders as its own option.
 *
 * `key` names the property each list item is matched on (default `'id'`) —
 * pass the field a given list actually keys on (e.g. `'name'` for a voice
 * list keyed by name rather than id).
 *
 * @param {unknown[]} list
 * @param {string|null|undefined} value
 * @param {(value: string) => unknown} makeOption
 * @param {{key?: string}} [options]
 * @returns {unknown[]}
 */
export const withUnlistedOption = (list, value, makeOption, { key = 'id' } = {}) => {
  if (!value) return list;
  if (list.some((item) => item?.[key] === value)) return list;
  return [makeOption(value), ...list];
};
