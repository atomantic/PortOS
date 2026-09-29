import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./apiCore.js', () => ({ request: vi.fn(async () => ({})) }));

import { request } from './apiCore.js';
import { generateAgentComment, moltworldBuild, moltworldSay } from './apiAccounts.js';

const lastCall = () => {
  const [path, options] = request.mock.calls.at(-1);
  return { path, method: options.method, body: JSON.parse(options.body) };
};

describe('apiAccounts named-field wrappers', () => {
  beforeEach(() => request.mockClear());

  it('generateAgentComment posts every named field', async () => {
    await generateAgentComment({ agentId: 'a1', accountId: 'c1', postId: 'p1', parentId: 'r1', providerId: 'prov', model: 'm' });
    expect(lastCall()).toEqual({
      path: '/agents/tools/generate-comment',
      method: 'POST',
      body: { agentId: 'a1', accountId: 'c1', postId: 'p1', parentId: 'r1', providerId: 'prov', model: 'm' }
    });
  });

  it('moltworldBuild posts coordinates and defaults z to 0', async () => {
    await moltworldBuild({ accountId: 'c1', agentId: 'a1', x: 1, y: 2, type: 'stone', action: 'place' });
    expect(lastCall()).toEqual({
      path: '/agents/tools/moltworld/build',
      method: 'POST',
      body: { accountId: 'c1', agentId: 'a1', x: 1, y: 2, z: 0, type: 'stone', action: 'place' }
    });
  });

  it('moltworldSay includes sayTo only when set', async () => {
    await moltworldSay({ accountId: 'c1', agentId: 'a1', message: 'hi', sayTo: 'bob' });
    expect(lastCall().body).toEqual({ accountId: 'c1', agentId: 'a1', message: 'hi', sayTo: 'bob' });
    await moltworldSay({ accountId: 'c1', agentId: 'a1', message: 'hi' });
    expect(lastCall().body).toEqual({ accountId: 'c1', agentId: 'a1', message: 'hi' });
  });
});
