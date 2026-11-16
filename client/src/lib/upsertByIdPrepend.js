// Newest-first upsert into an id-keyed list.
export function upsertByIdPrepend(list, item) {
  return [item, ...list.filter((entry) => entry.id !== item.id)];
}
