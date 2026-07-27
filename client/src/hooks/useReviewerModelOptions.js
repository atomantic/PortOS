import { useEffect, useMemo, useState } from 'react';
import * as api from '../services/api';
import { filterSelectableModels } from '../utils/providers';
import { MODEL_SELECTABLE_REVIEWERS } from '../components/cos/constants';

/**
 * Selectable model ids per model-taking reviewer, for `ReviewerPicker`'s Model
 * column. One hook so all four picker surfaces (Code Review Defaults, TaskAddForm,
 * ScheduleTab, SlashDoRunDrawer) offer the SAME options instead of only the
 * settings panel having them (#3133).
 *
 * Two sources, because the two reviewer kinds are different things:
 * - `lmstudio` / `ollama` ids come from `/api/local-llm/status`, so they reflect
 *   what's actually installed rather than a provider's stale stored `models`.
 * - `codex` / `claude` tiers come from the provider catalog (`/api/providers`) —
 *   these are CLI reviewers, not local backends, so there's nothing to probe.
 *
 * The `claude` list spans BOTH usage modes: the `claude-code` provider tiers and
 * the installed Ollama ids (an Ollama-backed `claude` CLI, where `--model` selects
 * the local model). Deduped, order-preserving.
 *
 * `freeText` marks a reviewer whose picker must accept a typed id, not just a
 * pick: an Ollama-backed `claude` can run any locally-installed id, and a
 * Bedrock/Vertex install needs its environment's own id form, neither of which a
 * catalog can enumerate. Consumers render a `<datalist>` for those.
 *
 * `unavailable` distinguishes "backend is down" from "backend has no models" so
 * the empty state can say the useful thing. Absent = not a local backend.
 * `loaded` flips once both fetches settle, so a consumer can tell "no options
 * yet" from "genuinely no options" (an empty list is a real answer, not a
 * pre-fetch placeholder).
 *
 * @returns {{ optionsByReviewer: Record<string, string[]>, freeText: Record<string, boolean>, unavailable: Record<string, boolean>, loaded: boolean }}
 */
export default function useReviewerModelOptions() {
  const [localStatus, setLocalStatus] = useState(null);
  const [providers, setProviders] = useState(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Secondary controls — a failed fetch degrades the Model column to free-text
    // rather than toasting over whatever page hosts the picker.
    Promise.all([
      api.getLocalLlmStatus({ silent: true }).catch(() => null),
      api.getProviders({ silent: true }).catch(() => null),
    ]).then(([status, providerData]) => {
      if (cancelled) return;
      setLocalStatus(status || null);
      setProviders(providerData?.providers || []);
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, []);

  return useMemo(() => {
    const localIds = (backend) => (localStatus?.[backend]?.models || [])
      .map((m) => m.id || m.name)
      .filter(Boolean);
    const providerTiers = (id) => {
      const provider = (providers || []).find((p) => p.id === id);
      if (!provider) return [];
      // `models` may be empty on a CLI provider configured with only a
      // defaultModel — `[]` is truthy, so a bare `||` wouldn't fall through.
      return filterSelectableModels(provider.models?.length ? provider.models : [provider.defaultModel]);
    };

    const ollama = localIds('ollama');
    const optionsByReviewer = {
      lmstudio: localIds('lmstudio'),
      ollama,
      codex: providerTiers('codex'),
      // Claude tiers first (the common case), then installed Ollama ids for an
      // Ollama-backed `claude`. Deduped, order-preserving.
      claude: Array.from(new Set([...providerTiers('claude-code'), ...ollama].filter(Boolean))),
    };

    return {
      optionsByReviewer,
      // A local backend's id list is authoritative (we probed it), so keep those
      // pickers a closed `<select>`. The two CLI reviewers are free-text: `claude`
      // for the Ollama-backed / Bedrock-form cases above, and `codex` because its
      // catalog is a stored snapshot that can lag a newly-released tier.
      freeText: { codex: true, claude: true, lmstudio: false, ollama: false },
      unavailable: {
        lmstudio: localStatus?.lmstudio?.available === false,
        ollama: localStatus?.ollama?.available === false,
      },
      loaded,
      // Exposed so a consumer can assert it covers every model-taking reviewer.
      reviewers: MODEL_SELECTABLE_REVIEWERS,
    };
  }, [localStatus, providers, loaded]);
}
