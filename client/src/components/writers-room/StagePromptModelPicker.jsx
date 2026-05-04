import { useEffect, useMemo, useState } from 'react';
import toast from '../ui/Toast';
import ProviderModelSelector from '../ProviderModelSelector';

/**
 * Inline picker for a prompt stage's provider+model. Mirrors the Tier/Specific
 * toggle in PromptManager so any panel that runs an LLM stage (Adapt, Evaluate,
 * Format, Characters) can configure it locally without sending the user to
 * /prompts. Persists via PUT /api/prompts/<stageName>.
 */
export default function StagePromptModelPicker({ stageName, label = 'Stage LLM', icon = null, hint = null }) {
  const [stage, setStage] = useState(null);
  const [providers, setProviders] = useState([]);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`/api/prompts/${encodeURIComponent(stageName)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('/api/providers').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]).then(([s, p]) => {
      if (cancelled) return;
      setStage(s || null);
      setProviders((p?.providers || []).filter((x) => x.enabled));
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, [stageName]);

  const persist = async (next) => {
    // Snapshot the previous stage from the current closure value BEFORE
    // calling setStage. Capturing inside the setStage updater is unsafe
    // under React 18 concurrent rendering / StrictMode — updaters can be
    // re-run or deferred, leaving the side-effect-captured snapshot
    // unreliable. The closure value is stable for this call.
    const prevStage = stage;
    setSaving(true);
    setStage((prev) => ({ ...prev, ...next }));
    const res = await fetch(`/api/prompts/${encodeURIComponent(stageName)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: next.provider ?? null,
        model: next.model,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      // Roll back the optimistic update so the picker UI doesn't show a
      // provider/model that wasn't actually persisted server-side.
      setStage(prevStage);
      toast.error(`Failed to save ${label}: ${await res.text().catch(() => res.statusText)}`);
    }
  };

  // Hooks must run in the same order every render — keep useMemo above the
  // early-return guards or React's hooks-rule check fires.
  const modelsForProvider = useMemo(() => {
    const p = providers.find((pr) => pr.id === stage?.provider);
    return p ? (p.models || [p.defaultModel]).filter(Boolean) : [];
  }, [providers, stage?.provider]);

  if (!loaded) return null;
  if (!stage) {
    return (
      <div className="text-[11px] text-port-error">
        Stage <code>{stageName}</code> not found — open Prompts to create it.
      </div>
    );
  }

  const isSpecific = !!stage.provider;

  const switchToTier = () => {
    if (!isSpecific) return;
    persist({ provider: null, model: 'default' });
  };
  const switchToSpecific = () => {
    if (isSpecific) return;
    const first = providers[0];
    if (!first) return;
    persist({ provider: first.id, model: first.defaultModel || (first.models || [])[0] || '' });
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[9px] uppercase tracking-wider text-gray-500 flex items-center gap-1">
          {icon}{label}
          {saving && <span className="text-gray-600 normal-case">· saving…</span>}
        </span>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={switchToTier}
            className={`px-1.5 py-0.5 text-[9px] rounded ${!isSpecific ? 'bg-port-accent text-white' : 'bg-port-border text-gray-400 hover:text-white'}`}
          >
            Tier
          </button>
          <button
            type="button"
            onClick={switchToSpecific}
            disabled={providers.length === 0}
            className={`px-1.5 py-0.5 text-[9px] rounded ${isSpecific ? 'bg-port-accent text-white' : 'bg-port-border text-gray-400 hover:text-white'} disabled:opacity-50`}
          >
            Specific
          </button>
        </div>
      </div>

      {!isSpecific ? (
        <select
          value={stage.model || 'default'}
          onChange={(e) => persist({ provider: null, model: e.target.value })}
          className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-[11px] text-gray-200"
        >
          <option value="default">Default — use the active provider's default model</option>
          <option value="quick">Quick — provider's light/fast model</option>
          <option value="coding">Coding — provider's medium model</option>
          <option value="heavy">Heavy — provider's heavy model</option>
        </select>
      ) : (
        <ProviderModelSelector
          providers={providers}
          selectedProviderId={stage.provider}
          selectedModel={stage.model || ''}
          availableModels={modelsForProvider}
          onProviderChange={(id) => {
            const p = providers.find((pr) => pr.id === id);
            persist({ provider: id, model: p?.defaultModel || (p?.models || [])[0] || '' });
          }}
          onModelChange={(model) => persist({ provider: stage.provider, model })}
          compact
        />
      )}

      {hint && <div className="text-[10px] text-gray-500">{hint}</div>}
    </div>
  );
}
