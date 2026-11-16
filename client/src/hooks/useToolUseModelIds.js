/**
 * Returns `{ idsByProvider, loaded }`: function-calling capable model ids for Ollama and LM Studio
 * from the local-LLM tool-use endpoint.
 */

import { useEffect, useState } from 'react';
import { getToolUseModels } from '../services/apiLocalLlm';

/**
 * Provider ids the server tags local rows with (`PROVIDER_ID[backend]` in
 * server/services/localLlm.js), seeded so "none installed" differs from an absent key.
 * A CUSTOM provider on another Ollama/LM Studio host stays regex-only.
 */
const LOCAL_PROVIDER_IDS = ['ollama', 'lmstudio'];

/**
 * Module-level fetch cache: `null` = never fetched (or failed and cleared for retry),
 * else a Promise. Agent pickers render one per row, so N mounts must join ONE
 * capability scan; hence a promise-of-result, not a result.
 */
let inFlight = null;

/**
 * Resolve to `idsByProvider` (possibly empty Sets) or `null` on failure; a failure
 * clears the cache so a later mount can retry.
 */
function fetchToolUseIds() {
  inFlight ||= getToolUseModels({ silent: true })
    .then((res) => {
      // Key by the server-reported providerId; seed empty Sets so none-installed reads as known.
      const idsByProvider = {};
      for (const m of res?.models || []) {
        if (!m?.providerId) continue;
        (idsByProvider[m.providerId] ||= new Set());
        if (m.id) idsByProvider[m.providerId].add(m.id);
      }
      for (const providerId of LOCAL_PROVIDER_IDS) idsByProvider[providerId] ||= new Set();
      return idsByProvider;
    })
    .catch(() => { inFlight = null; return null; });
  return inFlight;
}

/** Test seam — drop the shared cache so each case starts from "never fetched". */
export function __resetToolUseModelIdsCache() {
  inFlight = null;
}

/**
 * Model ids the SERVER reports as TOOL-USE capable, keyed BY PROVIDER ID
 * (`{ ollama: Set, lmstudio: Set }`), fetched once per page load and shared. The
 * client's `isToolUseModel` regex is an allowlist that goes stale (`phi4-mini` read
 * "⚠ no known tool use" while the Local LLMs "Agents" badge disagreed), so agent
 * pickers union this in via `localToolUseHint` / `withToolUseOptionLabel`.
 *
 * Callers UNION `idsByProvider` with the regex, so it only ADDS models; null/empty
 * degrades to regex-only. Never flatten or key by backend: a bare id is not a
 * capability, and a custom provider (or Ollama-backed CLI wrapper) on another host
 * was never enumerated. Those stay regex-only, since a false "🔧 tool use" sends an
 * agent to a model that narrates instead of acting.
 *
 * `loaded` flips true once the fetch SETTLES (success or failure), so a caller can
 * tell "still fetching" from "none capable" and not flash "⚠ no known tool use".
 *
 * @param {boolean} [enabled] gate the fetch (a picker's `highlightToolUse` or a
 *   drawer's `open`); fetches once and keeps the result if `enabled` goes false.
 * @returns {{idsByProvider: Record<string, Set<string>>|null, loaded: boolean}}
 */
export default function useToolUseModelIds(enabled = true) {
  const [state, setState] = useState({ idsByProvider: null, loaded: false });

  useEffect(() => {
    if (!enabled || state.loaded) return undefined;
    let canceled = false;
    // A failed fetch falls back to the regex without a toast, and still marks `loaded`.
    fetchToolUseIds().then((idsByProvider) => {
      if (!canceled) setState({ idsByProvider, loaded: true });
    });
    // A cancel leaves `loaded` false so reopening re-reads (free via the shared cache).
    return () => { canceled = true; };
  }, [enabled, state.loaded]);

  return state;
}
