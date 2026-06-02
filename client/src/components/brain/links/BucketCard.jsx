import { useState, Fragment } from 'react';
import { Plus, Edit2, Trash2, Save, X, Check, GripVertical } from 'lucide-react';
import BrailleSpinner from '../../BrailleSpinner';
import InlineConfirmRow from '../../ui/InlineConfirmRow';
import LinkChip from './LinkChip';
import { bucketColor, BUCKET_COLORS, BUCKET_COLOR_KEYS, LINK_DND_TYPE, BUCKET_DND_TYPE } from './bucketColors';
import { chipInsertIndex } from './bucketReorder';

/**
 * A single bucket (bookmark group): colored header with inline edit/delete,
 * a grid of link chips, and an inline "add URL" affordance. Acts as a drop
 * target so a link can be dragged in (from the list or another bucket) and
 * so buckets can be reordered by dragging their headers.
 */
export default function BucketCard({
  bucket,
  links,
  onUpdate,
  onDelete,
  onAddLink,
  onRemoveLink,
  onDropLink,
  onReorderBucket,
  onMoveLink
}) {
  const formFromBucket = () => ({ name: bucket.name, color: bucket.color, icon: bucket.icon || '' });
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [form, setForm] = useState(formFromBucket);
  const [addUrl, setAddUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  // The chip index where a dragged link would be inserted (null = no chip-level
  // drop in progress); renders a vertical insertion bar at that position.
  const [dropIndex, setDropIndex] = useState(null);

  const colors = bucketColor(bucket.color);

  // Insert a chip before or after the chip at index `i` based on which half of
  // it the pointer is over (chips flow left-to-right within a wrapping row).
  const dropIndexFor = (e, i) => chipInsertIndex(e.currentTarget.getBoundingClientRect(), e.clientX, i);

  // While dragging a link over a chip: show a precise insertion bar instead of
  // the whole-card drop ring. Bucket-reorder drags (no link payload) fall
  // through so they bubble to the card's drop handler.
  const handleChipDragOver = (e, i) => {
    if (!e.dataTransfer.types.includes(LINK_DND_TYPE)) return;
    e.preventDefault();
    e.stopPropagation();
    setDropActive(false);
    setDropIndex(dropIndexFor(e, i));
  };

  const handleChipDrop = (e, i) => {
    const linkId = e.dataTransfer.getData(LINK_DND_TYPE);
    if (!linkId) return; // not a chip drag — let the card handle bucket reorder
    e.preventDefault();
    e.stopPropagation();
    const targetIndex = dropIndexFor(e, i);
    setDropIndex(null);
    setDropActive(false);
    onMoveLink?.(linkId, targetIndex);
  };

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
      className={`flex flex-col bg-port-card border rounded-lg overflow-hidden transition-colors ${
        dropActive ? 'border-port-accent ring-1 ring-port-accent' : 'border-port-border'
      }`}
      onDragOver={(e) => { e.preventDefault(); if (dropIndex === null) setDropActive(true); }}
      // Don't clear dropIndex here: native dragleave bubbles, so a chip→gap
      // crossing would fire this and wipe the armed marker before a gap/bar
      // release — defeating the guarded clear on the chips row below. The chips
      // row's own dragleave (with a relatedTarget guard) owns clearing.
      onDragLeave={() => setDropActive(false)}
      onDrop={(e) => {
        e.preventDefault();
        const insertAt = dropIndex; // capture the visible insertion point before clearing
        setDropActive(false);
        setDropIndex(null);
        const linkId = e.dataTransfer.getData(LINK_DND_TYPE);
        if (linkId) {
          // Releasing in a chip gap / on the insertion bar bubbles here rather
          // than to a chip's own handler — honor the marker that was showing
          // (land at that index) instead of silently appending.
          if (insertAt !== null) onMoveLink?.(linkId, insertAt);
          else onDropLink?.(linkId);
          return;
        }
        const draggedBucketId = e.dataTransfer.getData(BUCKET_DND_TYPE);
        if (draggedBucketId) onReorderBucket?.(draggedBucketId);
      }}
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
        <div
          className={`flex items-center gap-2 px-3 py-2 border-b cursor-grab ${colors.header}`}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(BUCKET_DND_TYPE, bucket.id);
            e.dataTransfer.effectAllowed = 'move';
          }}
        >
          <GripVertical size={14} className="shrink-0 text-gray-500" />
          {bucket.icon && <span className="shrink-0 text-base leading-none">{bucket.icon}</span>}
          <h3 className={`font-medium truncate flex-1 ${colors.text}`}>{bucket.name}</h3>
          <span className="text-xs text-gray-500">{links.length}</span>
          <button
            onClick={startEdit}
            className="p-1 text-gray-400 hover:text-white transition-colors"
            title="Edit bucket"
          >
            <Edit2 size={13} />
          </button>
          <button
            onClick={() => setConfirmDelete(true)}
            className="p-1 text-gray-400 hover:text-port-error transition-colors"
            title="Delete bucket"
          >
            <Trash2 size={13} />
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
        className="flex flex-wrap gap-2 p-3 min-h-[2.5rem]"
        onDragLeave={(e) => {
          // Only clear when the pointer truly left the chips area — crossing
          // between chips fires its own dragleave we don't want to react to.
          if (!e.currentTarget.contains(e.relatedTarget)) setDropIndex(null);
        }}
      >
        {links.length === 0 && dropIndex === null && (
          <span className="text-xs text-gray-600 italic">Drop links here or add a URL below.</span>
        )}
        {links.map((link, i) => (
          <Fragment key={link.id}>
            {dropIndex === i && <ChipInsertionBar />}
            <div className="max-w-full min-w-0" onDragOver={(e) => handleChipDragOver(e, i)} onDrop={(e) => handleChipDrop(e, i)}>
              <LinkChip link={link} onRemove={onRemoveLink} draggable />
            </div>
          </Fragment>
        ))}
        {dropIndex === links.length && links.length > 0 && <ChipInsertionBar />}
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
          className="shrink-0 px-2 py-1 bg-port-accent/80 hover:bg-port-accent text-white rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          title="Add link to bucket"
        >
          {adding ? <BrailleSpinner /> : <Plus size={14} />}
        </button>
      </form>
    </div>
  );
}

/** A thin vertical accent bar marking where a dragged chip will land. */
function ChipInsertionBar() {
  // pointer-events-none so the bar isn't itself a drag target — a release on it
  // passes through to the chips row (and bubbles to the card drop handler).
  return <div className="w-0.5 self-stretch min-h-[1.75rem] rounded-full bg-port-accent pointer-events-none" aria-hidden="true" />;
}
