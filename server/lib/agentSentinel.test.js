import { describe, it, expect } from 'vitest';
import { DONE_SENTINEL_NAME, doneSentinelName, doneSentinelPath, extractSentinelPayloadFromTranscript, parseSentinelPayload, salvageSentinelPayload } from './agentSentinel.js';

describe('agentSentinel', () => {
  it('exposes the sentinel filename', () => {
    expect(DONE_SENTINEL_NAME).toBe('.agent-done');
  });

  describe('doneSentinelName', () => {
    it('scopes the filename to the agent instance', () => {
      expect(doneSentinelName('agent-1a2b3c')).toBe('.agent-done-agent-1a2b3c');
    });

    it('gives two concurrent agents distinct filenames', () => {
      expect(doneSentinelName('agent-aaa')).not.toBe(doneSentinelName('agent-bbb'));
    });

    it('falls back to the shared name when no id is available', () => {
      expect(doneSentinelName(null)).toBe('.agent-done');
      expect(doneSentinelName('   ')).toBe('.agent-done');
      expect(doneSentinelName(42)).toBe('.agent-done');
    });

    it('sanitizes path separators out of the id so the name stays one file in the workspace', () => {
      // A traversal-shaped id must not escape the workspace directory.
      expect(doneSentinelName('../../etc/passwd')).toBe('.agent-done-passwd');
      expect(doneSentinelName('a b/c')).toBe('.agent-done-c');
    });
  });

  describe('doneSentinelPath', () => {
    it('resolves the run-scoped file inside the workspace', () => {
      // Worktree-less agents share the primary checkout: a bare `.agent-done`
      // there may be a sibling run's, and must never finalize this one.
      expect(doneSentinelPath('/repo', 'agent-1')).toBe('/repo/.agent-done-agent-1');
    });

    it('degrades to the shared name when no agent id is available', () => {
      expect(doneSentinelPath('/repo', null)).toBe('/repo/.agent-done');
    });

    it('returns null without a workspace path', () => {
      expect(doneSentinelPath(null, 'agent-1')).toBeNull();
    });
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

    it('recovers an envelope whose proposal body contains a markdown code fence', async () => {
      // A reasoner proposing code writes a ```-fenced snippet into the body
      // string. The inner-fence heuristic would otherwise lock onto that body
      // fence and discard the envelope — salvage must skip it.
      const withCodeBody = {
        summary: 's',
        payload: { proposal: { slug: 'x', body: 'Change this:\n```js\nconst a = 1;\n```\ndone' } }
      };
      // Both a fenced-wrapper form and a raw (unwrapped) form must recover.
      const fenced = '```json\n' + JSON.stringify(withCodeBody) + '\n```';
      expect((await salvageSentinelPayload(fenced)).payload).toEqual(withCodeBody.payload);
      expect((await salvageSentinelPayload(JSON.stringify(withCodeBody))).payload).toEqual(withCodeBody.payload);
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
describe('extractSentinelPayloadFromTranscript', () => {
    const isReasonerPayload = (p) => !!p && typeof p === 'object' && !Array.isArray(p)
      && ['analysis', 'proposal', 'pause'].some(k => Object.hasOwn(p, k));
    const ANSWER = '{"analysis":"quiet cycle","proposal":null,"pause":null}';

    it('recovers a bare payload object the model printed, ANSI and all', async () => {
      const transcript = `\u001b[32m\u25cf\u001b[0m ${ANSWER}\u001b[0m\r\n`;
      const { payload } = await extractSentinelPayloadFromTranscript(transcript, isReasonerPayload);
      expect(payload).toEqual({ analysis: 'quiet cycle', proposal: null, pause: null });
    });

    it('unwraps the documented { summary, payload } envelope when that is what was printed', async () => {
      const transcript = 'done: {"summary":"nothing to file","payload":{"proposal":null}}';
      expect(await extractSentinelPayloadFromTranscript(transcript, isReasonerPayload))
        .toEqual({ summary: 'nothing to file', payload: { proposal: null } });
    });

    it('takes the LAST matching object, so the final answer beats an earlier prompt echo', async () => {
      const transcript = `schema: {"analysis":"<example>","proposal":null}\nanswer: ${ANSWER}`;
      const { payload } = await extractSentinelPayloadFromTranscript(transcript, isReasonerPayload);
      expect(payload.analysis).toBe('quiet cycle');
    });

    it('prefers the enclosing object over its own nested children', async () => {
      const transcript = '{"analysis":"a","proposal":{"scope":"self-improve","title":"t"}}';
      const { payload } = await extractSentinelPayloadFromTranscript(transcript, isReasonerPayload);
      expect(payload.proposal.title).toBe('t');
    });

    it('survives a truncated repaint that leaves an unmatched brace before the answer', async () => {
      const { payload } = await extractSentinelPayloadFromTranscript(`{ half a redraw ${ANSWER}`, isReasonerPayload);
      expect(payload).not.toBeNull();
    });

    it('keeps a bare deliverable that merely carries its own \`payload\` key', async () => {
      // Unwrapping unconditionally would hand the hook the nested value and drop
      // the answer the model actually printed.
      const transcript = '{"analysis":"a","proposal":null,"payload":"unrelated"}';
      const { payload } = await extractSentinelPayloadFromTranscript(transcript, isReasonerPayload);
      expect(payload).toEqual({ analysis: 'a', proposal: null, payload: 'unrelated' });
    });

    it('yields no payload for malformed or partial JSON', async () => {
      expect(await extractSentinelPayloadFromTranscript('{"analysis":"cut off mid-thoug', isReasonerPayload))
        .toEqual({ summary: '', payload: null });
      expect(await extractSentinelPayloadFromTranscript('{analysis: not json}', isReasonerPayload))
        .toEqual({ summary: '', payload: null });
    });

    it('recovers the answer even when an earlier line left an unmatched quote', async () => {
      const { payload } = await extractSentinelPayloadFromTranscript(`\u2502 renaming "foo\n${ANSWER}`, isReasonerPayload);
      expect(payload).not.toBeNull();
    });

    it('yields no payload for JSON that is not the hook deliverable', async () => {
      expect((await extractSentinelPayloadFromTranscript('{"tokens":1200}', isReasonerPayload)).payload).toBeNull();
    });

    it('yields no payload without a predicate, or for empty/brace-free text', async () => {
      expect((await extractSentinelPayloadFromTranscript(ANSWER, null)).payload).toBeNull();
      expect((await extractSentinelPayloadFromTranscript('no json here', isReasonerPayload)).payload).toBeNull();
      expect((await extractSentinelPayloadFromTranscript(null, isReasonerPayload)).payload).toBeNull();
    });
  });
});
