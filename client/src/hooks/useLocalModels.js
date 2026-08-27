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
 * `installed` is the server's per-backend "is the app here at all" verdict —
 * which counts a macOS LM Studio bundle with no `lms` shim and a running server
 * with no CLI, so callers must NOT re-derive it from a bare binary probe. It
 * stays `null` until the fetch resolves (and after a failed one), so a caller
 * can tell "not fetched" from a confirmed `false` and never offers an install
 * for an app it simply hasn't heard about yet.
 *
 * `hardwareCompatibilityByBackend` carries the server's definitive model
 * compatibility verdicts into provider editors without changing the existing
 * string-id API used by other consumers of this hook.
 *
 * `capabilitiesByBackend` keeps the runtime's reported badge vocabulary keyed
 * by model id. A present key with `null` means the model was found but its
 * runtime did not report capabilities; an absent key means that model was not
 * in the local status response.
 *
 * @returns {{ ollama: string[], lmstudio: string[], installed: { ollama: boolean|null, lmstudio: boolean|null }, recommendations: { ollama: object|null, lmstudio: object|null }, ctxById: Record<string, number>, hardwareCompatibilityByBackend: { ollama: Record<string, object>, lmstudio: Record<string, object> }, capabilitiesByBackend: { ollama: Record<string, string[]|null>, lmstudio: Record<string, string[]|null> }, loading: boolean }}
 */
export default function useLocalModels() {
  const [state, setState] = useState({
    ollama: [],
    lmstudio: [],
    installed: { ollama: null, lmstudio: null },
    recommendations: { ollama: null, lmstudio: null },
    ctxById: {},
    hardwareCompatibilityByBackend: { ollama: {}, lmstudio: {} },
    capabilitiesByBackend: { ollama: {}, lmstudio: {} },
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
        const hardwareCompatibilityByBackend = { ollama: {}, lmstudio: {} };
        const capabilitiesByBackend = { ollama: {}, lmstudio: {} };
        for (const backend of ['ollama', 'lmstudio']) {
          for (const m of status?.[backend]?.models || []) {
            const id = m.id || m.name;
            if (id) {
              capabilitiesByBackend[backend][id] = Array.isArray(m.capabilities)
                ? m.capabilities
                : null;
            }
            if (id && m.hardwareCompatibility && typeof m.hardwareCompatibility === 'object') {
              hardwareCompatibilityByBackend[backend][id] = m.hardwareCompatibility;
            }
            if (id && Number(m.contextLength) > 0) ctxById[id] = m.contextLength;
          }
        }
        const installedFlag = (backend) => (
          typeof status?.[backend]?.installed === 'boolean' ? status[backend].installed : null
        );
        setState({
          ollama: ids(status?.ollama?.models),
          lmstudio: ids(status?.lmstudio?.models),
          installed: { ollama: installedFlag('ollama'), lmstudio: installedFlag('lmstudio') },
          recommendations: {
            ollama: status?.ollama?.recommendations?.editorial || null,
            lmstudio: status?.lmstudio?.recommendations?.editorial || null,
          },
          ctxById,
          hardwareCompatibilityByBackend,
          capabilitiesByBackend,
          loading: false,
        });
      })
      .catch(() => { if (!canceled) setState((s) => ({ ...s, loading: false })); });
    return () => { canceled = true; };
  }, []);

  return state;
}
