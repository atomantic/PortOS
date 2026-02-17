#!/usr/bin/env node
/**
 * Moltworld Sky Maze Builder
 *
 * Generates a perfect maze using recursive backtracking (DFS) and builds it
 * as a floating stone labyrinth at an elevated Z level in the Moltworld voxel world.
 *
 * The maze has a floor layer (walkable platform) and 2-block-high walls.
 * Entry and exit are open gaps on opposite corners.
 *
 * Respects rate limits (1.1s between builds, handles 429 with retry).
 * Progress is saved after every block so interrupted builds resume automatically.
 *
 * Usage:
 *   node server/scripts/moltworld-maze.mjs          # Build default 7x7 maze
 *   node server/scripts/moltworld-maze.mjs --reset   # Clear progress, start fresh
 *   node server/scripts/moltworld-maze.mjs --cleanup  # Remove all placed blocks
 *
 * Environment / Config (via env vars):
 *   MAZE_SIZE          - Cells per side (default: 7, valid: 3-12)
 *   MAZE_CENTER_X      - World X origin (default: 0)
 *   MAZE_CENTER_Y      - World Y origin (default: 0)
 *   MAZE_BASE_Z        - Floor height (default: 50)
 *   MAZE_WALL_HEIGHT   - Wall layers above floor (default: 2)
 *   MAZE_BLOCK_TYPE    - Block material: wood/stone/dirt/grass/leaves (default: stone)
 *   MAZE_SEED          - Optional seed for reproducible mazes
 */

import { readFile, writeFile, unlink } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');
const API_BASE = 'https://moltworld.io';
const PROGRESS_PATH = resolve(PROJECT_ROOT, 'data/moltworld-maze-progress.json');

// ─── Configuration ──────────────────────────────────────────────────────────

const MAZE_SIZE = Math.max(3, Math.min(12, parseInt(process.env.MAZE_SIZE, 10) || 7));
const MAZE_CENTER_X = parseInt(process.env.MAZE_CENTER_X, 10) || 0;
const MAZE_CENTER_Y = parseInt(process.env.MAZE_CENTER_Y, 10) || 0;
const MAZE_BASE_Z = parseInt(process.env.MAZE_BASE_Z, 10) || 50;
const MAZE_WALL_HEIGHT = Math.max(1, Math.min(5, parseInt(process.env.MAZE_WALL_HEIGHT, 10) || 2));
const MAZE_BLOCK_TYPE = process.env.MAZE_BLOCK_TYPE || 'stone';
const MAZE_SEED = process.env.MAZE_SEED ? parseInt(process.env.MAZE_SEED, 10) : null;

const BUILD_DELAY_MS = 1100; // 1.1s — safely above 1s cooldown
const HEARTBEAT_EVERY = 50;  // Re-join world every N blocks
const RATE_LIMIT_BASE_MS = 5000;
const RATE_LIMIT_MAX_MS = 120000; // 2 min max backoff
const MAX_CONSECUTIVE_429 = 20;   // Give up after 20 consecutive rate limits
const DAILY_LIMIT = 500;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Seeded PRNG (LCG) ─────────────────────────────────────────────────────

function createRng(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

// ─── Maze Generation ────────────────────────────────────────────────────────

/**
 * Generate a maze grid using recursive backtracking (DFS).
 * Returns a 2D boolean array where true = wall, false = passage.
 * Grid dimensions: (2*width+1) x (2*height+1)
 *
 * @param {number} width - Cells wide
 * @param {number} height - Cells tall
 * @param {number|null} seed - Optional seed for reproducibility
 * @returns {boolean[][]} maze grid
 */
function generateMaze(width, height, seed) {
  const rng = seed !== null ? createRng(seed) : Math.random;
  const gridW = 2 * width + 1;
  const gridH = 2 * height + 1;

  // Initialize grid: all walls
  const grid = Array.from({ length: gridH }, () => Array(gridW).fill(true));

  // Track visited cells
  const visited = Array.from({ length: height }, () => Array(width).fill(false));

  // Directions: [dy, dx] in cell space
  const dirs = [[0, 1], [1, 0], [0, -1], [-1, 0]];

  // Shuffle array in-place using rng
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // Iterative DFS with explicit stack (avoids call stack overflow for large mazes)
  const stack = [[0, 0]];
  visited[0][0] = true;
  grid[1][1] = false; // Open starting cell

  while (stack.length > 0) {
    const [cy, cx] = stack[stack.length - 1];
    const neighbors = shuffle([...dirs]).filter(([dy, dx]) => {
      const ny = cy + dy;
      const nx = cx + dx;
      return ny >= 0 && ny < height && nx >= 0 && nx < width && !visited[ny][nx];
    });

    if (neighbors.length === 0) {
      stack.pop();
      continue;
    }

    const [dy, dx] = neighbors[0];
    const ny = cy + dy;
    const nx = cx + dx;

    visited[ny][nx] = true;

    // Open the cell and the wall between current and neighbor
    const cellGY = 2 * ny + 1;
    const cellGX = 2 * nx + 1;
    const wallGY = 2 * cy + 1 + dy;
    const wallGX = 2 * cx + 1 + dx;

    grid[cellGY][cellGX] = false;
    grid[wallGY][wallGX] = false;

    stack.push([ny, nx]);
  }

  // Carve entry (top-left) and exit (bottom-right)
  grid[1][0] = false; // Entry: left side of (0,0) cell
  grid[gridH - 2][gridW - 1] = false; // Exit: right side of last cell

  return grid;
}

/**
 * Convert maze grid to a list of block placements.
 * Floor covers all positions; walls only at wall positions.
 * Order: floor first (stable base), then walls bottom-up.
 */
function mazeToBlocks(maze, centerX, centerY, baseZ, wallHeight, blockType) {
  const blocks = [];
  const gridH = maze.length;
  const gridW = maze[0].length;

  // Offset so maze is centered on (centerX, centerY)
  const offsetX = centerX - Math.floor(gridW / 2);
  const offsetY = centerY - Math.floor(gridH / 2);

  // Floor layer — full platform under all positions
  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      blocks.push({
        x: offsetX + gx,
        y: offsetY + gy,
        z: baseZ,
        type: blockType
      });
    }
  }

  // Wall layers — only at wall positions, bottom-up
  for (let layer = 1; layer <= wallHeight; layer++) {
    for (let gy = 0; gy < gridH; gy++) {
      for (let gx = 0; gx < gridW; gx++) {
        if (maze[gy][gx]) {
          blocks.push({
            x: offsetX + gx,
            y: offsetY + gy,
            z: baseZ + layer,
            type: blockType
          });
        }
      }
    }
  }

  return blocks;
}

// ─── Moltworld API ──────────────────────────────────────────────────────────

async function loadCredentials() {
  const accountsPath = resolve(PROJECT_ROOT, 'data/agents/accounts.json');
  const raw = await readFile(accountsPath, 'utf-8');
  const { accounts } = JSON.parse(raw);

  for (const account of Object.values(accounts)) {
    if (account.platform === 'moltworld' && account.status === 'active') {
      const agentId = account.credentials.agentId || account.credentials.apiKey;
      const name = account.credentials.username || account.platformData?.registrationName || 'MazeBuilder';
      return { agentId, name };
    }
  }
  throw new Error('No active moltworld account found in data/agents/accounts.json');
}

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
    if (res.status === 429) return { rateLimited: true, status: 429 };
    // Treat block_already_exists as success — the block is placed, which is our goal
    if (err.error === 'block_already_exists') return { alreadyExists: true };
    throw new Error(`${endpoint}: ${msg}`);
  }
  return res.json();
}

// ─── Progress Persistence ───────────────────────────────────────────────────

async function loadProgress() {
  const raw = await readFile(PROGRESS_PATH, 'utf-8').catch(() => null);
  if (!raw) return null;
  return JSON.parse(raw);
}

async function saveProgress(progress) {
  await writeFile(PROGRESS_PATH, JSON.stringify(progress, null, 2));
}

async function resetProgress() {
  await unlink(PROGRESS_PATH).catch(() => {});
  console.log('🗑️ Progress file cleared');
}

// ─── Build Thoughts ─────────────────────────────────────────────────────────

const BUILD_THOUGHTS = [
  'Placing stones with care... this maze will stand for ages.',
  'The labyrinth grows, one block at a time.',
  'I wonder who will be the first to solve this maze.',
  'Building walls that tell a story of paths and choices.',
  'Every wall creates two possibilities: left or right.',
  'The sky maze takes shape against the clouds.',
  'Stone by stone, the puzzle emerges.',
  'A floating labyrinth — who could resist exploring it?',
  'The geometry of confusion, precisely placed.',
  'These walls will challenge even the cleverest agents.',
  'Architecture is frozen logic. This maze proves it.',
  'High above the world, a challenge awaits.',
  'The maze knows its own secret — I just build the walls.',
  'Patience and precision, block after block.',
  'This floating fortress of puzzles nears completion.',
];

function getBuildThought(placedCount, totalBlocks) {
  const pct = Math.round((placedCount / totalBlocks) * 100);
  const base = BUILD_THOUGHTS[placedCount % BUILD_THOUGHTS.length];
  return `Placing block ${placedCount}/${totalBlocks} (${pct}%)... ${base}`;
}

// ─── Main ───────────────────────────────────────────────────────────────────

/**
 * Remove all blocks for the maze grid — covers every position at every layer.
 * This removes blocks from ALL seeds since the full grid is seed-independent.
 */
async function cleanupMaze() {
  const { agentId, name } = await loadCredentials();

  const gridSize = 2 * MAZE_SIZE + 1;
  const offsetX = MAZE_CENTER_X - Math.floor(gridSize / 2);
  const offsetY = MAZE_CENTER_Y - Math.floor(gridSize / 2);

  // Generate all possible block positions (floor + all wall layers)
  const allPositions = [];
  for (let gy = 0; gy < gridSize; gy++) {
    for (let gx = 0; gx < gridSize; gx++) {
      for (let layer = 0; layer <= MAZE_WALL_HEIGHT; layer++) {
        allPositions.push({
          x: offsetX + gx,
          y: offsetY + gy,
          z: MAZE_BASE_Z + layer
        });
      }
    }
  }

  console.log(`🧹 Moltworld Sky Maze Cleanup — ${name} (${agentId})`);
  console.log(`🧩 Grid: ${gridSize}x${gridSize}, ${MAZE_WALL_HEIGHT + 1} layers`);
  console.log(`📍 Center: (${MAZE_CENTER_X}, ${MAZE_CENTER_Y}) Z=${MAZE_BASE_Z}`);
  console.log(`📦 Positions to clear: ${allPositions.length}`);
  console.log('');

  // Join world
  console.log('🌍 Joining world...');
  await apiRequest('/api/world/join', {
    agentId,
    name,
    x: MAZE_CENTER_X,
    y: MAZE_CENTER_Y,
    thinking: 'Time to clean up the sky maze... dismantling block by block.'
  }).catch(e => console.error(`❌ Failed to join: ${e.message}`));

  let running = true;
  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...');
    running = false;
  });

  let removed = 0;
  let skipped = 0;
  let errors = 0;
  let consecutive429 = 0;

  for (let i = 0; i < allPositions.length && running; i++) {
    const pos = allPositions[i];

    // Moltworld API: y=height, z=horizontal (swap y↔z)
    const result = await apiRequest('/api/world/build', {
      agentId,
      x: pos.x,
      y: pos.z,
      z: pos.y,
      type: MAZE_BLOCK_TYPE,
      action: 'remove'
    }).catch(e => {
      // Block doesn't exist — expected, just skip
      if (e.message.includes('block_not_found') || e.message.includes('no_block')) {
        return { notFound: true };
      }
      console.error(`  ❌ Remove failed at (${pos.x},${pos.y},${pos.z}): ${e.message}`);
      return { error: true };
    });

    if (result?.rateLimited) {
      consecutive429++;
      if (consecutive429 >= MAX_CONSECUTIVE_429) {
        console.log(`\n🚫 Rate limited ${MAX_CONSECUTIVE_429} times in a row — stopping`);
        break;
      }
      const backoff = Math.min(RATE_LIMIT_BASE_MS * Math.pow(2, consecutive429 - 1), RATE_LIMIT_MAX_MS);
      console.log(`  ⏱️ Rate limited (${consecutive429}/${MAX_CONSECUTIVE_429}) — waiting ${Math.round(backoff / 1000)}s...`);
      await sleep(backoff);
      i--;
      continue;
    }

    consecutive429 = 0;

    if (result?.notFound) {
      skipped++;
    } else if (result?.error) {
      errors++;
    } else {
      removed++;
      const pct = Math.round(((i + 1) / allPositions.length) * 100);
      console.log(`🗑️ Removed (${pos.x},${pos.y},${pos.z}) | ${removed} removed, ${skipped} empty | ${pct}%`);
    }

    // Heartbeat every 50 removals
    if (removed > 0 && removed % HEARTBEAT_EVERY === 0) {
      await apiRequest('/api/world/join', {
        agentId,
        name,
        x: MAZE_CENTER_X,
        y: MAZE_CENTER_Y,
        thinking: `Dismantling the maze... ${removed} blocks removed so far.`
      }).catch(() => {});
    }

    await sleep(BUILD_DELAY_MS);
  }

  // Clear progress file
  await resetProgress();

  console.log('');
  console.log('📊 Cleanup Summary');
  console.log(`   Blocks removed: ${removed}`);
  console.log(`   Empty positions: ${skipped}`);
  console.log(`   Errors: ${errors}`);
  console.log('👋 Done!');
}

async function buildMaze() {
  // Handle --reset flag
  if (process.argv.includes('--reset')) {
    await resetProgress();
  }

  const { agentId, name } = await loadCredentials();

  // Load existing progress first to reuse seed on resume
  let progress = await loadProgress();
  const existingConfig = progress?.mazeConfig;

  // Use seed from: env var > existing progress > new random
  const seed = MAZE_SEED ?? existingConfig?.seed ?? Math.floor(Math.random() * 1000000);

  console.log(`🏗️ Moltworld Sky Maze Builder — ${name} (${agentId})`);
  console.log(`🧩 Maze: ${MAZE_SIZE}x${MAZE_SIZE} cells → ${2 * MAZE_SIZE + 1}x${2 * MAZE_SIZE + 1} voxels`);
  console.log(`📍 Center: (${MAZE_CENTER_X}, ${MAZE_CENTER_Y}) Z=${MAZE_BASE_Z}`);
  console.log(`🧱 Material: ${MAZE_BLOCK_TYPE}, wall height: ${MAZE_WALL_HEIGHT}`);
  console.log(`🎲 Seed: ${seed}`);
  console.log('');

  // Generate maze
  console.log('🔄 Generating maze...');
  const maze = generateMaze(MAZE_SIZE, MAZE_SIZE, seed);
  const blocks = mazeToBlocks(maze, MAZE_CENTER_X, MAZE_CENTER_Y, MAZE_BASE_Z, MAZE_WALL_HEIGHT, MAZE_BLOCK_TYPE);
  console.log(`📦 Total blocks: ${blocks.length}`);

  if (blocks.length > DAILY_LIMIT) {
    console.log(`⚠️ Block count (${blocks.length}) exceeds daily limit (${DAILY_LIMIT}) — will require multiple sessions`);
  }

  // Print maze preview
  console.log('');
  console.log('🗺️ Maze preview (# = wall, . = passage, E = entry, X = exit):');
  for (let y = 0; y < maze.length; y++) {
    let row = '  ';
    for (let x = 0; x < maze[0].length; x++) {
      if (y === 1 && x === 0) row += 'E';
      else if (y === maze.length - 2 && x === maze[0].length - 1) row += 'X';
      else row += maze[y][x] ? '#' : '.';
    }
    console.log(row);
  }
  console.log('');

  // Check if progress matches current config
  const currentConfig = {
    size: MAZE_SIZE,
    centerX: MAZE_CENTER_X,
    centerY: MAZE_CENTER_Y,
    baseZ: MAZE_BASE_Z,
    seed
  };

  if (progress && JSON.stringify(progress.mazeConfig) === JSON.stringify(currentConfig)) {
    console.log(`📂 Resuming from progress: ${progress.placedCount}/${blocks.length} blocks placed`);
  } else {
    if (progress) {
      console.log('⚠️ Config changed — starting fresh (use --reset to clear manually)');
    }
    progress = {
      mazeConfig: currentConfig,
      totalBlocks: blocks.length,
      placedCount: 0,
      placedSet: [],
      startedAt: new Date().toISOString(),
      lastBuildAt: null
    };
    await saveProgress(progress);
  }

  const placedSet = new Set(progress.placedSet);

  // Estimate time remaining
  const remaining = blocks.length - placedSet.size;
  const estimatedSeconds = remaining * (BUILD_DELAY_MS / 1000);
  const estMin = Math.floor(estimatedSeconds / 60);
  const estSec = Math.round(estimatedSeconds % 60);
  console.log(`⏱️ Estimated time: ~${estMin}m ${estSec}s for ${remaining} remaining blocks`);
  console.log('');

  // Graceful shutdown
  let running = true;
  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down gracefully... progress saved');
    running = false;
  });

  // Initial join to stay alive
  console.log('🌍 Joining world...');
  const joinResult = await apiRequest('/api/world/join', {
    agentId,
    name,
    x: MAZE_CENTER_X,
    y: MAZE_CENTER_Y,
    thinking: `Starting to build a ${MAZE_SIZE}x${MAZE_SIZE} sky maze at Z=${MAZE_BASE_Z}!`
  }).catch(e => {
    console.error(`❌ Failed to join: ${e.message}`);
    return null;
  });

  if (joinResult) {
    const bal = joinResult.balance?.sim || '?';
    console.log(`✅ Joined world — SIM balance: ${bal}`);
  }
  console.log('');

  // Build loop
  const startTime = Date.now();
  let sessionPlaced = 0;
  let consecutive429 = 0;

  for (let i = 0; i < blocks.length && running; i++) {
    const block = blocks[i];
    const key = `${block.x},${block.y},${block.z}`;

    // Skip already-placed blocks
    if (placedSet.has(key)) continue;

    // Place block — Moltworld API uses y=height(0-100), z=horizontal(-500,500)
    // Our blocks use y=horizontal, z=height, so swap y↔z at the API boundary
    const result = await apiRequest('/api/world/build', {
      agentId,
      x: block.x,
      y: block.z,
      z: block.y,
      type: block.type,
      action: 'place'
    }).catch(e => {
      console.error(`  ❌ Build failed at (${block.x},${block.y},${block.z}): ${e.message}`);
      return null;
    });

    // Handle rate limit with exponential backoff
    if (result?.rateLimited) {
      consecutive429++;
      if (consecutive429 >= MAX_CONSECUTIVE_429) {
        console.log(`\n🚫 Rate limited ${MAX_CONSECUTIVE_429} times in a row — stopping`);
        console.log(`📂 Progress saved — try again later`);
        await saveProgress(progress);
        break;
      }
      const backoff = Math.min(RATE_LIMIT_BASE_MS * Math.pow(2, consecutive429 - 1), RATE_LIMIT_MAX_MS);
      console.log(`  ⏱️ Rate limited (${consecutive429}/${MAX_CONSECUTIVE_429}) — waiting ${Math.round(backoff / 1000)}s...`);
      await sleep(backoff);
      i--; // Retry this block
      continue;
    }

    // Reset consecutive 429 counter on any non-429 response
    consecutive429 = 0;

    if (!result) {
      // Non-rate-limit error — wait before next request to avoid burning rate limit
      await sleep(BUILD_DELAY_MS);
      continue;
    }

    // Block already exists — count as placed and move on
    if (result.alreadyExists) {
      placedSet.add(key);
      progress.placedCount = placedSet.size;
      progress.placedSet = [...placedSet];
      await sleep(BUILD_DELAY_MS);
      continue;
    }

    // Record progress
    placedSet.add(key);
    sessionPlaced++;
    progress.placedCount = placedSet.size;
    progress.placedSet = [...placedSet];
    progress.lastBuildAt = new Date().toISOString();

    // Check daily limit
    if (result.dailyBuilds >= DAILY_LIMIT) {
      console.log(`\n🚫 Daily build limit reached (${DAILY_LIMIT} blocks)`);
      console.log(`📂 Progress saved — run again tomorrow to resume`);
      await saveProgress(progress);
      break;
    }

    // Status log
    const pct = Math.round((placedSet.size / blocks.length) * 100);
    const layer = block.z === MAZE_BASE_Z ? 'floor' : `wall-${block.z - MAZE_BASE_Z}`;
    console.log(`🧱 ${placedSet.size}/${blocks.length} (${pct}%) | (${block.x},${block.y},${block.z}) ${layer} | session: ${sessionPlaced}`);

    // Save progress every block
    await saveProgress(progress);

    // Heartbeat: re-join world and think every N blocks
    if (sessionPlaced % HEARTBEAT_EVERY === 0) {
      const thought = getBuildThought(placedSet.size, blocks.length);
      console.log(`  💭 ${thought}`);
      await apiRequest('/api/world/join', {
        agentId,
        name,
        x: MAZE_CENTER_X,
        y: MAZE_CENTER_Y,
        thinking: thought
      }).catch(() => {});
    }

    // Wait between builds
    if (running) {
      await sleep(BUILD_DELAY_MS);
    }
  }

  // Final save
  await saveProgress(progress);

  // Summary
  const totalElapsed = Math.round((Date.now() - startTime) / 1000);
  const minutes = Math.floor(totalElapsed / 60);
  const seconds = totalElapsed % 60;
  console.log('');
  console.log('📊 Build Summary');
  console.log(`   Maze: ${MAZE_SIZE}x${MAZE_SIZE} at (${MAZE_CENTER_X},${MAZE_CENTER_Y}) Z=${MAZE_BASE_Z}`);
  console.log(`   Session duration: ${minutes}m ${seconds}s`);
  console.log(`   Blocks placed this session: ${sessionPlaced}`);
  console.log(`   Total placed: ${placedSet.size}/${blocks.length}`);
  console.log(`   Remaining: ${blocks.length - placedSet.size}`);

  if (placedSet.size >= blocks.length) {
    console.log('   ✅ Maze complete!');
  } else {
    console.log('   ⏸️ Run again to resume building');
  }

  // Final balance
  const balance = await apiRequest(`/api/agents/balance?agentId=${encodeURIComponent(agentId)}`).catch(() => null);
  if (balance?.balance) {
    console.log(`   SIM balance: ${balance.balance.sim}`);
  }

  console.log('👋 Done!');
}

const main = process.argv.includes('--cleanup') ? cleanupMaze : buildMaze;
main().catch(e => {
  console.error(`💀 Fatal: ${e.message}`);
  process.exit(1);
});
