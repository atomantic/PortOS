/**
 * Provider registry for the Voice Brain pickers: API providers (streaming chat) and coding agents, plus a model-list refresh.
 *
 * Shared by the Settings Voice tab and the Voice Call / sat-phone quick picker so
 * both offer the same lists and refresh the same way. A failed load is kept
 * distinct from an empty registry (`error`) so callers can offer Retry instead
 * of reading as "no providers". The refresh is silent; this hook owns its toast.
 */

import { useCallback, useEffect, useState } from 'react';
import { getProviders, refreshProviderModels } from '../services/apiProviders';
import toast from '../components/ui/Toast';
import useMounted from './useMounted';

export default function useVoiceLlmProviders() {
  const mountedRef = useMounted();
  const [apiProviders, setApiProviders] = useState([]);
  const [codeProviders, setCodeProviders] = useState([]);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const reload = useCallback(() => {
    setError(null);
    return getProviders({ silent: true })
      .then((data) => {
        if (!mountedRef.current) return;
        const all = Array.isArray(data?.providers) ? data.providers : [];
        // Voice streams tokens, which only `api` providers can do; the code-agent
        // picker draws from the CLI/TUI agents that can actually edit code.
        setApiProviders(all.filter((p) => p.type === 'api'));
        setCodeProviders(all.filter((p) => p.type === 'cli' || p.type === 'tui'));
      })
      .catch((err) => {
        if (!mountedRef.current) return;
        setApiProviders([]);
        setCodeProviders([]);
        setError(err instanceof Error ? err : new Error('Request failed'));
      });
  }, [mountedRef]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Re-query a provider's /models (LM Studio / Ollama load models on demand, so the list goes stale).
  const refreshModels = useCallback(async (providerId) => {
    if (!providerId || refreshing) return;
    setRefreshing(true);
    try {
      const updated = await refreshProviderModels(providerId, { silent: true });
      if (!mountedRef.current) return;
      setApiProviders((prev) => prev.map((p) => (p.id === providerId ? { ...p, models: updated.models || [] } : p)));
      toast.success(`Refreshed models for ${updated.name || providerId} (${updated.models?.length || 0})`);
    } catch (err) {
      if (mountedRef.current) toast.error(`Failed to refresh models: ${err.message}`);
    } finally {
      if (mountedRef.current) setRefreshing(false);
    }
  }, [mountedRef, refreshing]);

  return { apiProviders, codeProviders, error, reload, refreshing, refreshModels };
}
