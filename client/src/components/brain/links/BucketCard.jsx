import { useState } from 'react';
import { Plus, Edit2, Trash2, Save, X, Check, GripVertical } from 'lucide-react';
import BrailleSpinner from '../../BrailleSpinner';
import InlineConfirmRow from '../../ui/InlineConfirmRow';
import LinkChip from './LinkChip';
import { bucketColor, BUCKET_COLORS, BUCKET_COLOR_KEYS, LINK_DND_TYPE, BUCKET_DND_TYPE } from './bucketColors';

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
  onReorderBucket
}) {
  const formFromBucket = () => ({ name: bucket.name, color: bucket.color, icon: bucket.icon || '' });
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [form, setForm] = useState(formFromBucket);
  const [addUrl, setAddUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [dropActive, setDropActive] = useState(false);

  const colors = bucketColor(bucket.color);

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
      onDragOver={(e) => { e.preventDefault(); setDropActive(true); }}
      onDragLeave={() => setDropActive(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropActive(false);
        const linkId = e.dataTransfer.getData(LINK_DND_TYPE);
        if (linkId) { onDropLink?.(linkId); return; }
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
      <div className="flex flex-wrap gap-2 p-3 min-h-[2.5rem]">
        {links.length === 0 && (
          <span className="text-xs text-gray-600 italic">Drop links here or add a URL below.</span>
        )}
        {links.map(link => (
          <LinkChip
            key={link.id}
            link={link}
            onRemove={onRemoveLink}
            draggable
          />
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
          className="shrink-0 px-2 py-1 bg-port-accent/80 hover:bg-port-accent text-white rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          title="Add link to bucket"
        >
          {adding ? <BrailleSpinner /> : <Plus size={14} />}
        </button>
      </form>
    </div>
  );
}
