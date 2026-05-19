// Newest-first upsert into an id-keyed list: drop any existing entry with
// the same `id`, then prepend `item`. Used by UniverseBuilder list updates
// so the most-recently-edited universe surfaces at the top.
export function upsertByIdPrepend(list, item) {
  return [item, ...list.filter((entry) => entry.id !== item.id)];
}
