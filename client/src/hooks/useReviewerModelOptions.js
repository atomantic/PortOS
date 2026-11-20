/**
 * Provides selectable model ids and provider defaults per model-taking reviewer for the ReviewerPicker
 * Model column, from local LLM status and provider lists.
 *
 * Every picker surface (Code Review Defaults, TaskAddForm, ScheduleTab,
 * SlashDoRunDrawer) passes this as its `modelOptions`; the picker never fetches.
 */

import { useEffect, useMemo, useState } from 'react';
import { getLocalLlmStatus } from '../services/apiLocalLlm.js';
import { getProviders } from '../services/apiProviders.js';
import { filterSelectableModels, selectableModelsForProvider } from '../utils/providers';
// THE reviewer -> provider-record table, shared with the retired-pin audit so the
// picker and the audit cannot drift on what counts as a retired tier.
import { REVIEWER_PROVIDER_MATCHERS, providersForReviewer } from '../../../server/lib/reviewerProviderMatchers.js';
import { MODEL_SELECTABLE_REVIEWERS } from '../components/cos/constants';
import { reviewerEffortLevels, LOCAL_LLM_REVIEWERS } from '../lib/reviewerPins';
import { LOCAL_LLM_BACKENDS } from '../lib/localLlmBackends';

// Local backends whose installed-model list `/api/local-llm/status` probes, the
// same roster the Runtimes/Model Library views use. `mtplx` is NOT in it: its
// listing runs the `mtplx` wrapper, so it stays catalog-sourced and free-text.
const PROBED_LOCAL_BACKENDS = LOCAL_LLM_BACKENDS.map((b) => b.id);

/**
 * Selectable model ids per model-taking reviewer, so every picker surface offers
 * the SAME options.
 *
 * Two sources:
 * - `lmstudio` / `ollama` ids come from `/api/local-llm/status`, reflecting what
 *   is actually installed rather than a provider's stale stored `models`.
 * - Every other reviewer's tiers come from the provider catalog
 *   (`/api/providers`), unioned across the records in
 *   `REVIEWER_PROVIDER_MATCHERS`. That includes `mtplx`: its checkpoints live
 *   behind `/api/local-llm/mtplx/status`, which INVOKES the `mtplx` wrapper (a
 *   several-hundred-MB venv bootstrap on a cold version, see
 *   `server/lib/mtplxRuntime.js`), and a picker mount must never pay that.
 *
 * The `claude` list spans BOTH usage modes: the `claude-code`/`claude-code-tui`
 * tiers and the installed Ollama ids (an Ollama-backed CLI, where `--model`
 * selects the local model). Deduped, order-preserving.
 *
 * `freeText` marks a reviewer whose picker must ALSO accept a typed id (an
 * Ollama-backed `claude`, or a Bedrock/Vertex id a catalog can't enumerate); it
 * adds a "Custom…" escape to the dropdown. `false` gets a closed list because
 * its options came from a live probe.
 *
 * `unavailable` distinguishes "backend is down" from "backend has no models".
 * Absent = not probed (every reviewer outside PROBED_LOCAL_BACKENDS).
 *
 * `providerDisabled[reviewer]` is true when the reviewer HAS provider records on
 * this install and every one is switched off, so `ReviewerPicker` can drop it
 * from the Add row. Only true from a landed fetch: a null/failed
 * `/api/providers` reads as "nothing known", never "switched off". Always false
 * for a LOCAL_LLM_REVIEWERS backend (see the exemption at the return site).
 *
 * `loaded` flips once both fetches settle, so "no options yet" differs from
 * "genuinely no options".
 *
 * `modelEffortLevels(reviewer, model)` narrows an effort ladder by the PINNED
 * MODEL, because `agy` validates the model/effort PAIR (`gemini-3.1-pro` has no
 * `medium` tier). Only `antigravity` narrows today. Lives here so the picker does
 * no fetching of its own.
 *
 * @returns {{ optionsByReviewer: Record<string, string[]>, defaultModels: Record<string, string|null>, freeText: Record<string, boolean>, unavailable: Record<string, boolean>, providerDisabled: Record<string, boolean>, modelEffortLevels: (reviewer: string, model?: string|null) => readonly string[]|null, loaded: boolean, reviewers: string[] }}
 */
export default function useReviewerModelOptions() {
  const [localStatus, setLocalStatus] = useState(null);
  const [providers, setProviders] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [providersLoaded, setProvidersLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Secondary controls — a failed fetch degrades to free-text, not a toast.
    Promise.all([
      getLocalLlmStatus({ silent: true }).catch(() => null),
      getProviders({ silent: true }).catch(() => null),
    ]).then(([status, providerData]) => {
      if (cancelled) return;
      setLocalStatus(status || null);
      setProviders(providerData?.providers || []);
      setProvidersLoaded(Array.isArray(providerData?.providers));
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, []);

  return useMemo(() => {
    const localIds = (backend) => (localStatus?.[backend]?.models || [])
      .map((m) => m.id || m.name)
      .filter(Boolean);

    // Resolved ONCE for the whole roster: the option list, default, agy catalog and
    // `providerDisabled` all ask the same question. Ordering/de-duping are
    // `providersForReviewer`'s contract.
    const providersByReviewer = Object.fromEntries(
      Object.keys(REVIEWER_PROVIDER_MATCHERS).map((reviewer) => [reviewer, providersForReviewer(reviewer, providers)])
    );
    for (const provider of providers || []) providersByReviewer[`provider:${provider.id}`] = [provider];
    const providerReviewers = (providers || []).map(provider => `provider:${provider.id}`);
    const providersFor = (reviewer) => providersByReviewer[reviewer] || [];

    // `selectableModelsForProvider` owns per-provider normalization (agy's
    // one-id-per-effort-tier catalog collapses to base ids so the Effort cell stays
    // the effort control).
    const selectableModels = (provider) => {
      // `models` may be `[]` on a CLI provider with only a defaultModel; `[]` is
      // truthy, so a bare `||` wouldn't fall through.
      const models = provider.models?.length ? provider.models : [provider.defaultModel];
      return filterSelectableModels(selectableModelsForProvider(provider, models));
    };

    const providerTiers = (reviewer) =>
      Array.from(new Set(providersFor(reviewer).flatMap(selectableModels)));

    // Show the configured provider default even without a saved override.
    // Configured-default sentinels resolve to null: the CLI owns the choice, so
    // there is no model id to display.
    const providerDefault = (reviewer) => {
      const provider = providersFor(reviewer)[0];
      if (!provider?.defaultModel) return null;
      return filterSelectableModels(
        selectableModelsForProvider(provider, [provider.defaultModel])
      ).find(Boolean) || null;
    };

    // Local model lists come from the live probe, so only show a provider default
    // present in that list.
    const localDefault = (backend) => {
      const candidate = providersFor(backend)[0]?.defaultModel;
      return candidate && localIds(backend).includes(candidate) ? candidate : null;
    };

    const ollama = localIds('ollama');
    const optionsByReviewer = {
      ...Object.fromEntries(providerReviewers.map(reviewer => [reviewer, providerTiers(reviewer)])),
      lmstudio: localIds('lmstudio'),
      ollama,
      codex: providerTiers('codex'),
      // Claude tiers first, then installed Ollama ids for an Ollama-backed `claude`.
      claude: Array.from(new Set([...providerTiers('claude'), ...ollama].filter(Boolean))),
      antigravity: providerTiers('antigravity'),
      // The shipped grok provider carries only the configured-default sentinel
      // (stripped by `filterSelectableModels`), so this is `[]` until the user lists
      // real ids; the cell stays usable because every CLI reviewer is free-text.
      grok: providerTiers('grok'),
      cursor: providerTiers('cursor'),
      pi: providerTiers('pi'),
      // Empty for grok's reason: the shipped kimi provider carries only the sentinel.
      kimi: providerTiers('kimi'),
      // The namespaced `opencode/*` ids the Harnesses page refreshes from
      // `opencode models`. Still free-text: `opencode -m` takes any `provider/model`
      // the user's own config resolves.
      opencode: providerTiers('opencode'),
      // Kilo forks OpenCode's ids; empty until the Harnesses page refreshes them.
      kilo: providerTiers('kilo'),
      mtplx: providerTiers('mtplx'),
    };

    const defaultModels = {
      ...Object.fromEntries(providerReviewers.map(reviewer => [reviewer, providerDefault(reviewer)])),
      lmstudio: localDefault('lmstudio'),
      ollama: localDefault('ollama'),
      codex: providerDefault('codex'),
      claude: providerDefault('claude'),
      antigravity: providerDefault('antigravity'),
      grok: providerDefault('grok'),
      cursor: providerDefault('cursor'),
      pi: null, // A bare reviewer uses Pi's own configured default.

      kimi: providerDefault('kimi'),
      // Deliberately null: the reviewer spawns a BARE `opencode`, which uses the
      // user's own config, not the PortOS record's default.
      opencode: null,
      // Same as `opencode`: a bare `kilo` uses the user's own Kilo config.
      kilo: null,
      mtplx: providerDefault('mtplx'),
    };

    // The agy providers' RAW catalog (one id per effort tier,
    // `gemini-3.6-flash-low|-medium|-high`), which the narrowing reads. NOT
    // `optionsByReviewer.antigravity`, whose suffixes are already collapsed.
    const antigravityCatalog = Array.from(new Set(
      providersFor('antigravity').flatMap((provider) => provider.models || [])
    ));
    // The effort ladder offered ONCE ITS MODEL IS PINNED: `agy` validates the pair,
    // so a model with no `-medium` sibling must not offer `medium`.
    // `antigravityModelEffortLevels` returns null for "can't tell" (empty catalog,
    // unset model, configured-default sentinel) and the runtime ladder stands; `[]`
    // is a real answer (no effort tiers). `codex` model-gating is handled by
    // reviewerEffortLevels.
    const modelEffortLevels = (reviewer, model = null) => reviewerEffortLevels(reviewer, model, antigravityCatalog);

    return {
      providers: providers || [],
      providersLoaded,
      optionsByReviewer,
      defaultModels,
      modelEffortLevels,
      // A PROBED backend's id list is authoritative, so those stay a closed
      // `<select>`. Gated on PROBED_LOCAL_BACKENDS, not LOCAL_LLM_REVIEWERS: a closed
      // select over `mtplx`'s stored catalog would forbid a checkpoint the user has
      // pulled. Every CLI reviewer is free-text: `claude` for the Ollama-backed /
      // Bedrock cases, `codex`/`antigravity`/`grok`/`cursor` because stored catalogs
      // lag new tiers (grok's holds no real id, so typing is the ONLY way to pin one;
      // an agy pin may be typed effort-suffixed, the server splits it), `opencode`
      // because user config can declare namespaces the Zen catalog never lists.
      // Derived from the rosters so a new reviewer can't default to the wrong control.
      freeText: Object.fromEntries(
        [...MODEL_SELECTABLE_REVIEWERS, ...providerReviewers].map((r) => [r, !PROBED_LOCAL_BACKENDS.includes(r)])
      ),
      unavailable: {
        lmstudio: localStatus?.lmstudio?.available === false,
        ollama: localStatus?.ollama?.available === false,
      },
      // `every` over a NON-EMPTY match list keeps the two no-enabled-record cases
      // apart: every Kimi record switched off is `true` (hide), while no records at
      // all, or a failed/unlanded fetch, is `false` (nothing known, hide nothing).
      // `enabled === false` rather than falsiness: a record with no `enabled` key
      // reads ON, the opposite of `providerCardState`, because this answer HIDES a
      // control and incomplete data must never do that.
      //
      // A LOCAL-LLM reviewer is exempt: `lmstudio`/`ollama`/`mtplx` reviews go
      // straight to the daemon's base URL (`BACKEND_BASE_URLS` in
      // server/services/codeReview.js), so a switched-off provider record of the same
      // name doesn't stop them; `unavailable` is authoritative for those.
      providerDisabled: Object.fromEntries(
        Object.entries(providersByReviewer).map(([reviewer, matched]) =>
          [reviewer, !LOCAL_LLM_REVIEWERS.includes(reviewer) && matched.length > 0 && matched.every((p) => p.enabled === false)]
        )
      ),
      loaded,
      // So a consumer can assert it covers every model-taking reviewer.
      reviewers: MODEL_SELECTABLE_REVIEWERS,
    };
  }, [localStatus, providers, loaded, providersLoaded]);
}
