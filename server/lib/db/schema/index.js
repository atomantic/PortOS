// Barrel + composer for the per-domain schema DDL modules (#2832).
//
// ensureSchemaImpl() in server/lib/db.js used to inline ~1265 lines of
// CREATE TABLE / CREATE INDEX / trigger DDL for every domain. That DDL now
// lives in per-domain modules here, each exporting a plain statement array;
// this file re-exports them and composes the two ordered lists that
// ensureSchemaImpl runs on every boot.
//
// ORDER IS LOAD-BEARING. The composed lists reproduce the pre-split statement
// order EXACTLY (foreign-key references, the trigger function preceding its
// triggers, and catalog_user_types' original post-media position all depend on
// it), so the executed schema is byte-identical to the inline version.
//
// See README.md for the module catalog.

import { coreDdl } from './core.js';
import { tribeDdl } from './tribe.js';
import { humanActivityDdl } from './humanActivity.js';
import { commissionsDdl } from './commissions.js';
import { catalogDdl, catalogUserTypesDdl } from './catalog.js';
import { mediaDdl } from './media.js';
import { universesDdl } from './universes.js';
import { libraryDdl } from './library.js';
import { pipelineDdl } from './pipeline.js';
import { writersRoomDdl } from './writersRoom.js';
import { loraDdl } from './lora.js';
import { privacyDdl } from './privacy.js';
import { auditDdl, auditedTables, buildAuditTriggers } from './audit.js';

export {
  coreDdl,
  tribeDdl,
  humanActivityDdl,
  commissionsDdl,
  catalogDdl,
  catalogUserTypesDdl,
  mediaDdl,
  universesDdl,
  libraryDdl,
  pipelineDdl,
  writersRoomDdl,
  loraDdl,
  privacyDdl,
  auditDdl,
  auditedTables,
  buildAuditTriggers,
};

// Phase 1 — the `upgrades` list: memory-sync columns + migration tracker, then
// the machine-local Tribe / human-activity / commission tables. Run first,
// before the catalog block.
export function buildUpgradeDdl() {
  return [
    ...coreDdl,
    ...tribeDdl,
    ...humanActivityDdl,
    ...commissionsDdl,
  ];
}

// Phase 2 — the `catalogDDL` list: catalog + all creative-app tables, then the
// record_audit table/function, then the per-table audit triggers. catalog_user_types
// is threaded in AFTER the media block to match its original position (see catalog.js).
export function buildCatalogDdl() {
  return [
    ...catalogDdl,
    ...mediaDdl,
    ...catalogUserTypesDdl,
    ...universesDdl,
    ...libraryDdl,
    ...pipelineDdl,
    ...writersRoomDdl,
    ...loraDdl,
    ...privacyDdl,
    ...auditDdl,
    ...buildAuditTriggers(),
  ];
}
