import { useEffect, useState } from 'react';
import { getToolUseModels } from '../services/apiLocalLlm';

/**
 * The provider ids the server tags its local rows with (`PROVIDER_ID[backend]`
 * in server/services/localLlm.js). Seeded into the map so a backend that reports
 * no tool-capable model is a definite "none installed" rather than an absent key.
 * A CUSTOM provider pointed at a different Ollama/LM Studio host is deliberately
 * NOT here: the server never enumerated that host, so it stays regex-only.
 */
const LOCAL_PROVIDER_IDS = ['ollama', 'lmstudio'];

/**
 * Module-level fetch cache. `null` = never fetched (or the last attempt failed
 * and was cleared for retry); a Promise once a fetch is in flight or has
 * resolved. Agent pickers are rendered one-per-row on list pages (a schedule
 * card each), and the endpoint asks Ollama for every installed model's
 * capabilities — so N mounted selectors must share ONE capability scan rather
 * than firing N of them.
 *
 * Deliberately a promise-of-result, not a result: the second mount during the
 * first mount's in-flight window has to join that request, not start another.
 */
let inFlight = null;

/**
 * Resolve to `idsByProvider` (a map, possibly with empty Sets) or `null` when
 * the fetch failed. A failure clears the cache so a later mount can retry — a
 * transient backend hiccup must not pin every agent picker to regex-only for
 * the rest of the session.
 */
function fetchToolUseIds() {
  inFlight ||= getToolUseModels({ silent: true })
    .then((res) => {
      // Key by the providerId the server itself reports for each row, so the map
      // only ever vouches for the provider the server actually enumerated. Seed
      // a key per enumerated local provider even when it reports nothing, so a
      // present-but-empty backend reads as "none installed" rather than
      // "unknown" — the null-vs-empty sentinel rule.
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
 * The model ids the SERVER reports as TOOL-USE (function-calling) capable, keyed
 * BY THE PROVIDER ID that serves them (`{ ollama: Set, lmstudio: Set }`),
 * fetched once per page load and shared across every caller.
 *
 * The client's `isToolUseModel` regex is a positive allowlist of families with
 * dependable function calling, so it goes stale the moment a new one ships: a
 * genuinely tool-capable local model the regex doesn't know (`phi4-mini`, a
 * newer function-calling Gemma build) rendered as "⚠ no known tool use", while
 * the Local LLMs tab's "Agents" badge — reading the very same authoritative
 * capabilities — disagreed. The server has the real answer (Ollama's `/api/show`
 * `tools` capability; LM Studio's catalog capabilities), so agent pickers union
 * this map in via `localToolUseHint` / `withToolUseOptionLabel`.
 *
 * Returns `{ idsByProvider, loaded }`. Callers UNION `idsByProvider` with the
 * regex, so it only ever ADDS models the regex didn't recognize — a `null`/empty
 * map degrades to regex-only rather than blanking the annotation. Widening is
 * the safe direction here in both senses: the map can't speak for a provider the
 * server never enumerated, and the regex can't speak for a family it predates,
 * so neither vetoes the other.
 *
 * Keyed by the ENUMERATED PROVIDER, never flattened and never keyed by backend
 * alone — a bare id is not a capability. A CUSTOM provider (or an Ollama-BACKED
 * CLI wrapper) pointed at a *different* host resolves to the same backend but was
 * never enumerated, so a local model's id must not vouch for a remote model that
 * merely shares its name. Those providers stay on the regex-only path, which is
 * the conservative answer: a false "🔧 tool use" sends an agent to a model that
 * narrates instead of acting — the incident this annotation exists to prevent.
 *
 * `loaded` flips true once the fetch SETTLES (success or failure) and exists so a
 * caller can tell "still fetching" from "fetched, none capable". The endpoint
 * asks Ollama for each installed model's capabilities, so the pending window is
 * real, and asserting "⚠ no known tool use" inside it is the very bug this hook
 * fixes — only to have it vanish a beat later. `idsByProvider` alone can't carry
 * that distinction: it stays `null` on failure too.
 *
 * @param {boolean} [enabled] gate the fetch — pass a picker's `highlightToolUse`
 *   or a drawer's `open` so a page that merely *contains* a non-agent picker
 *   doesn't pay for the capability scan. Fetches once and keeps the result if
 *   `enabled` later goes false.
 * @returns {{idsByProvider: Record<string, Set<string>>|null, loaded: boolean}}
 */
export default function useToolUseModelIds(enabled = true) {
  const [state, setState] = useState({ idsByProvider: null, loaded: false });

  useEffect(() => {
    if (!enabled || state.loaded) return undefined;
    let canceled = false;
    // Secondary control — a failed fetch falls back to the regex rather than
    // toasting over the host page. It still marks `loaded`, so an unreachable
    // backend can't suppress the annotation forever; regex-only is then the best
    // answer available.
    fetchToolUseIds().then((idsByProvider) => {
      if (!canceled) setState({ idsByProvider, loaded: true });
    });
    // A cancel (drawer closed mid-flight) leaves `loaded` false, so reopening
    // re-reads rather than rendering against a result that never arrived. The
    // shared cache means that re-read is free when the first fetch succeeded.
    return () => { canceled = true; };
  }, [enabled, state.loaded]);

  return state;
}
