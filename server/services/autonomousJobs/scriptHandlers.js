/**
 * Autonomous Jobs — script handlers.
 *
 * Jobs of `type: 'script'` run one of these handlers directly as a function
 * (or a child process) instead of spawning an AI agent. `SCRIPT_HANDLERS` maps
 * the job's `scriptHandler` name to its implementation.
 */

import { readdir, stat, rm } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'
import { spawn } from 'child_process'
import { DAY, PATHS, readJSONFile } from '../../lib/fileUtils.js'
import { checkAndPrompt as autobiographyCheckAndPrompt } from '../autobiography.js'
import { runGoalCheckIn } from '../goalCheckIn.js'
import { cleanupOrphanedWorktrees, reapMergedWorktrees } from '../worktreeManager.js'
import { getActiveAgentIds } from '../agentState.js'
import { runSelfDiagnostics } from './selfDiagnostics.js'

/**
 * Run the moltworld-explore.mjs script as a child process (no AI agent needed).
 * Returns a summary object when the script exits.
 */
function runMoltworldExploration() {
  const scriptPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'moltworld-explore.mjs')
  const durationMinutes = process.env.MOLTWORLD_DURATION_MINUTES || '30'

  return new Promise((resolve, reject) => {
    const child = spawn('node', [scriptPath, durationMinutes], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env }
    })

    const output = []
    child.stdout.on('data', (chunk) => {
      const line = chunk.toString().trim()
      if (line) {
        output.push(line)
        console.log(`🌍 ${line}`)
      }
    })
    child.stderr.on('data', (chunk) => {
      const line = chunk.toString().trim()
      if (line) console.error(`🌍 ${line}`)
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, lines: output.length })
      } else {
        reject(new Error(`moltworld-explore.mjs exited with code ${code}`))
      }
    })

    child.on('error', (err) => reject(err))
  })
}

/**
 * Remove completed agent data directories older than 7 days, and reap leaked
 * CoS agent worktrees (dirs whose agent is no longer live).
 *
 * The worktree sweep lives here, on the daily scheduled cadence, rather than on
 * the 15-min CoS health-check hot path — running it that often gave it a wide
 * window to remove a human's in-flight `/claim` worktree mid-review.
 * `cleanupOrphanedWorktrees` itself also skips `claim-*` worktrees outright, so
 * the daily cadence is purely about reaping abandoned `agent-*` trees.
 */
async function agentDataCleanup() {
  // Active agent IDs so we never delete data / worktrees for running agents.
  // `getActiveAgentIds` lives in the side-effect-free `agentState.js`, so this
  // script job doesn't pull in the heavier `subAgentSpawner.js` orchestrator
  // (which re-exports the whole agent-lifecycle module graph) just to read the maps.
  const activeIds = new Set(getActiveAgentIds())

  // Also protect PAUSED agents. Pausing intentionally preserves the agent's
  // worktree + data dir as resume context, but a paused agent is removed from
  // the in-memory active/runner maps (so `getActiveAgentIds()` omits it) and —
  // critically — those maps are empty after a server restart while the agent's
  // `status: 'paused'` survives in state.json. Read the persisted status so a
  // paused agent's worktree/transcript is never reaped or rm'd out from under a
  // later resume. (readJSONFile keeps this off the subAgentSpawner import path.)
  const cosState = await readJSONFile(join(PATHS.cos, 'state.json'), null)
  if (cosState?.agents && typeof cosState.agents === 'object') {
    for (const [id, agent] of Object.entries(cosState.agents)) {
      if (agent?.status === 'paused') activeIds.add(id)
    }
  }

  const agentsDir = join(PATHS.cos, 'agents')
  let cleaned = 0
  if (existsSync(agentsDir)) {
    const entries = await readdir(agentsDir)
    const cutoff = Date.now() - 7 * DAY

    for (const entry of entries) {
      if (activeIds.has(entry)) continue
      const entryPath = join(agentsDir, entry)
      const info = await stat(entryPath).catch(() => null)
      if (!info?.isDirectory()) continue
      if (info.mtimeMs < cutoff) {
        const removed = await rm(entryPath, { recursive: true, force: true }).then(() => true, (err) => {
          console.warn(`⚠️ Failed to clean agent dir ${entry}: ${err.message}`)
          return false
        })
        if (removed) cleaned++
      }
    }
  }

  // First pass — SAFE reap: remove any worktree (CoS or `.claude/worktrees/`) whose
  // branch is fully merged into the default branch AND whose working tree is clean.
  // This is the bulk of the cleanup and cannot lose work (merged+clean ⇒ nothing
  // pending). It guards active agents and human `claim-*` worktrees.
  const merged = await reapMergedWorktrees(PATHS.root, { activeAgentIds: activeIds }).catch((err) => {
    console.warn(`⚠️ Merged-worktree reap failed: ${err.message}`)
    return { reaped: [] }
  })

  // Second pass — orphan integration: for inactive CoS worktrees that were NOT
  // merged (e.g. an agent died after committing but before its PR landed), attempt
  // to merge their commits back so the work isn't stranded. The helper guards
  // `claim-*` worktrees, so this can't touch a human's in-flight claim.
  const worktreesReaped = await cleanupOrphanedWorktrees(PATHS.root, activeIds).catch((err) => {
    console.warn(`⚠️ Orphaned worktree cleanup failed: ${err.message}`)
    return 0
  })

  const mergedCount = merged?.reaped?.length || 0
  console.log(`🧹 Agent data cleanup: removed ${cleaned} dir(s) older than 7 days, reaped ${mergedCount} merged + ${worktreesReaped} orphaned worktree(s)`)
  return { cleaned, mergedReaped: mergedCount, worktreesReaped }
}

/**
 * Registry of script handlers for jobs that execute functions directly
 * instead of spawning AI agents. Key is the scriptHandler name, value is the function.
 */
const SCRIPT_HANDLERS = {
  'autobiography-prompt': autobiographyCheckAndPrompt,
  'moltworld-exploration': runMoltworldExploration,
  'agent-data-cleanup': agentDataCleanup,
  'goal-check-in': runGoalCheckIn,
  // Daily self-diagnostics (#2464): reads task-learning per-category metrics and
  // files a single `monitoring`-labeled GitHub summary of failing self-healing
  // categories. Deterministic — no LLM calls (cold-bootstrap-safe).
  'self-diagnostics': runSelfDiagnostics
  // 'layered-intelligence' retired here (#2322): LI is now a per-app scheduled
  // task, not a global autonomous-job sweep. It runs as a normal reasoning agent
  // with programmatic-I/O hooks — see taskTypeHooks.js +
  // autonomousJobs/layeredIntelligenceHooks.js.
}

export { runMoltworldExploration, agentDataCleanup, SCRIPT_HANDLERS }
