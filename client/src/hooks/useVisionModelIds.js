import { useEffect, useState } from 'react';
import { getVisionModels } from '../services/apiLocalLlm';

/**
 * The set of model ids the SERVER reports as vision-capable, fetched once.
 *
 * The client's `isVisionModel` regex can only recognize multimodal families it
 * was written against, so it silently goes stale as new ones ship — it knew
 * `gemma-3` but not `gemma4`, which left a user whose only installed VLMs were
 * `gemma4:e4b` and `qwen3.6:35b` staring at an EMPTY Scene Evaluation model
 * picker. The server has the authoritative answer (Ollama's `/api/show`
 * capabilities and LM Studio's `type: 'vlm'` tag), so vision pickers union this
 * set with the regex via `visionLocalModelFilter`.
 *
 * Returns `null` until the fetch resolves (and on failure). Callers union this
 * set with the regex, so it only ever ADDS models the regex didn't recognize —
 * `null` (or an empty set, when no local VLM is installed) simply degrades to
 * today's regex-only behavior rather than blanking a picker. Widening is the
 * safe direction: a stale regex hides a model the user has, whereas this set
 * can't speak for a custom provider pointing at a host the server never
 * enumerated, so neither source is allowed to veto the other.
 *
 * @param {boolean} [enabled] gate the fetch — pass a drawer/modal's `open` when
 *   the host stays mounted while closed. The endpoint asks Ollama for each
 *   installed model's capabilities, so it is not free enough to fire on every
 *   render of a page that merely *contains* a closed picker. Fetches once and
 *   keeps the result if `enabled` later goes false.
 * @returns {Set<string>|null}
 */
export default function useVisionModelIds(enabled = true) {
  const [ids, setIds] = useState(null);

  useEffect(() => {
    if (!enabled || ids) return undefined;
    let canceled = false;
    // Secondary control — a failed fetch falls back to the regex rather than
    // toasting over the host page.
    getVisionModels({ silent: true })
      .then((res) => {
        if (canceled) return;
        setIds(new Set((res?.models || []).map((m) => m?.id).filter(Boolean)));
      })
      .catch(() => {});
    return () => { canceled = true; };
  }, [enabled, ids]);

  return ids;
}
