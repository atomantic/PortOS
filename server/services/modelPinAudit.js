/**
 * Retired-model-pin audit (#7315).
 *
 * Collects every stored model pin PortOS does NOT own, asks
 * `lib/modelPinReconcile.js` whether the provider still lists it, and returns
 * the ones that have rotted — so a Settings surface can say "this pin names a
 * model your provider no longer serves" instead of letting a render or a
 * scheduled run die on a raw vendor error months later.
 *
 * **Surface, never auto-rewrite.** A user's pin is a deliberate choice;
 * substituting one would render something different under the chosen model's
 * name (the behavior #7314 explicitly rejected). Clearing a pin back to
 * "inherit" is a one-click action the user takes — `clearModelPin` below — and
 * nothing here writes on its own.
 *
 * **Derived on read, never persisted.** The audit is a pure function of the
 * stores it reads, so there is no record to migrate, seed, keep in sync with a
 * refresh, or keep off the federation layer — and a pin that rotted BEFORE this
 * shipped is reported on the first read rather than waiting for the next
 * retirement. See modelPinReconcile.js for why that beats diffing one refresh
 * against the previous one.
 *
 * **Adding a pin source is one row in `PIN_SOURCES`.** Each row pairs the
 * collector that finds those pins with the writer that clears one, so a source
 * cannot be half-registered — the failure mode when the two halves were
 * separate tables was a Clear button that threw at click time.
 */

import { ANTIGRAVITY_CLI_ID } from '../lib/antigravity.js';
import { CODEX_CLI_ID } from '../lib/codex.js';
import { IMAGE_GEN_MODE } from '../lib/generationModes.js';
import { MODEL_OVERRIDE_CAPABLE_MODES } from '../lib/imageGenCapabilities.js';
import { catalogOfferings, reconcileModelPins } from '../lib/modelPinReconcile.js';
import { MODEL_SELECTABLE_REVIEWERS, normalizeReviewerModel } from '../lib/reviewerConfig.js';
import { reviewerProviderIds } from '../lib/reviewerProviderMatchers.js';
import { normalizeRenderPinValue, RENDER_TARGETS } from '../lib/renderTargets.js';
import { getSettings, updateSettingsWith } from './settings.js';

/**
 * The pin STORES are reached through deferred imports, not top-level ones.
 *
 * This module is imported eagerly by `routes/providers.js`, and `apps.js` /
 * `taskSchedule.js` / `providers.js` each drag a heavy subtree behind them —
 * enough to push the server suite past its static-instantiation budget
 * (`lib/importScoping.test.js`, and the "Import scoping" section of
 * server/AGENTS.md). The audit is a user-triggered read, so paying for those
 * trees at call time costs nothing anybody is waiting on.
 *
 * Each loader memoizes the PROMISE rather than the resolved module: two
 * collectors reach for `taskSchedule.js` inside the same `Promise.all`, and
 * concurrent `import()` calls of a mocked module can let one caller escape the
 * mock unless they share a single in-flight promise.
 */
let appsModule = null;
let notificationsModule = null;
let providersModule = null;
let taskScheduleModule = null;
let recordPinsModule = null;
let taskTemplatesModule = null;
const loadAppsModule = () => (appsModule ||= import('./apps.js'));
const loadNotificationsModule = () => (notificationsModule ||= import('./notifications.js'));
const loadProvidersModule = () => (providersModule ||= import('./providers.js'));
const loadTaskScheduleModule = () => (taskScheduleModule ||= import('./taskSchedule.js'));
const loadRecordPinsModule = () => (recordPinsModule ||= import('./modelPinRecords.js'));
const loadTaskTemplatesModule = () => (taskTemplatesModule ||= import('./taskTemplates.js'));

/**
 * Which provider record serves each cloud image-gen mode that can carry a pin.
 *
 * The mode SET is derived from `MODEL_OVERRIDE_CAPABLE_MODES` rather than
 * hand-listed, so a third override-capable backend cannot land a capability
 * entry and then be silently un-audited — the guard in this module's suite
 * fails when a mode gains `supportsModelOverride` with no row here. Grok is
 * absent on its own merits: its image backend is fixed, so there is no pin.
 *
 * The mode -> provider-record-id fact itself has no registry today
 * (`CLOUD_PROVIDER_SPECS` carries label/params but no provider id, and
 * imageGen/agy.js hardcodes its own), so it lives here as one map of the two
 * fields rather than two maps over the same keys.
 */
const PINNED_IMAGE_MODES = Object.freeze({
  [IMAGE_GEN_MODE.AGY]: { providerId: ANTIGRAVITY_CLI_ID, label: 'Agy CLI' },
  [IMAGE_GEN_MODE.CODEX]: { providerId: CODEX_CLI_ID, label: 'Codex CLI' },
});

/**
 * The provider record that serves `mode`, or null when `mode` names no pinnable
 * cloud backend.
 *
 * Every collector reading a `imageMode`/`imageModel` PAIR goes through this,
 * and `local` answering null is the point: the same model field holds a LOCAL
 * DIFFUSION CHECKPOINT id when the surface renders locally, and that is not a
 * CLI catalog entry to reconcile against. Judging one would report a working
 * local pin as retired and offer a button to delete it.
 */
const pinnedModeProviderId = (mode) => (typeof mode === 'string' && PINNED_IMAGE_MODES[mode]?.providerId) || null;

/** Exported for the coverage guard above — not a runtime dependency. */
export const PINNED_IMAGE_MODE_IDS = Object.freeze(Object.keys(PINNED_IMAGE_MODES));
export { MODEL_OVERRIDE_CAPABLE_MODES };

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * One pin descriptor, or nothing when either half of the pair is missing.
 *
 * A pin with no model is not a pin, and a pin whose provider cannot be named is
 * not judgeable — `reconcileModelPins` would have to guess which catalog to
 * compare it against, and a wrong guess is a false retirement. Returns an array
 * so every collector can stay a single `flatMap`.
 */
const pinIf = ({ model, providerId, providerIds, ...rest }) => {
  const id = trimmed(model);
  // A reviewer pin names a BINARY that several records front, so it hands in a
  // LIST (#7339); every other source names exactly one record. Both normalize to
  // the same descriptor — `providerIds` is what the membership rule judges, and
  // `providerId` (the preferred record) is what the panel names the pin by.
  const resolved = (providerIds ? [...providerIds] : [providerId]).map(trimmed).filter(Boolean);
  return id && resolved.length ? [{ ...rest, model: id, providerId: resolved[0], providerIds: resolved }] : [];
};

/** `settings.imageGen.<mode>.model` — the install-wide Image Gen pins. */
function collectImageGenPins({ settings }) {
  return Object.entries(PINNED_IMAGE_MODES).flatMap(([mode, { providerId, label }]) => pinIf({
    id: `settings:imageGen.${mode}.model`,
    mode,
    providerId,
    model: settings?.imageGen?.[mode]?.model,
    label: `${label} image model`,
    location: 'Settings → Media Gen → Image Gen',
    href: '/media/image?settings=1',
  }));
}

/**
 * `settings.renderDefaults.<target>.imageModel` — the per-surface pins.
 *
 * Gated on the entry's own `imageMode`: the same field holds a local diffusion
 * checkpoint id when the surface renders locally, and that is not a CLI catalog
 * entry to reconcile against. An entry pinning a model with no mode inherits
 * the install default, whose provider we cannot name from here — left alone
 * rather than guessed at.
 */
function collectRenderDefaultPins({ settings }) {
  return RENDER_TARGETS.flatMap((target) => {
    const entry = settings?.renderDefaults?.[target];
    const mode = normalizeRenderPinValue(entry?.imageMode);
    return pinIf({
      id: `settings:renderDefaults.${target}.imageModel`,
      target,
      providerId: pinnedModeProviderId(mode),
      model: normalizeRenderPinValue(entry?.imageModel),
      label: `${target} render model`,
      location: 'Settings → Media Gen → Render Defaults',
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
 * Per-app task-type override pins, which OUTRANK the global pin at spawn
 * (#4783). An override that pins a model but no provider runs on whatever the
 * global task pin names, so that is the catalog to judge it against; with
 * neither, the provider is the install's active one and unknowable from here,
 * so the pin is left alone.
 *
 * Reads `taskTypeOverrides` straight off the records `getActiveApps()` already
 * returned rather than calling `getAppTaskTypeOverrides(app.id)` per app. That
 * accessor re-loads the whole apps store TWICE per call and can `atomicWrite`
 * it (its legacy-format migration) — a write in a path this module advertises
 * as derived-on-read. Skipping the migration cannot change the answer: the
 * legacy `disabledTaskTypes` field migrates to `{ enabled: false }` entries
 * that carry no model, so they can never yield a pin.
 */
async function collectAppOverridePins({ schedule }) {
  const { getActiveApps } = await loadAppsModule();
  const apps = await getActiveApps().catch(() => []);
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
 * `settings.codeReview.<reviewer>Model` and `settings.codeReview.goalFidelity.model`
 * — the Code Review Defaults pins (#7339).
 *
 * These rot exactly like every other pin, with a worse failure: the user pins
 * `codexModel: 'gpt-4o'`, the vendor retires it, and nobody learns until a
 * review loop spawns `codex --model gpt-4o` and dies on a vendor error — inside
 * an unattended run, with the reviewer's verdict silently missing.
 *
 * **A reviewer is judged against SEVERAL provider records, not one.** The slug
 * names a BINARY, and PortOS ships more than one record per binary — `claude`
 * spans `claude-code` and `claude-code-tui`, `grok` spans `grok-cli` and its
 * TUI. The picker already unions their catalogs for exactly this reason
 * (sourcing from one record made it hostage to that record's staleness), so
 * judging a pin against a single record would report a model the OTHER record
 * still lists as retired. `reviewerProviderIds` resolves the whole set from the
 * shared matcher table the picker uses, and `reconcileModelPins` flags the pin
 * only when EVERY one of them fails to list it.
 *
 * A reviewer no record matches yields no ids, so `pinIf` drops the pin rather
 * than guessing — the same posture as an app override with no resolvable
 * provider. The `lmstudio`/`ollama`/`mtplx` reviewers DO match a record, whose
 * local-daemon carve-out in `modelPinMembership.js` passes any id through: the
 * daemon on this machine is the authority, not the record's cached snapshot.
 *
 * `goalFidelity` rides the same collector because it is the same kind of pin on
 * the same settings object — its `backend` names the record to judge against.
 * Today that backend is restricted to the local-LLM set, so it is silent by
 * construction; the row costs one settings read that already happened and keeps
 * the pin vocabulary complete if that restriction ever widens.
 */
function collectReviewerModelPins({ settings, providers }) {
  const codeReview = settings?.codeReview;
  const scalarPins = MODEL_SELECTABLE_REVIEWERS.flatMap((reviewer) => pinIf({
    id: `codeReview:${reviewer}Model`,
    reviewer,
    // Re-checked rather than trusted: settings.json is hand-editable, and a
    // value the token builders would silently drop is not a pin the user has.
    model: normalizeReviewerModel(codeReview?.[`${reviewer}Model`], reviewer),
    providerIds: reviewerProviderIds(reviewer, providers),
    label: `${reviewer} reviewer model`,
    location: 'Code Review Defaults',
    href: '/models/code-reviewers',
  }));
  const backend = trimmed(codeReview?.goalFidelity?.backend);
  return [...scalarPins, ...pinIf({
    id: 'codeReview:goalFidelity.model',
    model: normalizeReviewerModel(codeReview?.goalFidelity?.model, backend),
    providerIds: reviewerProviderIds(backend, providers),
    label: 'goal-fidelity review model',
    location: 'Code Review Defaults → Goal fidelity',
    href: '/models/code-reviewers',
  })];
}

/**
 * The `provider` + `model` pair a user-saved CoS task template pins.
 *
 * A template is a durable "run it this way" the user saved once and picks from
 * a menu for months, so its pin is among the likeliest to outlive the model it
 * names — and unlike a scheduled task it fails at the moment the user is
 * standing there launching work, with a vendor error for a model they picked so
 * long ago they no longer remember it.
 *
 * `provider` is a provider RECORD id (the Quick Templates menu seeds it from
 * `/api/providers`, and `applyTemplate` looks the record up by it), so one id —
 * no reviewer-style union. A template pinning a model but no provider would run
 * on whatever the form resolves at launch, which is not knowable here; `pinIf`
 * drops it rather than guessing. Built-ins carry neither field, so they can
 * never yield a pin.
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
 * The pin sources, in the order the panel reads them (install-wide first).
 *
 * ONE table, not a collector list beside a clearer map: the read half and the
 * write half of a pin source belong together, and keying them separately meant
 * a kind registered in one and missed in the other failed only when a user
 * clicked Clear. Adding a pin source is one row.
 *
 * Each `clear` touches the MODEL only — never the sibling mode/provider/enabled
 * fields, which are separate choices the user did not ask to undo.
 */
const PIN_SOURCES = Object.freeze([
  {
    kind: 'imageGen',
    collect: collectImageGenPins,
    clear: (pin) => updateSettingsWith((current) => ({
      ...current,
      imageGen: {
        ...(current.imageGen || {}),
        [pin.mode]: withoutKey(current.imageGen?.[pin.mode], 'model'),
      },
    })),
  },
  {
    kind: 'renderDefault',
    collect: collectRenderDefaultPins,
    clear: (pin) => updateSettingsWith((current) => ({
      ...current,
      renderDefaults: {
        ...(current.renderDefaults || {}),
        [pin.target]: withoutKey(current.renderDefaults?.[pin.target], 'imageModel'),
      },
    })),
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
  // Reviewer model pins (#7339). Install-wide, so above the per-record row, and
  // after the task/app rows because a reviewer pin only ever breaks the REVIEW
  // half of a run — a broken task pin breaks the run itself.
  {
    kind: 'reviewerModel',
    collect: collectReviewerModelPins,
    // The reviewer's own scalar ONLY — never the sibling `<reviewer>Effort`, the
    // `reviewers` list, or `goalFidelity`'s `backend`/`effort`. Each of those is
    // a separate choice the user did not ask to undo, and dropping a reviewer
    // out of the chain because its MODEL rotted would silently weaken the loop.
    clear: (pin) => updateSettingsWith((current) => ({
      ...current,
      codeReview: pin.reviewer
        ? withoutKey(current.codeReview, `${pin.reviewer}Model`)
        : {
          ...(current.codeReview || {}),
          goalFidelity: withoutKey(current.codeReview?.goalFidelity, 'model'),
        },
    })),
  },
  // User-saved CoS task-template pins (#7339).
  {
    kind: 'taskTemplate',
    collect: collectTaskTemplatePins,
    // `''` rather than a deleted key: that is this store's OWN encoding for an
    // unpinned template (`createTemplate` writes `model: ''`), and
    // `updateTemplate` merges rather than replaces, so an absent key would leave
    // the stale id in place. `provider` and `effort` are untouched.
    clear: async (pin) => {
      const { updateTemplate } = await loadTaskTemplatesModule();
      return updateTemplate(pin.templateId, { model: '' });
    },
  },
  // Per-record `imageModelId` pins (#7326) — universes, series, sprite records,
  // decks and music-video projects. ONE row rather than five: they share a
  // storage shape, so `modelPinRecords.js` handles them with one query per
  // family and dispatches the clear on `pin.family`. Last in the table because
  // the panel reads install-wide pins first — a setting that mis-points every
  // surface should be the row the user sees above one record's own choice.
  //
  // The record module finds the stored pairs and stops there; `pinnedModeProviderId`
  // is applied HERE, exactly as `collectRenderDefaultPins` applies it, so the
  // "a `local` pin names a diffusion checkpoint, not a CLI model" gate has one
  // definition. It also keeps the mode map out of a module this one reaches
  // through a deferred import — importing it back would close a cycle, and a
  // shared leaf would put another file in the static closure of every suite
  // that reaches `routes/providers.js`.
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
 * Reads each backing store ONCE and hands every collector the same context.
 * Two collectors need the task schedule, and `loadSchedule` is neither memoized
 * nor TTL-cached — it re-parses and re-normalizes the whole file every call,
 * and two concurrent calls that both see `needsSave` each queue their own
 * rewrite of it.
 *
 * A collector that throws must not take the whole audit down with it: one
 * unreadable store is a missing section, not a failed page.
 *
 * @param {Promise<Array<object>>|Array<object>} providerListPromise the caller's
 *   in-flight provider catalog read, shared rather than re-issued.
 * @returns {Promise<Array<object>>}
 */
async function collectModelPins(providerListPromise) {
  const { loadSchedule } = await loadTaskScheduleModule();
  const [settings, schedule, providers] = await Promise.all([
    getSettings().catch(() => ({})),
    loadSchedule().catch(() => null),
    // The reviewer collector classifies provider RECORDS, so it needs the same
    // catalog the reconciliation does. It takes the caller's in-flight promise
    // rather than a second `listProviders()`: awaiting it here keeps the two
    // reads independent for every other collector, while making one store read
    // serve both halves.
    Promise.resolve(providerListPromise).catch(() => []),
  ]);
  const context = { settings, schedule, providers };
  const collected = await Promise.all(PIN_SOURCES.map(async ({ kind, collect }) => {
    const pins = await Promise.resolve(collect(context)).catch((error) => {
      console.error(`❌ Model pin collector ${kind} failed: ${error.message}`);
      return [];
    });
    return pins.map((pin) => ({ ...pin, kind }));
  }));
  return collected.flat();
}

/**
 * The stale pins, plus the catalog each one's provider now offers.
 *
 * `providers` is keyed by provider id and carries only the records a stale pin
 * actually names — every id in its `providerIds`, so a reviewer pin ships the
 * catalog of each record fronting its binary and the panel can union them. A
 * 200-model Ollama catalog is still not shipped to a page with no Ollama pin.
 *
 * @returns {Promise<{pins: Array<object>, providers: Record<string, object>}>}
 */
export async function auditModelPins() {
  const { listProviders } = await loadProvidersModule();
  // The pin stores and the provider catalog are independent reads. The catalog
  // promise is handed to the collectors as well — a reviewer pin needs it to
  // resolve WHICH records front its binary — so both halves share one read
  // without either waiting on the other.
  const providerListPromise = listProviders();
  const [providerList, pins] = await Promise.all([providerListPromise, collectModelPins(providerListPromise)]);
  const byId = Object.fromEntries(providerList.map((provider) => [provider.id, provider]));
  const stale = reconcileModelPins(pins, byId);
  const providers = Object.fromEntries(
    [...new Set(stale.flatMap((pin) => pin.providerIds))].map((id) => [id, {
      id,
      name: byId[id]?.name || id,
      available: catalogOfferings(byId[id]),
    }]),
  );
  return { pins: stale, providers };
}

/**
 * One parent object with `key` REMOVED — "back to inherit" is the absence of
 * the field, not a blank string sitting where a model id used to be. `''` would
 * also read as no-pin at every resolver, but it survives a settings round-trip
 * and shows up in the file as a value the user never typed.
 */
const withoutKey = (parent, key) => {
  const next = { ...(parent || {}) };
  delete next[key];
  return next;
};

/**
 * Clear ONE pin back to "inherit", by the `id` the audit reported.
 *
 * Deliberately id-addressed rather than "clear everything stale": the user is
 * approving each pin's removal, and an audit read between their click and this
 * write must not widen what they approved. An id naming a pin that is no longer
 * stored resolves to `{ cleared: false }` rather than throwing — the pin is
 * already gone, which is the outcome the caller wanted.
 *
 * The retired-pin notification card (#7332) is retracted either way: a card
 * naming a pin that is no longer stored is a loop the user cannot close, and
 * `cleared: false` means the pin is already gone, not that the card is still
 * earned. Retraction must never fail the clear the user actually asked for.
 *
 * @param {string} pinId
 * @returns {Promise<{cleared: boolean, id: string}>}
 */
export async function clearModelPin(pinId) {
  // The SAME catalog read the audit makes, for the same reason: a reviewer pin
  // resolves its provider records from it, and a collection that skipped it
  // would silently drop every reviewer pin from the write-target allowlist —
  // turning the Clear button on a reported pin into a no-op `cleared: false`.
  const { listProviders } = await loadProvidersModule();
  const pins = await collectModelPins(listProviders());
  const pin = pins.find((candidate) => candidate.id === pinId);
  if (pin) await PIN_SOURCES.find((source) => source.kind === pin.kind).clear(pin);
  const { removeByMetadata } = await loadNotificationsModule();
  await removeByMetadata('pinId', pinId).catch((error) => {
    console.error(`❌ Retracting retired-pin notification for ${pinId} failed: ${error.message}`);
  });
  return { cleared: Boolean(pin), id: pinId };
}
