/**
 * Guard: Privacy Center records must NEVER federate.
 *
 * This is a product guarantee, not a deferred feature — see ADR
 * `docs/decisions/2026-08-08-privacy-records-machine-local.md` (#2148). The
 * vault holds SSN / passport / driver's-licence / financial-account facts, and
 * the peer-sync PULL path (`GET /api/peer-sync/record`) carries no peer
 * identity, so adding a privacy kind to the federation surface would publish
 * that data to anything that can reach the port — not merely subscribe it.
 *
 * These assertions are cheap and blunt on purpose: they match the string
 * `privacy` BROADLY across each federation surface and subtract nothing, so a
 * future `privacyVault`, `privacy_orgs`, or `privacyCases` entry trips the
 * guard no matter what it is called. If you are here because this test failed,
 * the answer is almost certainly "don't add it" — read the ADR's "Revisiting"
 * section before changing this file.
 */

import { describe, it, expect } from 'vitest';
import { PEER_SUBSCRIBABLE_KINDS } from './peerSyncShared.js';
import { PORTOS_SCHEMA_VERSIONS, NON_RECORD_SCHEMA_CATEGORIES } from '../../lib/schemaVersions.js';
import { privacyDdl } from '../../lib/db/schema/privacy.js';

const mentionsPrivacy = (value) => /privacy/i.test(String(value));

// Columns that only exist to support cross-instance sync. A privacy table that
// grows one is either federating already or is being prepared to — both are
// the thing this ADR forbids.
const FEDERATION_COLUMNS = ['sync_sequence', 'deleted_at'];

/** The `CREATE TABLE privacy_*` statements, each a complete balanced string. */
const privacyCreateTableStatements = privacyDdl.filter(
  (stmt) => /CREATE TABLE IF NOT EXISTS privacy_/i.test(stmt),
);

describe('privacy records never federate (ADR 2026-08-08, #2148)', () => {
  it('exposes no privacy kind to peer-sync subscriptions', () => {
    expect(PEER_SUBSCRIBABLE_KINDS.filter(mentionsPrivacy)).toEqual([]);
  });

  it('declares no privacy wire-schema category', () => {
    expect(Object.keys(PORTOS_SCHEMA_VERSIONS).filter(mentionsPrivacy)).toEqual([]);
    expect([...NON_RECORD_SCHEMA_CATEGORIES].filter(mentionsPrivacy)).toEqual([]);
  });

  // Explicit timeout: the lazy import below resolves the whole dataSync
  // service graph INSIDE the test body, which costs most of the default 10s
  // cap on a loaded machine and made this guard flake. Widening the cap keeps
  // the laziness (and the isolation it buys the two assertions above) without
  // the false red.
  it('declares no privacy dataSync snapshot category', async () => {
    // Imported lazily: dataSync pulls a broad service graph, and the two
    // assertions above must still run if that import ever gets heavier.
    const { getSupportedCategories } = await import('../dataSync.js');
    expect(getSupportedCategories().filter(mentionsPrivacy)).toEqual([]);
  }, 30000);

  it('gives no privacy table a sync cursor or tombstone column', () => {
    // Sanity: if the filter ever matches nothing the assertions below are
    // vacuous, so pin the table count we expect to be guarding.
    expect(privacyCreateTableStatements).toHaveLength(8);
    for (const stmt of privacyCreateTableStatements) {
      const table = stmt.match(/privacy_[a-z_]+/i)?.[0];
      for (const column of FEDERATION_COLUMNS) {
        expect(`${table}:${stmt.includes(column)}`).toBe(`${table}:false`);
      }
    }
  });

  // Bypass probe — proves the assertions above actually fire. Without this, a
  // predicate that silently stopped matching (a renamed export, a filter that
  // returns undefined) would keep the suite green while guarding nothing.
  it('the guard predicates reject a planted violation', () => {
    expect(['universe', 'privacyVault'].filter(mentionsPrivacy)).toEqual(['privacyVault']);
    expect(
      ['CREATE TABLE IF NOT EXISTS privacy_vault_records (id UUID, sync_sequence BIGINT)']
        .filter((s) => FEDERATION_COLUMNS.some((c) => s.includes(c))),
    ).toHaveLength(1);
  });
});
