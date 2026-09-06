/**
 * Guard: the AI provider connection graph must NEVER federate (#6367).
 *
 * `ai_connections` / `ai_harness_bindings` / `ai_route_bindings` hold this
 * machine's endpoints, credential material, execution environment and the
 * projection snapshots that carry both — exactly the class of record the
 * machine-local ADR (`docs/decisions/2026-08-08-privacy-records-machine-local.md`)
 * keeps off the federation layer. A sender's local connection UUID also cannot
 * identify a receiver's backend, so even the identifiers are meaningless
 * across installs while being dangerous to publish.
 *
 * Blunt on purpose, the same way `privacyNeverFederates.test.js` is: it matches
 * the strings BROADLY, so a future `aiConnection`, `providerGraph` or
 * `harnessBinding` entry trips it whatever it ends up being called. If you are
 * here because this failed, the answer is almost certainly "don't add it" — the
 * design record's "Peer/client boundary" section says a new peer-visible
 * eligibility field is a separately negotiated `schemaVersions.js` change, not
 * a graph kind on the wire.
 */

import { describe, expect, it } from 'vitest';
import { PEER_SUBSCRIBABLE_KINDS } from './peerSyncShared.js';
import { NON_RECORD_SCHEMA_CATEGORIES, PORTOS_SCHEMA_VERSIONS } from '../../lib/schemaVersions.js';
import { aiGraphDdl } from '../../lib/db/schema/aiGraph.js';

const GRAPH_TERMS = /ai_?connection|harness_?binding|route_?binding|provider_?graph/i;
const mentionsGraph = (value) => GRAPH_TERMS.test(String(value));

// Columns that exist only to support cross-instance sync. A graph table that
// grows one is either federating already or being prepared to.
const FEDERATION_COLUMNS = ['sync_sequence', 'deleted_at', 'origin_instance_id'];

const createTableStatements = aiGraphDdl.filter((stmt) => /CREATE TABLE IF NOT EXISTS ai_/i.test(stmt));

describe('the provider connection graph never federates', () => {
  it('exposes no graph kind to peer-sync subscriptions', () => {
    expect(PEER_SUBSCRIBABLE_KINDS.filter(mentionsGraph)).toEqual([]);
  });

  it('declares no graph wire-schema category', () => {
    expect(Object.keys(PORTOS_SCHEMA_VERSIONS).filter(mentionsGraph)).toEqual([]);
    expect([...NON_RECORD_SCHEMA_CATEGORIES].filter(mentionsGraph)).toEqual([]);
  });

  it('gives no graph table a sync cursor, tombstone or origin column', () => {
    // Sanity: a filter that matched nothing would make the loop below vacuous.
    expect(createTableStatements).toHaveLength(3);
    for (const statement of createTableStatements) {
      for (const column of FEDERATION_COLUMNS) {
        expect(statement, `${column} appears in a graph table`).not.toContain(column);
      }
    }
  });
});
