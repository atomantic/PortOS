/**
 * Per-record retired-model-pin source (#7326).
 *
 * The install-wide pins (`settings.imageGen`, `settings.renderDefaults`, the
 * scheduled-task pins) were covered by #7324. The pins stored ON A RECORD —
 * the flat `imageMode` / `imageModelId` pair #3231 Phase 3 put on universes,
 * series, sprite records, decks and music-video projects — rot exactly the same
 * way and were not: they name a model the vendor retired, and nobody learns
 * until that record's next render dies with a raw vendor error.
 *
 * This module is the collect + clear half of ONE `PIN_SOURCES` row
 * (`kind: 'record'`), not one row per store: every family stores the same
 * normalized pair in the same place (a JSONB document column beside a
 * soft-delete flag), so they differ only in the facts `RECORD_PIN_FAMILIES` names
 * — table, JSON column, how to read a name, where the pin is edited, and how to
 * clear one. Adding a sixth family is one row there.
 *
 * **Three rules this source exists to honor.**
 *
 *  1. **Report the record's own `imageMode` beside its model.** Every descriptor
 *     carries the mode UNJUDGED; `modelPinAudit.js` resolves it through the same
 *     `pinnedModeProviderId` its settings collectors use, and a mode that names
 *     no cloud backend drops the pin there. That is what keeps a LOCAL pin out of
 *     the audit: the same `imageModelId` field holds a local diffusion checkpoint
 *     id when the record renders locally, and reconciling one against a CLI
 *     catalog reports a working pin as retired.
 *  2. **Never read a whole record table.** The audit is derive-on-read, so the
 *     query projects four scalars and filters on `imageModelId IS NOT NULL` in
 *     the database. A pinned record is rare, so what comes back is a handful of
 *     rows — not every universe's JSONB document hydrated through its service.
 *  3. **Clearing writes the MODEL field only.** Each family's own update
 *     function applies the key-present-with-null clear (the absent-vs-empty
 *     convention in root AGENTS.md) and leaves the sibling `imageMode` alone —
 *     the backend choice is a separate decision the user did not ask to undo.
 *
 * Two record families that also persist an `imageModelId` are deliberately
 * ABSENT, because neither can produce an auditable pin: a pipeline issue's
 * gen-config clears the field for every mode but `local`
 * (`pipeline/issuesShared.js`), and a creative commission surfaces it only under
 * a `local` image backend (`commissionForm.js` → `modelModes: ['local']`). The
 * audit's mode gate would filter both to nothing; a row for them would be dead
 * weight that still cost a query.
 *
 * Reached from `modelPinAudit.js` through a DEFERRED import: the clear half
 * loads a record service, and those drag heavy subtrees the audit's own module
 * comment explains it must not pay for at import time.
 */

import { isTestDatabase, query } from '../lib/db.js';
import { recordRenderPin } from '../lib/renderTargets.js';
import { isTestRunner } from '../lib/runtimeEnv.js';

/**
 * One row per record family carrying the #3231 Phase 3 render pin.
 *
 * `nameSql` differs because some families mirror `name` as a column for their
 * list query and some leave it in the document; `json` differs because decks
 * name their document column `definition`. Everything else about the five is
 * identical, which is why they share one collector.
 *
 * `clear` imports its service lazily and per family, so clearing a deck pin does
 * not also instantiate the universe builder's closure.
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
 * `id::text` because decks key on UUID and every other family on TEXT — the pin
 * id this builds is a string either way, and a UUID that reached the clear path
 * as a pg UUID object would not match it back.
 *
 * The `IS NOT NULL` filter is what keeps rule 2: `->>` yields SQL NULL for both
 * an absent key and a JSON null, so the database returns only rows that actually
 * carry a pin. No index serves the expression today and none is added — the
 * filter's value here is that a scan returns a handful of four-scalar rows
 * instead of every document in the table, which is the cost this endpoint was
 * asked to avoid.
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
 * Normalizes through `recordRenderPin` rather than re-deriving: that is the ONE
 * rule for what counts as a stored pin (trim, the `'auto'` sentinel and blanks
 * collapse to null, the model id capped at the persisted length), and the
 * enqueue sites already read the pair through it.
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
 * The SAME condition `checkHealth` refuses to connect under — the test runner
 * pointed at a database that is not a designated `*_test` one. Reads are allowed
 * through `assertWriteAllowed`, so without this the ordinary server suite would
 * silently query the developer's LIVE `portos` every time a test touched the
 * audit, and a machine with no Postgres would log a failed scan per family per
 * call. Reusing the two exported predicates rather than re-deriving the rule
 * keeps this gate from drifting away from the one in `lib/db.js`.
 *
 * `npm run test:db` points PGDATABASE at `portos_test`, so the DB-backed suite
 * runs the real query; production is not a test runner at all and is unaffected.
 */
const scanAllowed = () => !isTestRunner() || isTestDatabase();

/**
 * Every per-record pin across the families above, in `RECORD_PIN_FAMILIES`
 * order so the panel's rows stay stable between reads.
 *
 * One family's query failing must not take the other four down with it — an
 * unreachable table is a missing section, not a failed audit. (`modelPinAudit`
 * catches at the SOURCE level, which would drop all five together.)
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
 * Goes through the family's own update function rather than an UPDATE against
 * the JSONB column: that is what keeps the record's sanitizer, LWW clock and
 * peer-sync fan-out in the loop, and a direct write would leave every service
 * still holding the old value in its cache.
 *
 * @param {{family?: string, recordId?: string}} pin
 * @returns {Promise<unknown>}
 */
export async function clearRecordPin(pin) {
  const family = RECORD_PIN_FAMILIES.find((entry) => entry.family === pin?.family);
  if (!family) throw new Error(`Unknown record pin family: ${pin?.family}`);
  return family.clear(pin.recordId);
}
