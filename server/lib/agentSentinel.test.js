import { describe, it, expect } from 'vitest';
import { DONE_SENTINEL_NAME, parseSentinelPayload, salvageSentinelPayload } from './agentSentinel.js';

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

  describe('salvageSentinelPayload', () => {
    const envelope = {
      summary: 'Proposed one improvement',
      payload: { analysis: 'a', proposal: { slug: 'add-telemetry', title: 'Add telemetry' } }
    };

    it('returns null payload for blank / brace-free contents', async () => {
      expect(await salvageSentinelPayload(null)).toEqual({ summary: '', payload: null });
      expect(await salvageSentinelPayload('nothing structured here')).toEqual({ summary: 'nothing structured here', payload: null });
    });

    it('recovers an envelope wrapped in ```json fences', async () => {
      const fenced = '```json\n' + JSON.stringify(envelope) + '\n```';
      const { payload } = await salvageSentinelPayload(fenced);
      expect(payload).toEqual(envelope.payload);
    });

    it('recovers an envelope with leading/trailing prose', async () => {
      const noisy = `Here is my result:\n${JSON.stringify(envelope)}\nDone.`;
      const { summary, payload } = await salvageSentinelPayload(noisy);
      expect(payload).toEqual(envelope.payload);
      expect(summary).toBe('Proposed one improvement');
    });

    it('recovers an envelope with raw newlines inside a string value', async () => {
      // A local model pastes a multi-line markdown body verbatim (literal \n,
      // not the escaped \\n JSON requires) — strict JSON.parse rejects it.
      const raw = '{"summary":"s","payload":{"proposal":{"slug":"x","body":"line one\nline two\ttabbed"}}}';
      expect(parseSentinelPayload(raw).payload).toBeNull(); // strict parse fails
      const { payload } = await salvageSentinelPayload(raw);
      expect(payload).toEqual({ proposal: { slug: 'x', body: 'line one\nline two\ttabbed' } });
    });

    it('does NOT misread a legacy markdown summary as structured', async () => {
      const md = '## Done\n\nRefactored `foo()` to return `{ ok: true }` on success.';
      expect(await salvageSentinelPayload(md)).toEqual({ summary: md, payload: null });
    });

    it('does NOT adopt an incidental non-envelope JSON object as payload', async () => {
      const md = 'Summary of work:\n{"unrelated": "config", "count": 3}';
      expect((await salvageSentinelPayload(md)).payload).toBeNull();
    });

    it('surfaces an explicit null payload from a fenced envelope', async () => {
      const fenced = '```json\n{"summary":"nothing to file","payload":null}\n```';
      expect(await salvageSentinelPayload(fenced)).toEqual({ summary: 'nothing to file', payload: null });
    });
  });
});
