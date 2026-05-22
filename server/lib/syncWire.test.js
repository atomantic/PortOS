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

    it('passes through valid universe/series/issue records', () => {
      const u = { id: 'u1', name: 'Foo', deleted: false };
      expect(sanitizeRecordForWire('universe', u)).toBe(u);
      expect(sanitizeRecordForWire('series', u)).toBe(u);
      expect(sanitizeRecordForWire('issue', u)).toBe(u);
    });

    it('passes tombstone records (deleted: true must cross the wire)', () => {
      const u = { id: 'u1', deleted: true, deletedAt: '2026-01-01T00:00:00Z' };
      expect(sanitizeRecordForWire('universe', u)).toBe(u);
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
      expect(result.data).toEqual({ universes: [{ id: 'u1', name: 'U' }] });
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
