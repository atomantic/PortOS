/**
 * App port-config orchestration.
 *
 * Port fields in apps.json are *derived* from ecosystem.config.cjs (the source
 * of truth PM2 reads). This module diffs a submitted port update against the
 * ACTUAL config literals and persists the change back to the ecosystem config
 * (value-keyed remap for distinct ports; per-process/label targeted rewrite for
 * shared-value ports) in ONE atomic write. Extracted verbatim from the
 * `PUT /api/apps/:id` route so the route handler stays HTTP-thin — the caller
 * still owns the precondition guard (`usesPm2` + path exists) and the HTTP
 * error/response mapping.
 *
 * Returns `{ persistFailed, uiPortOverride, changedKeys }`:
 *   - persistFailed  — true when the user changed a port we could NOT write to
 *                      the source-of-truth config (caller should reject 422).
 *   - uiPortOverride — the derived uiPort to pin for served-by-API apps
 *                      (undefined when the app's ui port is a real literal).
 *   - changedKeys    — port keys that differed from the config (for context).
 */

import { parseEcosystemFromPath, writeEcosystemPortEdits } from './streamingDetect.js';
import { deriveUiPort } from '../routes/apps/shared.js';

const PORT_KEYS = ['apiPort', 'uiPort', 'devUiPort'];
const LABEL_BY_KEY = { apiPort: 'api', uiPort: 'ui', devUiPort: 'devUi' };

/**
 * Persist submitted port edits for `existing` to its ecosystem config.
 * @param {object} existing  the current app record (must have repoPath)
 * @param {object} data      the validated PUT body (mutated? no — read-only here)
 */
export async function applyEcosystemPortEdits(existing, data) {
  // Diff the submitted ports against the ACTUAL config values (not apps.json,
  // whose top-level fields may be stale or absent for derived ports). This is
  // the single source of truth for both "did it change" and "what's the old
  // literal to rewrite": EditAppModal submits every field even on a rename, so
  // a value equal to the config's current port is a no-op echo, and a value
  // that differs is a genuine edit to persist.
  const { processes: cfgProcs } = await parseEcosystemFromPath(existing.repoPath);
  const currentPort = {};
  const procNameByKey = {}; // which process block owns each label (for targeted rewrites)
  for (const proc of cfgProcs || []) {
    for (const [key, label] of Object.entries(LABEL_BY_KEY)) {
      if (currentPort[key] === undefined && Number.isInteger(proc.ports?.[label])) {
        currentPort[key] = proc.ports[label];
        procNameByKey[key] = proc.name;
      }
    }
  }
  // Count current values so a value-keyed rewrite never fires on a number shared
  // by another port field (e.g. uiPort derived from apiPort, both 6000) — that
  // would rewrite every occurrence and clobber the field the user didn't touch.
  // Such a value can't be split by value alone; it falls through to the
  // per-process-label-targeted rewrite below.
  const valueCounts = new Map();
  for (const key of PORT_KEYS) {
    const v = currentPort[key];
    if (Number.isInteger(v)) valueCounts.set(v, (valueCounts.get(v) || 0) + 1);
  }
  // A port is "changed" when the submitted value differs from the config's
  // current value for that label. A field the config doesn't define has no
  // literal to rewrite, so it isn't treated as a config edit here.
  const changedKeys = PORT_KEYS.filter(key =>
    Number.isInteger(currentPort[key]) && Number.isInteger(data[key]) && data[key] !== currentPort[key]);

  // Served-by-API detection. When an app has an API process plus a Vite dev UI
  // but no literal `ports.ui`, the prod UI is served by the API server, so the
  // `uiPort` is *derived* (= apiPort) and CANNOT be set independently — there's
  // no separate UI port literal in the config to rewrite. The edit drawer always
  // submits every port field and never syncs the UI field to a changed API
  // field, so an API-only edit arrives as `{ apiPort: <new>, uiPort: <old
  // derived> }`. We can't distinguish that stale echo from a deliberate
  // (impossible) independent UI change, so the only coherent behavior is to
  // IGNORE the submitted uiPort entirely and pin the stored value to the derived
  // port (= the post-edit API port). That tracks the API port on every save,
  // never reverts, and never spuriously 422s the common API-edit path. The user
  // changes this UI port by changing the API port.
  const effectiveApiPort = Number.isInteger(data.apiPort) ? data.apiPort : currentPort.apiPort;
  const derivedUiPort = deriveUiPort(undefined, effectiveApiPort, currentPort.devUiPort);
  const uiIsDerived = currentPort.uiPort === undefined && Number.isInteger(derivedUiPort);
  const remap = [];
  const targetedEdits = []; // shared-value keys: rewritten by process + label
  for (const key of changedKeys) {
    const oldPort = currentPort[key]; // guaranteed integer by the filter above
    // Value shared with another field (can't disambiguate by value): target the
    // specific process block + label so the edit lands on exactly the port the
    // user touched, not every occurrence of the shared literal.
    if (valueCounts.get(oldPort) > 1 && procNameByKey[key]) {
      targetedEdits.push({ processName: procNameByKey[key], label: LABEL_BY_KEY[key], oldPort, newPort: data[key] });
      continue;
    }
    remap.push([oldPort, data[key]]);
  }

  // Persist the value-keyed remap (distinct ports) and the targeted edits
  // (shared-value ports) in ONE atomic write. Doing them as two separate writes
  // would let the value-keyed pass land on disk before a later unpersistable
  // targeted edit forces the reject below — leaving config partially changed for
  // a rejected request. writeEcosystemPortEdits computes both rewrites in memory
  // and writes only when nothing is unpersistable.
  const result = changedKeys.length > 0
    ? await writeEcosystemPortEdits(existing.repoPath, remap, targetedEdits)
    : { changed: false, remapApplied: false, applied: [], unapplied: [] };
  if (result.changed) {
    const remapMsg = result.remapApplied ? remap.map(([o, n]) => `${o}→${n}`).join(', ') : '';
    const tgtMsg = targetedEdits.map(e => `${e.label} ${e.oldPort}→${e.newPort}`).join(', ');
    console.log(`🔧 Updated ${result.file} ports for ${existing.name}: ${[remapMsg, tgtMsg].filter(Boolean).join(', ')} (restart the app to apply)`);
  }

  // Honesty gate: if the user changed a port we could NOT write to the
  // source-of-truth config, signal a reject rather than persist a registry value
  // PM2 will contradict (and the next refresh will revert). `remap.length &&
  // !remapApplied` catches value-keyed pairs whose literal wasn't found;
  // `unapplied` catches process/label edits that didn't match. On any
  // unpersistable targeted edit the writer persists nothing, so this leaves the
  // config untouched.
  const valueKeyedFailed = remap.length > 0 && !result.remapApplied;
  const targetedFailed = (result.unapplied || []).length > 0;
  const persistFailed = changedKeys.length > 0 && (valueKeyedFailed || targetedFailed);

  return {
    persistFailed,
    uiPortOverride: uiIsDerived ? derivedUiPort : undefined,
    changedKeys,
  };
}
