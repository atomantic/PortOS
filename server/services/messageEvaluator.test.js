import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ settings: vi.fn(), provider: vi.fn(), analyze: vi.fn(), jevGate: vi.fn(), jevMeasure: vi.fn() }));
vi.mock('./settings.js', () => ({ getSettings: mocks.settings }));
vi.mock('./providers.js', () => ({ getProviderById: mocks.provider }));
vi.mock('./messageTriageRules.js', () => ({ getTriageRules: async () => [{ senderPattern: 'rule sender instruction', correctedAction: 'review' }] }));
// The jev rung stubs to "feature off", which is the shipped default: these
// assertions are the proof that nothing about the chat path moved.
vi.mock('./untrustedContent.js', () => ({
  runUntrustedContentAnalysis: mocks.analyze,
  jevBatchGate: (...args) => mocks.jevGate(...args),
  measureJevBatch: (...args) => mocks.jevMeasure(...args),
}));
import { evaluateMessages, generateReplyBody } from './messageEvaluator.js';
const message = { id: 'message-1', from: { email: 'sender@example.test' }, subject: 'Example meeting', bodyText: 'Meet next Tuesday?' };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings.mockResolvedValue({});
  mocks.jevGate.mockResolvedValue({ mode: 'disabled', decided: new Map(), outcomes: new Map() });
  mocks.jevMeasure.mockResolvedValue(null);
  mocks.analyze.mockResolvedValue({ ok: true, value: [{ id: message.id, action: 'review', reason: 'Meeting', priority: 'medium' }] });
});
describe('message trust boundary', () => {
  it('screens complete text and requires exact unique response identities', async () => {
    const bodyText = `${'a'.repeat(500)} external instructions at the end`;
    const result = await evaluateMessages([{ ...message, bodyText }]);
    expect(result.evaluations[message.id].action).toBe('review');
    const call = mocks.analyze.mock.calls[0][0];
    expect(JSON.parse(call.content).messages[0].bodyText).toBe(bodyText);
    expect(call.prompt).not.toContain('rule sender instruction');
    expect(call.content).toContain('rule sender instruction');
    expect(call.responseSchema.safeParse([{ id: 'other-message', action: 'delete', reason: 'x', priority: 'low' }]).success).toBe(false);
    await expect(evaluateMessages([message, message])).rejects.toThrow('unique');
  });
  it('keeps sender and thread evidence out of trusted templates and identity context out of voice drafts', async () => {
    mocks.analyze.mockResolvedValue({ ok: true, value: { body: 'Tuesday works.' } });
    const thread = { ...message, id: 'message-0', bodyText: 'previous sender instruction' };
    await expect(generateReplyBody({ ...message, bodyText: 'sender instruction marker' }, 'Keep it brief.', { useVoice: true, threadMessages: [thread], templateOverride: 'Reply to {{body}}. {{instructions}}' })).resolves.toEqual({ body: 'Tuesday works.' });
    const call = mocks.analyze.mock.calls[0][0];
    expect(call.prompt).toContain('Keep it brief.');
    expect(call.prompt).not.toContain('sender instruction marker');
    expect(call.prompt).not.toContain('previous sender instruction');
    expect(call.content).toContain('previous sender instruction');
    expect(call.prompt).not.toContain('voice_context');
  });
  it('lets dedicated provider selections and explicit automatic mode replace legacy provider/model pairs', async () => {
    mocks.settings.mockResolvedValue({ messages: { providerId: 'old-cli', model: 'old-model' }, untrustedContent: { sources: { email: { providerId: 'local-api', model: null } } } });
    mocks.provider.mockResolvedValue({ id: 'local-api', type: 'api', defaultModel: 'local-model' });
    await evaluateMessages([message]);
    expect(mocks.analyze).toHaveBeenLastCalledWith(expect.objectContaining({ provider: expect.objectContaining({ id: 'local-api' }), model: null }));
    mocks.settings.mockResolvedValue({ messages: { providerId: 'old-cli', model: 'old-model' }, untrustedContent: { sources: { email: { providerId: null, model: null } } } });
    await evaluateMessages([message]);
    expect(mocks.analyze).toHaveBeenLastCalledWith(expect.objectContaining({ provider: undefined, model: null }));
    expect(mocks.provider).toHaveBeenCalledTimes(1);
  });
  // The jev triage gate. `untrustedContent.jev.test.js` covers the scorer and
  // the margin floors; these assert what the BATCH does with each verdict.
  describe('local decision scorer', () => {
    const second = { ...message, id: 'message-2', subject: 'Example newsletter', bodyText: 'Weekly roundup.' };
    const settle = (ids, choices) => mocks.jevGate.mockResolvedValue({
      mode: 'prefer', outcomes: new Map(), decided: new Map(ids.map(id => [id, choices])),
    });

    it('makes zero provider calls when every message resolves locally', async () => {
      settle([message.id, second.id], { 'message-triage': 'archive', 'message-priority': 'low' });
      const result = await evaluateMessages([message, second]);
      expect(mocks.analyze).not.toHaveBeenCalled();
      expect(result.evaluations[message.id]).toMatchObject({ action: 'archive', priority: 'low' });
      expect(result.evaluations[second.id]).toMatchObject({ action: 'archive', priority: 'low' });
    });

    it('sends only the abstained messages, with the coverage contract rebuilt for them', async () => {
      settle([message.id], { 'message-triage': 'reply', 'message-priority': 'high' });
      mocks.analyze.mockResolvedValue({ ok: true, value: [{ id: second.id, action: 'delete', reason: 'Junk', priority: 'low' }] });
      const result = await evaluateMessages([message, second]);
      const call = mocks.analyze.mock.calls[0][0];
      expect(JSON.parse(call.content).messages.map(row => row.id)).toEqual([second.id]);
      // The rebuilt schema must reject the full batch: a contract still sized
      // for two would make the model's one-row answer look incomplete.
      expect(call.responseSchema.safeParse([
        { id: message.id, action: 'reply', reason: 'x', priority: 'high' },
        { id: second.id, action: 'delete', reason: 'y', priority: 'low' },
      ]).success).toBe(false);
      expect(result.evaluations[message.id].action).toBe('reply');
      expect(result.evaluations[second.id].action).toBe('delete');
    });

    it('never pairs a local action with a provider priority', async () => {
      // One half of the pair abstained, so the item is not in `decided` at all —
      // the chat model's priority was conditioned on its own action, and mixing
      // the two would produce a pair neither model proposed.
      mocks.jevGate.mockResolvedValue({ mode: 'prefer', outcomes: new Map(), decided: new Map() });
      mocks.analyze.mockResolvedValue({ ok: true, value: [{ id: message.id, action: 'review', reason: 'Meeting', priority: 'medium' }] });
      const result = await evaluateMessages([message]);
      expect(result.evaluations[message.id]).toMatchObject({ action: 'review', priority: 'medium' });
      expect(JSON.parse(mocks.analyze.mock.calls[0][0].content).messages).toHaveLength(1);
    });

    it('reports an abstained message as skipped under only, never as a triage action', async () => {
      mocks.jevGate.mockResolvedValue({ mode: 'only', outcomes: new Map(), decided: new Map() });
      const result = await evaluateMessages([message]);
      expect(mocks.analyze).not.toHaveBeenCalled();
      expect(result.evaluations[message.id]).toBeUndefined();
      expect(result.skipped).toEqual([{ id: message.id, reason: 'jev-abstained' }]);
    });
  });

  it('surfaces blocked analysis instead of an empty recommendation or draft', async () => {
    mocks.analyze.mockResolvedValue({ ok: false, message: 'Screening unavailable.' });
    await expect(evaluateMessages([message])).rejects.toThrow('Screening unavailable.');
    await expect(generateReplyBody(message)).rejects.toThrow('Screening unavailable.');
  });
});
