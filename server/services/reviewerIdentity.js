/**
 * Target-forge identity check for requested-reviewer tokens (`@login`,
 * `@org/team-slug`).
 *
 * `normalizeReviewUsernames` only proves a token is syntactically safe; a
 * handle that does not exist on the forge passes it and then fails on every
 * unattended PR-side request. This answers "does the identity exist on the
 * TARGET forge?" with three outcomes that must never collapse into each other:
 *   verified    — the forge confirmed it
 *   missing     — the forge answered 404 for it (a verified configuration fault)
 *   unavailable — transport/auth/rate-limit failure; says nothing about the
 *                 identity, so it is never reported as missing
 * `skipped` covers a forge with no lookup here (GitLab): existence rules for
 * GitHub are not applied to other forges.
 *
 * Results are cached briefly so a polling dispatcher does not turn one saved
 * roster into a lookup per tick. The stored roster is never touched.
 */
import { execGh } from './github.js';
import { isForgeNoAccessMessage } from '../lib/forgeAccessErrors.js';

export const IDENTITY_STATUS = Object.freeze({
  VERIFIED: 'verified', MISSING: 'missing', UNAVAILABLE: 'unavailable', SKIPPED: 'skipped',
});

const LOOKUP_TIMEOUT_MS = 8000;
const LOOKUP_CONCURRENCY = 4;
// A confirmed identity rarely vanishes; a missing one is re-checked soon so a
// freshly created account or a fixed roster stops warning quickly; an
// unavailable answer is retried almost immediately.
const TTL_MS = { verified: 10 * 60_000, missing: 2 * 60_000, unavailable: 15_000 };

const cache = new Map();
export function __resetReviewerIdentityCache() { cache.clear(); }

const isNotFound = (err) => err?.ghNoAccess === true || isForgeNoAccessMessage(err?.ghStderr || err?.message);

async function lookup(ghApi, host, path) {
  const args = ['api', ...(host && host !== 'github.com' ? ['--hostname', host] : []), path];
  try {
    await ghApi(args, LOOKUP_TIMEOUT_MS);
    return 'found';
  } catch (err) {
    return isNotFound(err) ? 'not-found' : { error: err?.message || 'lookup failed' };
  }
}

async function resolveToken(ghApi, host, token) {
  const bare = token.replace(/^@+/, '');
  const [owner, team] = bare.split('/');
  if (!team) {
    const r = await lookup(ghApi, host, `users/${encodeURIComponent(owner)}`);
    if (r === 'found') return { status: IDENTITY_STATUS.VERIFIED };
    if (r === 'not-found') return { status: IDENTITY_STATUS.MISSING, reason: `GitHub user "${owner}" does not exist` };
    return { status: IDENTITY_STATUS.UNAVAILABLE, reason: r.error };
  }
  const t = await lookup(ghApi, host, `orgs/${encodeURIComponent(owner)}/teams/${encodeURIComponent(team)}`);
  if (t === 'found') return { status: IDENTITY_STATUS.VERIFIED };
  if (t !== 'not-found') return { status: IDENTITY_STATUS.UNAVAILABLE, reason: t.error };
  // GitHub answers 404 for a team the caller cannot see, so a team 404 only
  // proves absence when the owning organization itself does not exist.
  const o = await lookup(ghApi, host, `users/${encodeURIComponent(owner)}`);
  if (o === 'not-found') return { status: IDENTITY_STATUS.MISSING, reason: `GitHub organization "${owner}" does not exist` };
  return {
    status: IDENTITY_STATUS.UNAVAILABLE,
    reason: o === 'found' ? `Team "${bare}" is not visible to the signed-in gh account` : o.error,
  };
}

/**
 * @param {string[]} tokens    reviewer tokens with or without a leading `@`
 * @param {{ forge?: 'github'|'gitlab', host?: string, ghApi?: Function, now?: number }} [opts]
 * @returns {Promise<Array<{ token: string, kind: 'user'|'team', status: string, reason?: string }>>}
 *   in input order, one entry per distinct (case-insensitive) token
 */
export async function verifyReviewerIdentities(tokens, { forge = 'github', host = 'github.com', ghApi = execGh, now = Date.now() } = {}) {
  const seen = new Set();
  const distinct = [];
  for (const raw of Array.isArray(tokens) ? tokens : []) {
    const token = String(raw || '').trim().replace(/^@+/, '');
    if (!token || seen.has(token.toLowerCase())) continue;
    seen.add(token.toLowerCase());
    distinct.push(token);
  }
  const results = new Array(distinct.length);
  let next = 0;
  const worker = async () => {
    while (next < distinct.length) {
      const i = next++;
      const token = distinct[i];
      const kind = token.includes('/') ? 'team' : 'user';
      if (forge !== 'github') {
        results[i] = { token, kind, status: IDENTITY_STATUS.SKIPPED, reason: 'Identity lookup is only available for GitHub targets' };
        continue;
      }
      const key = `${host}\0${token.toLowerCase()}`;
      const hit = cache.get(key);
      if (hit && hit.expiresAt > now) { results[i] = { token, kind, ...hit.value }; continue; }
      const value = await resolveToken(ghApi, host, token);
      cache.set(key, { value, expiresAt: now + TTL_MS[value.status] });
      results[i] = { token, kind, ...value };
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOOKUP_CONCURRENCY, distinct.length) }, worker));
  return results;
}

/**
 * Preflight a resolved roster for dispatch. `usernames` are the blocking
 * reviewers except those whose `@token` is in `optionalReviewers`.
 * @returns {Promise<{ identities: object[], requiredMissing: object[], optionalMissing: object[] }>}
 */
export async function preflightReviewerIdentities({ usernames = [], optionalReviewers = [], forge, host, ghApi } = {}) {
  const optional = new Set(optionalReviewers.filter((r) => typeof r === 'string' && r.startsWith('@')).map((r) => r.slice(1).toLowerCase()));
  const tokens = [...usernames, ...optional];
  if (!tokens.length) return { identities: [], requiredMissing: [], optionalMissing: [] };
  const identities = (await verifyReviewerIdentities(tokens, { forge, host, ghApi }))
    .map((entry) => ({ ...entry, required: !optional.has(entry.token.toLowerCase()) }));
  const missing = identities.filter((entry) => entry.status === IDENTITY_STATUS.MISSING);
  return {
    identities,
    requiredMissing: missing.filter((entry) => entry.required),
    optionalMissing: missing.filter((entry) => !entry.required),
  };
}
