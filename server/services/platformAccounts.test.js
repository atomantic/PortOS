import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ data: { accounts: {} } }));
vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { agentPersonalities: '/unused' },
  createCachedStore: () => ({
    load: async () => state.data,
    mutate: async (fn) => fn(state.data),
    invalidateCache: () => {},
  }),
}));

import * as platformAccounts from './platformAccounts.js';

const MW_AGENT_ID = 'mw-agent-id-5a6b7c8d';
const API_KEY = 'api-key-1234abcd';

const seed = () => {
  state.data = {
    accounts: {
      'acct-mw': {
        agentId: 'agent-1',
        platform: 'moltworld',
        credentials: { apiKey: API_KEY, username: 'example', agentId: MW_AGENT_ID },
        status: 'active',
      },
    },
  };
};

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  seed();
});

describe('platform account credential masking', () => {
  it('masks the Moltworld agentId in list and detail reads', async () => {
    const [listed] = await platformAccounts.getAllAccounts();
    const detail = await platformAccounts.getAccountById('acct-mw');

    for (const account of [listed, detail]) {
      expect(account.credentials.agentId).toBe('***' + MW_AGENT_ID.slice(-4));
      expect(account.credentials.apiKey).toBe('***' + API_KEY.slice(-4));
      expect(JSON.stringify(account)).not.toContain(MW_AGENT_ID);
    }
  });

  it('keeps the full credentials for internal platform calls', async () => {
    const account = await platformAccounts.getAccountWithCredentials('acct-mw');

    expect(account.credentials.agentId).toBe(MW_AGENT_ID);
    expect(account.credentials.apiKey).toBe(API_KEY);
  });
});
