import { useEffect, useMemo, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Pencil, Star } from 'lucide-react';
import toast from '../components/ui/Toast';
import MediaCard from '../components/media/MediaCard';
import MediaLightbox from '../components/media/MediaLightbox';
import { normalizeImage, normalizeVideo } from '../components/media/normalize';
import {
  getMediaCollection, updateMediaCollection,
  removeMediaCollectionItem, listImageGallery, listVideoHistory,
  extractLastFrame,
} from '../services/api';

// Hydrate a collection's "<kind>:<ref>" pointer list into the same
// normalized records MediaCard expects. We do this on the client so the
// service stays a pure pointer store — that way an image that's been
// re-edited keeps its current metadata when you open the collection.
const hydrate = (collection, imagesByName, videosById) => {
  const out = [];
  for (const it of collection.items || []) {
    if (it.kind === 'image') {
      const img = imagesByName.get(it.ref);
      if (img) out.push({ ...normalizeImage(img), addedAt: it.addedAt });
    } else if (it.kind === 'video') {
      const vid = videosById.get(it.ref);
      if (vid) out.push({ ...normalizeVideo(vid), addedAt: it.addedAt });
    }
  }
  // Newest-added first — matches the cover-resolution order so the user's
  // mental model of "what's at the top" stays consistent.
  out.sort((a, b) => new Date(b.addedAt || 0) - new Date(a.addedAt || 0));
  return out;
};

export default function MediaCollectionDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [collection, setCollection] = useState(null);
  const [imagesByName, setImagesByName] = useState(new Map());
  const [videosById, setVideosById] = useState(new Map());
  const [loading, setLoading] = useState(true);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [preview, setPreview] = useState(null);

  const refresh = async () => {
    setLoading(true);
    const [c, images, videos] = await Promise.all([
      getMediaCollection(id).catch((err) => {
        toast.error(err.message || 'Collection not found');
        return null;
      }),
      listImageGallery().catch(() => []),
      listVideoHistory().catch(() => []),
    ]);
    setCollection(c);
    setNameDraft(c?.name || '');
    setImagesByName(new Map((images || []).map((i) => [i.filename, i])));
    setVideosById(new Map((videos || []).map((v) => [v.id, v])));
    setLoading(false);
  };
  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  const items = useMemo(
    () => collection ? hydrate(collection, imagesByName, videosById) : [],
    [collection, imagesByName, videosById]
  );

  const handleRename = async () => {
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === collection.name) { setEditingName(false); return; }
    const updated = await updateMediaCollection(collection.id, { name: trimmed }).catch((err) => {
      toast.error(err.message || 'Rename failed');
      return null;
    });
    if (updated) {
      setCollection(updated);
      setEditingName(false);
    }
  };

  const handleSetCover = async (item) => {
    const key = `${item.kind}:${item.kind === 'video' ? item.id : item.filename}`;
    const next = collection.coverKey === key ? null : key;
    const updated = await updateMediaCollection(collection.id, { coverKey: next }).catch((err) => {
      toast.error(err.message || 'Failed to set cover');
      return null;
    });
    if (updated) {
      setCollection(updated);
      toast.success(next ? 'Cover updated' : 'Cover reset to newest');
    }
  };

  const handleRemove = async (item) => {
    const key = `${item.kind}:${item.kind === 'video' ? item.id : item.filename}`;
    const updated = await removeMediaCollectionItem(collection.id, key).catch((err) => {
      toast.error(err.message || 'Remove failed');
      return null;
    });
    if (updated) setCollection(updated);
  };

  // Image-Gen "Remix" and "Send to Video" piping — same patterns as
  // MediaHistory, kept here so the collection grid is a fully usable
  // surface for action workflows, not just a viewer.
  const handleRemix = (item) => {
    const params = new URLSearchParams({ remix: item.filename });
    if (item.prompt) params.set('prompt', item.prompt);
    navigate(`/media/image?${params.toString()}`);
  };
  const handleSendToVideo = (item) => {
    const params = new URLSearchParams({ sourceImageFile: item.filename });
    if (item.width) params.set('w', String(item.width));
    if (item.height) params.set('h', String(item.height));
    navigate(`/media/video?${params.toString()}`);
  };
  const handleContinue = async (item) => {
    const { filename } = await extractLastFrame(item.id).catch((err) => {
      toast.error(err.message || 'Failed to extract last frame');
      return {};
    });
    if (!filename) return;
    const params = new URLSearchParams({ sourceImageFile: filename });
    if (item.width) params.set('w', String(item.width));
    if (item.height) params.set('h', String(item.height));
    navigate(`/media/video?${params.toString()}`);
  };

  if (loading) return <div className="text-gray-500 text-sm">Loading…</div>;
  if (!collection) return (
    <div className="text-gray-500 text-sm">
      <Link to="/media/collections" className="text-port-accent hover:underline">← Back to collections</Link>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link to="/media/collections" className="text-gray-400 hover:text-white" title="Back">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        {editingName ? (
          <input
            autoFocus
            type="text"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={handleRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRename();
              if (e.key === 'Escape') { setNameDraft(collection.name); setEditingName(false); }
            }}
            maxLength={80}
            className="text-xl font-semibold bg-port-card border border-port-border rounded px-2 py-1 text-white focus:outline-none focus:border-port-accent"
          />
        ) : (
          <button type="button" onClick={() => setEditingName(true)} className="text-xl font-semibold text-white hover:text-port-accent flex items-center gap-2">
            {collection.name}
            <Pencil className="w-4 h-4 text-gray-500" />
          </button>
        )}
        <span className="text-xs text-gray-500">{items.length} item{items.length === 1 ? '' : 's'}</span>
      </div>

      {items.length === 0 ? (
        <div className="text-gray-500 text-sm bg-port-card border border-port-border rounded-lg p-6 text-center">
          This collection is empty. Use the folder icon on any image/video card to add items here.
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
          {items.map((item) => {
            const key = `${item.kind}:${item.kind === 'video' ? item.id : item.filename}`;
            const isCover = collection.coverKey === key;
            return (
              <div key={key} className="relative">
                <MediaCard
                  item={item}
                  onPreview={setPreview}
                  onRemix={item.kind === 'image' ? handleRemix : undefined}
                  onSendToVideo={item.kind === 'image' ? handleSendToVideo : undefined}
                  onContinue={item.kind === 'video' ? handleContinue : undefined}
                  onDelete={handleRemove}
                  showCollectionMenu={false}
                />
                <button
                  type="button"
                  onClick={() => handleSetCover(item)}
                  className={`absolute top-1.5 right-1.5 w-7 h-7 rounded-full flex items-center justify-center border transition-colors ${
                    isCover
                      ? 'bg-port-accent text-white border-port-accent'
                      : 'bg-black/60 text-gray-300 border-port-border hover:text-white'
                  }`}
                  title={isCover ? 'Cover (click to reset to newest)' : 'Set as cover'}
                >
                  <Star className="w-3.5 h-3.5" fill={isCover ? 'currentColor' : 'none'} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {preview && (
        <MediaLightbox
          item={preview}
          onClose={() => setPreview(null)}
          onRemix={preview.kind === 'image' ? (i) => handleRemix(i) : undefined}
          onSendToVideo={preview.kind === 'image' ? (i) => handleSendToVideo(i) : undefined}
          onContinue={preview.kind === 'video' ? (i) => handleContinue(i.raw || i) : undefined}
        />
      )}
    </div>
  );
}
