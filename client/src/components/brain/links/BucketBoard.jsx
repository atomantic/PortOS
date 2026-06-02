import { useState, useCallback } from 'react';
import { Plus, FolderPlus, X } from 'lucide-react';
import * as api from '../../../services/api';
import toast from '../../ui/Toast';
import BucketCard from './BucketCard';

/**
 * The bucket board: a responsive grid of bucket cards plus a "new bucket"
 * affordance. The bucket collection + links (the single source of truth) live
 * in the parent LinksTab and flow in via props. Drag-and-drop is carried via
 * dataTransfer (link id / bucket id) so a link dragged from the list, a chip
 * dragged from another bucket, and a bucket header dragged to reorder all
 * resolve the same way regardless of which component started the drag.
 */
export default function BucketBoard({ links, buckets, setBuckets, onAssignLink, onAddLinkToBucket, onBucketDeleted, onMoveLinkToIndex }) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  const handleCreate = async (e) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    const bucket = await api.createBrainBucket({ name }).catch(err => {
      toast.error(err.message || 'Failed to create bucket');
      return null;
    });
    if (bucket) {
      setBuckets(prev => [...prev, bucket]);
      setNewName('');
      setCreating(false);
    }
  };

  const handleUpdate = useCallback(async (id, patch) => {
    const updated = await api.updateBrainBucket(id, patch).catch(err => {
      toast.error(err.message || 'Failed to update bucket');
      return null;
    });
    if (updated) setBuckets(prev => prev.map(b => (b.id === id ? updated : b)));
  }, [setBuckets]);

  const handleDelete = useCallback(async (id) => {
    const ok = await api.deleteBrainBucket(id).catch(err => {
      toast.error(err.message || 'Failed to delete bucket');
      return null;
    });
    if (ok) {
      setBuckets(prev => prev.filter(b => b.id !== id));
      // Server unassigned this bucket's links — mirror that locally (no refetch).
      onBucketDeleted?.(id);
    }
  }, [onBucketDeleted, setBuckets]);

  // --- Drag: move a link (from the list or another bucket) into a bucket ---
  const handleDropLink = useCallback((linkId, bucketId) => {
    const link = links.find(l => l.id === linkId);
    if (link && link.bucketId !== bucketId) {
      onAssignLink?.(link, bucketId);
    }
  }, [links, onAssignLink]);

  // --- Drag: drop a chip at a specific position within (or into) a bucket ---
  const handleMoveLink = useCallback((linkId, bucketId, targetIndex) => {
    const link = links.find(l => l.id === linkId);
    if (link) onMoveLinkToIndex?.(link, bucketId, targetIndex);
  }, [links, onMoveLinkToIndex]);

  // --- Drag: reorder buckets ---
  const handleReorder = useCallback((draggedId, targetBucket) => {
    if (!draggedId || draggedId === targetBucket.id) return;

    setBuckets(prev => {
      const ids = prev.map(b => b.id);
      const from = ids.indexOf(draggedId);
      const to = ids.indexOf(targetBucket.id);
      if (from === -1 || to === -1) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      api.reorderBrainBuckets(next.map(b => b.id)).catch(err => {
        toast.error(err.message || 'Failed to reorder buckets');
      });
      return next;
    });
  }, [setBuckets]);

  const linksFor = (bucketId) => links
    .filter(l => l.bucketId === bucketId)
    .sort((a, b) => (a.bucketOrder ?? 0) - (b.bucketOrder ?? 0));

  return (
    <div className="@container">
      <div className="grid grid-cols-1 @md:grid-cols-2 @4xl:grid-cols-3 gap-4">
        {buckets.map(bucket => (
          <BucketCard
            key={bucket.id}
            bucket={bucket}
            links={linksFor(bucket.id)}
            onUpdate={handleUpdate}
            onDelete={handleDelete}
            onAddLink={onAddLinkToBucket}
            onRemoveLink={(link) => onAssignLink?.(link, null)}
            onDropLink={(linkId) => handleDropLink(linkId, bucket.id)}
            onReorderBucket={(draggedId) => handleReorder(draggedId, bucket)}
            onMoveLink={(linkId, index) => handleMoveLink(linkId, bucket.id, index)}
          />
        ))}

        {/* New bucket */}
        {creating ? (
          <form
            onSubmit={handleCreate}
            className="flex flex-col items-stretch justify-center gap-2 p-4 bg-port-card border border-dashed border-port-accent/50 rounded-lg"
          >
            <label htmlFor="new-bucket-name" className="sr-only">New bucket name</label>
            <input
              id="new-bucket-name"
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Bucket name (e.g. Reading list)"
              className="px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm focus:outline-hidden focus:border-port-accent"
              autoFocus
            />
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={!newName.trim()}
                className="flex items-center gap-1 px-3 py-1.5 text-sm bg-port-accent hover:bg-port-accent/80 text-white rounded transition-colors disabled:opacity-40"
              >
                <Plus size={14} /> Create
              </button>
              <button
                type="button"
                onClick={() => { setCreating(false); setNewName(''); }}
                className="flex items-center gap-1 px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors"
              >
                <X size={14} /> Cancel
              </button>
            </div>
          </form>
        ) : (
          <button
            onClick={() => setCreating(true)}
            className="flex flex-col items-center justify-center gap-2 p-4 min-h-[7rem] bg-port-card/50 border border-dashed border-port-border rounded-lg text-gray-500 hover:text-port-accent hover:border-port-accent/50 transition-colors"
          >
            <FolderPlus size={22} />
            <span className="text-sm">New bucket</span>
          </button>
        )}
      </div>
    </div>
  );
}
