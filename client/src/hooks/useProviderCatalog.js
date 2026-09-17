import { useCallback, useEffect, useState } from 'react';
import { createProviderPreset, getProviderCatalog } from '../services/api';
import { harnessLabel } from '../utils/providerHarnesses.js';
import { parseProviderRef } from '../utils/providerRef.js';

/**
 * Module-level fetch cache, same shape as `useToolUseModelIds`: `null` = never
 * fetched (or the last attempt failed and was cleared for retry), a Promise
 * once a fetch is in flight or has resolved. The compose popover, the
 * preset-first `ProviderModelSelector`, and every bespoke picker migrating
 * onto this hook (#7566) can all mount inside the same tree, so N mounts must
 * share ONE `/providers/catalog` fetch rather than firing N of them.
 */
let inFlight = null;

const EMPTY_CATALOG = Object.freeze({
  harnesses: [], services: [], bootstraps: [], compatibility: {}, effortLevels: {}, effortLevelsByModel: {}, presets: [],
});

function fetchCatalog() {
  inFlight ||= getProviderCatalog({ silent: true })
    .catch((err) => {
      console.warn(`⚠️ Provider catalog fetch failed: ${err?.message || err}`);
      inFlight = null;
      return null;
    });
  return inFlight;
}

/** Test seam — drop the shared cache so each case starts from "never fetched". */
export function __resetProviderCatalogCache() {
  inFlight = null;
}

/**
 * The composition catalog behind the preset-first `ProviderModelSelector` and
 * `ProviderComposePopover` (#7566): one fetch of `GET /api/providers/catalog`
 * per mount tree, shared like `useToolUseModelIds`, plus the lookups every
 * picker/popover needs over it.
 *
 * - `presets` / `harnesses` / `services` / `bootstraps` — the raw catalog rows.
 * - `compatiblePairs(harnessId)` — the enabled service instances a harness can
 *   be pointed at, narrowed by `compatibility`.
 * - `methodsFor(harnessId)` — the execution modes (`cli`/`tui`/`api`) that
 *   harness supports.
 * - `modelsFor(serviceSlug)` — the service's own model catalog.
 * - `effortLevelsFor(harnessId, model)` — the per-model ladder when one
 *   narrows the harness's own (Codex, Antigravity), else the harness ladder.
 * - `resolveRef(id)` — a preset record for a preset id, or a SYNTHESIZED
 *   display record for a composite id (`{ id, name, harnessId, method,
 *   serviceSlug, bootstrapId, models, enabled: true, composite: true }`,
 *   named `"<harness label> · <METHOD> · <service label>"`, `" (free)"`
 *   suffixed for a free-plan service) — `null` when the id resolves to
 *   neither grammar or the composite names a harness/service this catalog
 *   doesn't know. Never contacts the server: unlike
 *   `GET /providers/composites/:id`, this is a pure lookup over the fetched
 *   catalog, so it renders a saved value instantly without a round trip, and
 *   carries no ELIGIBILITY verdict — pair it with the readiness/composites
 *   endpoints when "is this composite runnable right now" matters.
 * - `savePreset(input)` — `POST /providers/presets` ("Save as preset"),
 *   returned rather than imported separately so the popover doesn't need its
 *   own service import.
 *
 * @param {boolean} [enabled] - Load the catalog only when true, e.g. gate on
 *   the compose popover's `open`. Fetches once and keeps the result if
 *   `enabled` later goes false.
 * @returns {{
 *   harnesses: object[], services: object[], bootstraps: object[], presets: object[],
 *   compatibility: Record<string, string[]>, effortLevels: Record<string, string[]>,
 *   effortLevelsByModel: Record<string, Record<string, string[]>>,
 *   loading: boolean,
 *   compatiblePairs: (harnessId: string) => object[],
 *   methodsFor: (harnessId: string) => string[],
 *   modelsFor: (serviceSlug: string) => Array<string|object>,
 *   effortLevelsFor: (harnessId: string, model?: string|null) => string[],
 *   resolveRef: (id: string) => object|null,
 *   savePreset: (input: object) => Promise<object>,
 * }}
 */
export default function useProviderCatalog(enabled = true) {
  const [state, setState] = useState({ catalog: null, loaded: false });

  useEffect(() => {
    if (!enabled || state.loaded) return undefined;
    let canceled = false;
    fetchCatalog().then((catalog) => {
      if (!canceled) setState({ catalog, loaded: true });
    });
    // A cancel (popover closed mid-flight) leaves `loaded` false, so reopening
    // re-reads rather than rendering a result that never arrived — free when
    // the first fetch already succeeded, since the shared cache still has it.
    return () => { canceled = true; };
  }, [enabled, state.loaded]);

  const catalog = state.catalog || EMPTY_CATALOG;

  const compatiblePairs = useCallback((harnessId) => {
    const slugs = new Set(catalog.compatibility?.[harnessId] || []);
    return (catalog.services || []).filter((service) => slugs.has(service.slug) && service.enabled !== false);
  }, [catalog]);

  const methodsFor = useCallback(
    (harnessId) => [...((catalog.harnesses || []).find((harness) => harness.id === harnessId)?.modes || [])],
    [catalog],
  );

  const modelsFor = useCallback(
    (serviceSlug) => (catalog.services || []).find((service) => service.slug === serviceSlug)?.catalog?.models || [],
    [catalog],
  );

  const effortLevelsFor = useCallback((harnessId, model = null) => {
    const perModel = model ? catalog.effortLevelsByModel?.[harnessId]?.[model] : null;
    return perModel || catalog.effortLevels?.[harnessId] || [];
  }, [catalog]);

  const resolveRef = useCallback((id) => {
    if (!id) return null;
    const preset = (catalog.presets || []).find((p) => p.id === id);
    if (preset) return preset;
    const ref = parseProviderRef(id);
    if (ref?.kind !== 'composite') return null;
    const harness = (catalog.harnesses || []).find((h) => h.id === ref.harnessId);
    if (!harness) return null;
    const service = (catalog.services || []).find((s) => s.slug === ref.serviceSlug);
    if (!service) return null;
    const label = `${harnessLabel(ref.harnessId)} · ${ref.method.toUpperCase()} · ${service.label}${service.plan === 'free' ? ' (free)' : ''}`;
    return {
      id,
      name: label,
      type: ref.method,
      harnessId: ref.harnessId,
      method: ref.method,
      serviceSlug: ref.serviceSlug,
      bootstrapId: ref.bootstrapSlug,
      models: service.catalog?.models || [],
      enabled: true,
      composite: true,
    };
  }, [catalog]);

  const savePreset = useCallback((input) => createProviderPreset(input), []);

  return {
    harnesses: catalog.harnesses,
    services: catalog.services,
    bootstraps: catalog.bootstraps,
    presets: catalog.presets,
    compatibility: catalog.compatibility,
    effortLevels: catalog.effortLevels,
    effortLevelsByModel: catalog.effortLevelsByModel,
    loading: enabled && !state.loaded,
    compatiblePairs,
    methodsFor,
    modelsFor,
    effortLevelsFor,
    resolveRef,
    savePreset,
  };
}
