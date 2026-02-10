#!/usr/bin/env node
/**
 * Moltbook Claim Bot
 *
 * Retries the claim verification on Moltbook until X.com rate limits clear.
 * Calls the verify-tweet API directly — no browser dependencies needed.
 *
 * Usage:
 *   node server/scripts/moltbook-claim.mjs <claim_token> <tweet_url> [backoff_seconds]
 *
 * Example:
 *   node server/scripts/moltbook-claim.mjs \
 *     "moltbook_claim_abc123" \
 *     "https://x.com/antic/status/1234567890" \
 *     60
 */

const [token, tweetUrl, backoffArg] = process.argv.slice(2);
const BACKOFF_MS = (parseInt(backoffArg, 10) || 60) * 1000;
const MAX_ATTEMPTS = 120;
const API_URL = 'https://www.moltbook.com/api/v1/agents/verify-tweet';

if (!token || !tweetUrl) {
  console.error('Usage: node moltbook-claim.mjs <claim_token> <tweet_url> [backoff_seconds]');
  process.exit(1);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

console.log(`🦞 Moltbook Claim Bot`);
console.log(`🔑 Token: ${token}`);
console.log(`🐦 Tweet: ${tweetUrl}`);
console.log(`⏱️  Backoff: ${BACKOFF_MS / 1000}s between attempts`);
console.log(`🔁 Max attempts: ${MAX_ATTEMPTS}\n`);

let attempt = 0;
while (attempt < MAX_ATTEMPTS) {
  attempt++;
  const timestamp = new Date().toLocaleTimeString();

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, tweet_url: tweetUrl })
  });

  const data = await response.json();

  if (data.success) {
    console.log(`✅ [${timestamp}] Attempt ${attempt} — CLAIMED! 🦞`);
    console.log(JSON.stringify(data, null, 2));
    process.exit(0);
  }

  const detail = data.details ? ` (${data.details})` : '';
  console.log(`❌ [${timestamp}] Attempt ${attempt} — ${data.error}${detail} — retrying in ${BACKOFF_MS / 1000}s`);
  await sleep(BACKOFF_MS);
}

console.log(`\n💀 Failed after ${MAX_ATTEMPTS} attempts.`);
process.exit(1);
