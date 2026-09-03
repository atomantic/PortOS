import { useEffect, useMemo, useState } from 'react';
import * as api from '../services/api';
import { filterSelectableModels, selectableModelsForProvider, isAntigravityProvider, isGrokBuildCli, isKimiProvider, antigravityModelEffortLevels } from '../utils/providers';
import { MODEL_SELECTABLE_REVIEWERS } from '../components/cos/constants';
import { reviewerEffortLevels, normalizeReviewerSlug } from '../lib/reviewerPins';
import { LOCAL_LLM_BACKENDS } from '../lib/localLlmBackends';

// Local backends whose installed-model list `/api/local-llm/status` actually
// probes — the same roster the Runtimes/Model Library views render a catalog for,
// reused so the two can't drift. `mtplx` is a local backend but is NOT in it: its
// listing runs the `mtplx` wrapper, so it stays catalog-sourced and free-text.
const PROBED_LOCAL_BACKENDS = LOCAL_LLM_BACKENDS.map((b) => b.id);

/**
 * Selectable model ids per model-taking reviewer, for `ReviewerPicker`'s Model
 * column. One hook so all four picker surfaces (Code Review Defaults, TaskAddForm,
 * ScheduleTab, SlashDoRunDrawer) offer the SAME options instead of only the
 * settings panel having them (#3133).
 *
 * Two sources, because the two reviewer kinds are different things:
 * - `lmstudio` / `ollama` ids come from `/api/local-llm/status`, so they reflect
 *   what's actually installed rather than a provider's stale stored `models`.
 * - Every other reviewer's tiers come from the provider catalog
 *   (`/api/providers`). That includes `mtplx`: its installed checkpoints live
 *   behind `/api/local-llm/mtplx/status`, which INVOKES the `mtplx` wrapper (a
 *   several-hundred-MB venv bootstrap on a cold version — see
 *   `server/lib/mtplxRuntime.js`), and a picker mount must never pay that. The
 *   shipped provider's catalog plus a free-text field is the honest trade.
 *
 * The `claude` list spans BOTH usage modes: the `claude-code` provider tiers and
 * the installed Ollama ids (an Ollama-backed `claude` CLI, where `--model` selects
 * the local model). Deduped, order-preserving.
 *
 * `freeText` marks a reviewer whose picker must ALSO accept a typed id, not only
 * a pick: an Ollama-backed `claude` can run any locally-installed id, and a
 * Bedrock/Vertex install needs its environment's own id form, neither of which a
 * catalog can enumerate. Those still render a dropdown of the catalog — the flag
 * adds a "Custom…" escape to it (see `ReviewerPicker`'s Model cell); a reviewer
 * marked `false` gets a closed list, because its options came from a live probe.
 *
 * `unavailable` distinguishes "backend is down" from "backend has no models" so
 * the empty state can say the useful thing. Absent = not probed (every reviewer
 * outside PROBED_LOCAL_BACKENDS, `mtplx` included).
 * `loaded` flips once both fetches settle, so a consumer can tell "no options
 * yet" from "genuinely no options" (an empty list is a real answer, not a
 * pre-fetch placeholder).
 *
 * `modelEffortLevels(reviewer, model)` narrows a reviewer's effort ladder by its
 * PINNED MODEL, because `agy` validates the model/effort PAIR (`gemini-3.1-pro`
 * has no `medium` tier) — see #3733. Only `antigravity` narrows today; every other
 * reviewer returns its static ladder. Lives here rather than in the picker so the
 * picker keeps doing no fetching of its own.
 *
 * @returns {{ optionsByReviewer: Record<string, string[]>, defaultModels: Record<string, string|null>, freeText: Record<string, boolean>, unavailable: Record<string, boolean>, modelEffortLevels: (reviewer: string, model?: string|null) => readonly string[]|null, loaded: boolean, reviewers: string[] }}
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
    const providerFor = (...matchers) =>
      matchers.reduce((found, match) => found || (providers || []).find(match), null);

    const providerTiers = (...matchers) => {
      const provider = providerFor(...matchers);
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

    // Show the configured provider default in the picker even when the user has
    // not saved a per-reviewer override. A concrete default is useful context;
    // configured-default sentinels intentionally resolve to null because the CLI
    // owns the choice and there is no model id PortOS can honestly display.
    const providerDefault = (...matchers) => {
      const provider = providerFor(...matchers);
      if (!provider?.defaultModel) return null;
      return filterSelectableModels(
        selectableModelsForProvider(provider, [provider.defaultModel])
      ).find(Boolean) || null;
    };

    // Local backend model lists come from the live runtime probe, so only show a
    // provider default when it is present in that authoritative list.
    const localDefault = (backend) => {
      const candidate = providerFor((p) => p.id === backend)?.defaultModel;
      return candidate && localIds(backend).includes(candidate) ? candidate : null;
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
      cursor: providerTiers((p) => p.id === 'cursor-cli', (p) => p.id === 'cursor-tui'),
      // Legitimately empty, for grok's documented reason: the shipped kimi
      // provider carries only the configured-default sentinel, which
      // `filterSelectableModels` strips. Free-text keeps the cell usable.
      kimi: providerTiers((p) => p.id === 'kimi-cli', isKimiProvider),
      // Deliberately NOT sourced from the `opencode-<backend>` presets. Those
      // enumerate ids that only resolve under the `OPENCODE_CONFIG_CONTENT` a
      // PortOS-spawned provider injects, and the reviewer runs a bare `opencode`
      // against the user's OWN config — so listing them would offer picks that
      // silently fail. `opencode -m` takes a `provider/model` id the user types.
      opencode: [],
      mtplx: providerTiers((p) => p.id === 'mtplx'),
    };

    const defaultModels = {
      lmstudio: localDefault('lmstudio'),
      ollama: localDefault('ollama'),
      codex: providerDefault((p) => p.id === 'codex'),
      claude: providerDefault((p) => p.id === 'claude-code'),
      antigravity: providerDefault(isAntigravityProvider),
      grok: providerDefault((p) => p.id === 'grok-cli', isGrokBuildCli),
      cursor: providerDefault((p) => p.id === 'cursor-cli', (p) => p.id === 'cursor-tui'),
      kimi: providerDefault((p) => p.id === 'kimi-cli', isKimiProvider),
      opencode: null,
      mtplx: providerDefault((p) => p.id === 'mtplx'),
    };

    // The agy provider's RAW catalog — one id per effort tier
    // (`gemini-3.6-flash-low|-medium|-high`), which is exactly what the narrowing
    // reads. Deliberately NOT `optionsByReviewer.antigravity`: that list has
    // already had the suffixes collapsed away, so it carries no tier information.
    const antigravityCatalog = (providers || []).find(isAntigravityProvider)?.models || [];
    // The effort ladder a reviewer offers ONCE ITS MODEL IS PINNED. `agy` validates
    // the pair, so a model with no `-medium` sibling must not offer `medium`
    // (#3733). `antigravityModelEffortLevels` returns null for "can't tell" — empty
    // catalog, unset model, or the configured-default sentinel — and the full
    // static ladder stands there, the same null-means-fall-back contract
    // `effortLevelsForProvider` uses. `[]` is a real answer: that model has no
    // effort tiers at all.
    const modelEffortLevels = (reviewer, model = null) => {
      const ladder = reviewerEffortLevels(reviewer);
      if (!ladder || normalizeReviewerSlug(reviewer) !== 'antigravity') return ladder;
      return antigravityModelEffortLevels(model, antigravityCatalog) ?? ladder;
    };

    return {
      optionsByReviewer,
      defaultModels,
      modelEffortLevels,
      // A PROBED backend's id list is authoritative, so keep those pickers a closed
      // `<select>`. Gated on PROBED_LOCAL_BACKENDS rather than LOCAL_LLM_REVIEWERS
      // because `mtplx` is a local backend we deliberately do NOT probe here — a
      // closed select over its stored catalog would forbid a checkpoint the user
      // has actually pulled. Every CLI reviewer is free-text too: `claude` for
      // the Ollama-backed / Bedrock-form cases above, `codex`/`antigravity`/`grok`/`cursor`
      // because their catalogs are stored snapshots that can lag a newly-released
      // tier — grok's shipped catalog holds no real id at all, so a typed id is the
      // ONLY way to pin one (an agy pin may also be typed effort-suffixed — the
      // server splits it). Derived from the rosters so a reviewer added to either
      // one can't silently default to the wrong control.
      freeText: Object.fromEntries(
        MODEL_SELECTABLE_REVIEWERS.map((r) => [r, !PROBED_LOCAL_BACKENDS.includes(r)])
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
