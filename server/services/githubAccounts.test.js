import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { request } from '../lib/testHelper.js';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'github-accounts-test-'));
const ACCOUNTS_FILE = join(TEST_DATA_ROOT, 'github-accounts.json');

vi.mock('../lib/fileUtils.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: TEST_DATA_ROOT }));

vi.mock('./github.js', async (importOriginal) => ({
  ...(await importOriginal()),
  execGh: vi.fn(),
}));

vi.mock('./githubNotificationTriage.js', async (importOriginal) => ({
  ...(await importOriginal()),
  retriageOpenThreads: vi.fn(async () => 0),
}));

const { execGh } = await import('./github.js');
const { retriageOpenThreads } = await import('./githubNotificationTriage.js');
const { errorMiddleware } = await import('../lib/errorHandler.js');
const { default: githubRoutes } = await import('../routes/github.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/github', githubRoutes);
  app.use(errorMiddleware);
  return app;
}

const ghError = (stderr, code = 1) => Object.assign(new Error(stderr), { ghExitCode: code, ghStderr: stderr });

afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

describe('GitHub accounts API', () => {
  let app;
  beforeEach(() => {
    rmSync(ACCOUNTS_FILE, { force: true });
    vi.mocked(execGh).mockReset();
    app = makeApp();
  });

  it('shows the implicit github.com account until the operator saves one, then persists it on edit', async () => {
    const listed = await request(app).get('/api/github/accounts');
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([expect.objectContaining({ id: 'github-com', host: 'github.com', trust: 'public', mode: 'observe', implicit: true })]);

    const updated = await request(app).put('/api/github/accounts/github-com').send({ login: 'octocat' });
    expect(updated.status).toBe(200);
    expect(updated.body).toEqual(expect.objectContaining({ id: 'github-com', login: 'octocat' }));
    expect(updated.body.implicit).toBeUndefined();

    const after = await request(app).get('/api/github/accounts');
    expect(after.body).toEqual([expect.objectContaining({ id: 'github-com', login: 'octocat' })]);
    expect(after.body[0].implicit).toBeUndefined();
  });

  it('defaults Enterprise hosts to private trust, normalizes the host, and refuses duplicates', async () => {
    const created = await request(app).post('/api/github/accounts').send({ host: 'HTTPS://GitHub.Example.com/', login: 'alice' });
    expect(created.status).toBe(201);
    expect(created.body).toEqual(expect.objectContaining({ host: 'github.example.com', login: 'alice', trust: 'private', mode: 'observe', enabled: true }));

    const listed = await request(app).get('/api/github/accounts');
    expect(listed.body.map((account) => account.host)).toEqual(['github.com', 'github.example.com']);

    const duplicate = await request(app).post('/api/github/accounts').send({ host: 'github.example.com', login: 'ALICE' });
    expect(duplicate.status).toBe(409);
  });

  it('keeps agents off an Enterprise account until the operator allows them, and persists the choice', async () => {
    const created = await request(app).post('/api/github/accounts').send({ host: 'github.example.com' });
    expect(created.body.allowAgents).toBe(false);
    const allowed = await request(app).put(`/api/github/accounts/${created.body.id}`).send({ allowAgents: true });
    expect(allowed.status).toBe(200);
    expect(allowed.body.allowAgents).toBe(true);
    const bad = await request(app).put(`/api/github/accounts/${created.body.id}`).send({ allowAgents: 'yes' });
    expect(bad.status).toBe(400);
  });

  it('lets only an Enterprise account trust its whole instance, and re-decides its threads when trust changes', async () => {
    const created = await request(app).post('/api/github/accounts').send({ host: 'github.example.com', trustInstanceUsers: true });
    expect(created.status).toBe(201);
    expect(created.body.trustInstanceUsers).toBe(true);
    expect((await request(app).put('/api/github/accounts/github-com').send({ trustInstanceUsers: true })).status).toBe(400);
    expect((await request(app).post('/api/github/accounts').send({ host: 'github.com', login: 'octocat', trustInstanceUsers: true })).status).toBe(400);

    vi.mocked(retriageOpenThreads).mockClear();
    await request(app).put(`/api/github/accounts/${created.body.id}`).send({ allowAgents: true });
    expect(retriageOpenThreads).not.toHaveBeenCalled();
    await request(app).put(`/api/github/accounts/${created.body.id}`).send({ trustInstanceUsers: false });
    expect(retriageOpenThreads).toHaveBeenCalledWith(created.body.id);
  });

  it('rejects hosts and logins that are not plain identifiers', async () => {
    for (const body of [
      { host: '--hostname=evil' },
      { host: 'github.example.com/path' },
      { host: 'github.example.com', login: '-x' },
      { host: 'github.example.com', trust: 'trusted' },
    ]) {
      const res = await request(app).post('/api/github/accounts').send(body);
      expect(res.status).toBe(400);
    }
  });

  it('keeps an emptied account list authoritative instead of re-showing the implicit account', async () => {
    expect((await request(app).delete('/api/github/accounts/github-com')).status).toBe(200);
    expect((await request(app).get('/api/github/accounts')).body).toEqual([]);
    expect((await request(app).delete('/api/github/accounts/github-com')).status).toBe(404);
  });

  it('refuses a corrupt store instead of overwriting it', async () => {
    writeFileSync(ACCOUNTS_FILE, JSON.stringify({ version: 1, accounts: [{ id: 'x' }] }));
    expect((await request(app).get('/api/github/accounts')).status).toBe(503);
    expect((await request(app).post('/api/github/accounts').send({ host: 'github.com', login: 'bob' })).status).toBe(503);
  });

  describe('sign-in status', () => {
    it('pins a named login through its own token and reports ok', async () => {
      const { body: account } = await request(app).post('/api/github/accounts').send({ host: 'github.example.com', login: 'alice' });
      vi.mocked(execGh).mockImplementation(async (args, _timeout, { env }) => {
        if (args[0] === 'auth') return 'ghs_example';
        expect(env.GH_ENTERPRISE_TOKEN).toBe('ghs_example');
        expect(env.GH_HOST).toBe('github.example.com');
        return 'alice';
      });
      const res = await request(app).get(`/api/github/accounts/${account.id}/status`);
      expect(res.body).toEqual(expect.objectContaining({ status: 'ok', login: 'alice', remedy: null }));
    });

    it('names the login command when gh has no credential for the configured login', async () => {
      const { body: account } = await request(app).post('/api/github/accounts').send({ host: 'github.example.com', login: 'alice' });
      vi.mocked(execGh).mockRejectedValue(ghError('no oauth token found for github.example.com account alice'));
      const res = await request(app).get(`/api/github/accounts/${account.id}/status`);
      expect(res.body).toEqual(expect.objectContaining({ status: 'not-authenticated', command: 'gh auth login --hostname github.example.com --web --clipboard' }));
    });

    it('reports a missing gh binary instead of a sign-out for a named login', async () => {
      const { body: account } = await request(app).post('/api/github/accounts').send({ host: 'github.example.com', login: 'alice' });
      vi.mocked(execGh).mockRejectedValue(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }));
      const res = await request(app).get(`/api/github/accounts/${account.id}/status`);
      expect(res.body).toEqual(expect.objectContaining({ status: 'not-installed', command: null }));
    });

    it('flags an active login that differs from the configured one', async () => {
      await request(app).put('/api/github/accounts/github-com').send({ login: 'octocat' });
      vi.mocked(execGh).mockImplementation(async (args) => (args[0] === 'auth' ? 'gho_example' : 'someone-else'));
      const res = await request(app).get('/api/github/accounts/github-com/status');
      expect(res.body).toEqual(expect.objectContaining({ status: 'wrong-account', login: 'someone-else' }));
    });

    it('classifies an unreachable Enterprise host for an account with no fixed login', async () => {
      const { body: account } = await request(app).post('/api/github/accounts').send({ host: 'ghe.example.com' });
      vi.mocked(execGh).mockRejectedValue(ghError('error connecting to ghe.example.com'));
      const res = await request(app).get(`/api/github/accounts/${account.id}/status`);
      expect(res.body.status).toBe('unreachable');
    });
  });
});
