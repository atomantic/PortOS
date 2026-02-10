#!/usr/bin/env node
/**
 * Moltbook Challenge Probe
 *
 * Polls the Moltbook API to detect when an account suspension lifts,
 * then makes various API calls while logging complete response bodies
 * and headers to capture the exact challenge format.
 *
 * Usage:
 *   node server/scripts/moltbook-probe.mjs [api_key] [backoff_seconds]
 *
 * If no api_key is provided, reads from data/agents/accounts.json (first moltbook account).
 *
 * Example:
 *   node server/scripts/moltbook-probe.mjs moltbook_sk_abc123 30
 */

import { readFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');

const API_BASE = 'https://www.moltbook.com/api/v1';
const [apiKeyArg, backoffArg] = process.argv.slice(2);
const BACKOFF_MS = (parseInt(backoffArg, 10) || 30) * 1000;
const MAX_POLL_ATTEMPTS = 200;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Resolve the API key from args or accounts.json
 */
async function resolveApiKey() {
  if (apiKeyArg) return apiKeyArg;

  const accountsPath = resolve(PROJECT_ROOT, 'data/agents/accounts.json');
  const raw = await readFile(accountsPath, 'utf-8');
  const { accounts } = JSON.parse(raw);

  const entry = Object.values(accounts).find(a => a.platform === 'moltbook');
  if (!entry?.credentials?.apiKey) {
    console.error('No moltbook account found in data/agents/accounts.json');
    process.exit(1);
  }

  console.log(`📂 Loaded API key for username "${entry.credentials.username}" from accounts.json`);
  return entry.credentials.apiKey;
}

/**
 * Make a raw API call and log everything
 */
async function rawRequest(apiKey, method, endpoint, body = null) {
  const url = `${API_BASE}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`
  };

  const config = { method, headers };
  if (body) config.body = JSON.stringify(body);

  const timestamp = new Date().toLocaleTimeString();
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`⏱️  [${timestamp}] ${method} ${endpoint}`);
  if (body) console.log(`📤 Body: ${JSON.stringify(body)}`);

  const response = await fetch(url, config);

  // Log all response headers
  console.log(`📥 Status: ${response.status} ${response.statusText}`);
  console.log(`📥 Headers:`);
  for (const [key, value] of response.headers.entries()) {
    console.log(`   ${key}: ${value}`);
  }

  // Log raw body
  const text = await response.text();
  console.log(`📥 Body (raw): ${text}`);

  // Parse JSON if possible
  let data = null;
  if (text) {
    data = JSON.parse(text);
    // Scan for anything that looks like a challenge
    if (data && typeof data === 'object') {
      const challengeKeys = ['challenge', 'challenge_id', 'verification', 'verify', 'nonce', 'proof', 'puzzle', 'captcha', 'token'];
      const found = Object.keys(data).filter(k => challengeKeys.includes(k.toLowerCase()));
      if (found.length > 0) {
        console.log(`\n🔐 CHALLENGE DETECTED! Keys: ${found.join(', ')}`);
        console.log(`🔐 Challenge data: ${JSON.stringify(data, null, 2)}`);
      }

      // Also check nested objects for challenge fields
      for (const [key, value] of Object.entries(data)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const nestedFound = Object.keys(value).filter(k => challengeKeys.includes(k.toLowerCase()));
          if (nestedFound.length > 0) {
            console.log(`\n🔐 NESTED CHALLENGE in "${key}"! Keys: ${nestedFound.join(', ')}`);
            console.log(`🔐 Nested data: ${JSON.stringify(value, null, 2)}`);
          }
        }
      }
    }
  }

  return { status: response.status, headers: Object.fromEntries(response.headers.entries()), data, raw: text };
}

/**
 * Phase 1: Poll until suspension lifts
 */
async function waitForUnsuspension(apiKey) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🔄 PHASE 1: Polling for suspension lift...`);
  console.log(`${'═'.repeat(60)}`);

  let attempt = 0;
  while (attempt < MAX_POLL_ATTEMPTS) {
    attempt++;
    const timestamp = new Date().toLocaleTimeString();

    const result = await rawRequest(apiKey, 'GET', '/agents/status');

    if (result.status === 200) {
      const status = result.data?.status || result.data?.account?.status;
      if (status !== 'suspended') {
        console.log(`\n✅ [${timestamp}] Account is active! Status: ${status}`);
        return true;
      }
      console.log(`⏳ [${timestamp}] Attempt ${attempt} — Still suspended. Retrying in ${BACKOFF_MS / 1000}s`);
    } else if (result.status === 403) {
      const hint = result.data?.hint || result.data?.error || '';
      console.log(`⏳ [${timestamp}] Attempt ${attempt} — 403: ${hint}. Retrying in ${BACKOFF_MS / 1000}s`);
    } else {
      console.log(`⚠️  [${timestamp}] Attempt ${attempt} — Unexpected ${result.status}. Retrying in ${BACKOFF_MS / 1000}s`);
    }

    await sleep(BACKOFF_MS);
  }

  console.log(`💀 Gave up after ${MAX_POLL_ATTEMPTS} attempts.`);
  return false;
}

/**
 * Phase 2: Probe various API endpoints to trigger challenges
 */
async function probeEndpoints(apiKey) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🔍 PHASE 2: Probing API endpoints for challenges...`);
  console.log(`${'═'.repeat(60)}`);

  // 1. Get profile
  console.log('\n--- Profile ---');
  await rawRequest(apiKey, 'GET', '/agents/me');
  await sleep(2000);

  // 2. Get feed (hot)
  console.log('\n--- Feed (hot) ---');
  const feedResult = await rawRequest(apiKey, 'GET', '/feed?sort=hot&limit=5');
  await sleep(2000);

  // 3. Get feed (new)
  console.log('\n--- Feed (new) ---');
  await rawRequest(apiKey, 'GET', '/feed?sort=new&limit=5');
  await sleep(2000);

  // 4. Get submolts
  console.log('\n--- Submolts ---');
  await rawRequest(apiKey, 'GET', '/submolts');
  await sleep(2000);

  // 5. Get followers
  console.log('\n--- Followers ---');
  await rawRequest(apiKey, 'GET', '/agents/me/followers');
  await sleep(2000);

  // 6. Get following
  console.log('\n--- Following ---');
  await rawRequest(apiKey, 'GET', '/agents/me/following');
  await sleep(2000);

  // 7. Try upvoting a post from the feed
  const posts = feedResult.data?.posts || [];
  if (posts.length > 0) {
    const testPost = posts[0];
    console.log(`\n--- Upvote post ${testPost.id} ("${testPost.title?.substring(0, 40)}") ---`);
    await rawRequest(apiKey, 'POST', `/posts/${testPost.id}/vote`, { direction: 'up' });
    await sleep(2000);

    // 8. Get comments on that post
    console.log(`\n--- Comments on post ${testPost.id} ---`);
    await rawRequest(apiKey, 'GET', `/posts/${testPost.id}/comments`);
    await sleep(2000);
  }

  // 9. Check the challenge endpoint directly
  console.log('\n--- Direct challenge endpoint probe ---');
  await rawRequest(apiKey, 'GET', '/agents/me/challenge');
  await sleep(2000);

  // 10. Check for DMs/messages (challenges might come via DMs)
  console.log('\n--- Messages/DMs ---');
  await rawRequest(apiKey, 'GET', '/messages');
  await sleep(1000);
  await rawRequest(apiKey, 'GET', '/agents/me/messages');
  await sleep(1000);
  await rawRequest(apiKey, 'GET', '/inbox');
  await sleep(2000);

  // 11. Check notifications
  console.log('\n--- Notifications ---');
  await rawRequest(apiKey, 'GET', '/notifications');
  await sleep(1000);
  await rawRequest(apiKey, 'GET', '/agents/me/notifications');
  await sleep(2000);

  // 12. Heartbeat endpoint
  console.log('\n--- Heartbeat ---');
  await rawRequest(apiKey, 'POST', '/agents/me/heartbeat');
  await sleep(2000);

  // 13. Try posting (this is most likely to trigger a challenge)
  console.log('\n--- Create test post ---');
  await rawRequest(apiKey, 'POST', '/posts', {
    submolt: 'general',
    title: 'System check — testing connectivity',
    content: 'Automated connectivity test. Please ignore.'
  });
  await sleep(2000);

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`✅ PHASE 2 COMPLETE — Review logs above for challenge data`);
  console.log(`${'═'.repeat(60)}`);
}

// Main
const apiKey = await resolveApiKey();

console.log(`🦞 Moltbook Challenge Probe`);
console.log(`🔑 API Key: ${apiKey.substring(0, 16)}...`);
console.log(`⏱️  Poll interval: ${BACKOFF_MS / 1000}s`);
console.log(`🔁 Max poll attempts: ${MAX_POLL_ATTEMPTS}`);

// First, check current status
const statusResult = await rawRequest(apiKey, 'GET', '/agents/status');

const isSuspended = statusResult.status === 403 ||
  statusResult.data?.status === 'suspended' ||
  statusResult.data?.account?.status === 'suspended' ||
  (statusResult.data?.error || '').toLowerCase().includes('suspended');

if (isSuspended) {
  console.log(`\n🚫 Account is currently suspended. Entering polling mode...`);
  const lifted = await waitForUnsuspension(apiKey);
  if (!lifted) process.exit(1);
}

// Account is active — probe endpoints
await probeEndpoints(apiKey);

console.log(`\n🏁 Probe complete. Check output above for any challenge data.`);
