/**
 * Per-record retired-model-pin source (#7326).
 *
 * Collect + clear half of ONE `PIN_SOURCES` row (`kind: 'record'`): every family
 * stores the flat `imageMode` / `imageModelId` pair in a JSONB document column
 * beside a soft-delete flag, so they differ only in the facts
 * `RECORD_PIN_FAMILIES` names. Adding a family is one row there.
 *
 * Rules:
 *  1. **Report the record's own `imageMode` beside its model, unjudged.**
 *     `modelPinAudit.js` resolves it through `pinnedModeProviderId`; a mode that
 *     names no cloud backend drops the pin there. That keeps a LOCAL diffusion
 *     checkpoint id out of the audit, where reconciling it against a CLI catalog
 *     would report a working pin as retired.
 *  2. **Never read a whole record table.** Project four scalars and filter on
 *     `imageModelId IS NOT NULL` in the database.
 *  3. **Clearing writes the MODEL field only.** Each family's update function
 *     applies the key-present-with-null clear and leaves `imageMode` alone.
 *
 * Pipeline issues (`pipeline/issuesShared.js` clears the field outside `local`)
 * and creative commissions (`commissionForm.js` surfaces it only under `local`)
 * persist an `imageModelId` but are absent: the mode gate would filter both out.
 *
 * Reached from `modelPinAudit.js` through a DEFERRED import: the clear half loads
 * record services whose heavy subtrees the audit must not pay for at import.
 */

import { isTestDatabase, query } from '../lib/db.js';
import { recordRenderPin } from '../lib/renderTargets.js';
import { isTestRunner } from '../lib/runtimeEnv.js';

/**
 * One row per record family carrying the #3231 Phase 3 render pin.
 *
 * `nameSql` differs because some families mirror `name` as a column and some keep
 * it in the document; `json` because decks name their document column
 * `definition`. `clear` imports its service lazily per family so clearing a deck
 * pin does not load the universe builder's closure.
 */
export const RECORD_PIN_FAMILIES = Object.freeze([
  {
    family: 'universe',
    table: 'universes',
    json: 'data',
    nameSql: 'name',
    noun: 'universe',
    location: 'Universes → Render',
    href: (id) => `/universes/${encodeURIComponent(id)}?tab=render`,
    clear: async (recordId) => {
      const { updateUniverse } = await import('./universeBuilder/crud.js');
      return updateUniverse(recordId, { imageModelId: null });
    },
  },
  {
    family: 'series',
    table: 'pipeline_series',
    json: 'data',
    nameSql: 'name',
    noun: 'series',
    location: 'Series Pipeline → Series settings',
    href: (id) => `/pipeline/series/${encodeURIComponent(id)}`,
    clear: async (recordId) => {
      const { updateSeries } = await import('./pipeline/series.js');
      return updateSeries(recordId, { imageModelId: null });
    },
  },
  {
    family: 'sprite',
    table: 'sprite_records',
    json: 'data',
    nameSql: "data ->> 'name'",
    noun: 'sprite record',
    location: 'Sprites → Reference',
    href: (id) => `/sprites/${encodeURIComponent(id)}`,
    clear: async (recordId) => {
      const { updateRecord } = await import('./sprites/records.js');
      return updateRecord(recordId, { imageModelId: null });
    },
  },
  {
    family: 'deck',
    table: 'decks',
    json: 'definition',
    nameSql: 'name',
    noun: 'deck',
    location: 'Decks → Render',
    href: (id) => `/decks/${encodeURIComponent(id)}`,
    clear: async (recordId) => {
      const { updateDeck } = await import('./decks.js');
      return updateDeck(recordId, { imageModelId: null });
    },
  },
  {
    family: 'musicVideo',
    table: 'music_video_projects',
    json: 'data',
    nameSql: "data ->> 'name'",
    noun: 'music video',
    location: 'Music Video → Project toolbar',
    href: (id) => `/music-video/${encodeURIComponent(id)}`,
    clear: async (recordId) => {
      const { updateProject } = await import('./musicVideo/projects.js');
      return updateProject(recordId, { imageModelId: null });
    },
  },
]);

/**
 * The pinned-rows query for one family.
 *
 * `id::text` because decks key on UUID and every other family on TEXT; the pin
 * id is a string either way and a pg UUID object would not match it back.
 *
 * `->>` yields SQL NULL for both an absent key and a JSON null, so `IS NOT NULL`
 * returns only rows that carry a pin (rule 2). No index serves it.
 *
 * @param {{table: string, json: string, nameSql: string}} family
 * @returns {string}
 */
export function pinnedRowsSql({ table, json, nameSql }) {
  return `SELECT id::text AS id,
          ${nameSql} AS name,
          ${json} ->> 'imageMode' AS image_mode,
          ${json} ->> 'imageModelId' AS image_model_id
     FROM ${table}
    WHERE ${json} ->> 'imageModelId' IS NOT NULL
      AND deleted = FALSE`;
}

/**
 * One pin descriptor from a queried row, or null when the row carries no pin.
 *
 * Normalizes through `recordRenderPin`, the ONE rule for what counts as a stored
 * pin (trim, `'auto'` and blanks collapse to null, model id capped).
 *
 * @param {{family: object, row: object}} args
 * @returns {object|null}
 */
function recordPinDescriptor({ family, row }) {
  const pin = recordRenderPin({ imageMode: row?.image_mode, imageModelId: row?.image_model_id });
  const recordId = typeof row?.id === 'string' ? row.id : '';
  if (!pin.modelId || !recordId) return null;
  const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : recordId;
  return {
    id: `record:${family.family}:${recordId}`,
    family: family.family,
    recordId,
    mode: pin.mode,
    model: pin.modelId,
    label: `${name} · ${family.noun} render model`,
    location: family.location,
    href: family.href(recordId),
  };
}

/**
 * May this process scan the record tables?
 *
 * The same condition `checkHealth` refuses to connect under: the test runner
 * pointed at a non-`*_test` database. Reads pass `assertWriteAllowed`, so
 * without this the server suite would query the live `portos` DB. Reuses the two
 * exported predicates so it cannot drift from `lib/db.js`.
 */
const scanAllowed = () => !isTestRunner() || isTestDatabase();

/**
 * Every per-record pin across the families above, in `RECORD_PIN_FAMILIES`
 * order so the panel's rows stay stable between reads.
 *
 * One family's query failing must not take the others down (`modelPinAudit`
 * catches at the SOURCE level, which would drop all five together).
 *
 * @returns {Promise<Array<object>>}
 */
export async function collectRecordPins() {
  if (!scanAllowed()) return [];
  const perFamily = await Promise.all(RECORD_PIN_FAMILIES.map(async (family) => {
    const result = await query(pinnedRowsSql(family)).catch((error) => {
      console.error(`❌ Record model-pin scan of ${family.table} failed: ${error.message}`);
      return null;
    });
    return (result?.rows || [])
      .map((row) => recordPinDescriptor({ family, row }))
      .filter(Boolean);
  }));
  return perFamily.flat();
}

/**
 * Clear ONE per-record pin back to "inherit".
 *
 * Goes through the family's own update function, not an UPDATE on the JSONB
 * column, so the record's sanitizer, LWW clock and peer-sync fan-out still run.
 *
 * @param {{family?: string, recordId?: string}} pin
 * @returns {Promise<unknown>}
 */
export async function clearRecordPin(pin) {
  const family = RECORD_PIN_FAMILIES.find((entry) => entry.family === pin?.family);
  if (!family) throw new Error(`Unknown record pin family: ${pin?.family}`);
  return family.clear(pin.recordId);
}
