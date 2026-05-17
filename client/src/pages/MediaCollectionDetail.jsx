import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, CheckSquare, Copy, FolderInput, Inbox, Lock, Pencil, Star, StarOff, Trash2, X } from 'lucide-react';
import ShareToButton from '../components/sharing/ShareToButton';
import toast from '../components/ui/Toast';
import MediaCard from '../components/media/MediaCard';
import MediaPreview from '../components/media/MediaPreview';
import BulkTargetPicker from '../components/media/BulkTargetPicker';
import { normalizeImage, normalizeVideo } from '../components/media/normalize';
import { useMediaAnnotations } from '../hooks/useMediaAnnotations';
import { UNSORTED_ID, buildUnsortedCollection } from '../lib/unsorted';
import {
  getMediaCollection, updateMediaCollection,
  listMediaCollections,
  addMediaCollectionItem, removeMediaCollectionItem,
  listImageGallery, listVideoHistory,
  extractLastFrame, cleanGalleryImage,
  deleteImage, deleteVideoHistoryItem,
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
  const isUnsorted = id === UNSORTED_ID;
  const navigate = useNavigate();
  const [collection, setCollection] = useState(null);
  // Full collections list — fetched once for the bulk move/copy picker so it
  // doesn't pay a per-mount listMediaCollections() round-trip when opened.
  // Already loaded for the unsorted view as part of buildUnsortedCollection().
  const [allCollections, setAllCollections] = useState(null);
  const [imagesByName, setImagesByName] = useState(new Map());
  const [videosById, setVideosById] = useState(new Map());
  const [loading, setLoading] = useState(true);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [preview, setPreview] = useState(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // 'move' = add to target + remove from current; 'copy' = add only.
  const [pickerMode, setPickerMode] = useState(null);
  const moveBtnRef = useRef(null);
  const copyBtnRef = useRef(null);
  const { annotations, toggleStar, updateAnnotation, getCardProps } = useMediaAnnotations();

  const refresh = useCallback(async () => {
    setLoading(true);
    if (isUnsorted) {
      const [cols, images, videos] = await Promise.all([
        listMediaCollections().catch(() => []),
        listImageGallery().catch(() => []),
        listVideoHistory().catch(() => []),
      ]);
      setAllCollections(Array.isArray(cols) ? cols : []);
      setCollection(buildUnsortedCollection(cols, images, videos));
      setImagesByName(new Map((images || []).map((i) => [i.filename, i])));
      setVideosById(new Map((videos || []).map((v) => [v.id, v])));
      setLoading(false);
      return;
    }
    const [c, cols, images, videos] = await Promise.all([
      getMediaCollection(id).catch((err) => {
        toast.error(err.message || 'Collection not found');
        return null;
      }),
      listMediaCollections().catch(() => []),
      listImageGallery().catch(() => []),
      listVideoHistory().catch(() => []),
    ]);
    setCollection(c);
    setAllCollections(Array.isArray(cols) ? cols : []);
    setNameDraft(c?.name || '');
    setImagesByName(new Map((images || []).map((i) => [i.filename, i])));
    setVideosById(new Map((videos || []).map((v) => [v.id, v])));
    setLoading(false);
  }, [id, isUnsorted]);
  useEffect(() => { refresh(); }, [refresh]);

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
    const next = collection.coverKey === item.key ? null : item.key;
    const updated = await updateMediaCollection(collection.id, { coverKey: next }).catch((err) => {
      toast.error(err.message || 'Failed to set cover');
      return null;
    });
    if (updated) {
      setCollection(updated);
      toast.success(next ? 'Cover updated' : 'Cover reset to newest');
    }
  };

  // Per-card trash deletes the underlying file (matches MediaHistory). To
  // unfile an item from a single collection without deleting it, the user
  // either un-checks the current collection via the folder+ menu, or selects
  // it in select-mode and uses the bulk "Remove" action. Dropping the file
  // from the local image/video maps makes `hydrate()` filter it out of every
  // collection view at once — server-side `collection.items[]` may briefly
  // hold a dangling ref until the next mutation rewrites the file.
  const handleDelete = async (item) => {
    const ok = await (item.kind === 'image'
      ? deleteImage(item.filename)
      : deleteVideoHistoryItem(item.id)
    ).catch((err) => {
      toast.error(err.message || 'Delete failed');
      return null;
    });
    if (!ok) return;
    if (item.kind === 'image') {
      setImagesByName((m) => {
        const next = new Map(m);
        next.delete(item.filename);
        return next;
      });
    } else {
      setVideosById((m) => {
        const next = new Map(m);
        next.delete(item.id);
        return next;
      });
    }
    toast.success(`Deleted ${item.kind === 'image' ? item.filename : 'video'}`);
  };

  // Unordered membership — Set, not array.
  const toggleSelect = (key) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const exitSelectMode = () => { setSelectMode(false); setSelected(new Set()); setPickerMode(null); };
  const selectedItems = useMemo(
    () => items.filter((it) => selected.has(it.key)),
    [items, selected],
  );

  // Sequential — annotations and collections both do read-modify-write of a
  // single JSON file with no per-record lock; parallel writes lose updates.
  const bulkStar = async (starred) => {
    if (selectedItems.length === 0) return;
    setBulkBusy(true);
    for (const it of selectedItems) {
      await updateAnnotation(it.key, { starred });
    }
    setBulkBusy(false);
    toast.success(`${starred ? 'Favorited' : 'Unfavorited'} ${selectedItems.length} item${selectedItems.length === 1 ? '' : 's'}`);
  };

  const bulkRemove = async () => {
    if (selectedItems.length === 0) return;
    setBulkBusy(true);
    let lastOk = null;
    let failed = 0;
    for (const it of selectedItems) {
      const r = await removeMediaCollectionItem(collection.id, it.key, { silent: true }).catch(() => null);
      if (r) lastOk = r; else failed++;
    }
    if (lastOk) setCollection(lastOk);
    setBulkBusy(false);
    exitSelectMode();
    if (failed) toast.error(`Removed ${selectedItems.length - failed}; ${failed} failed`);
    else toast.success(`Removed ${selectedItems.length} item${selectedItems.length === 1 ? '' : 's'} from "${collection.name}"`);
  };

  const bulkMoveOrCopy = async (targetId, targetName) => {
    if (selectedItems.length === 0 || !pickerMode) return;
    const mode = pickerMode;
    setPickerMode(null);
    setBulkBusy(true);
    const placedKeys = new Set();
    let added = 0;
    let dupes = 0;
    for (const it of selectedItems) {
      const ref = it.kind === 'video' ? it.id : it.filename;
      const r = await addMediaCollectionItem(targetId, { kind: it.kind, ref }, { silent: true }).catch((err) => {
        if (err?.code === 'DUPLICATE') { dupes++; placedKeys.add(it.key); return 'dupe'; }
        return null;
      });
      if (r && r !== 'dupe') { added++; placedKeys.add(it.key); }
    }
    if (mode === 'move' && placedKeys.size > 0) {
      if (isUnsorted) {
        // Source is synthetic — placing items in any real collection takes
        // them out of Unsorted automatically. Just re-derive the view.
        await refresh();
      } else {
        let lastOk = null;
        for (const it of selectedItems) {
          if (!placedKeys.has(it.key)) continue;
          const r = await removeMediaCollectionItem(collection.id, it.key, { silent: true }).catch(() => null);
          if (r) lastOk = r;
        }
        if (lastOk) setCollection(lastOk);
      }
    }
    setBulkBusy(false);
    exitSelectMode();
    const verb = mode === 'move' ? (isUnsorted ? 'Filed' : 'Moved') : 'Copied';
    const note = dupes > 0 ? ` (${dupes} already there)` : '';
    const stranded = selectedItems.length - added - dupes;
    if (stranded > 0) toast.error(`${verb} ${added} to "${targetName}"${note}; ${stranded} failed`);
    else toast.success(`${verb} ${added} to "${targetName}"${note}`);
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
  const handleClean = async (img, level) => {
    if (!img?.filename) throw new Error('Missing filename');
    const cleaned = await cleanGalleryImage(img.filename, level).catch((err) => {
      toast.error(err.message || 'Failed to clean image');
      throw err;
    });
    const updated = await addMediaCollectionItem(collection.id, {
      kind: 'image',
      ref: cleaned.filename,
    }).catch(() => null);
    if (updated) setCollection(updated);
    // Seed imagesByName so hydrate() can render the cleaned file immediately
    // — without this the next render misses it until refresh() reruns.
    setImagesByName((m) => {
      const next = new Map(m);
      next.set(cleaned.filename, cleaned);
      return next;
    });
    toast.success(`Cleaned (${level}) → ${cleaned.filename}`);
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

  const renderTitle = () => {
    if (isUnsorted) return (
      <h1 className="text-xl font-semibold text-white flex items-center gap-2">
        <Inbox className="w-5 h-5 text-port-accent" />
        {collection.name}
      </h1>
    );
    // Universe-linked collections own their visible name — the user-facing
    // identity follows the universe (renaming the universe cascades here).
    // Routing is by `universeId` server-side regardless of name; this lock
    // exists to keep the displayed name consistent with the universe. The
    // server enforces it independently via the rename-lock in
    // updateCollection. The lock state is exposed visually (icon + title
    // tooltip for sighted users) and programmatically via the `sr-only`
    // span — real text content screen readers announce after the
    // collection name. An `aria-label` on the heading would override the
    // visible name; the `sr-only` text adds context without clobbering it.
    if (collection.universeId) {
      const lockMsg = 'Linked to a Universe — rename the universe to rename this collection.';
      return (
        <h1
          className="text-xl font-semibold text-white flex items-center gap-2"
          title={lockMsg}
        >
          {collection.name}
          <Lock className="w-4 h-4 text-gray-500" aria-hidden="true" />
          <span className="sr-only">{lockMsg}</span>
        </h1>
      );
    }
    if (editingName) return (
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
    );
    return (
      <button type="button" onClick={() => setEditingName(true)} className="text-xl font-semibold text-white hover:text-port-accent flex items-center gap-2">
        {collection.name}
        <Pencil className="w-4 h-4 text-gray-500" />
      </button>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link to="/media/collections" className="text-gray-400 hover:text-white" title="Back">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        {renderTitle()}
        <span className="text-xs text-gray-500">{items.length} item{items.length === 1 ? '' : 's'}</span>
        {items.length > 0 && !selectMode && (
          <button
            type="button"
            onClick={() => setSelectMode(true)}
            className="ml-auto px-2.5 py-1 text-xs bg-port-border hover:bg-port-border/70 text-white rounded flex items-center gap-1.5"
            title="Select multiple to move, copy, star, or remove"
          >
            <CheckSquare className="w-3.5 h-3.5" /> Select
          </button>
        )}
      </div>

      {selectMode && (
        <div className="bg-port-card border border-port-border rounded-lg px-3 py-2 flex flex-wrap items-center gap-2 sticky top-0 z-30">
          <span className="text-xs text-gray-300">
            <span className="text-white font-medium">{selected.size}</span> of {items.length} selected
          </span>
          <button
            type="button"
            onClick={() => setSelected(new Set(items.map((it) => it.key)))}
            disabled={bulkBusy || selected.size === items.length}
            className="px-2 py-1 text-[11px] bg-port-border hover:bg-port-border/70 text-white rounded disabled:opacity-40"
          >
            Select all
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            disabled={bulkBusy || selected.size === 0}
            className="px-2 py-1 text-[11px] bg-port-border hover:bg-port-border/70 text-white rounded disabled:opacity-40"
          >
            Clear
          </button>
          <div className="flex flex-wrap items-center gap-1.5 ml-auto">
            <button
              type="button"
              onClick={() => bulkStar(true)}
              disabled={bulkBusy || selected.size === 0}
              className="px-2 py-1 text-[11px] bg-port-warning/20 hover:bg-port-warning/40 text-port-warning rounded flex items-center gap-1 disabled:opacity-40"
              title="Favorite selected"
            >
              <Star className="w-3 h-3" /> Star
            </button>
            <button
              type="button"
              onClick={() => bulkStar(false)}
              disabled={bulkBusy || selected.size === 0}
              className="px-2 py-1 text-[11px] bg-port-border hover:bg-port-border/70 text-white rounded flex items-center gap-1 disabled:opacity-40"
              title="Unfavorite selected"
            >
              <StarOff className="w-3 h-3" /> Unstar
            </button>
            <ShareToButton
              kind="media"
              items={selectedItems.map((it) => ({ kind: it.kind, ref: it.ref }))}
              label="Share…"
            />
            <button
              ref={moveBtnRef}
              type="button"
              onClick={() => setPickerMode((m) => (m === 'move' ? null : 'move'))}
              disabled={bulkBusy || selected.size === 0}
              className="px-2 py-1 text-[11px] bg-port-accent/20 hover:bg-port-accent/40 text-port-accent rounded flex items-center gap-1 disabled:opacity-40"
              title={isUnsorted ? 'File selected into a collection' : 'Move selected to another collection'}
            >
              <FolderInput className="w-3 h-3" /> {isUnsorted ? 'File…' : 'Move…'}
            </button>
            {!isUnsorted && (
              <>
                <button
                  ref={copyBtnRef}
                  type="button"
                  onClick={() => setPickerMode((m) => (m === 'copy' ? null : 'copy'))}
                  disabled={bulkBusy || selected.size === 0}
                  className="px-2 py-1 text-[11px] bg-port-accent/20 hover:bg-port-accent/40 text-port-accent rounded flex items-center gap-1 disabled:opacity-40"
                  title="Copy selected to another collection"
                >
                  <Copy className="w-3 h-3" /> Copy…
                </button>
                <button
                  type="button"
                  onClick={bulkRemove}
                  disabled={bulkBusy || selected.size === 0}
                  className="px-2 py-1 text-[11px] bg-port-error/20 hover:bg-port-error/40 text-port-error rounded flex items-center gap-1 disabled:opacity-40"
                  title="Remove selected from this collection"
                >
                  <Trash2 className="w-3 h-3" /> Remove
                </button>
              </>
            )}
            <button
              type="button"
              onClick={exitSelectMode}
              disabled={bulkBusy}
              className="p-1 text-gray-400 hover:text-white disabled:opacity-40"
              title="Exit select mode"
              aria-label="Exit select mode"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          {pickerMode && (
            <BulkTargetPicker
              anchorRef={pickerMode === 'move' ? moveBtnRef : copyBtnRef}
              excludeId={collection.id}
              busy={bulkBusy}
              title={`${pickerMode === 'move' ? 'Move' : 'Copy'} ${selected.size} to…`}
              collections={allCollections}
              onPick={bulkMoveOrCopy}
              onClose={() => setPickerMode(null)}
            />
          )}
        </div>
      )}

      {items.length === 0 ? (
        <div className="text-gray-500 text-sm bg-port-card border border-port-border rounded-lg p-6 text-center">
          {isUnsorted
            ? 'Nothing unsorted — every image and video is in at least one collection.'
            : 'This collection is empty. Use the folder icon on any image/video card to add items here.'}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
          {items.map((item) => {
            const key = item.key;
            const isCover = collection.coverKey === key;
            const isSelected = selected.has(key);
            return (
              <div key={key} className="relative">
                <MediaCard
                  item={item}
                  onPreview={selectMode ? undefined : setPreview}
                  onClick={selectMode ? () => toggleSelect(key) : undefined}
                  onRemix={!selectMode && item.kind === 'image' ? handleRemix : undefined}
                  onSendToVideo={!selectMode && item.kind === 'image' ? handleSendToVideo : undefined}
                  onContinue={!selectMode && item.kind === 'video' ? handleContinue : undefined}
                  onDelete={!selectMode ? handleDelete : undefined}
                  hideActions={selectMode}
                  selected={isSelected}
                  {...getCardProps(key)}
                  onToggleStar={!selectMode ? toggleStar : undefined}
                />
                {!selectMode && !isUnsorted && (
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
                )}
                {selectMode && isSelected && (
                  <div className="absolute top-1.5 right-1.5 w-7 h-7 rounded-full bg-port-accent text-white border border-port-accent flex items-center justify-center pointer-events-none">
                    <CheckSquare className="w-4 h-4" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <MediaPreview
        preview={preview}
        setPreview={setPreview}
        items={items}
        annotations={annotations}
        updateAnnotation={updateAnnotation}
        onRemix={handleRemix}
        onSendToVideo={handleSendToVideo}
        onContinue={(i) => handleContinue(i.raw || i)}
        onClean={(i, level) => handleClean(i?.raw || i, level)}
      />
    </div>
  );
}
