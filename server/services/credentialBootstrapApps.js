import { bootstrapInputFor } from '../lib/providerPresets.js';
import { credentialBootstrapsSettingsSchema } from '../lib/validation.js';
import { isPlainObject } from '../lib/objects.js';
import { getSettings, updateSettingsWith } from './settings.js';

/**
 * Credential-bootstrap APPS (#7564): the wrapper CLIs a composite id's
 * `+<bootstrap-slug>` suffix names, kept in `settings.credentialBootstraps`
 * beside the harness enablement slice (no new file, no table).
 *
 * An app is `{ label, command, args?, argsSeparator?, setupCommand?,
 * harnessNames? }` — the same fields a record's inline `credentialBootstrap`
 * carries, plus the label and the per-harness name map, because one wrapper
 * fronts many harnesses and knows each by its own name (`claude` → `claude-code`).
 * `materializeRoute` turns an app into the inline object `composeBootstrapSpawn`
 * reads at spawn: `<command> <args...> <harnessName> [<separator>] <harness args>`.
 *
 * Saving never spawns anything: `setupCommand` is advisory text the UI shows,
 * and the wrapper itself runs only when a composite naming it is executed.
 */

/** Every app, keyed by slug. Malformed entries are dropped on read, never thrown on. */
export async function listCredentialBootstraps() {
  const raw = (await getSettings()).credentialBootstraps;
  return normalizeCredentialBootstraps(raw);
}

/**
 * Replace the whole table. Validated against the settings-slice schema so a
 * bad entry 400s here instead of surfacing as a spawn that cannot start.
 */
export async function saveCredentialBootstraps(apps) {
  const parsed = credentialBootstrapsSettingsSchema.parse(apps ?? {});
  await updateSettingsWith((current) => {
    const next = { ...current };
    if (Object.keys(parsed).length === 0) delete next.credentialBootstraps;
    else next.credentialBootstraps = parsed;
    return next;
  });
  return parsed;
}

/**
 * The stored slice with every entry the schema rejects dropped — a hand-edited
 * settings.json must not make every composite lookup throw.
 */
export function normalizeCredentialBootstraps(raw) {
  if (!isPlainObject(raw)) return {};
  return Object.fromEntries(Object.entries(raw).flatMap(([slug, app]) => {
    const result = credentialBootstrapsSettingsSchema.safeParse({ [slug]: app });
    return result.success ? [[slug, result.data[slug]]] : [];
  }));
}

// The bootstrap input `materializeRoute` takes for an app is a pure shape the
// preset library also needs (#7565); it lives there and is re-exported here.
export { bootstrapInputFor };

/** The catalog's sanitized view of the table: never a command line, only what a picker names. */
export const presentCredentialBootstraps = (apps) => Object.entries(apps).map(([slug, app]) => ({
  slug,
  label: app.label,
  harnessNames: { ...(app.harnessNames || {}) },
}));
