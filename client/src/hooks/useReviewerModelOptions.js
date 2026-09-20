import { useEffect, useMemo, useState } from 'react';
import * as api from '../services/api';
import { filterSelectableModels, selectableModelsForProvider, antigravityModelEffortLevels } from '../utils/providers';
// THE reviewer -> provider-record table, shared with the retired-pin audit
// (#7339). Taken from the server leaf rather than mirrored: the picker offering
// a tier the audit calls retired — or the audit flagging a pin the picker just
// handed the user — is exactly the drift a second copy would reintroduce.
import { REVIEWER_PROVIDER_MATCHERS, providersForReviewer } from '../../../server/lib/reviewerProviderMatchers.js';
import { MODEL_SELECTABLE_REVIEWERS } from '../components/cos/constants';
import { reviewerEffortLevels, normalizeReviewerSlug, LOCAL_LLM_REVIEWERS } from '../lib/reviewerPins';
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
 *   (`/api/providers`), unioned across the records listed in
 *   `REVIEWER_PROVIDER_MATCHERS`. That includes `mtplx`: its installed
 *   checkpoints live behind `/api/local-llm/mtplx/status`, which INVOKES the
 *   `mtplx` wrapper (a several-hundred-MB venv bootstrap on a cold version — see
 *   `server/lib/mtplxRuntime.js`), and a picker mount must never pay that. The
 *   shipped provider's catalog plus a free-text field is the honest trade.
 *
 * The `claude` list spans BOTH usage modes: the `claude-code`/`claude-code-tui`
 * provider tiers and the installed Ollama ids (an Ollama-backed `claude` CLI,
 * where `--model` selects the local model). Deduped, order-preserving.
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
 *
 * `providerDisabled[reviewer]` is true when the reviewer HAS provider records on
 * this install and every one of them is switched off — the signal
 * `ReviewerPicker` uses to drop it from the Add row, so a machine that never
 * enabled Kimi or Cursor isn't offered them. Only ever true from a landed fetch:
 * a null/failed `/api/providers` matches no record, which reads as "nothing
 * known", never as "switched off". Always false for a LOCAL_LLM_REVIEWERS
 * backend, whose review never reads a provider record at all — see the exemption
 * at the return site.
 *
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
 * @returns {{ optionsByReviewer: Record<string, string[]>, defaultModels: Record<string, string|null>, freeText: Record<string, boolean>, unavailable: Record<string, boolean>, providerDisabled: Record<string, boolean>, modelEffortLevels: (reviewer: string, model?: string|null) => readonly string[]|null, loaded: boolean, reviewers: string[] }}
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

    // Resolved ONCE for the whole roster rather than per lookup — the option
    // list, the shown default, the agy raw catalog and `providerDisabled` all
    // ask the same question, and a per-call helper re-walked the provider array
    // for every one of them. Ordering and de-duping are `providersForReviewer`'s
    // own contract; see its JSDoc.
    const providersByReviewer = Object.fromEntries(
      Object.keys(REVIEWER_PROVIDER_MATCHERS).map((reviewer) => [reviewer, providersForReviewer(reviewer, providers)])
    );
    for (const provider of providers || []) providersByReviewer[`provider:${provider.id}`] = [provider];
    const providerReviewers = (providers || []).map(provider => `provider:${provider.id}`);
    const providersFor = (reviewer) => providersByReviewer[reviewer] || [];

    // `selectableModelsForProvider` owns the per-provider normalization (today:
    // agy's one-id-per-effort-tier catalog collapsed to base ids, so the row's
    // separate Effort cell stays the effort control). Going through it rather
    // than special-casing agy here keeps the rule in one place.
    const selectableModels = (provider) => {
      // `models` may be empty on a CLI provider configured with only a
      // defaultModel — `[]` is truthy, so a bare `||` wouldn't fall through.
      const models = provider.models?.length ? provider.models : [provider.defaultModel];
      return filterSelectableModels(selectableModelsForProvider(provider, models));
    };

    const providerTiers = (reviewer) =>
      Array.from(new Set(providersFor(reviewer).flatMap(selectableModels)));

    // Show the configured provider default in the picker even when the user has
    // not saved a per-reviewer override. A concrete default is useful context;
    // configured-default sentinels intentionally resolve to null because the CLI
    // owns the choice and there is no model id PortOS can honestly display.
    const providerDefault = (reviewer) => {
      const provider = providersFor(reviewer)[0];
      if (!provider?.defaultModel) return null;
      return filterSelectableModels(
        selectableModelsForProvider(provider, [provider.defaultModel])
      ).find(Boolean) || null;
    };

    // Local backend model lists come from the live runtime probe, so only show a
    // provider default when it is present in that authoritative list.
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
      // Claude tiers first (the common case), then installed Ollama ids for an
      // Ollama-backed `claude`. Deduped, order-preserving.
      claude: Array.from(new Set([...providerTiers('claude'), ...ollama].filter(Boolean))),
      antigravity: providerTiers('antigravity'),
      // The shipped grok provider carries only the configured-default sentinel,
      // which `filterSelectableModels` strips — so this is legitimately `[]` until
      // the user lists real ids on the provider. The Model cell stays useful
      // regardless because grok, like every CLI reviewer, is free-text.
      grok: providerTiers('grok'),
      cursor: providerTiers('cursor'),
      pi: providerTiers('pi'),
      // Legitimately empty, for grok's documented reason: the shipped kimi
      // provider carries only the configured-default sentinel, which
      // `filterSelectableModels` strips. Free-text keeps the cell usable.
      kimi: providerTiers('kimi'),
      // The namespaced `opencode/*` ids the seeded Zen CLI/TUI records carry,
      // which the Harnesses page refreshes from `opencode models` — so the cell
      // is a dropdown of what this account can actually run instead of the plain
      // text input it used to be. Still free-text underneath: `opencode -m` takes
      // any `provider/model` the user's own config resolves.
      opencode: providerTiers('opencode'),
      // Kilo forks OpenCode's `provider/model` ids and its `models` subcommand,
      // so this is whatever the Harnesses page last refreshed onto the shipped
      // records — empty until then, with free-text keeping the cell usable.
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
      // Deliberately null even though the Zen records carry one: the reviewer
      // spawns a BARE `opencode`, which falls back to whatever the user's own
      // config names — not to the PortOS record's default. Naming a model here
      // would claim a default the run won't use.
      opencode: null,
      // Same reasoning as `opencode`: the reviewer spawns a bare `kilo`, which
      // falls back to the model the user's own Kilo config names.
      kilo: null,
      mtplx: providerDefault('mtplx'),
    };

    // The agy providers' RAW catalog — one id per effort tier
    // (`gemini-3.6-flash-low|-medium|-high`), which is exactly what the narrowing
    // reads. Deliberately NOT `optionsByReviewer.antigravity`: that list has
    // already had the suffixes collapsed away, so it carries no tier information.
    const antigravityCatalog = Array.from(new Set(
      providersFor('antigravity').flatMap((provider) => provider.models || [])
    ));
    // The effort ladder a reviewer offers ONCE ITS MODEL IS PINNED. `agy` validates
    // the pair, so a model with no `-medium` sibling must not offer `medium`
    // (#3733). `antigravityModelEffortLevels` returns null for "can't tell" —
    // empty catalog, unset model, or the configured-default sentinel — and the full
    // static ladder stands there, the same null-means-fall-back contract
    // `effortLevelsForProvider` uses. `[]` is a real answer: that model has no
    // effort tiers at all. For `codex`, the model gates `minimal` on gpt-6 family
    // models that reject it (model-gating is already handled by reviewerEffortLevels).
    const modelEffortLevels = (reviewer, model = null) => {
      const slug = normalizeReviewerSlug(reviewer);
      const ladder = reviewerEffortLevels(reviewer, model);
      if (!ladder || slug !== 'antigravity') return ladder;
      return antigravityModelEffortLevels(model, antigravityCatalog) ?? ladder;
    };

    return {
      providers: providers || [],
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
      // server splits it) — and `opencode` because a user's own config can declare
      // namespaces the Zen catalog never lists. Derived from the rosters so a
      // reviewer added to either one can't silently default to the wrong control.
      freeText: Object.fromEntries(
        [...MODEL_SELECTABLE_REVIEWERS, ...providerReviewers].map((r) => [r, !PROBED_LOCAL_BACKENDS.includes(r)])
      ),
      unavailable: {
        lmstudio: localStatus?.lmstudio?.available === false,
        ollama: localStatus?.ollama?.available === false,
      },
      // `every` over a NON-EMPTY match list, so the two ways to have no enabled
      // record stay apart: an install that switched every Kimi record off is
      // `true` (hide it), while a reviewer with no records at all — or a fetch
      // that failed or hasn't landed — is `false` (nothing is known, so hide
      // nothing). `enabled === false` rather than falsiness, which deliberately
      // reads a record with no `enabled` key as ON — the opposite of
      // `providerCardState`'s stricter test, because this answer HIDES a control
      // and incomplete data must never do that.
      //
      // A LOCAL-LLM reviewer is exempt: `lmstudio`/`ollama`/`mtplx` reviews go
      // straight to the daemon's own base URL (`BACKEND_BASE_URLS` in
      // server/services/codeReview.js), so a switched-off AI-provider record
      // named after the same backend does not stop the review from running. Left
      // in, it reported a reachable LM Studio serving models as unusable and
      // hid the row behind "show hidden reviewers". The live probe below
      // (`unavailable`) is the authoritative signal for these three.
      providerDisabled: Object.fromEntries(
        Object.entries(providersByReviewer).map(([reviewer, matched]) =>
          [reviewer, !LOCAL_LLM_REVIEWERS.includes(reviewer) && matched.length > 0 && matched.every((p) => p.enabled === false)]
        )
      ),
      loaded,
      // Exposed so a consumer can assert it covers every model-taking reviewer.
      reviewers: MODEL_SELECTABLE_REVIEWERS,
    };
  }, [localStatus, providers, loaded]);
}
