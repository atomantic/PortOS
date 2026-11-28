/**
 * App port-config orchestration.
 *
 * Port fields in apps.json are *derived* from ecosystem.config.cjs (the source
 * of truth PM2 reads). This module diffs a submitted port update against the
 * ACTUAL config literals and persists the change back to the ecosystem config
 * (per-process/label source-span edits) in one atomic write. The caller
 * still owns the precondition guard (`usesPm2` + path exists) and the HTTP
 * error/response mapping.
 *
 * Returns `{ persistFailed, uiPortOverride, changedKeys, portCollision }`:
 *   - persistFailed  — true when the user changed a port we could NOT write to
 *                      the source-of-truth config (caller should reject 422).
 *   - uiPortOverride — the derived uiPort to pin for served-by-API apps
 *                      (undefined when the app's ui port is a real literal).
 *   - changedKeys    — port keys that differed from the config (for context).
 *   - portCollision  — set when an edit would hand one process a port ANOTHER
 *                      process in the same config already holds (caller rejects
 *                      422); nothing is written in that case.
 */

import { parseEcosystemFromPath, writeEcosystemPortEdits } from './streamingDetect.js';
import { attributeProcessPorts, deriveUiPort, findCrossProcessPortCollision } from '../lib/ecosystemProcessPorts.js';

const PORT_KEYS = ['apiPort', 'uiPort', 'devUiPort'];
const LABEL_BY_KEY = { apiPort: 'api', uiPort: 'ui', devUiPort: 'devUi' };

/**
 * Persist submitted port edits for `existing` to its ecosystem config.
 * @param {object} existing  the current app record (must have repoPath)
 * @param {object} data      the validated PUT body (mutated? no — read-only here)
 */
export async function applyEcosystemPortEdits(existing, data) {
  // Diff against the ACTUAL config values (apps.json fields may be stale). The
  // edit modal submits every field even on a rename, so a value equal to the
  // config's port is a no-op echo and a differing one is a genuine edit.
  const { processes: cfgProcs, portsEditable } = await parseEcosystemFromPath(existing.repoPath);
  if (portsEditable === false) {
    const changedKeys = PORT_KEYS.filter(key => Number.isInteger(data[key]) && data[key] !== existing[key]);
    return { persistFailed: changedKeys.length > 0, changedKeys, portCollision: null };
  }
  // Attribute each label to the process belonging to THIS app, not the first
  // declarer (#7357): a sibling daemon's `ports.ui` is not the app's UI port. An
  // unattributable label stays undefined so the served-by-API derivation below
  // takes over.
  const { ports: attributedPorts, processNames: procNameByLabel } = attributeProcessPorts(cfgProcs, existing);
  const currentPort = {};
  const procNameByKey = {}; // which process block owns each label (for targeted rewrites)
  for (const [key, label] of Object.entries(LABEL_BY_KEY)) {
    currentPort[key] = attributedPorts[label];
    procNameByKey[key] = procNameByLabel[label];
  }
  // A field the config doesn't define has no literal to rewrite, so it isn't a config edit.
  const changedKeys = PORT_KEYS.filter(key =>
    Number.isInteger(currentPort[key]) && Number.isInteger(data[key]) && data[key] !== currentPort[key]);

  // Served-by-API detection. With an API process plus a Vite dev UI but no literal
  // `ports.ui`, the prod UI is served by the API, so `uiPort` is *derived*
  // (= apiPort) and cannot be set independently. The drawer submits every field,
  // so an API-only edit arrives as `{ apiPort: <new>, uiPort: <old derived> }`,
  // indistinguishable from an (impossible) independent UI change. So IGNORE the
  // submitted uiPort and pin the stored value to the post-edit API port.
  const effectiveApiPort = Number.isInteger(data.apiPort) ? data.apiPort : currentPort.apiPort;
  const derivedUiPort = deriveUiPort(undefined, effectiveApiPort, currentPort.devUiPort);
  const uiIsDerived = currentPort.uiPort === undefined && Number.isInteger(derivedUiPort);
  // Evaluate collisions against the complete proposed batch before writing.
  const portCollision = findCrossProcessPortCollision(cfgProcs, changedKeys.map(key => ({
    processName: procNameByKey[key],
    label: LABEL_BY_KEY[key],
    newPort: data[key],
  })));
  if (portCollision) {
    return { persistFailed: false, uiPortOverride: uiIsDerived ? derivedUiPort : undefined, changedKeys, portCollision };
  }

  const targetedEdits = changedKeys.map(key => ({
    processName: procNameByKey[key], label: LABEL_BY_KEY[key], oldPort: currentPort[key], newPort: data[key],
  }));
  // Unknown source fields must not become registry-only edits. Permit echoes
  // of recorded values, and the established served-by-API UI derivation.
  const unknownChange = PORT_KEYS.some(key => Number.isInteger(data[key]) &&
    currentPort[key] === undefined && !(key === 'uiPort' && uiIsDerived) && data[key] !== existing[key]);
  if (unknownChange) {
    return { persistFailed: true, changedKeys, portCollision: null };
  }
  const result = changedKeys.length > 0
    ? await writeEcosystemPortEdits(existing.repoPath, targetedEdits)
    : { changed: false, unapplied: [] };
  if (result.changed) {
    console.log(`🔧 Updated ${result.file} ports for ${existing.name}: ${targetedEdits.map(e => `${e.label} ${e.oldPort}→${e.newPort}`).join(', ')} (restart the app to apply)`);
  }
  const persistFailed = changedKeys.length > 0 && (!result.changed || result.unapplied.length > 0);

  return {
    persistFailed,
    uiPortOverride: uiIsDerived ? derivedUiPort : undefined,
    changedKeys,
    portCollision: null,
  };
}
