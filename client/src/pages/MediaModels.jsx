/**
 * Media Models — view + clean up cached HuggingFace model weights and LoRA files.
 *
 * HF models live at HF's standard location (`~/.cache/huggingface/hub` unless
 * the user set HF_HOME). PortOS doesn't move or symlink them — it just reads
 * sizes for display and offers Delete to free disk space. LoRAs sit in
 * `data/loras/` and are tracked by DataManager.
 */

import { useState, useEffect, useCallback } from 'react';
import { Trash2, RefreshCw, Image as ImageIcon, Film } from 'lucide-react';
import toast from '../components/ui/Toast';
import { listCachedModels, deleteCachedModel, deleteLora } from '../services/api';

export default function MediaModels() {
  const [data, setData] = useState({ models: [], loras: [], hubDir: '', diskUsage: {} });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);

  const refresh = useCallback(() => {
    setLoading(true);
    listCachedModels()
      .then(setData)
      .catch(() => setData({ models: [], loras: [], hubDir: '', diskUsage: {} }))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleDeleteModel = async (id) => {
    setBusy(id);
    try {
      await deleteCachedModel(id);
      toast.success('Model deleted — will re-download on next use');
      setData((d) => ({ ...d, models: d.models.filter((m) => m.id !== id) }));
    } catch (err) {
      toast.error(err.message || 'Delete failed');
    } finally {
      setBusy(null);
    }
  };

  const handleDeleteLora = async (filename) => {
    setBusy(filename);
    try {
      await deleteLora(filename);
      toast.success('LoRA deleted');
      setData((d) => ({ ...d, loras: d.loras.filter((l) => l.filename !== filename) }));
    } catch (err) {
      toast.error(err.message || 'Delete failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end gap-2">
        <button
          onClick={refresh}
          disabled={loading}
          className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-port-border/50 disabled:opacity-50 min-h-[40px] min-w-[40px] flex items-center justify-center"
          title="Refresh"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Object.entries(data.diskUsage || {}).map(([key, value]) => (
          <div key={key} className="bg-port-card border border-port-border rounded-xl p-4">
            <div className="text-xs text-gray-400 capitalize">{key}</div>
            <div className="text-lg font-semibold text-white">{value}</div>
          </div>
        ))}
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
