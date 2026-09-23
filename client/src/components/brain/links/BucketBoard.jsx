import { useState, useCallback, useMemo } from 'react';
import { Plus, FolderPlus, X } from 'lucide-react';
import * as api from '../../../services/api';
import toast from '../../ui/Toast';
import BucketCard from './BucketCard';

/**
 * The bucket board: a responsive grid of bucket cards plus a "new bucket"
 * affordance. The bucket collection + links (the single source of truth) live
 * in the parent LinksTab and flow in via props. Drag-and-drop (reordering
 * buckets, filing/reordering chips) is dnd-kit, driven by the ONE
 * `DndContext` the parent `LinksTab` mounts around this board and the flat
 * link list — see `bucketDnd.js` for the shared coordinate/collision logic.
 */
export default function BucketBoard({ links, buckets, setBuckets, onAssignLink, onAddLinkToBucket, onBucketDeleted }) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  const handleCreate = async (e) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    const bucket = await api.createBrainBucket({ name }, { silent: true }).catch(err => {
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
    const updated = await api.updateBrainBucket(id, patch, { silent: true }).catch(err => {
      toast.error(err.message || 'Failed to update bucket');
      return null;
    });
    if (updated) setBuckets(prev => prev.map(b => (b.id === id ? updated : b)));
  }, [setBuckets]);

  const handleDelete = useCallback(async (id) => {
    const ok = await api.deleteBrainBucket(id, { silent: true }).catch(err => {
      toast.error(err.message || 'Failed to delete bucket');
      return null;
    });
    if (ok) {
      setBuckets(prev => prev.filter(b => b.id !== id));
      // Server unassigned this bucket's links — mirror that locally (no refetch).
      onBucketDeleted?.(id);
    }
  }, [onBucketDeleted, setBuckets]);

  const groupedLinks = useMemo(() => {
    const grouped = new Map();
    links.forEach(link => {
      const bucketLinks = grouped.get(link.bucketId);
      if (bucketLinks) {
        bucketLinks.push(link);
      } else {
        grouped.set(link.bucketId, [link]);
      }
    });
    grouped.forEach(bucketLinks => {
      bucketLinks.sort((a, b) => (a.bucketOrder ?? 0) - (b.bucketOrder ?? 0));
    });
    return grouped;
  }, [links]);

  return (
    <div className="@container">
      <div className="grid grid-cols-1 @md:grid-cols-2 @4xl:grid-cols-3 gap-4">
        {buckets.map((bucket, bucketIndex) => (
          <BucketCard
            key={bucket.id}
            bucket={bucket}
            bucketIndex={bucketIndex}
            links={groupedLinks.get(bucket.id) || []}
            onUpdate={handleUpdate}
            onDelete={handleDelete}
            onAddLink={onAddLinkToBucket}
            onRemoveLink={(link) => onAssignLink?.(link, null)}
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
