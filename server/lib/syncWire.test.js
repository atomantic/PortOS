import { describe, it, expect } from 'vitest';
import {
  sanitizeRecordForWire,
  sanitizeStateForWire,
  sanitizeSoftDeleteFields,
} from './syncWire.js';

describe('syncWire', () => {
  describe('sanitizeSoftDeleteFields', () => {
    it('returns live shape when deleted is absent or not strictly true', () => {
      expect(sanitizeSoftDeleteFields({})).toEqual({ deleted: false, deletedAt: null });
      expect(sanitizeSoftDeleteFields({ deleted: false })).toEqual({ deleted: false, deletedAt: null });
      // Truthy-but-not-true (string, number, object) is treated as live — guards against
      // corrupted payloads sneaking a tombstone through.
      expect(sanitizeSoftDeleteFields({ deleted: 1 })).toEqual({ deleted: false, deletedAt: null });
      expect(sanitizeSoftDeleteFields({ deleted: 'yes' })).toEqual({ deleted: false, deletedAt: null });
    });

    it('drops deletedAt when deleted=false, even if the payload has both', () => {
      expect(sanitizeSoftDeleteFields({ deleted: false, deletedAt: '2026-01-01T00:00:00Z' }))
        .toEqual({ deleted: false, deletedAt: null });
    });

    it('preserves deletedAt only when it is a non-empty string and deleted=true', () => {
      expect(sanitizeSoftDeleteFields({ deleted: true, deletedAt: '2026-01-01T00:00:00Z' }))
        .toEqual({ deleted: true, deletedAt: '2026-01-01T00:00:00Z' });
      expect(sanitizeSoftDeleteFields({ deleted: true, deletedAt: 12345 }))
        .toEqual({ deleted: true, deletedAt: null });
      expect(sanitizeSoftDeleteFields({ deleted: true }))
        .toEqual({ deleted: true, deletedAt: null });
    });

    it('normalizes empty / whitespace deletedAt to null (no useless tombstone markers)', () => {
      expect(sanitizeSoftDeleteFields({ deleted: true, deletedAt: '' }))
        .toEqual({ deleted: true, deletedAt: null });
      expect(sanitizeSoftDeleteFields({ deleted: true, deletedAt: '   ' }))
        .toEqual({ deleted: true, deletedAt: null });
      expect(sanitizeSoftDeleteFields({ deleted: true, deletedAt: '\t\n' }))
        .toEqual({ deleted: true, deletedAt: null });
    });

    it('null/undefined input returns live shape', () => {
      expect(sanitizeSoftDeleteFields(null)).toEqual({ deleted: false, deletedAt: null });
      expect(sanitizeSoftDeleteFields(undefined)).toEqual({ deleted: false, deletedAt: null });
    });
  });

  describe('sanitizeRecordForWire', () => {
    it('returns null for non-objects', () => {
      expect(sanitizeRecordForWire('universe', null)).toBeNull();
      expect(sanitizeRecordForWire('universe', undefined)).toBeNull();
      expect(sanitizeRecordForWire('universe', 'string')).toBeNull();
    });

    it('returns null for unknown kinds', () => {
      expect(sanitizeRecordForWire('mystery', { id: 'x' })).toBeNull();
    });

    it('returns null for arrays (typeof [] is "object" — must be excluded explicitly)', () => {
      expect(sanitizeRecordForWire('universe', [])).toBeNull();
      expect(sanitizeRecordForWire('universe', [{ id: 'u1' }])).toBeNull();
    });

    it('returns null for records missing or having a non-string id (receiver merges drop these)', () => {
      // Without the id guard, a corrupted entry crosses the wire and the
      // checksum reflects content the receiver can never merge in — permanent
      // sync churn until both sides clean up the corrupt record.
      expect(sanitizeRecordForWire('universe', { name: 'no id' })).toBeNull();
      expect(sanitizeRecordForWire('universe', { id: '', name: 'empty id' })).toBeNull();
      expect(sanitizeRecordForWire('universe', { id: '   ', name: 'ws id' })).toBeNull();
      expect(sanitizeRecordForWire('universe', { id: 42, name: 'num id' })).toBeNull();
    });

    it('passes through universe/series/issue records with canonical soft-delete fields', () => {
      const u = { id: 'u1', name: 'Foo' };
      const canonical = { id: 'u1', name: 'Foo', deleted: false, deletedAt: null };
      expect(sanitizeRecordForWire('universe', u)).toEqual(canonical);
      expect(sanitizeRecordForWire('series', u)).toEqual(canonical);
      expect(sanitizeRecordForWire('issue', u)).toEqual(canonical);
    });

    it('preserves tombstone records (deleted: true must cross the wire)', () => {
      const u = { id: 'u1', deleted: true, deletedAt: '2026-01-01T00:00:00Z' };
      expect(sanitizeRecordForWire('universe', u))
        .toEqual({ id: 'u1', deleted: true, deletedAt: '2026-01-01T00:00:00Z' });
    });

    it('canonicalizes a legacy record (no deleted/deletedAt fields) to match a rewritten live record byte-for-byte', () => {
      // Regression: without this, an upgraded peer that has rewritten its
      // state to include { deleted: false, deletedAt: null } would compute a
      // different snapshot checksum than a not-yet-upgraded peer with the
      // same logical content, and the 60s sync loop would churn forever.
      // computeChecksum uses JSON.stringify, which is key-order sensitive —
      // assert STRING equality, not just object equality.
      const legacy = { id: 'u1', name: 'U' };
      const rewritten = { id: 'u1', name: 'U', deleted: false, deletedAt: null };
      const a = sanitizeRecordForWire('universe', legacy);
      const b = sanitizeRecordForWire('universe', rewritten);
      expect(a).toEqual(b);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });

    it('canonicalizes records with oddly-ordered keys (deleted in head position) to canonical tail order', () => {
      // Regression for the Copilot finding: spreading sanitizeSoftDeleteFields
      // into a record that already has `deleted` in a non-tail position only
      // OVERWRITES the value — the key keeps its original position. Without
      // explicitly stripping then re-adding, the JSON.stringify output differs.
      const odd = { deleted: false, id: 'u1', deletedAt: null, name: 'U' };
      const canonical = { id: 'u1', name: 'U', deleted: false, deletedAt: null };
      expect(JSON.stringify(sanitizeRecordForWire('universe', odd)))
        .toBe(JSON.stringify(sanitizeRecordForWire('universe', canonical)));
    });

    it('strips stray deletedAt when deleted=false (defensive against corrupted payloads)', () => {
      const corrupt = { id: 'u1', deleted: false, deletedAt: '2026-01-01T00:00:00Z' };
      expect(sanitizeRecordForWire('universe', corrupt))
        .toEqual({ id: 'u1', deleted: false, deletedAt: null });
    });

    it('returns null for live ephemeral records — they never cross the wire', () => {
      // All three record kinds honor the ephemeral filter so a local-only
      // scratch record stays off the federation regardless of which
      // category's transport picks it up.
      expect(sanitizeRecordForWire('universe', { id: 'u1', name: 'U', ephemeral: true })).toBeNull();
      expect(sanitizeRecordForWire('series', { id: 's1', name: 'S', ephemeral: true })).toBeNull();
      expect(sanitizeRecordForWire('issue', { id: 'i1', seriesId: 's1', title: 'I', ephemeral: true })).toBeNull();
    });

    it('lets tombstones for ephemeral records cross the wire (a record that was once shared then marked ephemeral then deleted)', () => {
      // The ephemeral filter intentionally does NOT apply when deleted=true.
      // History that matters: U was created live → peer auto-subscribed →
      // user PATCHed { ephemeral: true } → user soft-deleted U. The peer
      // still has the live copy on disk; the tombstone has to reach them
      // for convergence. The wire output strips the `ephemeral` field
      // entirely so the checksum is byte-stable against a pre-flag peer's
      // tombstone for the same record.
      const tombstone = { id: 'u1', name: 'U', ephemeral: true, deleted: true, deletedAt: '2026-05-22T00:00:00Z' };
      const result = sanitizeRecordForWire('universe', tombstone);
      expect(result).not.toBeNull();
      expect(result.ephemeral).toBeUndefined();
      expect(result.deleted).toBe(true);
      expect(result.deletedAt).toBe('2026-05-22T00:00:00Z');
    });

    it('strips a stray `ephemeral: false` from the wire output (byte-stable checksum vs pre-flag peers)', () => {
      // Defensive: if any code path persists `ephemeral: false` on disk
      // (legacy data, hand-edit, importer bypass), the wire JSON must NOT
      // carry the field — otherwise the snapshot checksum diverges from a
      // pre-flag peer's snapshot for the same record and the 60s loop
      // churns forever.
      const result = sanitizeRecordForWire('universe', { id: 'u1', name: 'U', ephemeral: false });
      expect(result).not.toBeNull();
      expect(result.ephemeral).toBeUndefined();
      // Byte-stable shape against a record with no `ephemeral` key at all:
      const reference = sanitizeRecordForWire('universe', { id: 'u1', name: 'U' });
      expect(JSON.stringify(result)).toBe(JSON.stringify(reference));
    });

    it('non-true ephemeral values are NOT filtered for LIVE records (truthy-but-not-true is treated as live)', () => {
      // Matches the soft-delete posture — only the literal `true` triggers
      // the filter so a corrupted payload (`ephemeral: 1` / `'yes'`) can't
      // accidentally remove a record from sync.
      expect(sanitizeRecordForWire('universe', { id: 'u1', ephemeral: 1 })).not.toBeNull();
      expect(sanitizeRecordForWire('universe', { id: 'u1', ephemeral: 'yes' })).not.toBeNull();
      expect(sanitizeRecordForWire('universe', { id: 'u1', ephemeral: false })).not.toBeNull();
    });
  });

  describe('sanitizeStateForWire', () => {
    it('strips runs[] from universe state (peer-local LLM history)', () => {
      const state = {
        universes: [{ id: 'u1', name: 'U' }],
        runs: [{ id: 'r1', universeId: 'u1' }],
      };
      const result = sanitizeStateForWire('universe', state);
      expect(result.kind).toBe('universe');
      // Universes are canonicalized through sanitizeRecordForWire, which adds
      // the default soft-delete fields so legacy + rewritten records hash the
      // same on the wire (see the canonicalization regression test above).
      expect(result.data).toEqual({
        universes: [{ id: 'u1', name: 'U', deleted: false, deletedAt: null }],
      });
      expect(result.data.runs).toBeUndefined();
    });

    it('handles missing universes array (empty state)', () => {
      expect(sanitizeStateForWire('universe', {})).toEqual({
        kind: 'universe',
        data: { universes: [] },
      });
    });

    it('preserves tombstoned records in universe state', () => {
      const state = {
        universes: [
          { id: 'u1' },
          { id: 'u2', deleted: true, deletedAt: '2026-01-01T00:00:00Z' },
        ],
      };
      const result = sanitizeStateForWire('universe', state);
      expect(result.data.universes).toHaveLength(2);
      expect(result.data.universes[1].deleted).toBe(true);
    });

    it('drops ephemeral records from the snapshot — they live local-only', () => {
      const state = {
        universes: [
          { id: 'live' },
          { id: 'scratch', ephemeral: true },
        ],
      };
      const result = sanitizeStateForWire('universe', state);
      expect(result.data.universes).toHaveLength(1);
      expect(result.data.universes[0].id).toBe('live');
    });

    it('returns series + issues for pipeline kind', () => {
      const state = {
        series: [{ id: 's1' }],
        issues: [{ id: 'i1' }, { id: 'i2', deleted: true }],
      };
      const result = sanitizeStateForWire('pipeline', state);
      expect(result.kind).toBe('pipeline');
      expect(result.data.series).toHaveLength(1);
      expect(result.data.issues).toHaveLength(2);
    });

    it('null for unknown kind / non-object state', () => {
      expect(sanitizeStateForWire('mystery', {}).data).toBeNull();
      expect(sanitizeStateForWire('universe', null).data).toBeNull();
    });
  });
});
