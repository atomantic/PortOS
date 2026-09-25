import { isDeepStrictEqual } from 'node:util';
import { ServerError } from '../lib/errorHandler.js';
import { requireToolkit } from '../lib/aiToolkitState.js';
import { isDerivedPreset } from '../lib/providerGraphRecords.js';
import { effortLevelsForProvider } from '../lib/providerModels.js';
import { listedModels, materializeDerivedPreset, refusedDerivedEdits } from '../lib/providerPresets.js';
import { allocateServiceSlug } from '../lib/providerServiceInstances.js';
import { listCredentialBootstraps } from './credentialBootstrapApps.js';
import { describeCompositeProvider, resolveCompositeParts } from './compositeProviders.js';
import { providerGraphEnabled, reconcileProviderGraph, requireProviderGraph } from './providerGraph.js';
import { readGraph } from './providerGraphStore.js';

/**
 * PRESET orchestration (#7565, epic #7561): the store-backed half of
 * `lib/providerPresets.js`.
 *
 *   - `materializeStoredPreset` — what `POST /api/providers` and `PUT
 *     /api/providers/:id` hand the toolkit for a DERIVED preset: the record
 *     with its connection-owned values re-derived from the service instance it
 *     names, and a direct edit to one of those values refused with a pointer
 *     at the service.
 *   - `createPresetFromComposite` — "Save as preset": a composite id the
 *     resolver already judges runnable becomes a stored record, enabled, with
 *     the selection's model and effort as its defaults.
 *   - `derivePreset` — "Convert to derived preset" for one legacy record: the
 *     same fixpoint rule the boot backfill applies, on demand.
 *
 * Every write lands in `data/providers.json` through the toolkit, so an older
 * release executes a derived preset exactly as any record. Local I/O only;
 * nothing here contacts a provider.
 */

const providerService = () => requireToolkit().services.providers;

/**
 * The harness, instance and bootstrap a derived record names — resolved by
 * the same lookup a composite id goes through, so a name nothing answers to
 * is the same 400 (`service-unknown`, `bootstrap-unknown`, …) either way.
 */
async function presetInputs(record) {
  requireProviderGraph();
  const [graph, bootstraps] = await Promise.all([readGraph(), listCredentialBootstraps()]);
  const resolved = resolveCompositeParts(
    { harnessId: record.harnessId, method: record.method, serviceSlug: record.serviceId, bootstrapSlug: record.credentialBootstrapId ?? null },
    { graph, bootstraps },
  );
  if (resolved.code) throw new ServerError(resolved.reason, { status: 400, code: resolved.code });
  return resolved;
}

/**
 * The record a save stores for a derived preset.
 *
 * `candidate` is the stored record with the client's updates already merged
 * (secrets restored); `updates` is the patch itself, so a connection-owned
 * value the client MOVED is refused while one it merely echoed back is not.
 * A `models` edit on a derived preset is read as a narrowing of the service
 * catalog rather than refused: which of the catalog a preset offers is the
 * preset's own choice.
 *
 * @param {object} candidate
 * @param {{updates?: object, previous?: object}} [options]
 * @returns {Promise<object>} the record to hand `createProvider` / `updateProvider`
 */
export async function materializeStoredPreset(candidate, { updates = {}, previous = null } = {}) {
  const record = { ...candidate, method: candidate.method ?? candidate.type };
  const { harness, connection, instance, bootstrap } = await presetInputs(record);
  const listed = listedModels(instance, connection.catalog);
  // An editor Save echoes the stored list back; only a CHANGED list is a
  // narrowing. And a narrowing keeps ids the catalog does not list yet
  // (`derivedPresetModels` filters them at derivation) — dropping them here
  // turned a stale instance catalog into a permanent one-model preset.
  if (Array.isArray(updates.models) && listed.length > 0
    && !(previous && isDeepStrictEqual(updates.models, previous.models))) {
    const chosen = new Set(updates.models);
    record.catalogNarrowing = listed.every((model) => chosen.has(model)) ? null : [...chosen];
  }
  const { record: derived, error, ownedEnvNames } = materializeDerivedPreset({
    record, harness, instance, catalog: connection.catalog, bootstrap,
  });
  if (error) throw new ServerError(error.message, { status: 400, code: error.code });
  const refused = refusedDerivedEdits(updates, derived, ownedEnvNames, previous);
  if (refused.length > 0) {
    throw new ServerError(
      `${refused.join(', ')} ${refused.length === 1 ? 'is' : 'are'} derived from service "${record.serviceId}"; edit the service (PATCH /api/providers/services/${record.serviceId}) instead`,
      { status: 400, code: 'PRESET_FIELD_DERIVED', context: { fields: refused, serviceId: record.serviceId } },
    );
  }
  return derived;
}

/** A readable, free record id for a composite: `pi-tui-nvidia-nim-free`, `claude-cli-anthropic-corp-auth`, suffixed when taken. */
const mintPresetId = (parts, taken) =>
  allocateServiceSlug([parts.harnessId, parts.method, parts.serviceSlug, parts.bootstrapSlug].filter(Boolean).join('-'), taken);

/**
 * "Save as preset": store the record a composite id resolves to.
 *
 * The resolver's verdict is the gate — an ineligible composite is a 400 with
 * the same code and reason a picker shows beside it, never a stored record
 * that cannot run. The stored record is the composite's materialization
 * (so it spawns with the identical argv and env) plus the caller's model and
 * effort as its defaults and the `+<bootstrap>` suffix as its
 * `credentialBootstrapId`; a later save re-derives it like any derived preset.
 *
 * @param {{compositeId: string, id?: string, name?: string, model?: string|null, effort?: string|null}} input
 * @returns {Promise<object>} the created record
 */
export async function createPresetFromComposite({ compositeId, id, name, model, effort }) {
  const verdict = await describeCompositeProvider(compositeId);
  if (!verdict.eligible) throw new ServerError(verdict.reason, { status: 400, code: verdict.code });
  const { record, parts } = verdict;
  const { providers } = await providerService().getAllProviders();
  const taken = new Set(providers.map((provider) => provider.id));
  if (id && taken.has(id)) throw new ServerError(`Provider "${id}" already exists`, { status: 409, code: 'PRESET_ID_TAKEN' });
  const defaultModel = model ?? record.defaultModel ?? null;
  if (model && record.models.length > 0 && !record.models.includes(model)) {
    throw new ServerError(`${parts.serviceSlug} lists no model "${model}"`, { status: 400, code: 'PRESET_MODEL_UNKNOWN' });
  }
  if (effort) {
    const levels = effortLevelsForProvider(record, defaultModel);
    if (!levels || !levels.includes(effort)) {
      throw new ServerError(levels ? `This preset accepts effort ${levels.join(', ')}` : 'This preset\'s harness takes no effort setting',
        { status: 400, code: 'PRESET_EFFORT_UNSUPPORTED' });
    }
  }
  const body = {
    ...record,
    // The composite's key rides non-enumerably; a stored preset carries it as any record does.
    apiKey: record.apiKey ?? '',
    id: id ?? mintPresetId(parts, taken),
    name: name ?? record.name,
    defaultModel,
    ...(effort ? { effort } : {}),
    ...(parts.bootstrapSlug ? { credentialBootstrapId: parts.bootstrapSlug } : {}),
  };
  delete body.servicePlan;
  const created = await providerService().createProvider(body);
  console.log(`🔗 Saved composite ${compositeId} as preset ${created.id}`);
  return created;
}

/**
 * Convert ONE legacy preset into a derived one, on demand.
 *
 * The conversion IS a reconcile pass: it imports a record the graph has never
 * routed (as its own fragment, named as a service instance) and stamps every
 * routed legacy record whose re-derivation is a fixpoint — the same rule the
 * boot backfill applies, so the button and the boot pass cannot disagree about
 * what is convertible. Refused with the pass's own reason when re-deriving
 * this record would change how it runs.
 *
 * @param {string} id
 * @returns {Promise<object>} the record as stored afterwards
 */
export async function derivePreset(id) {
  requireProviderGraph();
  const before = await providerService().getProviderById(id);
  if (!before) throw new ServerError('Provider not found', { status: 404 });
  if (isDerivedPreset(before)) return before;
  const pass = await reconcileProviderGraph('derive');
  const after = await providerService().getProviderById(id);
  if (after && isDerivedPreset(after)) {
    console.log(`🔗 Converted ${id} into a derived preset on service ${after.serviceId}`);
    return after;
  }
  const reason = pass?.presets?.skipped.find((entry) => entry.id === id)?.reason ?? 'not-derivable';
  throw new ServerError(`"${id}" cannot be derived from a service as it is configured (${reason})`,
    { status: 409, code: 'PRESET_NOT_DERIVABLE', context: { reason } });
}

/** Whether a save has to go through {@link materializeStoredPreset}: the record is derived and the graph can answer for its service. */
export const savesAsDerivedPreset = (candidate) => isDerivedPreset(candidate) && providerGraphEnabled();

/**
 * What a create or update hands the toolkit: the service-derived record for a
 * derived preset, the caller's own body for a legacy one. `candidate` is the
 * record as it would be stored; `updates` the patch the client sent.
 */
export const storableProviderRecord = (candidate, updates, previous = null) =>
  (savesAsDerivedPreset(candidate) ? materializeStoredPreset(candidate, { updates, previous }) : Promise.resolve(updates));
