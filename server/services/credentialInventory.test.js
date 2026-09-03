import { describe, expect, it, vi, beforeEach } from 'vitest';

const mock = vi.hoisted(() => ({
  getSettings: vi.fn(async () => ({})),
  getHfTokenInfo: vi.fn(async () => ({ token: null, source: 'none' })),
  jiraConfigured: false,
  datadogConfigured: false,
  spotifyStatus: { hasCredentials: false, hasTokens: false },
  stackerAccounts: [],
  openclawConfig: {},
}));

vi.mock('./settings.js', () => ({
  getSettings: mock.getSettings,
}));

vi.mock('./hfToken.js', () => ({
  getHfTokenInfo: mock.getHfTokenInfo,
}));

vi.mock('./jira.js', () => ({
  hasConfiguredInstances: vi.fn(async () => mock.jiraConfigured),
}));

vi.mock('./datadog.js', () => ({
  hasConfiguredInstances: vi.fn(async () => mock.datadogConfigured),
}));

vi.mock('./spotifyAuth.js', () => ({
  getAuthStatus: vi.fn(async () => mock.spotifyStatus),
}));

vi.mock('./stackerNews.js', () => ({
  listAccounts: vi.fn(async () => mock.stackerAccounts),
}));

vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readJSONFile: vi.fn(async () => mock.openclawConfig),
  };
});

import { getCredentialInventory } from './credentialInventory.js';

const byId = (credentials, id) => credentials.find((row) => row.id === id);

const secretShaped = /(hf_|sk-|ghp_|gho_|github_pat_|xox[baprs]-)/;

describe('credentialInventory', () => {
  beforeEach(() => {
    mock.getSettings.mockResolvedValue({});
    mock.getHfTokenInfo.mockResolvedValue({ token: null, source: 'none' });
    mock.jiraConfigured = false;
    mock.datadogConfigured = false;
    mock.spotifyStatus = { hasCredentials: false, hasTokens: false };
    mock.stackerAccounts = [];
    mock.openclawConfig = {};
  });

  it('reports settings over env when both are set, without echoing the value', async () => {
    const { credentials, headline } = await getCredentialInventory({
      settings: { imageGen: { hfToken: 'hf_thisMustNeverLeaveTheServer' }, civitai: { apiKey: 'secret-civitai-key' } },
      env: { HF_TOKEN: 'hf_envMustNotWin', CIVITAI_API_KEY: 'env-civitai' },
      envFile: new Map(),
      detectors: {},
    });

    expect(headline).toMatch(/no key at all/i);
    expect(byId(credentials, 'huggingface')).toMatchObject({ configured: true, source: 'settings' });
    expect(byId(credentials, 'civitai')).toMatchObject({ configured: true, source: 'settings' });
    expect(JSON.stringify({ credentials })).not.toMatch(secretShaped);
    expect(JSON.stringify({ credentials })).not.toContain('hf_thisMustNeverLeaveTheServer');
    expect(JSON.stringify({ credentials })).not.toContain('secret-civitai-key');
  });

  it('distinguishes repo .env from inherited process.env', async () => {
    const envFile = new Map([['CIVITAI_API_KEY', 'from-dot-env'], ['ANTHROPIC_API_KEY', 'from-dot-env']]);
    const { credentials } = await getCredentialInventory({
      settings: {},
      env: { ANTHROPIC_API_KEY: 'from-dot-env', OPENAI_API_KEY: 'shell-only' },
      envFile,
      detectors: {},
    });

    expect(byId(credentials, 'civitai')).toMatchObject({ configured: true, source: 'env-file' });
    expect(byId(credentials, 'anthropic')).toMatchObject({ configured: true, source: 'env-file' });
    expect(byId(credentials, 'openai')).toMatchObject({ configured: true, source: 'env' });
    expect(JSON.stringify({ credentials })).not.toContain('from-dot-env');
    expect(JSON.stringify({ credentials })).not.toContain('shell-only');
  });

  it('uses the huggingface CLI source when that is the only place a token exists', async () => {
    mock.getHfTokenInfo.mockResolvedValue({ token: 'hf_cliTokenMustNotLeak', source: 'cli' });
    const { credentials } = await getCredentialInventory({
      settings: {},
      env: {},
      envFile: new Map(),
    });
    expect(byId(credentials, 'huggingface')).toMatchObject({ configured: true, source: 'cli' });
    expect(JSON.stringify({ credentials })).not.toContain('hf_cliTokenMustNotLeak');
  });

  it('names the instance feature that stays dark without a JIRA token', async () => {
    const { credentials } = await getCredentialInventory({
      settings: {},
      env: {},
      envFile: new Map(),
      detectors: { jira: async () => null },
    });
    expect(byId(credentials, 'jira')).toMatchObject({
      configured: false,
      source: 'none',
      unavailableFeatures: [{ id: 'jira', label: 'JIRA' }],
    });
  });

  it('treats a configured JIRA instance file as config, not env', async () => {
    mock.jiraConfigured = true;
    const { credentials } = await getCredentialInventory({
      settings: {},
      env: {},
      envFile: new Map(),
    });
    expect(byId(credentials, 'jira')).toMatchObject({ configured: true, source: 'config', unavailableFeatures: [] });
  });
});
