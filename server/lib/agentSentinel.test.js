import { describe, it, expect } from 'vitest';
import { DONE_SENTINEL_NAME, parseSentinelPayload } from './agentSentinel.js';

describe('agentSentinel', () => {
  it('exposes the sentinel filename', () => {
    expect(DONE_SENTINEL_NAME).toBe('.agent-done');
  });

  describe('parseSentinelPayload', () => {
    it('returns empty summary + null payload for missing/blank contents', () => {
      expect(parseSentinelPayload(null)).toEqual({ summary: '', payload: null });
      expect(parseSentinelPayload(undefined)).toEqual({ summary: '', payload: null });
      expect(parseSentinelPayload('   \n ')).toEqual({ summary: '', payload: null });
    });

    it('treats a plain-markdown sentinel as text (legacy back-compat)', () => {
      const md = '## Done\n\n- Fixed the bug\n- Opened PR #42';
      expect(parseSentinelPayload(md)).toEqual({ summary: md, payload: null });
    });

    it('does NOT misread a bare JSON array or scalar as structured', () => {
      expect(parseSentinelPayload('[1, 2, 3]')).toEqual({ summary: '[1, 2, 3]', payload: null });
      expect(parseSentinelPayload('42')).toEqual({ summary: '42', payload: null });
    });

    it('extracts summary + payload from a JSON object sentinel', () => {
      const contents = JSON.stringify({
        summary: 'Proposed one improvement',
        payload: { proposal: { slug: 'add-telemetry', title: 'Add telemetry' } }
      });
      expect(parseSentinelPayload(contents)).toEqual({
        summary: 'Proposed one improvement',
        payload: { proposal: { slug: 'add-telemetry', title: 'Add telemetry' } }
      });
    });

    it('tolerates a JSON object missing summary (payload still surfaces)', () => {
      const contents = JSON.stringify({ payload: { proposal: null } });
      expect(parseSentinelPayload(contents)).toEqual({ summary: '', payload: { proposal: null } });
    });

    it('surfaces an explicit null payload as null (not absent)', () => {
      const contents = JSON.stringify({ summary: 'nothing to file', payload: null });
      expect(parseSentinelPayload(contents)).toEqual({ summary: 'nothing to file', payload: null });
    });

    it('degrades malformed JSON that opens with { to text', () => {
      const broken = '{ not valid json';
      expect(parseSentinelPayload(broken)).toEqual({ summary: broken, payload: null });
    });
  });
});
