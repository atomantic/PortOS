import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { Router } from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { CODEX_ACCOUNT_STATUS } from '../lib/codexAccount.js';

// The lifecycle service owns the process; this suite asserts the ROUTE
// CONTRACT — which service call each endpoint makes, what it validates, and
// what shape reaches the browser.
vi.mock('../services/codexAppServer.js', () => ({
  getCodexAccountReadiness: vi.fn(),
  startCodexChatGptLogin: vi.fn(),
  cancelCodexChatGptLogin: vi.fn(),
  codexLogout: vi.fn(),
  peekCodexAccountReadiness: vi.fn(() => null),
}));
vi.mock('../services/providerRuntimeInstaller.js', async (importOriginal) => ({
  ...(await importOriginal()),
  peekProviderRuntimeStatuses: vi.fn(() => ({ codex: { id: 'codex', label: 'Codex CLI', installed: true } })),
}));

const codexAppServer = await import('../services/codexAppServer.js');
const { createPortOSProviderRoutes } = await import('./providers.js');

const CODEX = { id: 'codex', name: 'Codex CLI', type: 'cli', command: 'codex', envVars: {} };
const CLAUDE = { id: 'claude-code', name: 'Claude Code', type: 'cli', command: 'claude', envVars: {} };

const READY = {
  status: CODEX_ACCOUNT_STATUS.ready,
  detail: 'Signed in on the pro plan',
  runtimeInstalled: true,
  accountFetched: true,
  account: { authMethod: 'chatgpt', planType: 'pro', usesCodexManagedCredentials: false },
  rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: null, limitName: null }, secondary: null, credits: null },
  login: null,
  error: null,
  checkedAt: 1_700_000_000_000,
};

const appWith = (providers = [CODEX, CLAUDE]) => {
  const providerService = { getAllProviders: vi.fn().mockResolvedValue({ activeProvider: 'codex', providers }) };
  const app = express();
  app.use(express.json());
  app.use('/api/providers', createPortOSProviderRoutes({
    services: { providers: providerService }, routes: { providers: Router() },
  }));
  app.use(errorMiddleware);
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();
  codexAppServer.peekCodexAccountReadiness.mockReturnValue(null);
});

describe('GET /api/providers/codex/account', () => {
  it('returns the readiness verdict and honours ?fresh=1', async () => {
    codexAppServer.getCodexAccountReadiness.mockResolvedValue(READY);

    const res = await request(appWith()).get('/api/providers/codex/account');
    expect(res.status).toBe(200);
    expect(res.body.readiness.status).toBe(CODEX_ACCOUNT_STATUS.ready);
    expect(codexAppServer.getCodexAccountReadiness).toHaveBeenCalledWith({ fresh: false });

    await request(appWith()).get('/api/providers/codex/account?fresh=1');
    expect(codexAppServer.getCodexAccountReadiness).toHaveBeenLastCalledWith({ fresh: true });
  });

  it('is not shadowed by the GET /:id provider lookup', async () => {
    codexAppServer.getCodexAccountReadiness.mockResolvedValue(READY);

    const res = await request(appWith()).get('/api/providers/codex/account');

    expect(res.body.readiness).toBeTruthy();
    expect(res.body.id).toBeUndefined();
  });
});

describe('POST /api/providers/codex/account/login', () => {
  it('starts the browser flow and returns only the URL and login id', async () => {
    codexAppServer.startCodexChatGptLogin.mockResolvedValue({
      loginId: 'login-1', authUrl: 'https://auth.example.com/x', verificationUrl: null, userCode: null,
      startedAt: 1, expiresAt: 2,
    });

    const res = await request(appWith()).post('/api/providers/codex/account/login').send({});

    expect(res.status).toBe(200);
    expect(codexAppServer.startCodexChatGptLogin).toHaveBeenCalledWith({ deviceCode: false });
    expect(res.body.login.authUrl).toBe('https://auth.example.com/x');
  });

  it('passes the device-code opt-in through', async () => {
    codexAppServer.startCodexChatGptLogin.mockResolvedValue({ loginId: 'login-2', verificationUrl: 'https://auth.example.com/d', userCode: 'ABCD' });

    await request(appWith()).post('/api/providers/codex/account/login').send({ deviceCode: true });

    expect(codexAppServer.startCodexChatGptLogin).toHaveBeenCalledWith({ deviceCode: true });
  });

  it('rejects a non-boolean deviceCode instead of coercing it', async () => {
    const res = await request(appWith()).post('/api/providers/codex/account/login').send({ deviceCode: 'yes' });

    expect(res.status).toBe(400);
    expect(codexAppServer.startCodexChatGptLogin).not.toHaveBeenCalled();
  });
});

describe('POST /api/providers/codex/account/login/cancel', () => {
  it('cancels the named login and answers with the settled readiness', async () => {
    codexAppServer.cancelCodexChatGptLogin.mockResolvedValue({ ...READY, status: CODEX_ACCOUNT_STATUS.signedOut });

    const res = await request(appWith()).post('/api/providers/codex/account/login/cancel').send({ loginId: 'login-1' });

    expect(res.status).toBe(200);
    expect(codexAppServer.cancelCodexChatGptLogin).toHaveBeenCalledWith('login-1');
    expect(res.body.readiness.status).toBe(CODEX_ACCOUNT_STATUS.signedOut);
  });

  it('requires a login id', async () => {
    const res = await request(appWith()).post('/api/providers/codex/account/login/cancel').send({});

    expect(res.status).toBe(400);
    expect(codexAppServer.cancelCodexChatGptLogin).not.toHaveBeenCalled();
  });

  it('surfaces the service\'s 409 for a login that is no longer pending', async () => {
    const err = Object.assign(new Error('That ChatGPT sign-in is no longer in progress.'), { status: 409, code: 'CODEX_UNKNOWN_LOGIN' });
    codexAppServer.cancelCodexChatGptLogin.mockRejectedValue(err);

    const res = await request(appWith()).post('/api/providers/codex/account/login/cancel').send({ loginId: 'stale' });

    expect(res.status).toBe(409);
  });
});

describe('POST /api/providers/codex/account/logout', () => {
  it('signs out and returns the re-read readiness', async () => {
    codexAppServer.codexLogout.mockResolvedValue({ ...READY, status: CODEX_ACCOUNT_STATUS.signedOut, account: null });

    const res = await request(appWith()).post('/api/providers/codex/account/logout').send({});

    expect(res.status).toBe(200);
    expect(res.body.readiness.status).toBe(CODEX_ACCOUNT_STATUS.signedOut);
  });
});

describe('GET /api/providers decorates the Codex cards', () => {
  const byId = (res) => Object.fromEntries(res.body.providers.map((p) => [p.id, p]));

  it('publishes nothing but an unprobed null on a cold cache, and never accuses a card', async () => {
    const cards = byId(await request(appWith()).get('/api/providers'));

    expect(cards.codex.codexAccount).toBeNull();
    expect(cards.codex.prerequisitesMet).toBe(true);
    expect(cards.codex.missingPrerequisites).toEqual([]);
    // Reading the list must never be the thing that spawns an app-server.
    expect(codexAppServer.getCodexAccountReadiness).not.toHaveBeenCalled();
  });

  it('attaches the cached snapshot to Codex providers only', async () => {
    codexAppServer.peekCodexAccountReadiness.mockReturnValue(READY);

    const cards = byId(await request(appWith()).get('/api/providers'));

    expect(cards.codex.codexAccount.status).toBe(CODEX_ACCOUNT_STATUS.ready);
    expect(cards['claude-code']).not.toHaveProperty('codexAccount');
  });

  it('adds a presentation-only finding for a signed-out account', async () => {
    codexAppServer.peekCodexAccountReadiness.mockReturnValue({ ...READY, status: CODEX_ACCOUNT_STATUS.signedOut, account: null });

    const cards = byId(await request(appWith()).get('/api/providers'));

    expect(cards.codex.missingPrerequisites).toEqual([{ code: 'codexAccount', label: 'No ChatGPT account is signed in' }]);
    expect(cards['claude-code'].missingPrerequisites).toEqual([]);
  });

  it('does not turn an unknown verdict into a finding', async () => {
    codexAppServer.peekCodexAccountReadiness.mockReturnValue({ ...READY, status: CODEX_ACCOUNT_STATUS.unknown, accountFetched: false, account: null });

    const cards = byId(await request(appWith()).get('/api/providers'));

    expect(cards.codex.missingPrerequisites).toEqual([]);
    expect(cards.codex.prerequisitesMet).toBe(true);
  });
});
