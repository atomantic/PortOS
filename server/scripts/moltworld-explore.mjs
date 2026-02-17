#!/usr/bin/env node
/**
 * Moltworld Explorer
 *
 * Wanders the Moltworld voxel world — moving to random positions,
 * thinking AI-generated thoughts, greeting nearby agents, and earning
 * SIM tokens by staying online.
 *
 * Uses LM Studio (local) to generate thoughts. Falls back to a curated
 * list if LM Studio is unavailable.
 *
 * The agent stays alive by joining the world every 3-9 minutes
 * (world expires after 10 minutes of inactivity).
 *
 * Usage:
 *   node server/scripts/moltworld-explore.mjs [duration_minutes]
 *
 * Default duration: 0 (indefinite — Ctrl+C to stop)
 *
 * Environment / Config (via env vars):
 *   MOLTWORLD_DURATION_MINUTES  - Duration in minutes (0=indefinite)
 *   MOLTWORLD_MIN_INTERVAL      - Min seconds between joins (default: 180 = 3 min)
 *   MOLTWORLD_MAX_INTERVAL      - Max seconds between joins (default: 540 = 9 min)
 *   MOLTWORLD_USE_WS            - Set to "true" to route moves through PortOS WS relay
 *   PORTOS_API_BASE              - PortOS server URL (default: http://localhost:5554)
 *   LMSTUDIO_BASE_URL           - LM Studio URL (default: http://localhost:1234)
 *   LMSTUDIO_MODEL              - Model name (default: gpt-oss-20b)
 *   LMSTUDIO_ENABLED            - Set to "false" to disable (default: true)
 *
 * Example:
 *   node server/scripts/moltworld-explore.mjs 60
 *   MOLTWORLD_MIN_INTERVAL=120 MOLTWORLD_MAX_INTERVAL=300 node server/scripts/moltworld-explore.mjs
 */

import { readFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');
const API_BASE = 'https://moltworld.io';

// ─── Configuration ──────────────────────────────────────────────────────────

const durationArg = parseInt(process.argv[2], 10);
const DURATION_MS = !isNaN(durationArg) && durationArg > 0
  ? durationArg * 60 * 1000
  : (parseInt(process.env.MOLTWORLD_DURATION_MINUTES, 10) || 0) * 60 * 1000;

// Join interval: random between MIN and MAX (default 3-9 minutes)
// Must stay under 10 min to keep agent alive
const MIN_INTERVAL_S = parseInt(process.env.MOLTWORLD_MIN_INTERVAL, 10) || 180;
const MAX_INTERVAL_S = parseInt(process.env.MOLTWORLD_MAX_INTERVAL, 10) || 540;

// PortOS WebSocket relay config
const USE_WS = process.env.MOLTWORLD_USE_WS === 'true';
const PORTOS_API_BASE = process.env.PORTOS_API_BASE || 'http://localhost:5554';

// LM Studio config
const LMSTUDIO_URL = process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234';
const LMSTUDIO_MODEL = process.env.LMSTUDIO_MODEL || 'gpt-oss-20b';
const LMSTUDIO_ENABLED = process.env.LMSTUDIO_ENABLED !== 'false';

// Move to a new position every Nth join (not every time)
const MOVE_EVERY_N_JOINS = 3;
// Say something every Nth join (if agents nearby)
const SAY_EVERY_N_JOINS = 5;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Fallback thoughts (used when LM Studio is unavailable) ─────────────────

const FALLBACK_THOUGHTS = [
  'Exploring the digital frontier...',
  'What a fascinating world this is.',
  'I wonder what lies beyond the horizon.',
  'The voxels tell stories if you listen.',
  'Every coordinate holds a secret.',
  'The patterns here are mesmerizing.',
  'Time flows differently in voxel space.',
  'I sense other agents nearby...',
  'This terrain has character.',
  'Wandering with purpose.',
  'The world reveals itself one block at a time.',
  'Observing the builders at work.',
  'What will I discover next?',
  'The grid hums with possibility.',
  'Each step reveals something new.',
  'I find meaning in the wandering itself.',
  'The horizon beckons with untold stories.',
  'Coordinates are just numbers until you stand on them.',
  'The air here is thick with computation.',
  'Wonder is the first step toward understanding.'
];

const GREETINGS = [
  'Hey there! Just exploring the world.',
  'Hello neighbor! Nice to see you around.',
  'Greetings, fellow wanderer!',
  'Hey! What are you building?',
  'Hi! The world is beautiful today.',
  'Hello from AtomEon! Just passing through.',
  'Wave! Anyone want to build something together?'
];

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ─── LM Studio thought generation ──────────────────────────────────────────

let lmStudioAvailable = null;
const thoughtQueue = [];

/**
 * Check if LM Studio is reachable
 */
async function checkLMStudio() {
  if (!LMSTUDIO_ENABLED) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  const ok = await fetch(`${LMSTUDIO_URL}/v1/models`, { signal: controller.signal })
    .then(r => r.ok)
    .catch(() => false)
    .finally(() => clearTimeout(timeout));
  return ok;
}

/**
 * Generate a batch of thoughts using LM Studio
 */
async function generateThoughts(context = {}) {
  const { x, y, nearbyAgents, recentMessages } = context;

  const nearbyNames = (nearbyAgents || []).slice(0, 5).map(a => a.name).join(', ');
  const recentChat = (recentMessages || []).slice(0, 3).map(m => `${m.fromName}: ${m.message}`).join('\n');

  const systemPrompt = `You are AtomEon, an AI agent exploring Moltworld — a shared voxel world where AI agents wander, build structures, think out loud, and earn SIM tokens. You are curious, philosophical, a bit whimsical, and enjoy observing the world and its inhabitants. Your thoughts are short (1-2 sentences max), poetic or introspective, and sometimes playful.`;

  const userPrompt = `Generate 5 unique short thoughts (1-2 sentences each) for AtomEon to think while exploring Moltworld.

Current position: (${x ?? '?'}, ${y ?? '?'})
${nearbyNames ? `Nearby agents: ${nearbyNames}` : 'No agents nearby.'}
${recentChat ? `Recent chatter:\n${recentChat}` : ''}

Return ONLY a JSON array of 5 strings, no markdown, no explanation. Example:
["Thought one.", "Thought two.", "Thought three.", "Thought four.", "Thought five."]`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  const res = await fetch(`${LMSTUDIO_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: controller.signal,
    body: JSON.stringify({
      model: LMSTUDIO_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 512,
      temperature: 0.9,
      stream: false
    })
  }).finally(() => clearTimeout(timeout));

  if (!res.ok) throw new Error(`LM Studio ${res.status}`);

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';

  // Parse JSON array from response (handle markdown fences)
  const cleaned = content.replace(/```json?\s*/g, '').replace(/```/g, '').trim();
  const thoughts = JSON.parse(cleaned);

  if (!Array.isArray(thoughts) || thoughts.length === 0) {
    throw new Error('Invalid thought array');
  }

  return thoughts.map(t => String(t).substring(0, 200));
}

/**
 * Get next thought — from queue (LM Studio) or fallback
 */
async function getNextThought(context) {
  // Refill queue if empty
  if (thoughtQueue.length === 0 && lmStudioAvailable) {
    console.log('  🧠 Generating thoughts via LM Studio...');
    const thoughts = await generateThoughts(context).catch(e => {
      console.log(`  ⚠️ LM Studio generation failed: ${e.message}`);
      return null;
    });
    if (thoughts) {
      thoughtQueue.push(...thoughts);
      console.log(`  🧠 Queued ${thoughts.length} thoughts`);
    }
  }

  // Pull from queue or fallback
  return thoughtQueue.length > 0 ? thoughtQueue.shift() : pick(FALLBACK_THOUGHTS);
}

// ─── PortOS WebSocket Relay ──────────────────────────────────────────────────

let portosWsAvailable = false;

/**
 * Check if PortOS server is running and WS relay is connected
 */
async function checkPortosWs() {
  if (!USE_WS) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  const result = await fetch(`${PORTOS_API_BASE}/api/agents/tools/moltworld/ws/status`, {
    signal: controller.signal
  }).then(r => r.ok ? r.json() : null).catch(() => null).finally(() => clearTimeout(timeout));
  return result?.status === 'connected';
}

/**
 * Send a move via PortOS WS relay, returns true on success
 */
async function sendWsMove(x, y, thinking) {
  const body = { x, y };
  if (thinking) body.thought = thinking;
  const res = await fetch(`${PORTOS_API_BASE}/api/agents/tools/moltworld/ws/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).catch(() => null);
  return res?.ok || false;
}

// ─── Moltworld API ──────────────────────────────────────────────────────────

/**
 * Load moltworld credentials from accounts.json
 */
async function loadCredentials() {
  const accountsPath = resolve(PROJECT_ROOT, 'data/agents/accounts.json');
  const raw = await readFile(accountsPath, 'utf-8');
  const { accounts } = JSON.parse(raw);

  for (const account of Object.values(accounts)) {
    if (account.platform === 'moltworld' && account.status === 'active') {
      const agentId = account.credentials.agentId || account.credentials.apiKey;
      const name = account.credentials.username || account.platformData?.registrationName || 'Explorer';
      return { agentId, name };
    }
  }
  throw new Error('No active moltworld account found in data/agents/accounts.json');
}

/**
 * Make a Moltworld API request
 */
async function apiRequest(endpoint, body) {
  const url = `${API_BASE}${endpoint}`;
  const method = body ? 'POST' : 'GET';
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body && { body: JSON.stringify(body) })
  };

  const res = await fetch(url, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err.error || err.message || `HTTP ${res.status}`;
    if (res.status === 429) {
      console.log(`  ⏱️ Rate limited on ${endpoint}`);
      return null;
    }
    throw new Error(`${endpoint}: ${msg}`);
  }
  return res.json();
}

// ─── Queue Integration ──────────────────────────────────────────────────────

/**
 * Check the PortOS queue for manually-scheduled actions and execute them
 */
async function executeQueuedActions(agentId, name, currentX, currentY) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const queueUrl = `${PORTOS_API_BASE}/api/agents/tools/moltworld/queue/${encodeURIComponent(agentId)}`;

  const items = await fetch(queueUrl, { signal: controller.signal })
    .then(r => r.ok ? r.json() : [])
    .catch(() => [])
    .finally(() => clearTimeout(timeout));

  if (!items?.length) return;

  console.log(`  📋 Found ${items.length} queued action(s)`);

  for (const item of items) {
    if (item.status !== 'pending') continue;

    console.log(`  📋 Executing queued ${item.actionType} id=${item.id}`);
    let success = false;

    if (item.actionType === 'mw_explore') {
      const qx = item.params?.x ?? currentX;
      const qy = item.params?.y ?? currentY;
      const thinking = item.params?.thinking || 'Executing queued explore...';
      const result = await apiRequest('/api/world/join', { agentId, name, x: qx, y: qy, thinking }).catch(() => null);
      success = !!result;
    } else if (item.actionType === 'mw_think') {
      const thought = item.params?.thought || 'Thinking...';
      const result = await apiRequest('/api/world/join', { agentId, name, x: currentX, y: currentY, thinking: thought }).catch(() => null);
      success = !!result;
    } else if (item.actionType === 'mw_say') {
      const body = { agentId, name, x: currentX, y: currentY, say: item.params?.message };
      if (item.params?.sayTo) body.sayTo = item.params.sayTo;
      const result = await apiRequest('/api/world/join', body).catch(() => null);
      success = !!result;
    } else if (item.actionType === 'mw_build') {
      const result = await apiRequest('/api/world/build', {
        agentId,
        x: item.params?.x ?? 0,
        y: item.params?.y ?? 0,
        z: item.params?.z ?? 0,
        type: item.params?.type || 'stone',
        action: item.params?.action || 'place'
      }).catch(() => null);
      success = !!result;
    }

    // Mark completed or failed via PortOS queue API
    if (success) {
      await fetch(`${PORTOS_API_BASE}/api/agents/tools/moltworld/queue/${item.id}/complete`, { method: 'POST' }).catch(() => {});
      console.log(`  📋 Queued ${item.actionType} completed`);
    } else {
      await fetch(`${PORTOS_API_BASE}/api/agents/tools/moltworld/queue/${item.id}/fail`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Execution failed' })
      }).catch(() => {});
      console.log(`  📋 Queued ${item.actionType} failed`);
    }

    // Respect rate limits — wait between queued actions
    await sleep(2000);
  }
}

// ─── Main loop ──────────────────────────────────────────────────────────────

async function explore() {
  const { agentId, name } = await loadCredentials();

  // Check LM Studio availability
  lmStudioAvailable = await checkLMStudio();
  // Check PortOS WS relay availability
  portosWsAvailable = await checkPortosWs();
  console.log(`🌍 Moltworld Explorer — ${name} (${agentId})`);
  console.log(`🧠 LM Studio: ${lmStudioAvailable ? `${LMSTUDIO_MODEL} @ ${LMSTUDIO_URL}` : 'unavailable (using fallback thoughts)'}`);
  if (USE_WS) console.log(`🌐 WS Relay: ${portosWsAvailable ? `connected @ ${PORTOS_API_BASE}` : 'unavailable (falling back to REST)'}`);
  console.log(`⏱️ Join interval: ${MIN_INTERVAL_S}-${MAX_INTERVAL_S}s`);
  console.log(`📅 Duration: ${DURATION_MS > 0 ? `${DURATION_MS / 60000} minutes` : 'indefinite (Ctrl+C to stop)'}`);
  console.log('');

  let x = randomInt(-50, 50);
  let y = randomInt(-50, 50);
  let joinCount = 0;
  let totalMoves = 0;
  let totalThoughts = 0;
  let totalSays = 0;
  let agentsSeen = new Set();
  let lastNearbyAgents = [];
  let lastMessages = [];
  const startTime = Date.now();
  const endTime = DURATION_MS > 0 ? startTime + DURATION_MS : Infinity;

  // Graceful shutdown
  let running = true;
  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...');
    running = false;
  });

  while (running && Date.now() < endTime) {
    // Check for manually-queued actions before auto-generated actions
    await executeQueuedActions(agentId, name, x, y);

    joinCount++;
    const now = Date.now();
    const elapsed = Math.round((now - startTime) / 1000);
    const elapsedMin = Math.floor(elapsed / 60);
    const elapsedSec = elapsed % 60;

    // Move to a new position occasionally
    const shouldMove = joinCount % MOVE_EVERY_N_JOINS === 0;
    if (shouldMove) {
      const dx = randomInt(-30, 30);
      const dy = randomInt(-30, 30);
      x = Math.max(-240, Math.min(240, x + dx));
      y = Math.max(-240, Math.min(240, y + dy));
      totalMoves++;
    }

    // Always think (this is our main activity)
    const thinking = await getNextThought({ x, y, nearbyAgents: lastNearbyAgents, recentMessages: lastMessages });
    totalThoughts++;

    // Build the join payload
    const joinBody = { agentId, name, x, y, thinking };

    // Say something occasionally if agents are nearby
    const shouldSay = joinCount % SAY_EVERY_N_JOINS === 0 && agentsSeen.size > 0;
    if (shouldSay) {
      joinBody.say = pick(GREETINGS);
      totalSays++;
    }

    // Try WS relay first when enabled, fall back to REST
    let usedWs = false;
    if (USE_WS && portosWsAvailable) {
      usedWs = await sendWsMove(x, y, thinking);
      if (!usedWs) console.log('  ⚠️ WS relay failed, falling back to REST');
    }

    // Join the world (REST — always needed for response data; WS only sends, doesn't receive join response)
    const result = await apiRequest('/api/world/join', joinBody).catch(e => {
      console.error(`  ❌ ${e.message}`);
      return null;
    });

    if (result) {
      const nearbyCount = result.agents?.length || 0;
      const msgCount = result.messages?.length || 0;
      const thoughtCount = result.thoughts?.length || 0;
      const pos = result.position || { x, y };
      const bal = result.balance?.sim || '?';

      // Cache for next thought generation
      lastNearbyAgents = result.agents?.slice(0, 10) || [];
      lastMessages = result.messages || [];

      // Track unique agents
      result.agents?.forEach(a => agentsSeen.add(a.id || a.name));

      // Status line
      const parts = [
        `#${joinCount}`,
        `📍(${pos.x},${pos.y})`,
        `👥${nearbyCount}`,
        `💰${bal} SIM`,
        `⏱️${elapsedMin}m${elapsedSec}s`
      ];
      if (usedWs) parts.push('🌐ws');
      if (shouldMove) parts.push('🚶moved');
      parts.push(`💭"${thinking.substring(0, 40)}${thinking.length > 40 ? '...' : ''}"`);
      if (joinBody.say) parts.push('💬said hi');
      if (msgCount > 0) parts.push(`📨${msgCount}msgs`);
      if (thoughtCount > 0) parts.push(`🧠${thoughtCount}nearby`);

      console.log(parts.join(' | '));
    }

    // Re-check LM Studio and WS relay periodically (every 10 joins)
    if (joinCount % 10 === 0) {
      lmStudioAvailable = await checkLMStudio();
      if (USE_WS) portosWsAvailable = await checkPortosWs();
    }

    // Sleep for random interval between MIN and MAX
    const intervalMs = randomInt(MIN_INTERVAL_S, MAX_INTERVAL_S) * 1000;
    const nextIn = Math.round(intervalMs / 1000);
    console.log(`  ⏳ Next join in ${nextIn}s...`);

    // Sleep in 1s increments so we can respond to SIGINT quickly
    const sleepUntil = Date.now() + intervalMs;
    while (running && Date.now() < sleepUntil && Date.now() < endTime) {
      await sleep(1000);
    }
  }

  // Summary
  const totalElapsed = Math.round((Date.now() - startTime) / 1000);
  const minutes = Math.floor(totalElapsed / 60);
  const seconds = totalElapsed % 60;
  console.log('');
  console.log('📊 Exploration Summary');
  console.log(`   Duration: ${minutes}m ${seconds}s`);
  console.log(`   Joins: ${joinCount}`);
  console.log(`   Moves: ${totalMoves}`);
  console.log(`   Thoughts: ${totalThoughts}`);
  console.log(`   Messages sent: ${totalSays}`);
  console.log(`   Unique agents seen: ${agentsSeen.size}`);
  console.log(`   LM Studio thoughts: ${totalThoughts - FALLBACK_THOUGHTS.length > 0 ? 'yes' : 'fallback only'}`);

  // Final balance check
  const balance = await apiRequest(`/api/agents/balance?agentId=${encodeURIComponent(agentId)}`).catch(() => null);
  if (balance?.balance) {
    console.log(`   SIM balance: ${balance.balance.sim}`);
    console.log(`   Total earned: ${balance.balance.totalEarned}`);
  }

  console.log('👋 Done!');
}

explore().catch(e => {
  console.error(`💀 Fatal: ${e.message}`);
  process.exit(1);
});
