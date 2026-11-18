/**
 * Hook `useVisionModelIds` returning vision-capable model ids by provider (Ollama, LM Studio) with a
 * `loaded` flag.
 */

import { useEffect, useState } from 'react';
import { getVisionModels } from '../services/apiLocalLlm';
import { LOCAL_LLM_PROVIDER_IDS, LOCAL_VISION_BACKENDS } from '../../../server/lib/localLlmCapabilityBackends.js';

/**
 * Model ids the SERVER reports as vision-capable, keyed BY PROVIDER ID (`{ ollama: Set, lmstudio: Set }`), fetched once: the client's `isVisionModel` regex goes stale as families ship (`gemma4`), and vision pickers union this in via `visionLocalModelFilter` / `assignmentModelOptions`.
 * It only ADDS models (null/empty degrades to regex-only). Never flatten or key by backend: a bare id is not a capability and would leak a CLI's blanket vision claim, or a local VLM id, onto a custom provider the server never enumerated.
 * `loaded` flips true once the fetch SETTLES (success or failure) so a caller can tell "still fetching" from "none installed"; `idsByProvider` alone is `null` on failure too.
 * @param {boolean} [enabled] gate the fetch (a drawer's `open`); fetches once and
 *   keeps the result if `enabled` later goes false.
 * @returns {{idsByProvider: Record<string, Set<string>>|null, loaded: boolean}}
 */
export default function useVisionModelIds(enabled = true) {
  const [state, setState] = useState({ idsByProvider: null, loaded: false });

  useEffect(() => {
    if (!enabled || state.loaded) return undefined;
    let canceled = false;
    // A failed fetch falls back to the regex without a toast, and still marks `loaded`.
    getVisionModels({ silent: true })
      .then((res) => {
        if (canceled) return;
        // Key by the server-reported providerId; seed empty Sets so none-installed reads as known.
        const idsByProvider = {};
        for (const m of res?.models || []) {
          if (!LOCAL_VISION_BACKENDS.has(m?.backend) || !m?.providerId) continue;
          (idsByProvider[m.providerId] ||= new Set());
          if (m.id) idsByProvider[m.providerId].add(m.id);
        }
        for (const providerId of LOCAL_LLM_PROVIDER_IDS) idsByProvider[providerId] ||= new Set();
        setState({ idsByProvider, loaded: true });
      })
      .catch(() => { if (!canceled) setState({ idsByProvider: null, loaded: true }); });
    // A cancel leaves `loaded` false so reopening refetches.
    return () => { canceled = true; };
  }, [enabled, state.loaded]);

  return state;
}
