import { useEffect, useState } from 'react';
import { getVisionModels } from '../services/apiLocalLlm';

/**
 * Local backends whose `/vision-models` entries are per-MODEL capability facts.
 * MIRROR of `LOCAL_VISION_BACKENDS` in
 * server/services/creativeDirector/sceneEvaluator.js — keep in lockstep.
 *
 * The endpoint also returns `backend: 'cli'` entries, and those are NOT a
 * per-model fact: `isVisionCapableCliProvider` (server/lib/localModelHeuristics.js)
 * tags EVERY model of any `command: 'claude'|'codex'` CLI provider `vision: true`,
 * because such a CLI can read an image file whatever model it fronts. For an
 * ollama-backed Claude CLI (the shipped `claude-ollama` sample) that model list is
 * Ollama's *tool-use* models — `gpt-oss:20b`, `qwen3.6:35b` — text-only ids that
 * also exist in the real `ollama` provider's list. Folding those into a flat id
 * set would hand a text-only model to a vision picker on the `ollama` provider
 * (the id matches, so the per-provider intersection can't catch it), and
 * sceneEvaluator honors an explicit pin's model verbatim — so the scene would be
 * "evaluated" by a model that cannot see it. Drop CLI entries here, exactly as
 * sceneEvaluator's own auto-resolution does.
 */
const LOCAL_VISION_BACKENDS = new Set(['ollama', 'lmstudio']);

/**
 * The set of model ids the SERVER reports as vision-capable on a LOCAL backend,
 * fetched once.
 *
 * The client's `isVisionModel` regex can only recognize multimodal families it
 * was written against, so it silently goes stale as new ones ship — it knew
 * `gemma-3` but not `gemma4`, which left a user whose only installed VLMs were
 * `gemma4:e4b` and `qwen3.6:35b` staring at an EMPTY Scene Evaluation model
 * picker. The server has the authoritative answer (Ollama's `/api/show`
 * capabilities and LM Studio's `type: 'vlm'` tag), so vision pickers union this
 * set with the regex via `visionLocalModelFilter`.
 *
 * Returns `{ ids, loaded }`. Callers union `ids` with the regex, so it only ever
 * ADDS models the regex didn't recognize — a `null`/empty set simply degrades to
 * regex-only rather than blanking a picker. Widening is the safe direction: a
 * stale regex hides a model the user has, whereas this set can't speak for a
 * custom provider pointing at a host the server never enumerated, so neither
 * source vetoes the other.
 *
 * `loaded` flips true once the fetch SETTLES (success or failure) and exists so a
 * caller can tell "still fetching" from "fetched, none installed" — the endpoint
 * asks Ollama for each installed model's capabilities, so the pending window is
 * real. Without it a picker asserts "no vision models found" during the fetch
 * (the very bug this hook exists to fix) and then flips. `ids` alone can't carry
 * that distinction: it stays `null` on failure too.
 *
 * @param {boolean} [enabled] gate the fetch — pass a drawer/modal's `open` when
 *   the host stays mounted while closed, so a page merely *containing* a closed
 *   picker doesn't pay for the capability scan. Fetches once and keeps the result
 *   if `enabled` later goes false.
 * @returns {{ids: Set<string>|null, loaded: boolean}}
 */
export default function useVisionModelIds(enabled = true) {
  const [state, setState] = useState({ ids: null, loaded: false });

  useEffect(() => {
    if (!enabled || state.loaded) return undefined;
    let canceled = false;
    // Secondary control — a failed fetch falls back to the regex rather than
    // toasting over the host page. It still marks `loaded`, so an unreachable
    // backend can't suppress a caller's "none installed" messaging forever;
    // regex-only is then the best answer available.
    getVisionModels({ silent: true })
      .then((res) => {
        if (canceled) return;
        const ids = new Set(
          (res?.models || [])
            .filter((m) => LOCAL_VISION_BACKENDS.has(m?.backend))
            .map((m) => m?.id)
            .filter(Boolean),
        );
        setState({ ids, loaded: true });
      })
      .catch(() => { if (!canceled) setState({ ids: null, loaded: true }); });
    // A cancel (drawer closed mid-flight) leaves `loaded` false, so reopening
    // refetches rather than rendering against a result that never arrived.
    return () => { canceled = true; };
  }, [enabled, state.loaded]);

  return state;
}
