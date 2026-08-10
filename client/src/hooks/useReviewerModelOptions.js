import { useEffect, useMemo, useState } from 'react';
import * as api from '../services/api';
import { filterSelectableModels, selectableModelsForProvider, isAntigravityProvider, isGrokBuildCli } from '../utils/providers';
import { LOCAL_LLM_REVIEWERS, MODEL_SELECTABLE_REVIEWERS } from '../components/cos/constants';

/**
 * Selectable model ids per model-taking reviewer, for `ReviewerPicker`'s Model
 * column. One hook so all four picker surfaces (Code Review Defaults, TaskAddForm,
 * ScheduleTab, SlashDoRunDrawer) offer the SAME options instead of only the
 * settings panel having them (#3133).
 *
 * Two sources, because the two reviewer kinds are different things:
 * - `lmstudio` / `ollama` ids come from `/api/local-llm/status`, so they reflect
 *   what's actually installed rather than a provider's stale stored `models`.
 * - `codex` / `claude` / `antigravity` / `grok` tiers come from the provider
 *   catalog (`/api/providers`) — these are CLI reviewers, not local backends, so
 *   there's nothing to probe.
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
 * @returns {{ optionsByReviewer: Record<string, string[]>, freeText: Record<string, boolean>, unavailable: Record<string, boolean>, loaded: boolean, reviewers: string[] }}
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
    // `match` is a predicate rather than an id so a reviewer whose provider can be
    // recognized by more than its shipped id (an `agy` configured by path) uses the
    // same predicate the rest of the app does. Several matchers = preference order:
    // `grok` names one binary that ships as BOTH a `cli` and a `tui` provider, and
    // the reviewer is spawned non-interactively, so the CLI's catalog wins — the
    // broad predicate is the fallback for an install that only kept the TUI.
    const providerTiers = (...matchers) => {
      const provider = matchers.reduce((found, match) => found || (providers || []).find(match), null);
      if (!provider) return [];
      // `models` may be empty on a CLI provider configured with only a
      // defaultModel — `[]` is truthy, so a bare `||` wouldn't fall through.
      const models = provider.models?.length ? provider.models : [provider.defaultModel];
      // `selectableModelsForProvider` owns the per-provider normalization (today:
      // agy's one-id-per-effort-tier catalog collapsed to base ids, so the row's
      // separate Effort cell stays the effort control). Going through it rather
      // than special-casing agy here keeps the rule in one place.
      return filterSelectableModels(selectableModelsForProvider(provider, models));
    };

    const ollama = localIds('ollama');
    const optionsByReviewer = {
      lmstudio: localIds('lmstudio'),
      ollama,
      codex: providerTiers((p) => p.id === 'codex'),
      // Claude tiers first (the common case), then installed Ollama ids for an
      // Ollama-backed `claude`. Deduped, order-preserving.
      claude: Array.from(new Set([...providerTiers((p) => p.id === 'claude-code'), ...ollama].filter(Boolean))),
      antigravity: providerTiers(isAntigravityProvider),
      // The shipped grok provider carries only the configured-default sentinel,
      // which `filterSelectableModels` strips — so this is legitimately `[]` until
      // the user lists real ids on the provider. The Model cell stays useful
      // regardless because grok, like every CLI reviewer, is free-text.
      grok: providerTiers((p) => p.id === 'grok-cli', isGrokBuildCli),
    };

    return {
      optionsByReviewer,
      // A local backend's id list is authoritative (we probed it), so keep those
      // pickers a closed `<select>`. Every CLI reviewer is free-text: `claude` for
      // the Ollama-backed / Bedrock-form cases above, `codex`/`antigravity`/`grok`
      // because their catalogs are stored snapshots that can lag a newly-released
      // tier — grok's shipped catalog holds no real id at all, so a typed id is the
      // ONLY way to pin one (an agy pin may also be typed effort-suffixed — the
      // server splits it). Derived from the rosters so a reviewer added to either
      // one can't silently default to the wrong control.
      freeText: Object.fromEntries(
        MODEL_SELECTABLE_REVIEWERS.map((r) => [r, !LOCAL_LLM_REVIEWERS.includes(r)])
      ),
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
