import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ settings: vi.fn(), provider: vi.fn(), analyze: vi.fn() }));
vi.mock('./settings.js', () => ({ getSettings: mocks.settings }));
vi.mock('./providers.js', () => ({ getProviderById: mocks.provider }));
vi.mock('./messageTriageRules.js', () => ({ getTriageRules: async () => [{ senderPattern: 'rule sender instruction', correctedAction: 'review' }] }));
vi.mock('./untrustedContent.js', () => ({ runUntrustedContentAnalysis: mocks.analyze }));
import { evaluateMessages, generateReplyBody } from './messageEvaluator.js';
const message = { id: 'message-1', from: { email: 'sender@example.test' }, subject: 'Example meeting', bodyText: 'Meet next Tuesday?' };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings.mockResolvedValue({});
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
  it('surfaces blocked analysis instead of an empty recommendation or draft', async () => {
    mocks.analyze.mockResolvedValue({ ok: false, message: 'Screening unavailable.' });
    await expect(evaluateMessages([message])).rejects.toThrow('Screening unavailable.');
    await expect(generateReplyBody(message)).rejects.toThrow('Screening unavailable.');
  });
});
