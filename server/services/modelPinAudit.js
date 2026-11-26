/**
 * Retired-model-pin audit.
 *
 * Collects every stored model pin PortOS does NOT own, asks
 * `lib/modelPinReconcile.js` whether the provider still lists it, and returns
 * the ones that have rotted, so a Settings surface can flag a pin naming a
 * model the provider no longer serves instead of a run dying on a raw vendor error.
 *
 * **Surface, never auto-rewrite.** A user's pin is a deliberate choice;
 * substituting one would render under a different model than the one chosen.
 * Clearing a pin back to "inherit" is a user action (`clearModelPin`); nothing
 * here writes on its own.
 *
 * **Derived on read, never persisted.** The audit is a pure function of the
 * stores it reads: no record to migrate, sync or keep off federation, and a pin
 * that rotted earlier is reported on the first read. See modelPinReconcile.js.
 *
 * **Adding a pin source is one row in `PIN_SOURCES`.** Each row pairs the
 * collector with the writer that clears one, so a source cannot be
 * half-registered (a Clear button that throws at click time).
 */

import { ANTIGRAVITY_CLI_ID } from '../lib/antigravity.js';
import { CODEX_CLI_ID } from '../lib/codex.js';
import { IMAGE_GEN_MODE, METERED_IMAGE_GEN_MODES } from '../lib/generationModes.js';
import { MODEL_OVERRIDE_CAPABLE_MODES } from '../lib/imageGenCapabilities.js';
import { resolveGoalFidelityConfig } from '../lib/goalFidelity.js';
import { catalogOfferings, pinProviderIds, reconcileModelPins } from '../lib/modelPinReconcile.js';
import { isProviderReviewer, normalizeReviewerModel, reviewerModelsFromDefaults } from '../lib/reviewerConfig.js';
import { reviewerProviderIds } from '../lib/reviewerProviderMatchers.js';
import { normalizeRenderPinValue, RENDER_TARGETS } from '../lib/renderTargets.js';
import { getSettings, updateSettingsWith } from './settings.js';

/**
 * The pin STORES are reached through deferred imports, not top-level ones.
 *
 * This module is imported eagerly by `routes/providers.js`, and `apps.js` /
 * `taskSchedule.js` / `providers.js` each drag a heavy subtree, enough to push
 * the server suite past its static-instantiation budget (`lib/importScoping.test.js`,
 * server/AGENTS.md "Import scoping"). The audit is a user-triggered read, so
 * paying at call time is free.
 *
 * Each loader memoizes the PROMISE, not the resolved module: concurrent
 * `import()` calls of a mocked module can let one caller escape the mock unless
 * they share one in-flight promise.
 */
let appsModule = null;
let notificationsModule = null;
let providersModule = null;
let taskScheduleModule = null;
let recordPinsModule = null;
let taskTemplatesModule = null;
const loadAppsModule = () => (appsModule ||= import('./apps.js'));
const loadNotificationsModule = () => (notificationsModule ||= import('./notifications.js'));
const loadProvidersModule = () => (providersModule ||= import('./provider/providers.js'));
const loadTaskScheduleModule = () => (taskScheduleModule ||= import('./taskSchedule.js'));
const loadRecordPinsModule = () => (recordPinsModule ||= import('./modelPinRecords.js'));
const loadTaskTemplatesModule = () => (taskTemplatesModule ||= import('./taskTemplates.js'));

/**
 * Which provider record serves each cloud image-gen mode that can carry a pin.
 *
 * The mode SET is derived from `MODEL_OVERRIDE_CAPABLE_MODES` so a new
 * override-capable backend cannot go un-audited: this module's suite fails when
 * a mode gains `supportsModelOverride` with no row here. Grok is absent because
 * its image backend is fixed (no pin).
 *
 * The mode -> provider-record-id fact has no registry elsewhere
 * (`CLOUD_PROVIDER_SPECS` carries no provider id; imageGen/agy.js hardcodes its
 * own), so it lives here.
 */
const PINNED_IMAGE_MODES = Object.freeze({
  [IMAGE_GEN_MODE.AGY]: { providerId: ANTIGRAVITY_CLI_ID, label: 'Agy CLI' },
  [IMAGE_GEN_MODE.CODEX]: { providerId: CODEX_CLI_ID, label: 'Codex CLI' },
});

/**
 * The provider record that serves `mode`, or null when `mode` names no pinnable
 * cloud backend.
 *
 * `local` answering null is the point: the same model field holds a LOCAL
 * DIFFUSION CHECKPOINT id when the surface renders locally, which is not a CLI
 * catalog entry to reconcile against. Judging one would report a working local
 * pin as retired and offer to delete it.
 */
const pinnedModeProviderId = (mode) => (typeof mode === 'string' && PINNED_IMAGE_MODES[mode]?.providerId) || null;

/** Exported for the coverage guard above — not a runtime dependency. */
export const PINNED_IMAGE_MODE_IDS = Object.freeze(Object.keys(PINNED_IMAGE_MODES));

/**
 * Override-capable modes deliberately NOT audited here; the coverage guard
 * accepts a mode in exactly one of the two lists.
 *
 * fal.ai, Runway, Higgsfield and Google: their model ids come from PortOS's
 * curated catalogs (lib/falImageModels.js, lib/runwayImageModels.js,
 * lib/higgsfieldImageModels.js, lib/googleImageModels.js), not a provider record
 * a vendor refresh can retire. `resolveCloudProviderConfig` already refuses a
 * per-render id outside it and degrades a stale saved one to the shipped default.
 */
export const CATALOG_VALIDATED_IMAGE_MODE_IDS = METERED_IMAGE_GEN_MODES;
export { MODEL_OVERRIDE_CAPABLE_MODES };

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * One pin descriptor, or nothing when either half of the pair is missing.
 *
 * A pin whose provider cannot be named is not judgeable: guessing the catalog
 * risks a false retirement. Returns an array so every collector stays a single
 * `flatMap`.
 */
const pinIf = ({ model, providerId, providerIds, ...rest }) => {
  const id = trimmed(model);
  // A reviewer pin names a BINARY that several records front, so it hands in a
  // LIST; every other source names one record. Both collapse to ONE output
  // field, `providerIds`, normalized by the leaf's own `pinProviderIds`.
  const resolved = pinProviderIds({ providerId, providerIds });
  return id && resolved.length ? [{ ...rest, model: id, providerIds: resolved }] : [];
};

/** `settings.imageGen.<mode>.model` — the install-wide Image Gen pins. */
function collectImageGenPins({ settings }) {
  return Object.entries(PINNED_IMAGE_MODES).flatMap(([mode, { providerId, label }]) => pinIf({
    id: `settings:imageGen.${mode}.model`,
    mode,
    settingsPath: ['imageGen', mode, 'model'],
    providerId,
    model: settings?.imageGen?.[mode]?.model,
    label: `${label} image model`,
    location: 'Media Gen Settings',
    href: '/media/image?settings=1',
  }));
}

/**
 * `settings.renderDefaults.<target>.imageModel` — the per-surface pins.
 *
 * Gated on the entry's own `imageMode`: with a local mode the field holds a
 * diffusion checkpoint id, not a CLI catalog entry. An entry pinning a model
 * with no mode inherits the install default, whose provider we cannot name from
 * here, so it is left alone.
 */
function collectRenderDefaultPins({ settings }) {
  return RENDER_TARGETS.flatMap((target) => {
    const entry = settings?.renderDefaults?.[target];
    const mode = normalizeRenderPinValue(entry?.imageMode);
    return pinIf({
      id: `settings:renderDefaults.${target}.imageModel`,
      target,
      settingsPath: ['renderDefaults', target, 'imageModel'],
      providerId: pinnedModeProviderId(mode),
      model: normalizeRenderPinValue(entry?.imageModel),
      label: `${target} render model`,
      location: 'Media Gen Settings → Defaults',
      href: '/media/image?settings=1',
    });
  });
}

/** `schedule.tasks.<taskType>.model` — the global scheduled-task pins. */
function collectTaskSchedulePins({ schedule }) {
  return Object.entries(schedule?.tasks || {}).flatMap(([taskType, task]) => pinIf({
    id: `task:${taskType}`,
    taskType,
    providerId: task?.providerId,
    model: task?.model,
    label: `${taskType} task model`,
    location: 'Chief of Staff → Schedule',
    href: '/cos/schedule',
  }));
}

/**
 * Per-app task-type override pins, which OUTRANK the global pin at spawn. An
 * override that pins a model but no provider runs on whatever the global task
 * pin names, so that is the catalog to judge against; with neither, the provider
 * is the install's active one and unknowable here, so the pin is left alone.
 *
 * Reads `taskTypeOverrides` straight off the `getActiveApps()` records instead
 * of `getAppTaskTypeOverrides(app.id)`: that accessor re-loads the apps store
 * twice per call and can `atomicWrite` it (legacy-format migration), a write in
 * a path advertised as derived-on-read. Skipping the migration cannot change the
 * answer: legacy `disabledTaskTypes` migrates to entries carrying no model.
 */
async function collectAppOverridePins({ schedule }) {
  const { getActiveApps } = await loadAppsModule();
  // No local catch: an unreadable apps store must reach the collector-level
  // catch (counted toward `incomplete`), not silently read as "no overrides".
  const apps = await getActiveApps();
  return (apps || []).flatMap((app) =>
    Object.entries(app?.taskTypeOverrides || {}).flatMap(([taskType, override]) => pinIf({
      id: `app:${app.id}:${taskType}`,
      appId: app.id,
      taskType,
      providerId: trimmed(override?.providerId) || schedule?.tasks?.[taskType]?.providerId,
      model: override?.model,
      label: `${app.name || app.id} · ${taskType} task model`,
      location: 'Chief of Staff → Schedule → per-app overrides',
      href: '/cos/schedule',
    })),
  );
}

/**
 * `settings.codeReview`'s reviewer model pins: the `<reviewer>Model` scalars,
 * the `provider:<id>` entries in `providerModels`, and the goal-fidelity gate's
 * own model.
 *
 * These rot like every other pin, with a worse failure: a retired model is only
 * discovered when a review loop spawns the CLI inside an unattended run and the
 * reviewer's verdict is silently missing.
 *
 * **A reviewer is judged against SEVERAL provider records, not one.** The slug
 * names a BINARY that more than one record fronts (see
 * `lib/reviewerProviderMatchers.js`; the union is the only safe answer). A
 * reviewer no record matches yields no ids, so `pinIf` drops the pin rather than
 * guessing. A `provider:<id>` reviewer IS one record. The `lmstudio`/`ollama`/
 * `mtplx` reviewers match a record whose local-daemon carve-out in
 * `modelPinMembership.js` passes any id through: the local daemon is the
 * authority, not the record's cached snapshot.
 *
 * Stored scalars are read through `reviewerModelsFromDefaults`, the one adapter
 * to the token-keyed map the resolvers speak, so a judged pin is exactly a pin
 * the token builders would emit. Reviewer records are resolved only once a token
 * is known to carry a pin: `providersForReviewer` walks the catalog per matcher.
 */
function collectReviewerModelPins({ settings, providers }) {
  const codeReview = settings?.codeReview;
  // `settingsPath` is how a pin says where it lives, so a scalar, a map entry
  // and the nested goal-fidelity key share ONE writer.
  const reviewerPin = ({ judgeAs, settingsPath, ...rest }) => pinIf({
    ...rest,
    settingsPath,
    // Same `settings:<dotted path>` spelling the image-gen and render-default
    // pins already use, so a pin id still says where it lives.
    id: `settings:${settingsPath.join('.')}`,
    providerIds: isProviderReviewer(judgeAs)
      ? [judgeAs.slice('provider:'.length)]
      : reviewerProviderIds(judgeAs, providers),
    href: '/models/code-reviewers',
  });

  const scalarPins = Object.entries(reviewerModelsFromDefaults(codeReview)).flatMap(([token, model]) => reviewerPin({
    judgeAs: token,
    model,
    settingsPath: isProviderReviewer(token)
      ? ['codeReview', 'providerModels', token]
      : ['codeReview', `${token}Model`],
    label: `${token} reviewer model`,
    location: 'Code Review Defaults',
  }));

  // The gate's BACKEND comes from `resolveGoalFidelityConfig`, which owns when
  // the gate runs at all (disabled, or a hand-edited backend outside the local-LLM
  // set). Its MODEL deliberately does not: that resolver falls back to
  // `<backend>Model`, and auditing the fallback would report that scalar twice
  // under two ids, with a clear that wrote somewhere else.
  const gate = resolveGoalFidelityConfig(codeReview);
  return [...scalarPins, ...reviewerPin({
    judgeAs: gate?.backend,
    model: normalizeReviewerModel(codeReview?.goalFidelity?.model, gate?.backend),
    settingsPath: ['codeReview', 'goalFidelity', 'model'],
    label: 'goal-fidelity review model',
    location: 'Code Review Defaults → Goal fidelity',
  })];
}
/**
 * The `provider` + `model` pair a user-saved CoS task template pins.
 *
 * A template is a durable "run it this way" the user picks for months, so its
 * pin is among the likeliest to outlive its model, and it fails at launch time
 * with a vendor error for a model long forgotten.
 *
 * `provider` is a provider RECORD id (the Quick Templates menu seeds it from
 * `/api/providers`), so one id, no reviewer-style union. A template pinning a
 * model but no provider is not judgeable here, so `pinIf` drops it. Built-ins
 * carry neither field.
 */
async function collectTaskTemplatePins() {
  const { getAllTemplates } = await loadTaskTemplatesModule();
  const templates = await getAllTemplates();
  return (templates || []).flatMap((template) => pinIf({
    id: `template:${template?.id}`,
    templateId: template?.id,
    providerId: template?.provider,
    model: template?.model,
    label: `${trimmed(template?.name) || template?.id} · template model`,
    location: 'Chief of Staff → Tasks → Quick Templates',
    // No per-template route exists — a template is edited from the Quick
    // Templates row on the task form, so that page IS the destination.
    href: '/cos/tasks',
  }));
}

/**
 * One parent object with `key` REMOVED: "back to inherit" is the absence of the
 * field. `''` would also read as no-pin, but it survives a settings round-trip
 * as a value the user never typed.
 */
const withoutKey = (parent, key) => {
  const next = { ...(parent || {}) };
  delete next[key];
  return next;
};

/**
 * `root` with the key at `path` removed, every level above it copied.
 *
 * Three pin sources store a model id at different depths under `settings`
 * (`imageGen.<mode>.model`, `codeReview.<reviewer>Model`,
 * `codeReview.goalFidelity.model`). A pin carries its own `settingsPath` and
 * they share this one writer, so a new settings-backed source is a
 * collector-only edit.
 *
 * A path whose parent holds no object is returned unchanged: there is nothing to
 * clear, and writing `{}` into settings for an already-gone pin is a change the
 * user did not ask for.
 */
const withoutSettingsPath = (root, [head, ...rest]) => {
  if (!root || typeof root !== 'object') return root;
  if (rest.length === 0) return withoutKey(root, head);
  if (!root[head] || typeof root[head] !== 'object') return root;
  return { ...root, [head]: withoutSettingsPath(root[head], rest) };
};

/** The `clear` every settings-backed pin source shares. */
const clearSettingsPath = (pin) =>
  updateSettingsWith((current) => withoutSettingsPath(current, pin.settingsPath));

/**
 * The pin sources, in the order the panel reads them (install-wide first).
 *
 * ONE table, not a collector list beside a clearer map: keying the read and
 * write halves separately meant a kind registered in one and missed in the other
 * failed only when a user clicked Clear.
 *
 * Each `clear` touches the MODEL only, never the sibling mode/provider/enabled
 * fields, which are separate choices the user did not ask to undo.
 */
const PIN_SOURCES = Object.freeze([
  {
    kind: 'imageGen',
    collect: collectImageGenPins,
    clear: clearSettingsPath,
  },
  {
    kind: 'renderDefault',
    collect: collectRenderDefaultPins,
    clear: clearSettingsPath,
  },
  {
    kind: 'task',
    collect: collectTaskSchedulePins,
    clear: async (pin) => {
      const { updateTaskInterval } = await loadTaskScheduleModule();
      return updateTaskInterval(pin.taskType, { model: null });
    },
  },
  {
    kind: 'appOverride',
    collect: collectAppOverridePins,
    clear: async (pin) => {
      const { updateAppTaskTypeOverride } = await loadAppsModule();
      return updateAppTaskTypeOverride(pin.appId, pin.taskType, { model: null });
    },
  },
  // Reviewer model pins. Install-wide, so above the per-record row, and after the
  // task/app rows because a reviewer pin breaks only the REVIEW half of a run.
  {
    kind: 'reviewerModel',
    collect: collectReviewerModelPins,
    // The pin's own `settingsPath` and nothing beside it: never the sibling
    // `<reviewer>Effort`, the `reviewers` list, or `goalFidelity`'s
    // `backend`/`effort`. Dropping a reviewer from the chain because its MODEL
    // rotted would silently weaken the loop.
    clear: clearSettingsPath,
  },
  // User-saved CoS task-template pins (#7339).
  {
    kind: 'taskTemplate',
    collect: collectTaskTemplatePins,
    // `''` rather than a deleted key: that is this store's own encoding for an
    // unpinned template, and `updateTemplate` merges, so an absent key would leave
    // the stale id in place. `provider` and `effort` are untouched.
    clear: async (pin) => {
      const { updateTemplate } = await loadTaskTemplatesModule();
      return updateTemplate(pin.templateId, { model: '' });
    },
  },
  // Per-record `imageModelId` pins: universes, series, sprite records, decks and
  // music-video projects. ONE row because they share a storage shape;
  // `modelPinRecords.js` dispatches the clear on `pin.family`. Last because the
  // panel reads install-wide pins first.
  //
  // The record module finds the stored pairs and stops there; `pinnedModeProviderId`
  // is applied HERE, as `collectRenderDefaultPins` does, so the "a `local` pin
  // names a diffusion checkpoint" gate has one definition and the mode map stays
  // out of a module reached through a deferred import (importing it back would
  // close a cycle).
  {
    kind: 'record',
    collect: async () => {
      const { collectRecordPins } = await loadRecordPinsModule();
      const stored = await collectRecordPins();
      return stored.flatMap((pin) => pinIf({ ...pin, providerId: pinnedModeProviderId(pin.mode) }));
    },
    clear: async (pin) => {
      const { clearRecordPin } = await loadRecordPinsModule();
      return clearRecordPin(pin);
    },
  },
]);

/**
 * Every stored model pin PortOS does not own, in `PIN_SOURCES` order.
 *
 * Reads each backing store ONCE and hands every collector the same context: two
 * collectors need the task schedule, and `loadSchedule` is not memoized and can
 * queue a rewrite per concurrent call.
 *
 * A collector that throws must not take the audit down: one unreadable store is
 * a missing section. Each failure is counted so callers can tell "evaluated and
 * healthy" from "unevaluated after a store-read error"; the notifier must not
 * retract announced cards on the latter.
 *
 * @returns {Promise<{pins: Array<object>, errors: number}>}
 */
async function collectModelPins() {
  const { loadSchedule } = await loadTaskScheduleModule();
  const { listProviders } = await loadProvidersModule();
  let errors = 0;
  const [settings, schedule, providers] = await Promise.all([
    getSettings().catch(() => { errors += 1; return {}; }),
    loadSchedule().catch(() => { errors += 1; return null; }),
    // The reviewer collector classifies provider RECORDS, so the catalog is one of
    // this function's own inputs. `loadProviders` fronts a short TTL cache that
    // coalesces in-flight reads, so the reconciliation's own read costs nothing.
    listProviders().catch(() => { errors += 1; return []; }),
  ]);
  const context = { settings, schedule, providers };
  const collected = await Promise.all(PIN_SOURCES.map(async ({ kind, collect }) => {
    const pins = await Promise.resolve(collect(context)).catch((error) => {
      console.error(`❌ Model pin collector ${kind} failed: ${error.message}`);
      errors += 1;
      return [];
    });
    return pins.map((pin) => ({ ...pin, kind }));
  }));
  return { pins: collected.flat(), errors };
}

/**
 * The stale pins, plus the catalog each one's provider now offers.
 *
 * `providers` is keyed by provider id and carries only the records a stale pin
 * names (every id in its `providerIds`, so a reviewer pin ships each record
 * fronting its binary), so a 200-model Ollama catalog is not shipped to a page
 * with no Ollama pin.
 *
 * `incomplete` is true when any backing store or collector failed: the pin set
 * is then unevaluated, and callers that retract on empty (the retired-pin
 * notifier) must skip the pass rather than withdraw announcements the next
 * audit would re-raise.
 *
 * @returns {Promise<{pins: Array<object>, providers: Record<string, object>, incomplete: boolean}>}
 */
export async function auditModelPins() {
  const { listProviders } = await loadProvidersModule();
  // The pin stores and the provider catalog are independent reads.
  const [providerList, { pins, errors }] = await Promise.all([listProviders(), collectModelPins()]);
  const byId = Object.fromEntries(providerList.map((provider) => [provider.id, provider]));
  const stale = reconcileModelPins(pins, byId);
  const providers = Object.fromEntries(
    [...new Set(stale.flatMap((pin) => pin.providerIds))].map((id) => [id, {
      id,
      name: byId[id]?.name || id,
      available: catalogOfferings(byId[id]),
    }]),
  );
  return { pins: stale, providers, incomplete: errors > 0 };
}

/**
 * Clear ONE pin back to "inherit", by the `id` the audit reported.
 *
 * Id-addressed rather than "clear everything stale": the user approves each
 * pin's removal, and an audit read between their click and this write must not
 * widen what they approved. An id naming a pin no longer stored resolves to
 * `{ cleared: false }` rather than throwing.
 *
 * The retired-pin notification card is retracted either way: a card naming a pin
 * that is no longer stored is a loop the user cannot close. Retraction must never
 * fail the clear the user asked for.
 *
 * @param {string} pinId
 * @returns {Promise<{cleared: boolean, id: string}>}
 */
export async function clearModelPin(pinId) {
  const { pins } = await collectModelPins();
  const pin = pins.find((candidate) => candidate.id === pinId);
  if (pin) await PIN_SOURCES.find((source) => source.kind === pin.kind).clear(pin);
  const { removeByMetadata } = await loadNotificationsModule();
  await removeByMetadata('pinId', pinId).catch((error) => {
    console.error(`❌ Retracting retired-pin notification for ${pinId} failed: ${error.message}`);
  });
  return { cleared: Boolean(pin), id: pinId };
}
