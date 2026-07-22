import { useState } from 'react';
import { Plus, Loader2 } from 'lucide-react';
import toast from '../../ui/Toast';
import { createPipelineSeason } from '../../../services/api';

export default function AddSeasonRow({ series, onSeriesUpdate }) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);

  const handleAdd = async (e) => {
    e?.preventDefault();
    const t = title.trim();
    if (!t) return;
    setSaving(true);
    const created = await createPipelineSeason(series.id, { title: t }, { silent: true }).catch((err) => {
      toast.error(err.message || 'Failed to create volume / season');
      return null;
    });
    setSaving(false);
    if (!created) return;
    onSeriesUpdate({
      ...series,
      seasons: [...(series.seasons || []), created].sort((a, b) => (a.number || 0) - (b.number || 0)),
    });
    setTitle('');
    setAdding(false);
    toast.success(`Volume / Season ${created.number}: ${created.title} added`);
  };

  if (!adding) {
    return (
      <button
        type="button"
        onClick={() => setAdding(true)}
        className="inline-flex items-center gap-1 px-3 py-2 rounded border border-dashed border-port-border bg-port-bg text-sm text-gray-400 hover:text-white hover:border-port-accent/40"
      >
        <Plus size={14} /> Add volume / season
      </button>
    );
  }
  return (
    <form onSubmit={handleAdd} className="flex items-center gap-2">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Volume / Season title…"
        className="w-72 px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
        autoFocus
        maxLength={200}
      />
      <button
        type="submit"
        disabled={!title.trim() || saving}
        className="inline-flex items-center gap-1 px-3 py-2 rounded bg-port-accent text-white text-sm font-medium disabled:opacity-40"
      >
        {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
        Add volume / season
      </button>
      <button
        type="button"
        onClick={() => { setAdding(false); setTitle(''); }}
        className="text-xs text-gray-400 hover:text-white px-2"
      >
        Cancel
      </button>
    </form>
  );
}
