/**
 * Guard: Beeper conversation-mirror records must NEVER federate (#27, #28).
 *
 * The mirror holds full message bodies and attachment metadata pulled from
 * every connected network — exactly the shape of data the peer-sync PULL path
 * (`GET /api/peer-sync/record`) was never designed to carry safely. The store
 * decision (rationale on #7, ADR alongside it) settled this: these tables are
 * machine-local, full stop.
 *
 * Modeled directly on `privacyNeverFederates.test.js` (ADR
 * docs/decisions/2026-08-08-privacy-records-machine-local.md, #2148) — same
 * shape of guard, same reasoning. These assertions are cheap and blunt on
 * purpose: they match the string `beeper` broadly across each federation
 * surface, so a future `beeperConversation` or `beeperMessage` kind trips the
 * guard no matter what it is called.
 *
 * Every filter is paired with a floor on the list it filters. A federation
 * surface that collapsed to `[]` (a renamed export, a lazily-populated
 * registry read too early) would satisfy a bare `.filter(...).toEqual([])`
 * while guarding nothing, so each list must also still be recognizably
 * populated. Floors sit well under today's counts: they catch a collapse, not
 * ordinary growth or pruning of unrelated kinds.
 */

import { describe, it, expect } from 'vitest';
import { basename } from 'path';
import { PEER_SUBSCRIBABLE_KINDS } from './peerSyncShared.js';
import { PORTOS_SCHEMA_VERSIONS, NON_RECORD_SCHEMA_CATEGORIES } from '../../lib/schemaVersions.js';
import { beeperDdl } from '../../lib/db/schema/beeper.js';
import { mediaLibraryDirs } from './peerMediaLibrarySync.js';

const mentionsBeeper = (value) => /beeper/i.test(String(value));

// Columns that only exist to support cross-instance sync. A beeper table that
// grows one is either federating already or is being prepared to — both are
// the thing this design forbids. `sync_sequence` is the whole list: the Beeper
// schema uses `unsent_at` for the inbound source tombstone specifically so no
// exemption is needed here, and re-adding `deleted_at` would only make the
// guard fire on a future plain soft-delete column with no federation intent.
const FEDERATION_COLUMNS = ['sync_sequence'];

/**
 * A media-library walk entry that would carry a beeper directory to a peer.
 * The kind is matched broadly (a `beeperAttachments` kind trips it); the dir is
 * matched on its BASENAME only, because `mediaLibraryDirs()` entries are always
 * `<installRoot>/data/<kind>` — the last segment is the only part that names
 * the media kind. Matching any path segment instead would also fire on an
 * ANCESTOR directory that merely happens to be called `beeper` (a
 * `beeper/integration` worktree checked out under one), a false red that says
 * nothing about what federates. A `beeper`-prefixed basename still trips, so a
 * future `data/beeper-attachments` cannot slip in under a non-beeper kind.
 */
const namesBeeperMedia = ({ kind, dir }) => mentionsBeeper(kind)
  || /^beeper/i.test(basename(String(dir)));

/** The `CREATE TABLE beeper_*` statements, each a complete balanced string. */
const beeperCreateTableStatements = beeperDdl.filter(
  (stmt) => /CREATE TABLE IF NOT EXISTS beeper_/i.test(stmt),
);

describe('beeper conversation mirror never federates (#27)', () => {
  it('exposes no beeper kind to peer-sync subscriptions', () => {
    expect(PEER_SUBSCRIBABLE_KINDS.length).toBeGreaterThan(10);
    expect(PEER_SUBSCRIBABLE_KINDS.filter(mentionsBeeper)).toEqual([]);
  });

  it('declares no beeper wire-schema category', () => {
    expect(Object.keys(PORTOS_SCHEMA_VERSIONS).length).toBeGreaterThan(15);
    expect([...NON_RECORD_SCHEMA_CATEGORIES].length).toBeGreaterThan(1);
    expect(Object.keys(PORTOS_SCHEMA_VERSIONS).filter(mentionsBeeper)).toEqual([]);
    expect([...NON_RECORD_SCHEMA_CATEGORIES].filter(mentionsBeeper)).toEqual([]);
  });

  // Explicit timeout: the lazy import below resolves the whole dataSync
  // service graph INSIDE the test body (see privacyNeverFederates.test.js for
  // why that cost is paid here rather than at module load).
  it('declares no beeper dataSync snapshot category', async () => {
    const { getSupportedCategories } = await import('../dataSync.js');
    expect(getSupportedCategories().length).toBeGreaterThan(5);
    expect(getSupportedCategories().filter(mentionsBeeper)).toEqual([]);
  }, 30000);

  it('gives no beeper table a sync cursor column', () => {
    // Sanity: if the filter ever matches nothing the assertion below is
    // vacuous, so pin the table count we expect to be guarding. Eight since
    // #36 added `beeper_outbox` — an outbound message body is exactly as
    // machine-local as an inbound one, and the row also records that THIS
    // install sent it, which is nobody else's business either.
    expect(beeperCreateTableStatements).toHaveLength(8);
    for (const stmt of beeperCreateTableStatements) {
      const table = stmt.match(/beeper_[a-z_]+/i)?.[0];
      for (const column of FEDERATION_COLUMNS) {
        expect(`${table}:${stmt.includes(column)}`).toBe(`${table}:false`);
      }
    }
  });

  // The media-library manifest is the OTHER way `data/` bytes reach a peer: it
  // walks whole directories rather than record kinds, so no schema-version or
  // subscription guard above covers it. `mediaLibraryDirs()` is the list
  // `buildMediaLibraryManifest` walks, hence the list that decides what
  // crosses — asserting on it (not the exclude-pattern name map beside it,
  // which federates nothing) is what makes this guard real.
  it('carries no beeper directory into the media-library federation walk', () => {
    const dirs = mediaLibraryDirs();
    // Non-vacuity pin: image, video, audio, music.
    expect(dirs).toHaveLength(4);
    expect(dirs.filter(namesBeeperMedia)).toEqual([]);
  });

  // Bypass probe — proves the assertions above actually fire.
  it('the guard predicates reject a planted violation', () => {
    expect(['universe', 'beeperConversation'].filter(mentionsBeeper)).toEqual(['beeperConversation']);
    expect(
      ['CREATE TABLE IF NOT EXISTS beeper_conversations (id UUID, sync_sequence BIGINT)']
        .filter((s) => FEDERATION_COLUMNS.some((c) => s.includes(c))),
    ).toHaveLength(1);
    // The planted dir entry carries a NON-beeper kind, so only the basename
    // branch can catch it; the trailing entry pins that an ancestor named
    // `beeper` is not itself a violation.
    expect(
      [
        { kind: 'image', dir: '/data/images' },
        { kind: 'attachments', dir: '/data/beeper' },
        { kind: 'image', dir: '/beeper/integration/data/images' },
      ].filter(namesBeeperMedia),
    ).toEqual([{ kind: 'attachments', dir: '/data/beeper' }]);
  });
});
