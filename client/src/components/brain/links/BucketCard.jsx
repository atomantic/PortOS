import { useState, Fragment } from 'react';
import { Plus, Edit2, Trash2, Save, X, Check, GripVertical } from 'lucide-react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import BrailleSpinner from '../../BrailleSpinner';
import InlineConfirmRow from '../../ui/InlineConfirmRow';
import LinkChip from './LinkChip';
import { bucketColor, BUCKET_COLORS, BUCKET_COLOR_KEYS } from './bucketColors';
import { bucketDropId, chipSlotId, BUCKET_KIND, LINK_KIND, LINK_SLOT_KIND } from './bucketDnd';

/**
 * A single bucket (bookmark group): colored header with inline edit/delete,
 * a grid of link chips, and an inline "add URL" affordance.
 *
 * Drag-and-drop is dnd-kit, driven by the ONE `DndContext` in `LinksTab`
 * (buckets and chips share it so a link can move from the flat list straight
 * into a bucket). This card registers two independent drop targets: the
 * whole card is a 'bucket' droppable (reordering the board), and each chip —
 * plus the chip area as a whole, for "append to the end" — is a 'link-slot'
 * droppable (filing/reordering a link). The two never collide because
 * `linksCollisionDetection` only matches droppables of the dragged item's own
 * kind.
 */
export default function BucketCard({
  bucket,
  bucketIndex,
  links,
  onUpdate,
  onDelete,
  onAddLink,
  onRemoveLink,
}) {
  const formFromBucket = () => ({ name: bucket.name, color: bucket.color, icon: bucket.icon || '' });
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [form, setForm] = useState(formFromBucket);
  const [addUrl, setAddUrl] = useState('');
  const [adding, setAdding] = useState(false);

  const colors = bucketColor(bucket.color);

  const { setNodeRef: setCardDropRef, isOver: isBucketOver } = useDroppable({
    id: bucketDropId(bucket.id),
    data: { kind: BUCKET_KIND, bucketId: bucket.id, bucketName: bucket.name, bucketIndex },
  });
  const {
    attributes: bucketDragAttrs, listeners: bucketDragListeners,
    setNodeRef: setBucketDragRef, setActivatorNodeRef: setBucketActivatorRef,
    isDragging: isBucketDragging,
  } = useDraggable({
    id: `bucket-drag:${bucket.id}`,
    data: { kind: BUCKET_KIND, bucket, bucketIndex },
  });
  const { setNodeRef: setEndSlotRef, isOver: isEndSlotOver } = useDroppable({
    id: chipSlotId(bucket.id, links.length),
    data: { kind: LINK_SLOT_KIND, bucketId: bucket.id, bucketName: bucket.name, bucketIndex, index: links.length },
  });

  const startEdit = () => {
    setForm(formFromBucket());
    setEditing(true);
  };

  const saveEdit = async () => {
    const name = form.name.trim();
    if (!name) return;
    await onUpdate(bucket.id, { name, color: form.color, icon: form.icon.trim() });
    setEditing(false);
  };

  const handleAdd = async (e) => {
    e.preventDefault();
    const url = addUrl.trim();
    if (!url || adding) return;
    setAdding(true);
    const ok = await onAddLink(url, bucket.id);
    setAdding(false);
    if (ok) setAddUrl('');
  };

  return (
    <div
      ref={setCardDropRef}
      className={`flex flex-col bg-port-card border rounded-lg overflow-hidden transition-colors ${
        isBucketOver ? 'border-port-accent ring-1 ring-port-accent' : 'border-port-border'
      } ${isBucketDragging ? 'opacity-30' : ''}`}
    >
      {/* Header */}
      {editing ? (
        <div className="p-3 space-y-2 border-b border-port-border">
          <div>
            <label htmlFor={`bucket-name-${bucket.id}`} className="sr-only">Bucket name</label>
            <input
              id={`bucket-name-${bucket.id}`}
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-white text-sm"
              placeholder="Bucket name"
              autoFocus
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={form.icon}
              onChange={(e) => setForm({ ...form, icon: e.target.value })}
              className="w-12 px-2 py-1 bg-port-bg border border-port-border rounded text-white text-sm text-center"
              placeholder="🔖"
              maxLength={4}
              aria-label="Bucket icon (emoji)"
            />
            <div className="flex items-center gap-1 flex-wrap">
              {BUCKET_COLOR_KEYS.map(key => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setForm({ ...form, color: key })}
                  className={`w-5 h-5 rounded-full ${BUCKET_COLORS[key].dot} flex items-center justify-center`}
                  title={key}
                  aria-label={`Color ${key}`}
                >
                  {form.color === key && <Check size={12} className="text-white" />}
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={saveEdit}
              className="flex items-center gap-1 px-2 py-1 text-xs bg-port-success/20 text-port-success rounded hover:bg-port-success/30 transition-colors"
            >
              <Save size={12} /> Save
            </button>
            <button
              onClick={() => setEditing(false)}
              className="flex items-center gap-1 px-2 py-1 text-xs text-gray-400 hover:text-white transition-colors"
            >
              <X size={12} /> Cancel
            </button>
          </div>
        </div>
      ) : (
        // py-1 rather than py-2: the 44px action buttons now set the row height,
        // so the larger tap targets don't also inflate the header.
        <div ref={setBucketDragRef} className={`flex items-center gap-2 px-3 py-1 border-b ${colors.header}`}>
          <button
            type="button"
            ref={setBucketActivatorRef}
            {...bucketDragAttrs}
            {...bucketDragListeners}
            className="shrink-0 flex items-center justify-center text-gray-500 cursor-grab active:cursor-grabbing"
            aria-label={`Reorder bucket ${bucket.name}`}
            title="Drag to reorder buckets"
          >
            <GripVertical size={14} />
          </button>
          {bucket.icon && <span className="shrink-0 text-base leading-none">{bucket.icon}</span>}
          <h3 className={`font-medium truncate flex-1 ${colors.text}`}>{bucket.name}</h3>
          <span className="text-xs text-gray-500">{links.length}</span>
          <button
            onClick={startEdit}
            className="shrink-0 flex items-center justify-center min-h-[44px] min-w-[44px] rounded text-gray-400 hover:text-white transition-colors"
            title="Edit bucket" aria-label="Edit bucket"
          >
            <Edit2 size={14} />
          </button>
          <button
            onClick={() => setConfirmDelete(true)}
            className="shrink-0 flex items-center justify-center min-h-[44px] min-w-[44px] rounded text-gray-400 hover:text-port-error transition-colors"
            title="Delete bucket" aria-label="Delete bucket"
          >
            <Trash2 size={14} />
          </button>
        </div>
      )}

      {/* Delete confirm */}
      {confirmDelete && (
        <InlineConfirmRow
          variant="separator"
          question="Delete bucket? Its links stay (ungrouped)."
          onConfirm={() => { onDelete(bucket.id); setConfirmDelete(false); }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}

      {/* Chips */}
      <div
        ref={setEndSlotRef}
        className={`flex flex-wrap gap-2 p-3 min-h-[2.5rem] rounded transition-colors ${
          isEndSlotOver ? 'bg-port-accent/10 ring-1 ring-inset ring-port-accent' : ''
        }`}
      >
        {links.length === 0 && (
          <span className="text-xs text-gray-600 italic">Drop links here or add a URL below.</span>
        )}
        {links.map((link, i) => (
          <Fragment key={link.id}>
            <DraggableLinkChip bucket={bucket} bucketIndex={bucketIndex} link={link} index={i} onRemove={onRemoveLink} />
          </Fragment>
        ))}
      </div>

      {/* Add URL */}
      <form onSubmit={handleAdd} className="flex gap-1 p-2 border-t border-port-border">
        <label htmlFor={`bucket-add-${bucket.id}`} className="sr-only">Add a URL to {bucket.name}</label>
        <input
          id={`bucket-add-${bucket.id}`}
          type="text"
          value={addUrl}
          onChange={(e) => setAddUrl(e.target.value)}
          placeholder="Add a URL…"
          className="flex-1 min-w-0 px-2 py-1 bg-port-bg border border-port-border rounded text-white text-sm placeholder-gray-600 focus:outline-hidden focus:border-port-accent"
          disabled={adding}
        />
        <button
          type="submit"
          disabled={adding || !addUrl.trim()}
          className="shrink-0 flex items-center justify-center min-h-[44px] min-w-[44px] bg-port-accent/80 hover:bg-port-accent text-white rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          title="Add link to bucket" aria-label="Add link to bucket"
        >
          {adding ? <BrailleSpinner /> : <Plus size={14} />}
        </button>
      </form>
    </div>
  );
}

/**
 * A chip that is BOTH a drag source (moving itself elsewhere) and a drop
 * target (another link dropped here is inserted before it) — the same
 * "slot doubles as source" shape `KanbanBoard.jsx`'s `DraggableTicket` uses.
 */
function DraggableLinkChip({ bucket, bucketIndex, link, index, onRemove }) {
  const { setNodeRef: setSlotRef, isOver } = useDroppable({
    id: chipSlotId(bucket.id, index),
    data: { kind: LINK_SLOT_KIND, bucketId: bucket.id, bucketName: bucket.name, bucketIndex, index },
  });
  const {
    attributes, listeners, setNodeRef: setDragRef, setActivatorNodeRef, isDragging,
  } = useDraggable({
    id: `link-chip:${link.id}`,
    data: { kind: LINK_KIND, link, bucketId: bucket.id, index },
  });

  return (
    <div
      ref={(node) => { setSlotRef(node); setDragRef(node); }}
      className={`max-w-full min-w-0 rounded-md transition-[box-shadow] ${isDragging ? 'opacity-30' : ''} ${
        isOver ? 'ring-2 ring-port-accent ring-offset-1 ring-offset-port-card' : ''
      }`}
    >
      <LinkChip link={link} onRemove={onRemove} dragHandleProps={{ attributes, listeners, setActivatorNodeRef }} />
    </div>
  );
}
