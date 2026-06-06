import { useEffect, useState } from 'react';
import { getLocalLlmStatus } from '../services/apiLocalLlm';

/**
 * Fetch the live list of installed local-LLM models (Ollama / LM Studio) once.
 *
 * A provider's stored `models` array goes stale as the user pulls new models in
 * Ollama, so model pickers that only read `provider.models` hide models that are
 * actually installed (the reported "Command R+ / Gemma missing from the fallback
 * dropdown" bug). Components fold this hook's per-backend ids into their option
 * lists via `mergeModelLists` + `localBackendForProvider`.
 *
 * Also surfaces the server's editorial recommendation per backend so editorial
 * UIs can suggest a best-fit model.
 *
 * `ctxById` maps each installed model id to its native context window (tokens)
 * so pickers can show a "(32K ctx)" parenthetical without a second fetch.
 *
 * @returns {{ ollama: string[], lmstudio: string[], recommendations: { ollama: object|null, lmstudio: object|null }, ctxById: Record<string, number>, loading: boolean }}
 */
export default function useLocalModels() {
  const [state, setState] = useState({
    ollama: [],
    lmstudio: [],
    recommendations: { ollama: null, lmstudio: null },
    ctxById: {},
    loading: true,
  });

  useEffect(() => {
    let canceled = false;
    // Secondary control — a failed fetch shouldn't toast over the host page.
    getLocalLlmStatus({ silent: true })
      .then((status) => {
        if (canceled) return;
        const ids = (list) => (list || []).map((m) => m.id || m.name).filter(Boolean);
        const ctxById = {};
        for (const m of [...(status?.ollama?.models || []), ...(status?.lmstudio?.models || [])]) {
          const id = m.id || m.name;
          if (id && Number(m.contextLength) > 0) ctxById[id] = m.contextLength;
        }
        setState({
          ollama: ids(status?.ollama?.models),
          lmstudio: ids(status?.lmstudio?.models),
          recommendations: {
            ollama: status?.ollama?.recommendations?.editorial || null,
            lmstudio: status?.lmstudio?.recommendations?.editorial || null,
          },
          ctxById,
          loading: false,
        });
      })
      .catch(() => { if (!canceled) setState((s) => ({ ...s, loading: false })); });
    return () => { canceled = true; };
  }, []);

  return state;
}
