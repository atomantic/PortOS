/**
 * GitHub accounts for the notifications manager (#12869): one login on one host
 * (github.com or a GitHub Enterprise Server hostname) with the operator-chosen
 * trust level and automation mode. Credentials stay in `gh`'s own store; this
 * file holds only machine-local configuration and is never federated.
 *
 * Trust is a property of the ACCOUNT the operator configured, never of any
 * notification content — later phases compute per-thread trust from it plus
 * repo ownership and actor metadata.
 */
import { join } from 'path';
import { z } from 'zod';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { atomicWrite, ensureDir, PATHS, readJSONFile } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { ServerError } from '../lib/errorHandler.js';
import { execGh, classifyGhProbe, ghRemedy } from './github.js';
import {
  GITHUB_ACCOUNT_HOST_RE as HOST_RE,
  GITHUB_ACCOUNT_LOGIN_RE as LOGIN_RE,
  GITHUB_ACCOUNT_MODES,
  GITHUB_ACCOUNT_TRUST_LEVELS,
  githubAccountCreateSchema,
  githubAccountUpdateSchema,
  validateRequest,
} from '../lib/validation.js';

const ACCOUNTS_FILE = join(PATHS.data, 'github-accounts.json');
const STORE_VERSION = 1;
const STATUS_TIMEOUT_MS = 10000;
const queueWrite = createFileWriteQueue();

const GITHUB_DOT_COM = 'github.com';
// Shown before the operator has configured anything: the github.com login `gh`
// already uses, so an existing install sees its account without a migration.
// Persisted only once edited.
const IMPLICIT_ACCOUNT_ID = 'github-com';

const defaultTrustForHost = (host) => (host === GITHUB_DOT_COM ? 'public' : 'private');

const storedAccountSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  host: z.string().regex(HOST_RE),
  login: z.string().regex(LOGIN_RE).nullable(),
  trust: z.enum(GITHUB_ACCOUNT_TRUST_LEVELS),
  allowedProviders: z.array(z.string()).nullable(),
  mode: z.enum(GITHUB_ACCOUNT_MODES),
  auditReport: z.boolean().optional(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).passthrough();
const storeSchema = z.object({ version: z.literal(STORE_VERSION), accounts: z.array(storedAccountSchema) }).passthrough();

const implicitAccount = () => ({
  id: IMPLICIT_ACCOUNT_ID,
  label: GITHUB_DOT_COM,
  host: GITHUB_DOT_COM,
  login: null,
  trust: 'public',
  allowedProviders: null,
  mode: 'observe',
  auditReport: false,
  enabled: true,
  createdAt: null,
  updatedAt: null,
  implicit: true,
});

// null = no store yet (show the implicit account); a stored empty list means
// the operator removed every account and stays authoritative.
async function loadStore() {
  await ensureDir(PATHS.data);
  const raw = await readJSONFile(ACCOUNTS_FILE, null, { strict: true, allowArray: false });
  if (raw === null) return null;
  const parsed = storeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ServerError('GitHub accounts storage is invalid; original file preserved', {
      status: 503, code: 'GITHUB_ACCOUNTS_UNAVAILABLE',
    });
  }
  return parsed.data;
}

const saveStore = (accounts) => atomicWrite(ACCOUNTS_FILE, { version: STORE_VERSION, accounts });

const currentAccounts = (store) => (store ? store.accounts : [implicitAccount()]);

const materialize = (account) => {
  if (!account.implicit) return account;
  const now = new Date().toISOString();
  const { implicit: _implicit, ...rest } = account;
  return { ...rest, createdAt: now, updatedAt: now };
};

const sameIdentity = (a, b) => a.host === b.host && (a.login || '').toLowerCase() === (b.login || '').toLowerCase();

function assertUniqueIdentity(accounts, candidate) {
  const clash = accounts.find((account) => account.id !== candidate.id && sameIdentity(account, candidate));
  if (clash) {
    throw new ServerError(`An account for ${candidate.login ? `${candidate.login} on ` : ''}${candidate.host} already exists`, {
      status: 409, code: 'GITHUB_ACCOUNT_EXISTS',
    });
  }
}

const notFound = (id) => new ServerError(`GitHub account ${id} not found`, { status: 404, code: 'GITHUB_ACCOUNT_NOT_FOUND' });

export async function listAccounts() {
  return currentAccounts(await loadStore());
}

export async function getAccount(id) {
  const account = (await listAccounts()).find((entry) => entry.id === id);
  if (!account) throw notFound(id);
  return account;
}

export function createAccount(input) {
  const data = validateRequest(githubAccountCreateSchema, input);
  return queueWrite(async () => {
    const accounts = currentAccounts(await loadStore()).map(materialize);
    const now = new Date().toISOString();
    const account = {
      id: uuidv4(),
      label: data.label || (data.login ? `${data.login} @ ${data.host}` : data.host),
      host: data.host,
      login: data.login ?? null,
      trust: data.trust || defaultTrustForHost(data.host),
      allowedProviders: data.allowedProviders ?? null,
      mode: data.mode || 'observe',
      auditReport: data.auditReport ?? false,
      enabled: data.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
    assertUniqueIdentity(accounts, account);
    await saveStore([...accounts, account]);
    console.log(`🔐 Added GitHub account for ${account.host} (${account.trust})`);
    return account;
  });
}

export function updateAccount(id, input) {
  const data = validateRequest(githubAccountUpdateSchema, input);
  return queueWrite(async () => {
    const accounts = currentAccounts(await loadStore()).map(materialize);
    const index = accounts.findIndex((account) => account.id === id);
    if (index === -1) throw notFound(id);
    const updated = { ...accounts[index], ...data, updatedAt: new Date().toISOString() };
    if (data.label === '') updated.label = updated.login ? `${updated.login} @ ${updated.host}` : updated.host;
    assertUniqueIdentity(accounts, updated);
    accounts[index] = updated;
    await saveStore(accounts);
    return updated;
  });
}

export function deleteAccount(id) {
  return queueWrite(async () => {
    const accounts = currentAccounts(await loadStore()).map(materialize);
    const remaining = accounts.filter((account) => account.id !== id);
    if (remaining.length === accounts.length) throw notFound(id);
    await saveStore(remaining);
    return { id };
  });
}

// --- Sign-in status ---------------------------------------------------------

const loginCommand = (host) => `gh auth login --hostname ${host} --web --clipboard`;

function classifyError(error) {
  if (error?.ghExitCode !== undefined) return classifyGhProbe({ code: error.ghExitCode, stderr: error.ghStderr });
  if (error?.code) return classifyGhProbe({ spawnError: error });
  return classifyGhProbe({ code: null, stderr: error?.message });
}

// `gh auth token` only reads gh's local credential store, so a non-zero exit
// means "no credential for that login" — unless gh itself is missing or the
// call never finished, which must not be reported as signed out.
const TOKEN_LOOKUP_FAULTS = new Set(['not-installed', 'unreachable']);

/**
 * `{ env }` that makes `gh` act as THIS account, or `{ status }` when it can't.
 * A named login is pinned through its own token so a second login on the same
 * host works without `gh auth switch`; an account with no login uses whichever
 * login is active on that host.
 */
export async function resolveGitHubAccountEnv(account, { baseEnv = process.env } = {}) {
  const env = { ...baseEnv, GH_HOST: account.host };
  if (!account.login) return { env };
  const lookup = await execGh(
    ['auth', 'token', '--hostname', account.host, '--user', account.login],
    STATUS_TIMEOUT_MS,
    { env },
  )
    .then((token) => ({ token, error: null }))
    .catch((error) => ({ token: null, error }));
  if (!lookup.token) {
    const { status } = classifyError(lookup.error);
    return { status: TOKEN_LOOKUP_FAULTS.has(status) ? status : 'not-authenticated' };
  }
  return {
    env: account.host === GITHUB_DOT_COM
      ? { ...env, GH_TOKEN: lookup.token }
      : { ...env, GH_ENTERPRISE_TOKEN: lookup.token },
  };
}

/**
 * Probe `gh` for one account: is it installed, is the host reachable, and is
 * the configured login actually the one the API answers as.
 */
export async function getAccountStatus(id) {
  const account = await getAccount(id);
  const { host, login } = account;
  const checkedAt = new Date().toISOString();
  const { env, status: lookupStatus } = await resolveGitHubAccountEnv(account);
  if (lookupStatus && lookupStatus !== 'not-authenticated') {
    return { id, host, status: lookupStatus, login: null, checkedAt, remedy: ghRemedy(lookupStatus, { hostname: host }), command: null };
  }
  if (!env) {
    return {
      id, host, status: 'not-authenticated', login: null, checkedAt,
      remedy: `gh has no credential for ${login} on ${host}. Run \`${loginCommand(host)}\` and sign in as ${login}.`,
      command: loginCommand(host),
    };
  }
  const attempt = await execGh(['api', 'user', '--hostname', host, '--jq', '.login'], STATUS_TIMEOUT_MS, { env })
    .then((answer) => ({ answer, error: null }))
    .catch((error) => ({ answer: null, error }));
  if (attempt.answer) {
    if (login && attempt.answer.toLowerCase() !== login.toLowerCase()) {
      return {
        id, host, status: 'wrong-account', login: attempt.answer, checkedAt,
        remedy: `${host} answered as ${attempt.answer}, not ${login}. Sign in as ${login} or change this account's login.`,
        command: loginCommand(host),
      };
    }
    return { id, host, status: 'ok', login: attempt.answer, checkedAt, remedy: null, command: null };
  }
  const classified = classifyError(attempt.error);
  const status = classified.status === 'ok' ? 'error' : classified.status;
  return {
    id, host, status, login: null, checkedAt,
    remedy: ghRemedy(status, { hostname: host }),
    command: status === 'not-authenticated' ? loginCommand(host) : null,
  };
}
