import { useEffect, useMemo, useState } from 'react';
import toast from './ui/Toast';
import ProviderModelSelector from './ProviderModelSelector';
import { getProviders, getSettings, updateSettings } from '../services/api';
import { filterSelectableModels } from '../utils/providers';

/**
 * Reusable provider+model picker for per-feature AI assignment. Reads/writes
 * `settings[featureKey] = { providerId, model }` and restricts the provider
 * list to enabled CLI providers — the autofixer (file edits + pm2) and the
 * Google Calendar MCP sync both need an agentic CLI; API chat providers can't
 * edit files or call MCP tools. Falls back to `fallbackId` (default
 * `claude-code`, the historical hardcoded behavior) when nothing is saved.
 *
 * Persists on every change (optimistic, rolls back on failure) so there's no
 * separate Save button — matches the inline-picker pattern in
 * StagePromptModelPicker.
 */
export default function FeatureProviderPicker({ featureKey, fallbackId = 'claude-code', hint = null }) {
  const [providers, setProviders] = useState([]);
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getProviders().catch(() => ({ providers: [] })),
      getSettings({ silent: true }).catch(() => ({})),
    ]).then(([p, settings]) => {
      if (cancelled) return;
      // Match the server resolver's default-true semantics (pickCliProvider
      // uses `enabled !== false`) so the picker never hides a provider the
      // server would actually run, or vice versa.
      const cli = (p?.providers || []).filter((x) => x.type === 'cli' && x.enabled !== false);
      setProviders(cli);

      // Resolve the effective selection: saved providerId if it's still a
      // valid CLI provider, else fallbackId, else the first CLI provider.
      const cfg = settings?.[featureKey] || {};
      const resolved =
        cli.find((x) => x.id === cfg.providerId) ||
        cli.find((x) => x.id === fallbackId) ||
        cli[0] ||
        null;
      const offered = resolved ? filterSelectableModels(resolved.models || [resolved.defaultModel]) : [];
      setProviderId(resolved?.id || '');
      setModel(cfg.model && offered.includes(cfg.model) ? cfg.model : (resolved?.defaultModel || ''));
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, [featureKey, fallbackId]);

  const availableModels = useMemo(() => {
    const p = providers.find((pr) => pr.id === providerId);
    return p ? filterSelectableModels(p.models || [p.defaultModel]) : [];
  }, [providers, providerId]);

  const persist = async (nextProviderId, nextModel) => {
    const prev = { providerId, model };
    setProviderId(nextProviderId);
    setModel(nextModel);
    setSaving(true);
    // updateSettings toasts its own error; pass a custom catch that just rolls
    // back local state (no second toast).
    const merged = await updateSettings({ [featureKey]: { providerId: nextProviderId, model: nextModel } }).catch(() => null);
    setSaving(false);
    if (!merged) {
      setProviderId(prev.providerId);
      setModel(prev.model);
      return;
    }
    toast.success('Saved');
  };

  if (!loaded) return null;
  if (providers.length === 0) {
    return (
      <div className="text-sm text-port-warning">
        No enabled CLI providers configured. Add one under{' '}
        <a className="text-port-accent underline" href="/ai">AI Providers</a>.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <ProviderModelSelector
        providers={providers}
        selectedProviderId={providerId}
        selectedModel={model}
        availableModels={availableModels}
        onProviderChange={(id) => {
          const p = providers.find((pr) => pr.id === id);
          persist(id, p?.defaultModel || filterSelectableModels(p?.models)[0] || '');
        }}
        onModelChange={(m) => persist(providerId, m)}
      />
      <div className="flex items-center gap-2 min-h-[16px]">
        {saving && <span className="text-xs text-gray-500">saving…</span>}
        {hint && <p className="text-xs text-gray-500">{hint}</p>}
      </div>
    </div>
  );
}
