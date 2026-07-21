/**
 * Compose/barrel test for the per-domain schema DDL modules (#2832).
 *
 * Issue #2832 split the ~1265-line inline DDL in ensureSchemaImpl()
 * (server/lib/db.js) into per-domain modules here, each exporting a plain
 * statement array, with index.js composing the two ordered lists the composer
 * runs. This pins that contract:
 *   - every domain module exports an array of SQL strings,
 *   - the composer includes each module's statements,
 *   - ORDER is preserved (FK references + trigger-function-before-triggers),
 *   - the audit-trigger builder emits two statements per audited table.
 *
 * Byte-for-byte equivalence with the pre-split inline arrays was verified at
 * extraction time; catalog↔init-db.sql parity is locked separately by
 * db.catalogDdlParity.test.js.
 */

import { describe, it, expect } from 'vitest';
import * as schema from './index.js';
import {
  buildUpgradeDdl,
  buildCatalogDdl,
  auditedTables,
  buildAuditTriggers,
} from './index.js';

const DOMAIN_ARRAYS = [
  'coreDdl', 'tribeDdl', 'humanActivityDdl', 'commissionsDdl',
  'catalogDdl', 'catalogUserTypesDdl', 'mediaDdl', 'universesDdl',
  'libraryDdl', 'pipelineDdl', 'writersRoomDdl', 'loraDdl', 'privacyDdl',
  'auditDdl',
];

describe('db/schema barrel + composer (#2832)', () => {
  it.each(DOMAIN_ARRAYS)('%s is a non-empty array of SQL strings', (name) => {
    const arr = schema[name];
    expect(Array.isArray(arr), `${name} should be an array`).toBe(true);
    expect(arr.length).toBeGreaterThan(0);
    for (const stmt of arr) expect(typeof stmt).toBe('string');
  });

  it('buildUpgradeDdl composes the phase-1 modules in order', () => {
    const expected = [
      ...schema.coreDdl,
      ...schema.tribeDdl,
      ...schema.humanActivityDdl,
      ...schema.commissionsDdl,
    ];
    expect(buildUpgradeDdl()).toEqual(expected);
  });

  it('buildCatalogDdl composes the phase-2 modules in order, with catalog_user_types after media', () => {
    const expected = [
      ...schema.catalogDdl,
      ...schema.mediaDdl,
      ...schema.catalogUserTypesDdl,
      ...schema.universesDdl,
      ...schema.libraryDdl,
      ...schema.pipelineDdl,
      ...schema.writersRoomDdl,
      ...schema.loraDdl,
      ...schema.privacyDdl,
      ...schema.auditDdl,
      ...buildAuditTriggers(),
    ];
    expect(buildCatalogDdl()).toEqual(expected);
  });

  it('every FK target created within these lists precedes the statement referencing it', () => {
    // Structural safety net for the extraction: for each `REFERENCES <table>`
    // whose target is created WITHIN these two lists, that CREATE must appear at
    // or before the referencing statement — catches an intra-list reorder. Some
    // FK targets (e.g. `memories`) are created by a separate schema path and the
    // `upgrades` list only ALTERs them, so a target absent here is not a failure.
    const all = [...buildUpgradeDdl(), ...buildCatalogDdl()];
    const createdAt = new Map();
    all.forEach((sql, i) => {
      const m = /CREATE TABLE IF NOT EXISTS (\w+)/.exec(sql);
      if (m && !createdAt.has(m[1])) createdAt.set(m[1], i);
    });
    all.forEach((sql, i) => {
      const re = /REFERENCES\s+(\w+)\s*\(/gi;
      let m;
      while ((m = re.exec(sql)) !== null) {
        const target = m[1];
        if (!createdAt.has(target)) continue; // created by another schema path
        expect(createdAt.get(target), `FK target ${target} created after its reference`).toBeLessThanOrEqual(i);
      }
    });
  });

  it('the record_audit_log() function is defined before any trigger that calls it', () => {
    const catalog = buildCatalogDdl();
    const fnIdx = catalog.findIndex((s) => /CREATE OR REPLACE FUNCTION record_audit_log/.test(s));
    const firstTrigIdx = catalog.findIndex((s) => /EXECUTE FUNCTION record_audit_log/.test(s));
    expect(fnIdx).toBeGreaterThanOrEqual(0);
    expect(firstTrigIdx).toBeGreaterThan(fnIdx);
  });

  it('buildAuditTriggers emits a DROP + CREATE pair per audited table', () => {
    const triggers = buildAuditTriggers();
    expect(triggers.length).toBe(auditedTables.length * 2);
    for (const t of auditedTables) {
      expect(triggers).toContain(`DROP TRIGGER IF EXISTS trg_${t}_audit ON ${t}`);
      expect(triggers.some((s) => s.startsWith(`CREATE TRIGGER trg_${t}_audit `))).toBe(true);
    }
  });
});
