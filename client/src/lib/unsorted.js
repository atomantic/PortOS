// Synthetic "Unsorted" collection: every image/video that isn't filed in at
// least one real collection. Derived client-side from the three list
// endpoints that both /media/collections and /media/collections/:id already
// fetch, so no new server route is required.

export const UNSORTED_ID = 'unsorted';

export function buildUnsortedCollection(collections, images, videos) {
  const filed = new Set();
  for (const c of collections || []) {
    for (const it of c.items || []) {
      filed.add(`${it.kind}:${it.ref}`);
    }
  }
  const items = [];
  for (const img of images || []) {
    if (!img?.filename) continue;
    const key = `image:${img.filename}`;
    if (!filed.has(key)) {
      items.push({ kind: 'image', ref: img.filename, addedAt: img.createdAt });
    }
  }
  for (const vid of videos || []) {
    if (!vid?.id) continue;
    const key = `video:${vid.id}`;
    if (!filed.has(key)) {
      items.push({ kind: 'video', ref: vid.id, addedAt: vid.createdAt });
    }
  }
  items.sort((a, b) => new Date(b.addedAt || 0) - new Date(a.addedAt || 0));
  return {
    id: UNSORTED_ID,
    name: 'Unsorted',
    description: 'Media not in any collection',
    items,
    coverKey: null,
    synthetic: true,
    createdAt: null,
    updatedAt: null,
  };
}
