/**
 * Hook `useVisionModelIds` returning vision-capable model ids by provider (Ollama, LM Studio) with a
 * `loaded` flag.
 */

import { useEffect, useState } from 'react';
import { getVisionModels } from '../services/apiLocalLlm';

/**
 * Local backends whose `/vision-models` entries are per-MODEL capability facts.
 * MIRROR of `LOCAL_VISION_BACKENDS` in server/services/creativeDirector/sceneEvaluator.js.
 * `backend: 'cli'` entries are dropped: `isVisionCapableCliProvider` tags EVERY model
 * of a claude/codex CLI provider vision-capable, and folding text-only ids (an
 * ollama-backed CLI's tool-use models) into a flat set would hand them to a vision
 * picker on the `ollama` provider, and sceneEvaluator honors a pinned model verbatim.
 */
const LOCAL_VISION_BACKENDS = new Set(['ollama', 'lmstudio']);

/**
 * Provider ids the server tags local rows with (`PROVIDER_ID[backend]` in
 * server/services/localLlm.js), seeded so "none installed" differs from an absent key.
 * A CUSTOM provider on another Ollama/LM Studio host is not here: never enumerated,
 * so it stays regex-only.
 */
const LOCAL_PROVIDER_IDS = ['ollama', 'lmstudio'];

/**
 * Model ids the SERVER reports as vision-capable, keyed BY PROVIDER ID
 * (`{ ollama: Set, lmstudio: Set }`), fetched once. The client's `isVisionModel`
 * regex goes stale as new families ship (`gemma4`), leaving an empty picker; the
 * server has the authoritative answer, and vision pickers union it in via
 * `visionLocalModelFilter` / `assignmentModelOptions`.
 *
 * Callers union `idsByProvider` with the regex, so it only ADDS models; null/empty
 * degrades to regex-only. Never flatten or key by backend: a bare id is not a
 * capability, and would leak a CLI's blanket vision claim or a local VLM id onto a
 * custom provider on a host the server never enumerated.
 *
 * `loaded` flips true once the fetch SETTLES (success or failure), so a caller can
 * tell "still fetching" from "none installed" and never flashes "no vision models
 * found" mid-fetch; `idsByProvider` alone is `null` on failure too.
 *
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
        for (const providerId of LOCAL_PROVIDER_IDS) idsByProvider[providerId] ||= new Set();
        setState({ idsByProvider, loaded: true });
      })
      .catch(() => { if (!canceled) setState({ idsByProvider: null, loaded: true }); });
    // A cancel leaves `loaded` false so reopening refetches.
    return () => { canceled = true; };
  }, [enabled, state.loaded]);

  return state;
}
