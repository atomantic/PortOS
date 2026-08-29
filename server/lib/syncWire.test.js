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

  describe('creativeDirectorProject — machine-local commissionId', () => {
    it('strips commissionId from the wire so a peer never resolves another machine\'s projects', () => {
      // A commission federates its BRIEF only and lands DORMANT on the receiver;
      // only the minting machine runs it. If the project's back-pointer travelled,
      // pausing/deleting that dormant commission on the peer would park a project
      // whose agent, CoS task and queued renders live on the OTHER machine — with
      // no local process able to stop them.
      const wire = sanitizeRecordForWire('creativeDirectorProject', {
        id: 'cd-1', name: 'P', status: 'planning', commissionId: 'commission-1',
      });
      expect(wire).not.toHaveProperty('commissionId');
      expect(wire).toMatchObject({ id: 'cd-1', name: 'P', status: 'planning' });
    });

    it('still carries the rest of the record', () => {
      const wire = sanitizeRecordForWire('creativeDirectorProject', {
        id: 'cd-1', name: 'P', treatment: { logline: 'l' }, deleted: false,
      });
      expect(wire).toMatchObject({ id: 'cd-1', name: 'P', treatment: { logline: 'l' } });
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

    it('strips styleImageRefs from universe wire form (wire-local probe renders)', () => {
      // styleImageRefs are per-peer, regenerable base style-probe renders. They
      // must never cross the wire: an older peer that lacks the field in its
      // sanitizer would drop it on receive, then LWW-strip it back off a newer
      // peer after its own edit. The wire form is byte-stable against a record
      // that never carried the field at all.
      const withRefs = sanitizeRecordForWire('universe', {
        id: 'u1', name: 'U', styleImageRefs: ['a.png', 'b.png'],
      });
      expect(withRefs.styleImageRefs).toBeUndefined();
      const without = sanitizeRecordForWire('universe', { id: 'u1', name: 'U' });
      expect(JSON.stringify(withRefs)).toBe(JSON.stringify(without));
    });

    it('strips the per-record render pin from universe wire form (#3231 Phase 3)', () => {
      // imageMode/imageModelId are install-capability choices (the peer may
      // not have the pinned backend configured) — wire-local like
      // styleImageRefs, and byte-stable against a record without the pair.
      const withPin = sanitizeRecordForWire('universe', {
        id: 'u1', name: 'U', imageMode: 'agy', imageModelId: 'gemini-3.6-flash-low',
      });
      expect(withPin.imageMode).toBeUndefined();
      expect(withPin.imageModelId).toBeUndefined();
      const without = sanitizeRecordForWire('universe', { id: 'u1', name: 'U' });
      expect(JSON.stringify(withPin)).toBe(JSON.stringify(without));
    });

    it('keeps only portable character production canon on the universe wire (#5378)', () => {
      const wire = sanitizeRecordForWire('universe', {
        id: 'u1', name: 'U',
        characters: [{
          id: 'chr-1', name: 'A', imageRefs: ['neutral.png'],
          voiceCanon: {
            version: 2, description: 'warm low alto', sourcePolicy: 'designed', approved: true,
            emotionalRange: ['guarded', { recordingPath: '/private/range.wav' }],
            avoid: ['announcer', { providerId: 'private-provider' }],
            pronunciations: [{
              term: 'Aster', pronunciation: 'AS-ter', recordingPath: '/private/pronunciation.wav',
            }],
            profileId: 'machine-local-profile', artifactPath: '/private/voice.wav', performerName: 'private',
          },
          identityPack: {
            assets: [{ role: 'neutral', imageRef: 'neutral.png', approved: true, localPath: '/private/image.png' }],
            avoid: ['different eye color', { trainingDataset: 'private' }], trainingDataset: 'private',
          },
        }],
      });
      expect(wire.characters[0].voiceCanon).toEqual({
        version: 2, description: 'warm low alto', defaultDelivery: '',
        emotionalRange: ['guarded'], avoid: ['announcer'],
        pronunciations: [{ term: 'Aster', pronunciation: 'AS-ter' }],
        sourcePolicy: 'designed', approved: true,
      });
      expect(wire.characters[0].identityPack).toEqual({
        assets: [{ role: 'neutral', imageRef: 'neutral.png', approved: true }],
        avoid: ['different eye color'],
      });
      expect(JSON.stringify(wire)).not.toMatch(/machine-local|private/);
    });

    it('does NOT strip styleImageRefs from series/issue wire form (universe-only field)', () => {
      // The strip is scoped to `kind === 'universe'` — series/issue records
      // never carry styleImageRefs, but a stray value (hand-edit, corrupted
      // payload) on those kinds must pass through unchanged so the strip can't
      // silently alter unrelated record shapes.
      const series = sanitizeRecordForWire('series', { id: 's1', name: 'S', styleImageRefs: ['x.png'] });
      expect(series.styleImageRefs).toEqual(['x.png']);
    });

    it('strips Music Video image pins while retaining the legacy backend wire shape (#3245)', () => {
      const withPins = sanitizeRecordForWire('musicVideoProject', {
        id: 'mv-1',
        name: 'Example Video',
        imageMode: 'grok',
        imageModelId: 'example-image-model',
        videoSettings: {
          backend: 'grok',
          modelId: 'example-video-model',
          grokDuration: 10,
          generationMode: 'image',
        },
      });
      const preField = sanitizeRecordForWire('musicVideoProject', {
        id: 'mv-1',
        name: 'Example Video',
        videoSettings: {
          backend: 'grok',
          modelId: 'example-video-model',
          grokDuration: 10,
          generationMode: 'image',
        },
      });

      expect(withPins.imageMode).toBeUndefined();
      expect(withPins.imageModelId).toBeUndefined();
      expect(withPins.videoSettings.backend).toBe('grok');
      expect(JSON.stringify(withPins)).toBe(JSON.stringify(preField));
    });

    it('strips local commission runs, including taste and audio provenance, from the brief wire form (#4347)', () => {
      const withLocalRun = sanitizeRecordForWire('creativeCommission', {
        id: 'commission-example',
        name: 'Example Commission',
        brief: { intent: 'ambient', musicTaste: { source: 'digital-twin', window: 'month' } },
        runs: [{
          id: 'run-example',
          tasteRecipe: { source: 'digital-twin', sourceHash: 'private-local' },
          musicGeneration: { engine: 'musicgen', modelId: 'example-model', durationSec: 45 },
          musicOutput: { filename: 'example.wav', sourceHash: 'private-local' },
        }],
        schedule: { kind: 'DAILY' },
        assignment: { providerId: 'local-only' },
        feedback: [],
        enabled: true,
        updatedAt: '2026-08-16T00:00:00.000Z',
      });
      const briefOnly = sanitizeRecordForWire('creativeCommission', {
        id: 'commission-example',
        name: 'Example Commission',
        brief: { intent: 'ambient', musicTaste: { source: 'digital-twin', window: 'month' } },
        updatedAt: '2026-08-16T00:00:00.000Z',
      });

      expect(withLocalRun.runs).toBeUndefined();
      expect(JSON.stringify(withLocalRun)).toBe(JSON.stringify(briefOnly));
    });

    describe('author kind', () => {
      it('passes through an author with canonical tail soft-delete fields', () => {
        const a = { id: 'auth-1', name: 'Ada', bio: 'b' };
        expect(sanitizeRecordForWire('author', a))
          .toEqual({ id: 'auth-1', name: 'Ada', bio: 'b', deleted: false, deletedAt: null });
      });

      it('canonicalizes an oddly-ordered author record byte-for-byte (checksum stability)', () => {
        const odd = { deleted: false, id: 'auth-1', deletedAt: null, name: 'Ada' };
        const canonical = { id: 'auth-1', name: 'Ada', deleted: false, deletedAt: null };
        expect(JSON.stringify(sanitizeRecordForWire('author', odd)))
          .toBe(JSON.stringify(sanitizeRecordForWire('author', canonical)));
      });

      it('preserves an author tombstone (deleted: true crosses the wire)', () => {
        const t = { id: 'auth-1', name: 'Ada', deleted: true, deletedAt: '2026-01-01T00:00:00Z' };
        expect(sanitizeRecordForWire('author', t))
          .toEqual({ id: 'auth-1', name: 'Ada', deleted: true, deletedAt: '2026-01-01T00:00:00Z' });
      });

      it('returns null for an author missing an id', () => {
        expect(sanitizeRecordForWire('author', { name: 'no id' })).toBeNull();
      });
    });

    describe('mediaCollection kind', () => {
      it('strips the local-only provenance stamp so an upgraded peer stays checksum-stable', () => {
        // #3311: `source` drives the grid's ordering/badge on THIS install only.
        // A peer that predates the field would sanitize it away, leaving the two
        // installs permanently checksum-mismatched on the mediaCollections
        // category — so it must not cross the wire at all.
        const stamped = { id: 'c1', name: 'Universe: Example', source: 'auto', items: [] };
        const unstamped = { id: 'c1', name: 'Universe: Example', items: [] };
        expect(sanitizeRecordForWire('mediaCollection', stamped).source).toBeUndefined();
        expect(JSON.stringify(sanitizeRecordForWire('mediaCollection', stamped)))
          .toBe(JSON.stringify(sanitizeRecordForWire('mediaCollection', unstamped)));
      });

      it('strips the stamp from the snapshot-category projection too', () => {
        const { data } = sanitizeStateForWire('mediaCollections', {
          collections: [{ id: 'c1', name: 'Concept Art', source: 'user', items: [] }],
        });
        expect(data.collections[0].source).toBeUndefined();
      });
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
