/**
 * Media Models — manage the model catalog + clean up cached weights.
 *
 * Two concerns share this page:
 *  1. Model catalog (registry): the image/video base models that can be picked
 *     in the gen forms. Built-in entries are read-only; user-added entries
 *     (installed from HuggingFace) are editable/removable. Adding a model here
 *     appends a `data/media-models.json` entry and hot-reloads the registry —
 *     no server restart (issue #2124).
 *  2. Cached weights: HF models live at HF's standard location
 *     (`~/.cache/huggingface/hub` unless HF_HOME is set). PortOS doesn't move or
 *     symlink them — it reads sizes for display and offers Delete to free disk.
 *     LoRAs sit in `data/loras/`.
 */

import { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, Trash2, Image as ImageIcon, Film, Plus, Pencil, Lock, X, Check } from 'lucide-react';
import toast from '../components/ui/Toast';
import {
  listCachedModels,
  deleteCachedModel,
  deleteLora,
  listMediaModelRegistry,
  addMediaModelFromHf,
  patchCustomMediaModel,
  removeCustomMediaModel,
} from '../services/api';

export default function MediaModels() {
  const [data, setData] = useState({ models: [], loras: [], hubDir: '', diskUsage: {} });
  const [registry, setRegistry] = useState({ video: [], image: [] });
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  // Add-from-HF form state
  const [hfUrl, setHfUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState(null);

  // Inline edit state for a user-added entry
  const [editId, setEditId] = useState(null);
  const [editFields, setEditFields] = useState({ name: '', steps: '', guidance: '' });

  const refresh = useCallback(() => {
    setError(null);
    listCachedModels()
      .then(setData)
      .catch(err => setError(err?.message || 'Failed to load media models'));
    listMediaModelRegistry()
      .then(setRegistry)
      .catch(() => {}); // registry is secondary — cache view still renders on failure
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleDeleteModel = async (id) => {
    setBusy(id);
    await deleteCachedModel(id)
      .then(() => {
        toast.success('Model deleted — will re-download on next use');
        setData((d) => ({ ...d, models: d.models.filter((m) => m.id !== id) }));
      })
      .catch((err) => toast.error(err.message || 'Delete failed'))
      .finally(() => setBusy(null));
  };

  const handleDeleteLora = async (filename) => {
    setBusy(filename);
    await deleteLora(filename)
      .then(() => {
        toast.success('LoRA deleted');
        setData((d) => ({ ...d, loras: d.loras.filter((l) => l.filename !== filename) }));
      })
      .catch((err) => toast.error(err.message || 'Delete failed'))
      .finally(() => setBusy(null));
  };

  const handleAddFromHf = async (e) => {
    e?.preventDefault?.();
    const url = hfUrl.trim();
    if (!url) return;
    setAdding(true);
    setAddError(null);
    await addMediaModelFromHf({ url, silent: true })
      .then((result) => {
        toast.success(`Added ${result?.entry?.name || 'model'} — download its weights from the gen form`);
        setHfUrl('');
        // The response carries the server-derived entry + kind, so update the
        // registry list locally instead of refetching (both round-trips).
        const kind = result?.kind === 'image' ? 'image' : 'video';
        const entry = { ...result.entry, kind, builtIn: false };
        setRegistry((r) => ({ ...r, [kind]: [...r[kind], entry] }));
      })
      .catch((err) => setAddError(err?.message || 'Failed to add model'))
      .finally(() => setAdding(false));
  };

  const startEdit = (m) => {
    setEditId(m.id);
    setEditFields({
      name: m.name ?? '',
      steps: m.steps ?? '',
      guidance: m.guidance ?? '',
    });
  };

  const cancelEdit = () => { setEditId(null); };

  const saveEdit = async (id) => {
    setBusy(id);
    const patch = {
      name: editFields.name.trim(),
      steps: Number(editFields.steps),
      guidance: Number(editFields.guidance),
    };
    await patchCustomMediaModel(id, patch, { silent: true })
      .then((updated) => {
        toast.success('Model updated');
        setEditId(null);
        // Merge the returned fields into the matching registry row locally
        // instead of refetching the whole catalog + cache.
        const merge = (list) => list.map((m) => (m.id === id ? { ...m, ...updated } : m));
        setRegistry((r) => ({ video: merge(r.video), image: merge(r.image) }));
      })
      .catch((err) => toast.error(err.message || 'Update failed'))
      .finally(() => setBusy(null));
  };

  const handleRemoveCustom = async (id) => {
    setBusy(id);
    await removeCustomMediaModel(id, { silent: true })
      .then(() => {
        toast.success('Custom model removed');
        setRegistry((r) => ({
          video: r.video.filter((m) => m.id !== id),
          image: r.image.filter((m) => m.id !== id),
        }));
      })
      .catch((err) => toast.error(err.message || 'Remove failed'))
      .finally(() => setBusy(null));
  };

  if (error) {
    return (
      <div className="p-6 text-center">
        <AlertTriangle size={32} className="mx-auto text-port-warning mb-3" />
        <p className="text-gray-400 mb-3">Couldn't load media models: {error}</p>
        <button type="button" onClick={refresh} className="px-4 py-2 bg-port-card border border-port-border rounded-lg text-white hover:bg-port-bg">
          Retry
        </button>
      </div>
    );
  }

  const renderRegistryRow = (m) => {
    const isEditing = editId === m.id;
    return (
      <div key={`${m.kind}-${m.id}`} className="bg-port-bg border border-port-border rounded-lg p-3">
        {isEditing ? (
          <div className="space-y-2">
            <div>
              <label htmlFor={`edit-name-${m.id}`} className="block text-xs text-gray-400 mb-1">Name</label>
              <input
                id={`edit-name-${m.id}`}
                type="text"
                value={editFields.name}
                onChange={(e) => setEditFields((f) => ({ ...f, name: e.target.value }))}
                className="w-full px-2 py-1 text-sm bg-port-card border border-port-border rounded text-white"
              />
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <label htmlFor={`edit-steps-${m.id}`} className="block text-xs text-gray-400 mb-1">Steps</label>
                <input
                  id={`edit-steps-${m.id}`}
                  type="number"
                  min="1"
                  max="200"
                  value={editFields.steps}
                  onChange={(e) => setEditFields((f) => ({ ...f, steps: e.target.value }))}
                  className="w-full px-2 py-1 text-sm bg-port-card border border-port-border rounded text-white"
                />
              </div>
              <div className="flex-1">
                <label htmlFor={`edit-guidance-${m.id}`} className="block text-xs text-gray-400 mb-1">Guidance</label>
                <input
                  id={`edit-guidance-${m.id}`}
                  type="number"
                  min="0"
                  max="30"
                  step="0.5"
                  value={editFields.guidance}
                  onChange={(e) => setEditFields((f) => ({ ...f, guidance: e.target.value }))}
                  className="w-full px-2 py-1 text-sm bg-port-card border border-port-border rounded text-white"
                />
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={cancelEdit} disabled={busy === m.id} className="px-3 py-1.5 text-xs bg-port-card border border-port-border rounded text-gray-300 hover:bg-port-bg flex items-center gap-1">
                <X className="w-3 h-3" /> Cancel
              </button>
              <button type="button" onClick={() => saveEdit(m.id)} disabled={busy === m.id} className="px-3 py-1.5 text-xs bg-port-accent/20 hover:bg-port-accent/40 text-port-accent rounded disabled:opacity-50 flex items-center gap-1">
                <Check className="w-3 h-3" /> {busy === m.id ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-sm text-white truncate flex items-center gap-2">
                {m.name}
                {m.builtIn && <Lock className="w-3 h-3 text-gray-500 shrink-0" title="Built-in (read-only)" />}
                {m.deprecated && <span className="text-[10px] px-1 rounded bg-port-warning/20 text-port-warning">legacy</span>}
              </div>
              <div className="text-xs text-gray-500 truncate">
                {m.repo || m.id}
                {' · '}
                {m.runtime || m.runner || m.kind}
                {m.steps != null && ` · ${m.steps} steps`}
              </div>
            </div>
            {!m.builtIn && (
              <div className="flex gap-1 shrink-0">
                <button type="button" onClick={() => startEdit(m)} disabled={busy === m.id} className="px-2 py-1.5 text-xs bg-port-card border border-port-border rounded text-gray-300 hover:bg-port-bg disabled:opacity-50 flex items-center gap-1">
                  <Pencil className="w-3 h-3" /> Edit
                </button>
                <button type="button" onClick={() => handleRemoveCustom(m.id)} disabled={busy === m.id} className="px-2 py-1.5 text-xs bg-port-error/20 hover:bg-port-error/40 text-port-error rounded disabled:opacity-50 flex items-center gap-1">
                  <Trash2 className="w-3 h-3" /> {busy === m.id ? '…' : 'Remove'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Object.entries(data.diskUsage || {}).map(([key, value]) => (
          <div key={key} className="bg-port-card border border-port-border rounded-xl p-4">
            <div className="text-xs text-gray-400 capitalize">{key}</div>
            <div className="text-lg font-semibold text-white">{value}</div>
          </div>
        ))}
      </div>

      {/* Model Catalog — add from HuggingFace + manage user-added entries */}
      <div className="bg-port-card border border-port-border rounded-xl p-5 space-y-4">
        <h2 className="text-sm font-medium text-gray-300 flex items-center gap-2">
          <Plus className="w-4 h-4" /> Add a base model from HuggingFace
        </h2>
        <form onSubmit={handleAddFromHf} className="space-y-2">
          <label htmlFor="hf-model-url" className="block text-xs text-gray-400">
            HuggingFace repo (URL or <code>org/name</code>) — safetensors/MLX models only
          </label>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              id="hf-model-url"
              type="text"
              value={hfUrl}
              onChange={(e) => { setHfUrl(e.target.value); setAddError(null); }}
              placeholder="e.g. notapalindrome/ltx23-mlx-av-q4"
              className="flex-1 px-3 py-2 text-sm bg-port-bg border border-port-border rounded-lg text-white placeholder-gray-600"
            />
            <button
              type="submit"
              disabled={adding || !hfUrl.trim()}
              className="px-4 py-2 text-sm bg-port-accent/20 hover:bg-port-accent/40 text-port-accent rounded-lg disabled:opacity-50 flex items-center justify-center gap-1 shrink-0"
            >
              <Plus className="w-4 h-4" /> {adding ? 'Adding…' : 'Add Model'}
            </button>
          </div>
          {addError && (
            <p className="text-xs text-port-error flex items-start gap-1">
              <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" /> {addError}
            </p>
          )}
          <p className="text-[11px] text-gray-600">
            GGUF-only, Wan, and HunyuanVideo repos are refused — no PortOS runtime can load them. For a GGUF LTX build, use the native MLX Q4 model instead.
          </p>
        </form>

        {registry.video.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-xs font-medium text-gray-400 flex items-center gap-2"><Film className="w-3 h-3" /> Video models ({registry.video.length})</h3>
            <div className="space-y-2">{registry.video.map(renderRegistryRow)}</div>
          </div>
        )}
        {registry.image.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-xs font-medium text-gray-400 flex items-center gap-2"><ImageIcon className="w-3 h-3" /> Image models ({registry.image.length})</h3>
            <div className="space-y-2">{registry.image.map(renderRegistryRow)}</div>
          </div>
        )}
      </div>

      {data.hubDir && (
        <p className="text-xs text-gray-500">
          HuggingFace cache: <code className="text-gray-400">{data.hubDir}</code>
        </p>
      )}

      <div className="bg-port-card border border-port-border rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-medium text-gray-300 flex items-center gap-2">
          <ImageIcon className="w-4 h-4" /> Cached Models ({data.models.length})
        </h2>
        {data.models.length === 0 ? (
          <p className="text-xs text-gray-500">No models cached yet. They'll appear here as you generate.</p>
        ) : (
          <div className="space-y-2">
            {data.models.map((m) => (
              <div key={m.id} className="flex items-center gap-3 bg-port-bg border border-port-border rounded-lg p-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-white truncate">{m.label || m.repo}</div>
                  <div className="text-xs text-gray-500 truncate">{m.repo}</div>
                </div>
                <span className="text-sm text-gray-400 shrink-0">{m.sizeHuman}</span>
                <button
                  type="button"
                  onClick={() => handleDeleteModel(m.id)}
                  disabled={busy === m.id}
                  className="px-3 py-1.5 text-xs bg-port-error/20 hover:bg-port-error/40 text-port-error rounded disabled:opacity-50 flex items-center gap-1"
                >
                  <Trash2 className="w-3 h-3" /> {busy === m.id ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-port-card border border-port-border rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-medium text-gray-300 flex items-center gap-2">
          <Film className="w-4 h-4" /> LoRAs ({data.loras.length})
        </h2>
        {data.loras.length === 0 ? (
          <p className="text-xs text-gray-500">
            Drop <code className="text-gray-400">.safetensors</code> LoRA files into <code className="text-gray-400">data/loras/</code> and they'll show up here for use in Image Gen.
          </p>
        ) : (
          <div className="space-y-2">
            {data.loras.map((l) => (
              <div key={l.filename} className="flex items-center gap-3 bg-port-bg border border-port-border rounded-lg p-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-white truncate">{l.name}</div>
                  <div className="text-xs text-gray-500 truncate">{l.filename}</div>
                </div>
                <span className="text-sm text-gray-400 shrink-0">{l.sizeHuman}</span>
                <button
                  type="button"
                  onClick={() => handleDeleteLora(l.filename)}
                  disabled={busy === l.filename}
                  className="px-3 py-1.5 text-xs bg-port-error/20 hover:bg-port-error/40 text-port-error rounded disabled:opacity-50 flex items-center gap-1"
                >
                  <Trash2 className="w-3 h-3" /> {busy === l.filename ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
