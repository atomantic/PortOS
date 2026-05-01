import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, FolderOpen, Trash2, Image as ImageIcon, Film } from 'lucide-react';
import toast from '../components/ui/Toast';
import {
  listMediaCollections, createMediaCollection, deleteMediaCollection,
  listVideoHistory, listImageGallery,
} from '../services/api';

// Resolve a collection's cover-thumbnail URL. Default = newest item by
// addedAt; user-pinned coverKey wins when set. We need full image/video
// records to build the thumbnail src, so the page fetches both lists once
// and shares them across cards via a Map lookup.
const resolveCover = (collection, imagesByName, videosById) => {
  const items = collection.items || [];
  if (items.length === 0) return null;

  const lookup = (it) => {
    if (it.kind === 'image') {
      const img = imagesByName.get(it.ref);
      return img ? (img.path || `/data/images/${img.filename}`) : null;
    }
    const vid = videosById.get(it.ref);
    return vid?.thumbnail ? `/data/video-thumbnails/${vid.thumbnail}` : null;
  };

  if (collection.coverKey) {
    const pinned = items.find((it) => `${it.kind}:${it.ref}` === collection.coverKey);
    if (pinned) {
      const url = lookup(pinned);
      if (url) return url;
    }
  }
  // Fallback chain: most-recently-added item with a renderable thumbnail.
  const sorted = [...items].sort((a, b) => new Date(b.addedAt || 0) - new Date(a.addedAt || 0));
  for (const it of sorted) {
    const url = lookup(it);
    if (url) return url;
  }
  return null;
};

export default function MediaCollections() {
  const [collections, setCollections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [imagesByName, setImagesByName] = useState(new Map());
  const [videosById, setVideosById] = useState(new Map());

  const refresh = async () => {
    setLoading(true);
    const [cols, images, videos] = await Promise.all([
      listMediaCollections().catch(() => []),
      listImageGallery().catch(() => []),
      listVideoHistory().catch(() => []),
    ]);
    setCollections(Array.isArray(cols) ? cols : []);
    setImagesByName(new Map((images || []).map((i) => [i.filename, i])));
    setVideosById(new Map((videos || []).map((v) => [v.id, v])));
    setLoading(false);
  };
  useEffect(() => { refresh(); }, []);

  const handleCreate = async (e) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    const created = await createMediaCollection({ name: trimmed }).catch((err) => {
      toast.error(err.message || 'Failed to create');
      return null;
    });
    setCreating(false);
    if (created) {
      setCollections((prev) => [...prev, created]);
      setName('');
      toast.success(`Created "${created.name}"`);
    }
  };

  const handleDelete = async (collection) => {
    setCollections((prev) => prev.filter((c) => c.id !== collection.id));
    await deleteMediaCollection(collection.id).catch((err) => {
      toast.error(err.message || 'Delete failed');
      refresh();
    });
  };

  const enriched = useMemo(() => collections.map((c) => {
    const counts = (c.items || []).reduce((acc, it) => {
      acc[it.kind] = (acc[it.kind] || 0) + 1;
      return acc;
    }, { image: 0, video: 0 });
    return { ...c, cover: resolveCover(c, imagesByName, videosById), counts };
  }), [collections, imagesByName, videosById]);

  return (
    <div className="space-y-4">
      <form onSubmit={handleCreate} className="flex gap-2 items-center">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          placeholder="New collection name"
          className="flex-1 bg-port-card border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
        />
        <button
          type="submit"
          disabled={creating || !name.trim()}
          className="px-3 py-2 bg-port-accent/20 hover:bg-port-accent/40 text-port-accent rounded-lg text-sm flex items-center gap-1.5 disabled:opacity-40"
        >
          <Plus className="w-4 h-4" /> Create
        </button>
      </form>

      {loading ? (
        <div className="text-gray-500 text-sm">Loading…</div>
      ) : enriched.length === 0 ? (
        <div className="text-gray-500 text-sm bg-port-card border border-port-border rounded-lg p-6 text-center">
          No collections yet. Create one above, or use the folder icon on any image/video card to start a new collection.
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {enriched.map((c) => (
            <div key={c.id} className="bg-port-card border border-port-border rounded-xl overflow-hidden flex flex-col">
              <Link
                to={`/media/collections/${encodeURIComponent(c.id)}`}
                className="block aspect-square bg-port-bg relative"
              >
                {c.cover ? (
                  <img src={c.cover} alt={c.name} className="w-full h-full object-cover" loading="lazy" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-gray-600">
                    <FolderOpen className="w-12 h-12" />
                  </div>
                )}
              </Link>
              <div className="p-2 space-y-1.5 flex-1 flex flex-col">
                <Link to={`/media/collections/${encodeURIComponent(c.id)}`} className="text-sm text-white hover:text-port-accent line-clamp-1" title={c.name}>
                  {c.name}
                </Link>
                <div className="flex items-center gap-2 text-[10px] text-gray-500">
                  {c.counts.image > 0 && <span className="flex items-center gap-1"><ImageIcon className="w-3 h-3" />{c.counts.image}</span>}
                  {c.counts.video > 0 && <span className="flex items-center gap-1"><Film className="w-3 h-3" />{c.counts.video}</span>}
                  {c.counts.image === 0 && c.counts.video === 0 && <span>Empty</span>}
                </div>
                <div className="flex-1" />
                <button
                  type="button"
                  onClick={() => handleDelete(c)}
                  className="self-end px-1.5 py-1 bg-port-error/20 hover:bg-port-error/40 text-port-error text-[10px] rounded flex items-center gap-1"
                  title="Delete collection"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
