import { createHash, randomUUID } from 'crypto';
import { query, withTransaction } from '../lib/db.js';
import { executeXBrowserRead } from '../integrations/x/index.js';
import { openXHandoff } from './xBrowser.js';

const USERNAME_PATTERN = /^[A-Za-z0-9_]{1,15}$/;
const DRAFT_STATES = new Set(['draft', 'pending_review', 'approved', 'rejected', 'opened']);
const MAX_DRAFT_AGE_MS = 24 * 60 * 60 * 1000;
const syncLocks = new Map();

const normalizeUsername = (value) => {
  const username = String(value || '').trim().replace(/^@/, '');
  if (!USERNAME_PATTERN.test(username)) throw new Error('Invalid X username');
  return username.toLowerCase();
};
const safeUsername = (value) => {
  const username = String(value || '').trim().replace(/^@/, '').toLowerCase();
  return USERNAME_PATTERN.test(username) ? username : '';
};

const boundedText = (value, max) => typeof value === 'string' ? value.replace(/\0/g, '').slice(0, max) : '';
const stableHash = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const safeDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

const accountView = (row) => ({
  id: row.id,
  label: row.label,
  username: row.username,
  enabled: row.enabled,
  notes: row.notes || '',
  profileSnapshot: row.profile_snapshot || {},
  lastSyncAt: row.last_sync_at,
  lastError: row.last_error || '',
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const postView = (row) => ({
  id: row.id,
  accountId: row.account_id,
  remoteId: row.remote_id,
  kind: row.kind,
  body: row.body,
  sourceUrl: row.source_url,
  remoteCreatedAt: row.remote_created_at,
  impressions: row.impressions,
  engagements: row.engagements,
  replies: row.replies,
  reposts: row.reposts,
  likes: row.likes,
  bookmarks: row.bookmarks,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const draftView = (row) => ({
  id: row.id,
  accountId: row.account_id,
  accountLabel: row.account_label || '',
  username: row.username || '',
  body: row.body,
  state: row.state,
  reviewNote: row.review_note || '',
  result: row.result || {},
  approvedAt: row.approved_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const accountSelect = 'SELECT * FROM x_accounts';

export async function listAccounts() {
  const result = await query(`${accountSelect} ORDER BY created_at ASC`);
  return result.rows.map(accountView);
}

export async function getAccount(id) {
  const result = await query(`${accountSelect} WHERE id=$1`, [id]);
  return result.rows[0] ? accountView(result.rows[0]) : null;
}

async function getAccountRow(id, client = { query }) {
  const result = await client.query('SELECT * FROM x_accounts WHERE id=$1', [id]);
  return result.rows[0] || null;
}

export async function createAccount({ label, username, enabled = true, notes = '' }) {
  const id = randomUUID();
  await query(
    `INSERT INTO x_accounts (id,label,username,enabled,notes)
     VALUES ($1,$2,$3,$4,$5)`,
    [id, boundedText(label, 120).trim(), normalizeUsername(username), enabled, boundedText(notes, 4_000)],
  );
  console.log(`🐦 Added X account ${id}`);
  return getAccount(id);
}

export async function updateAccount(id, updates) {
  const existing = await getAccountRow(id);
  if (!existing) return null;
  await query(
    `UPDATE x_accounts SET label=$2,username=$3,enabled=$4,notes=$5,updated_at=NOW() WHERE id=$1`,
    [id, boundedText(updates.label ?? existing.label, 120).trim(), normalizeUsername(updates.username ?? existing.username), updates.enabled ?? existing.enabled, boundedText(updates.notes ?? existing.notes, 4_000)],
  );
  return getAccount(id);
}

export async function deleteAccount(id) {
  const result = await query('DELETE FROM x_accounts WHERE id=$1', [id]);
  return result.rowCount > 0;
}

export function deriveXDiagnostics({ accountUsername, profile = {}, latest = {}, people = {} }) {
  const configured = normalizeUsername(accountUsername);
  const profileUsername = safeUsername(profile.username);
  const latestPosts = Array.isArray(latest.posts) ? latest.posts : [];
  const matchingPosts = latestPosts.filter((post) => safeUsername(post.authorHandle) === configured);
  return {
    profilePublic: Boolean(profileUsername && profileUsername === configured),
    profileHandleMatches: Boolean(profileUsername && profileUsername === configured),
    appearsInPeopleSearch: people.exactMatch === true || (Array.isArray(people.handles) && people.handles.map(safeUsername).includes(configured)),
    recentPostsInLatestSearch: matchingPosts.length > 0,
    latestSearchPostCount: matchingPosts.length,
    recommendationEligibility: 'unknown',
    checkedAt: new Date().toISOString(),
  };
}

const normalizeRemotePost = (post) => ({
  remoteId: boundedText(post?.remoteId, 80),
  kind: post?.kind === 'reply' ? 'reply' : 'post',
  body: boundedText(post?.body, 40_000),
  sourceUrl: boundedText(post?.sourceUrl, 2_000),
  remoteCreatedAt: safeDate(post?.remoteCreatedAt),
  impressions: Number.isInteger(post?.impressions) ? post.impressions : null,
  engagements: Number.isInteger(post?.engagements) ? post.engagements : null,
  replies: Number.isInteger(post?.replies) ? post.replies : 0,
  reposts: Number.isInteger(post?.reposts) ? post.reposts : 0,
  likes: Number.isInteger(post?.likes) ? post.likes : 0,
  bookmarks: Number.isInteger(post?.bookmarks) ? post.bookmarks : 0,
});

const mergePosts = (...lists) => [...new Map(lists.flat().map(normalizeRemotePost).filter((post) => /^\d+$/.test(post.remoteId)).map((post) => [post.remoteId, post])).values()].slice(0, 100);

async function syncAccountUnlocked(accountId) {
  const account = await getAccountRow(accountId);
  if (!account) return null;
  if (!account.enabled) throw new Error('Selected X account is disabled');

  const [profileResult, latestResult, peopleResult] = await Promise.all([
    executeXBrowserRead('profile', { username: account.username }),
    executeXBrowserRead('latest', { username: account.username }),
    executeXBrowserRead('people', { username: account.username }),
  ]);
  const profile = profileResult.profile || {};
  const latestPosts = Array.isArray(latestResult.posts) ? latestResult.posts : [];
  const people = peopleResult || {};
  const diagnostics = deriveXDiagnostics({ accountUsername: account.username, profile, latest: { posts: latestPosts }, people });
  const snapshot = {
    profile,
    diagnostics,
    peopleSearch: { exactMatch: people.exactMatch === true },
    latestSearch: { postCount: diagnostics.latestSearchPostCount },
  };
  const posts = mergePosts(profileResult.posts || [], latestPosts);

  await withTransaction(async (client) => {
    for (const post of posts) {
      await client.query(
        `INSERT INTO x_posts
         (id,account_id,remote_id,kind,body,source_url,remote_created_at,impressions,engagements,replies,reposts,likes,bookmarks,content_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (account_id,remote_id) DO UPDATE SET kind=EXCLUDED.kind,body=EXCLUDED.body,
           source_url=EXCLUDED.source_url,remote_created_at=EXCLUDED.remote_created_at,
           impressions=EXCLUDED.impressions,engagements=EXCLUDED.engagements,replies=EXCLUDED.replies,
           reposts=EXCLUDED.reposts,likes=EXCLUDED.likes,bookmarks=EXCLUDED.bookmarks,
           content_hash=EXCLUDED.content_hash,received_at=NOW(),updated_at=NOW()`,
        [randomUUID(), accountId, post.remoteId, post.kind, post.body, post.sourceUrl, post.remoteCreatedAt,
          post.impressions, post.engagements, post.replies, post.reposts, post.likes, post.bookmarks, stableHash(post.body)],
      );
    }
    await client.query(
      `UPDATE x_accounts SET profile_snapshot=$2,last_sync_at=NOW(),last_error='',updated_at=NOW() WHERE id=$1`,
      [accountId, snapshot],
    );
  });
  const [nextAccount, nextPosts] = await Promise.all([getAccount(accountId), listPosts(accountId)]);
  return { account: nextAccount, posts: nextPosts, ingested: posts.length, diagnostics };
}

export async function syncAccount(accountId) {
  if (syncLocks.has(accountId)) return syncLocks.get(accountId);
  const run = syncAccountUnlocked(accountId)
    .catch(async (error) => {
      await query('UPDATE x_accounts SET last_error=$2,updated_at=NOW() WHERE id=$1', [accountId, boundedText(error.message, 2_000)]).catch(() => {});
      throw error;
    })
    .finally(() => syncLocks.delete(accountId));
  syncLocks.set(accountId, run);
  return run;
}

export async function listPosts(accountId) {
  const result = await query('SELECT * FROM x_posts WHERE account_id=$1 ORDER BY COALESCE(remote_created_at,received_at) DESC LIMIT 100', [accountId]);
  return result.rows.map(postView);
}

export async function openAccountDestination(accountId, kind) {
  const account = await getAccountRow(accountId);
  if (!account) return null;
  if (!['profile', 'latest', 'people', 'settings'].includes(kind)) throw new Error('Unsupported X handoff destination');
  const value = kind === 'settings' ? '' : account.username;
  return openXHandoff({ kind, value });
}

export async function listDrafts(accountId) {
  const result = await query(
    `SELECT d.*, a.label AS account_label, a.username
     FROM x_drafts d JOIN x_accounts a ON a.id=d.account_id
     WHERE d.account_id=$1 ORDER BY d.created_at DESC LIMIT 100`,
    [accountId],
  );
  return result.rows.map(draftView);
}

export async function createDraft({ accountId, body }) {
  const account = await getAccountRow(accountId);
  if (!account) throw new Error('X account not found');
  const result = await query(
    'INSERT INTO x_drafts (id,account_id,body) VALUES ($1,$2,$3) RETURNING *',
    [randomUUID(), accountId, boundedText(body, 4_000).trim()],
  );
  return draftView({ ...result.rows[0], account_label: account.label, username: account.username });
}

export async function listPendingReviewActions({ limit = 50 } = {}) {
  const result = await query(
    `SELECT d.*, a.label AS account_label, a.username
     FROM x_drafts d JOIN x_accounts a ON a.id=d.account_id
     WHERE d.state='pending_review' ORDER BY d.created_at ASC LIMIT $1`,
    [limit],
  );
  return result.rows.map((row) => ({ ...draftView(row), kind: 'draft_post', payload: { body: row.body } }));
}

export async function reviewDraft(id, state, reviewNote = '') {
  if (!DRAFT_STATES.has(state) || !['pending_review', 'approved', 'rejected'].includes(state)) throw new Error('Unsupported X draft review state');
  const current = await query('SELECT * FROM x_drafts WHERE id=$1', [id]);
  const existing = current.rows[0];
  if (!existing) return null;
  const allowed = existing.state === 'draft' && state === 'pending_review'
    || existing.state === 'pending_review' && ['approved', 'rejected'].includes(state);
  if (!allowed) return null;
  const result = await query(
    `UPDATE x_drafts SET state=$2,review_note=$3,approved_at=CASE WHEN $2='approved' THEN NOW() ELSE approved_at END,updated_at=NOW()
     WHERE id=$1 RETURNING *`,
    [id, state, boundedText(reviewNote, 2_000)],
  );
  const row = result.rows[0];
  const account = await getAccountRow(row.account_id);
  return draftView({ ...row, account_label: account?.label, username: account?.username });
}

export async function openApprovedDraft(id) {
  const result = await query(
    `SELECT d.*, a.label AS account_label, a.username, a.enabled
     FROM x_drafts d JOIN x_accounts a ON a.id=d.account_id WHERE d.id=$1`,
    [id],
  );
  const draft = result.rows[0];
  if (!draft || draft.state !== 'approved') return null;
  if (!draft.approved_at || Date.now() - new Date(draft.approved_at).getTime() > MAX_DRAFT_AGE_MS) throw new Error('X draft approval is stale; review a fresh draft');
  if (!draft.enabled) throw new Error('Selected X account is disabled');
  const handoff = await openXHandoff({ kind: 'compose', value: draft.body });
  const updated = await query(
    `UPDATE x_drafts SET state='opened',result=$2,updated_at=NOW() WHERE id=$1 AND state='approved' RETURNING *`,
    [id, { handoffOpened: true, url: handoff.url }],
  );
  const opened = updated.rows[0];
  return opened ? draftView({ ...opened, account_label: draft.account_label, username: draft.username }) : null;
}

export const xDraftStates = [...DRAFT_STATES];
