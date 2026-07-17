import { useEffect, useMemo, useState } from 'react';
import { Boxes, RefreshCw, AlertTriangle, Check } from 'lucide-react';
import toast from '../ui/Toast';
import { getSettings, updateSettings } from '../../services/apiSystem';
import { getLocalLlmStatus } from '../../services/apiLocalLlm';

// Provider-agnostic embeddings configuration. Powers the creative catalog's
// semantic search + the memory system's vector storage. Vector dim is pinned
// to 768 (matches the live `vector(768)` columns); the dropdown calls out
// known 768-dim models so the user picks one that won't get rejected.

const PROVIDERS = [
  { id: 'none', label: 'Disabled', description: "Don't embed at ingest. Rows persist; semantic search returns empty until you backfill." },
  { id: 'ollama', label: 'Ollama', description: 'Use a locally installed Ollama embedding model.' },
  { id: 'lmstudio', label: 'LM Studio', description: 'Use an LM Studio embedding model.' },
];

// 768-dim models we know about. Used as the recommendation hint in the
// dropdown — the user can still type any other model name.
const KNOWN_768_DIM = {
  ollama: ['nomic-embed-text', 'snowflake-arctic-embed:s'],
  lmstudio: ['nomic-ai/nomic-embed-text-v1.5-GGUF', 'text-embedding-nomic-embed-text-v1.5'],
};

const EMBEDDING_HINT_RE = /embed|bge|nomic|mxbai|gte|e5|arctic/i;

export default function EmbeddingsTab() {
  const [provider, setProvider] = useState('none');
  const [model, setModel] = useState('');
  const [saved, setSaved] = useState({ provider: 'none', model: '' });
  const [models, setModels] = useState({ ollama: [], lmstudio: [] });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);

  const refreshModels = async () => {
    setModelsLoading(true);
    const status = await getLocalLlmStatus({ silent: true }).catch(() => null);
    setModels({
      ollama: (status?.ollama?.installedModels || []).map((m) => m.id || m.name),
      lmstudio: (status?.lmstudio?.installedModels || []).map((m) => m.id || m.name),
    });
    setModelsLoading(false);
  };

  useEffect(() => {
    (async () => {
      const settings = await getSettings({ silent: true }).catch(() => null);
      const cfg = settings?.embeddings || {};
      setProvider(cfg.provider || 'none');
      setModel(cfg.model || '');
      setSaved({ provider: cfg.provider || 'none', model: cfg.model || '' });
      setLoading(false);
      refreshModels();
    })();
  }, []);

  const candidateModels = useMemo(() => {
    if (provider === 'none') return [];
    const installed = models[provider] || [];
    const filtered = installed.filter((id) => EMBEDDING_HINT_RE.test(id));
    const known = KNOWN_768_DIM[provider] || [];
    // Combine, dedupe, preserve order: filtered installed first, then known not-yet-installed.
    const seen = new Set();
    const out = [];
    for (const m of [...filtered, ...known]) {
      if (!seen.has(m)) { seen.add(m); out.push(m); }
    }
    return out;
  }, [provider, models]);

  const dirty = provider !== saved.provider || (model || '') !== (saved.model || '');

  const handleSave = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    await updateSettings({
      embeddings: { provider, model: model.trim() || null },
    }, { silent: true }).then(() => {
      setSaved({ provider, model: model.trim() || '' });
      toast.success('Embeddings settings saved');
    }).catch((err) => {
      toast.error(`Save failed: ${err?.message || 'unknown error'}`);
    }).finally(() => setSaving(false));
  };

  if (loading) {
    return <div className="text-sm text-gray-400">Loading…</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-gray-300">
        <Boxes size={18} />
        <h2 className="text-lg font-semibold">Embeddings</h2>
      </div>

      <p className="text-sm text-gray-400">
        Vector embeddings power semantic search across the creative catalog (Characters, Ideas,
        Scenes, …) and the memory system. PortOS expects 768-dimensional vectors;
        pick a 768-dim model below or your saves will be rejected.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
      {/* Provider picker */}
      <div className="space-y-2">
        <label htmlFor="embeddings-provider" className="block text-sm font-medium text-gray-300">
          Provider
        </label>
        <select
          id="embeddings-provider"
          value={provider}
          onChange={(e) => {
            const next = e.target.value;
            setProvider(next);
            // Clear model when provider changes so we don't carry a foreign-provider name.
            if (next !== saved.provider) setModel('');
          }}
          className="w-full bg-port-bg border border-port-border rounded px-3 py-2 text-sm text-white"
        >
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
        <p className="text-xs text-gray-500">
          {PROVIDERS.find((p) => p.id === provider)?.description}
        </p>
      </div>

      {/* Model picker — hidden when provider is 'none' */}
      {provider !== 'none' && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label htmlFor="embeddings-model" className="block text-sm font-medium text-gray-300">
              Model
            </label>
            <button
              type="button"
              onClick={refreshModels}
              disabled={modelsLoading}
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200 disabled:opacity-50"
            >
              <RefreshCw size={12} className={modelsLoading ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
          <input
            id="embeddings-model"
            list="embeddings-model-options"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="nomic-embed-text"
            className="w-full bg-port-bg border border-port-border rounded px-3 py-2 text-sm text-white"
          />
          <datalist id="embeddings-model-options">
            {candidateModels.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          {candidateModels.length === 0 && !modelsLoading && (
            <div className="flex items-start gap-2 text-xs text-amber-400">
              <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
              <span>
                No installed embedding models detected on {provider}. Install one in Local LLMs
                (e.g. <code className="text-amber-300">nomic-embed-text</code> on Ollama).
              </span>
            </div>
          )}
          {(models[provider] || []).length > 0 && !EMBEDDING_HINT_RE.test(model) && model && (
            <div className="flex items-start gap-2 text-xs text-amber-400">
              <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
              <span>
                <code>{model}</code> doesn't look like an embedding model. Embeddings must be
                768-dim; non-embedding models will fail at ingest time.
              </span>
            </div>
          )}
        </div>
      )}
      </div>

      <div className="flex items-center gap-3 pt-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty || saving}
          className="flex items-center gap-1.5 px-4 py-2 bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded transition-colors"
        >
          {saving ? 'Saving…' : (
            <>
              <Check size={14} />
              Save
            </>
          )}
        </button>
        {!dirty && !loading && (
          <span className="text-xs text-gray-500">
            Saved: {saved.provider === 'none' ? 'Disabled' : `${saved.provider}${saved.model ? ` · ${saved.model}` : ''}`}
          </span>
        )}
      </div>
    </div>
  );
}
