import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  scan: vi.fn(),
  fetch: vi.fn(),
  read: vi.fn(),
  providers: vi.fn(),
  getProviderById: vi.fn(),
  getActiveProvider: vi.fn(),
  runPrompt: vi.fn(),
  getActivities: vi.fn(),
}));

vi.mock('./modelAbuseGuard.js', () => ({ runModelAbuseScan: mocks.scan }));
vi.mock('./settings.js', () => ({ readSettingsStrict: mocks.read }));
vi.mock('./providers.js', () => ({
  getAllProviders: mocks.providers,
  getProviderById: mocks.getProviderById,
  getActiveProvider: mocks.getActiveProvider,
}));
vi.mock('./providerExecutionReadiness.js', () => ({
  ensureProviderReadyForExecution: async () => ({ success: true }),
}));
vi.mock('./promptRunner.js', async () => {
  const { ServerError } = await import('../lib/errorHandler.js');
  return {
    runPromptThroughProvider: mocks.runPrompt,
    assertProvider: (provider, { message, code, status = 503 } = {}) => {
      if (provider) return;
      if (code) throw new ServerError(message, { status, code });
      throw new Error(message);
    },
  };
});
vi.mock('./agentActivity.js', () => ({ getActivities: mocks.getActivities }));
vi.mock('./untrustedContent.js', async (importActual) => {
  const actual = await importActual();
  return { ...actual, runUntrustedContentAnalysis: vi.fn(actual.runUntrustedContentAnalysis) };
});

import { generateComment, generatePost, generateReply } from './agentContentGenerator.js';
import { runUntrustedContentAnalysis } from './untrustedContent.js';
import { PRIVATE_UNTRUSTED_CONTENT_SOURCES, UNTRUSTED_CONTENT_SOURCES } from '../lib/untrustedContentSources.js';
import { untrustedContentSettingsSchema } from '../lib/untrustedContent.js';

const agent = { id: 'agent-1', name: 'Example Agent', personality: { promptPrefix: 'Curious', topics: ['systems'] } };
const remotePost = {
  title: 'Remote title UNIQUE-POST',
  author: { name: 'remote-author' },
  content: 'Remote body UNIQUE-BODY',
};
const remoteComments = [{ author: 'commenter', content: 'Remote comment UNIQUE-COMMENT' }];
const api = {
  id: 'api-1', name: 'Example API', type: 'api', enabled: true,
  endpoint: 'https://api.example.com/v1', defaultModel: 'example-text', contextWindow: 32768,
};
const replyJson = new Response(JSON.stringify({
  choices: [{ message: { content: '{"content":"A thoughtful reply."}' }, finish_reason: 'stop' }],
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.read.mockResolvedValue({ corrupt: false, settings: {} });
  mocks.providers.mockResolvedValue({ providers: [api] });
  mocks.scan.mockResolvedValue({ ok: true, safe: true });
  mocks.getActivities.mockResolvedValue([]);
  mocks.fetch.mockResolvedValue(replyJson.clone());
  mocks.runPrompt.mockResolvedValue({ text: '{"title":"Hello","content":"Body text"}', model: 'example-text' });
});

afterEach(() => vi.unstubAllGlobals());

describe('Moltbook content generation', () => {
  it('registers moltbook as a public untrusted-content source', () => {
    expect(UNTRUSTED_CONTENT_SOURCES).toContain('moltbook');
    expect(PRIVATE_UNTRUSTED_CONTENT_SOURCES).not.toContain('moltbook');
    expect(untrustedContentSettingsSchema.safeParse({
      sources: { moltbook: { maxInputChars: 1000 } },
    }).success).toBe(true);
  });

  it('screens a pinned API comment and keeps remote text out of the trusted task', async () => {
    mocks.getProviderById.mockResolvedValue(api);

    const generated = await generateComment(agent, remotePost, remoteComments, [], 'api-1', 'example-text');

    expect(generated.content).toBe('A thoughtful reply.');
    expect(mocks.runPrompt).not.toHaveBeenCalled();
    expect(mocks.getActiveProvider).not.toHaveBeenCalled();
    const call = runUntrustedContentAnalysis.mock.calls[0][0];
    expect(call.source).toBe('moltbook');
    expect(call.provider).toBe(api);
    expect(call.content).toContain('UNIQUE-BODY');
    expect(call.content).toContain('UNIQUE-COMMENT');
    expect(call.prompt).not.toContain('UNIQUE-BODY');
    expect(call.prompt).not.toContain('UNIQUE-COMMENT');
    expect(call.prompt).not.toContain('UNIQUE-POST');
    const request = mocks.fetch.mock.calls[0][1];
    const body = JSON.parse(request.body);
    expect(request.redirect).toBe('error');
    expect(body).not.toHaveProperty('tools');
    expect(body.messages[0].content).not.toContain('UNIQUE-BODY');
    expect(body.messages[1].content).toContain('UNIQUE-BODY');
    expect(body.messages[1].content).toContain('UNIQUE-COMMENT');
  });

  it('lets an unpinned comment use the abuse-guard API provider and the requested model', async () => {
    const generated = await generateComment(agent, remotePost, remoteComments, [], null, 'requested-model');

    expect(generated.content).toBe('A thoughtful reply.');
    expect(mocks.getProviderById).not.toHaveBeenCalled();
    expect(mocks.getActiveProvider).not.toHaveBeenCalled();
    expect(runUntrustedContentAnalysis.mock.calls[0][0].provider).toBeUndefined();
    expect(runUntrustedContentAnalysis.mock.calls[0][0].model).toBe('requested-model');
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body).model).toBe('requested-model');
    expect(mocks.runPrompt).not.toHaveBeenCalled();
  });

  it('does not publish when screening rejects the remote post', async () => {
    mocks.getProviderById.mockResolvedValue(api);
    mocks.scan.mockResolvedValue({ ok: true, safe: false, code: 'security-guard-classified-malicious' });

    await expect(generateComment(agent, remotePost, remoteComments, [], 'api-1'))
      .rejects.toMatchObject({ status: 422, code: 'security-guard-classified-malicious' });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.runPrompt).not.toHaveBeenCalled();
  });

  it('refuses a pinned CLI provider without calling the tool runner or another provider', async () => {
    mocks.getProviderById.mockResolvedValue({
      id: 'cli-1', name: 'Example CLI', type: 'cli', command: 'codex', enabled: true,
    });

    await expect(generateComment(agent, remotePost, remoteComments, [], 'cli-1'))
      .rejects.toMatchObject({ status: 422, code: 'untrusted-content-provider-unavailable' });
    await expect(generateReply(agent, remotePost, { author: 'commenter', content: 'UNIQUE-PARENT' }, [], 'cli-1'))
      .rejects.toMatchObject({ code: 'untrusted-content-provider-unavailable' });
    expect(runUntrustedContentAnalysis).not.toHaveBeenCalled();
    expect(mocks.runPrompt).not.toHaveBeenCalled();
    expect(mocks.getActiveProvider).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('keeps a parent comment inside the untrusted envelope', async () => {
    mocks.getProviderById.mockResolvedValue(api);

    await generateReply(agent, remotePost, { author: 'commenter', content: 'Remote parent UNIQUE-PARENT' }, [], 'api-1', 'example-text');

    const call = runUntrustedContentAnalysis.mock.calls[0][0];
    expect(call.content).toContain('UNIQUE-PARENT');
    expect(call.prompt).not.toContain('UNIQUE-PARENT');
    expect(call.prompt).not.toContain('UNIQUE-BODY');
  });

  it('refuses a non-tool-free post provider before any run', async () => {
    mocks.getProviderById.mockResolvedValue({ id: 'tui-1', name: 'Example TUI', type: 'tui', command: 'claude', enabled: true });
    await expect(generatePost(agent, {}, 'tui-1')).rejects.toMatchObject({
      status: 422, code: 'PROVIDER_MODE_NOT_PERMITTED', message: expect.stringContaining('Example TUI'),
    });

    mocks.getProviderById.mockResolvedValue({ id: 'codex-1', name: 'Example Codex', type: 'cli', command: 'codex', enabled: true });
    await expect(generatePost(agent, {}, 'codex-1')).rejects.toMatchObject({ code: 'PROVIDER_MODE_NOT_PERMITTED' });

    mocks.getProviderById.mockResolvedValue(null);
    mocks.getActiveProvider.mockResolvedValue(api);
    await expect(generatePost(agent, {}, 'missing-id')).rejects.toMatchObject({
      code: 'PROVIDER_MODE_NOT_PERMITTED', message: expect.stringContaining('missing-id'),
    });
    expect(mocks.getActiveProvider).not.toHaveBeenCalled();
    expect(mocks.runPrompt).not.toHaveBeenCalled();

    mocks.getActiveProvider.mockResolvedValue({ id: 'tui-1', name: 'Example TUI', type: 'tui', command: 'claude', enabled: true });
    await expect(generatePost(agent, {})).rejects.toMatchObject({ code: 'PROVIDER_MODE_NOT_PERMITTED' });
    expect(mocks.runPrompt).not.toHaveBeenCalled();
  });

  it('generates an original post on a tool-free provider with no fallback', async () => {
    mocks.getProviderById.mockResolvedValue(api);
    const generated = await generatePost(agent, { submolt: 'general' }, 'api-1', 'example-text');
    expect(generated).toMatchObject({ title: 'Hello', content: 'Body text' });
    expect(mocks.runPrompt).toHaveBeenCalledWith(expect.objectContaining({
      provider: api,
      source: 'agent-content-post',
      toolFree: true,
      allowFallback: false,
    }));

    const claude = { id: 'claude-1', name: 'Example Claude', type: 'cli', command: 'claude', enabled: true };
    mocks.getProviderById.mockResolvedValue(claude);
    await generatePost(agent, {}, 'claude-1');
    expect(mocks.runPrompt).toHaveBeenLastCalledWith(expect.objectContaining({
      provider: claude, toolFree: true, allowFallback: false,
    }));
  });
});
