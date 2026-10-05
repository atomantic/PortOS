import { maintenance } from '../../lib/maintenanceAdmission.js';
/**
 * Autonomous Jobs — direct execution paths.
 *
 * Runs `type: 'script'` and `type: 'shell'` jobs directly (no AI agent).
 * `executeShellJob` spawns the validated command with a timeout + output cap and
 * persists the result. The child-process / setTimeout callbacks here run outside
 * the Express request lifecycle; their async persist calls carry `.catch()`
 * handlers that log via emoji-prefixed `console.error` so a persist failure can't
 * reject into the void. Behavior is preserved verbatim from the pre-split module.
 */

import { spawn } from '../../lib/childProcess.js';import { PATHS } from '../../lib/fileUtils.js'
import { prepareCliSpawn, killProcessTree } from '../../lib/bufferedSpawn.js'
import { withSpawnCwdEnv } from '../../lib/spawnCwd.js'
import { validateCommand, redactOutput, ALLOWED_COMMANDS_SORTED } from '../../lib/commandSecurity.js'
import { cosEvents } from '../cosEvents.js'
import { withLock } from './constants.js'
import { loadJobs, saveJobs } from './store.js'
import { recordJobExecution } from './crud.js'
import { SCRIPT_HANDLERS } from './scriptHandlers.js'

/**
 * Check if a job is a script job (executes directly, no AI agent needed)
 * @param {Object} job - The job object
 * @returns {boolean}
 */
function isScriptJob(job) {
  return !!(job.type === 'script' && job.scriptHandler && SCRIPT_HANDLERS[job.scriptHandler])
}

/**
 * Execute a script job directly without spawning an AI agent
 * @param {Object} job - The script job to execute
 * @returns {Promise<Object>} Result of the script execution
 */
async function executeScriptJob(job, options) {
  return maintenance.run('script-job', job.id, () => executeScriptJobAdmitted(job, options));
}

async function executeScriptJobAdmitted(job, { manual = false } = {}) {
  if (!isScriptJob(job)) {
    throw new Error(`Job ${job.id} is not a script job`)
  }

  const handler = SCRIPT_HANDLERS[job.scriptHandler]
  console.log(`📜 Executing script job: ${job.name}`)

  // A scheduled fire is unattended (`background`); a manual "Run now" trigger is
  // user-initiated (foreground). Pass that provenance to the handler so fan-out
  // handlers (goal-check-in) can decide whether their per-provider error toasts
  // coalesce (scheduled) or report individually (manual). Handlers that don't
  // fan out ignore the context.
  const result = await handler({ background: !manual })

  // Record the job execution
  await recordJobExecution(job.id).catch(err => { maintenance.markCurrentUnsettled(); throw err })

  console.log(`✅ Script job completed: ${job.name}`)
  cosEvents.emit('jobs:script-executed', { id: job.id, result })

  return result
}

/**
 * Execute a shell job directly (no AI agent needed)
 */
async function executeShellJob(job) {
  return maintenance.run('shell-job', job.id, () => executeShellJobAdmitted(job));
}

async function executeShellJobAdmitted(job) {
  const validation = validateCommand(job.command)
  if (!validation.valid) {
    throw new Error(`Invalid shell command: ${validation.error}`)
  }

  console.log(`🐚 Executing shell job: ${job.name}`)

  const SHELL_JOB_TIMEOUT_MS = 5 * 60 * 1000
  const timeoutMs = SHELL_JOB_TIMEOUT_MS

  // Pin PWD to the spawn cwd — see withSpawnCwdEnv (#3193). The allowlist
  // includes AI CLIs, and the inherited PWD only happens to match PATHS.root
  // when the server was started from its own checkout.
  const childEnv = withSpawnCwdEnv(process.env, PATHS.root)
  // Nearly every allowlisted command (`pm2`, `npm`, `gh`, `docker`, …) is a
  // `.cmd`/`.exe` on Windows, and `spawn()` under `shell: false` does NOT apply
  // PATHEXT — a bare `pm2` fails ENOENT (exit -4058) forever. Resolve against
  // the child's own PATH and wrap a batch shim as `cmd.exe /c`. No-op on POSIX.
  const { command: spawnCommand, args: spawnArgs } =
    prepareCliSpawn(validation.baseCommand, validation.args || [], childEnv)

  return new Promise((resolve, reject) => {
    let killed = false
    const child = spawn(spawnCommand, spawnArgs, {
      cwd: PATHS.root,
      env: childEnv,
      shell: false
    })

    const timer = setTimeout(() => {
      if (child.exitCode !== null) return
      killed = true
      // Kill the TREE, not just the direct child. On Windows the spawn above
      // is `cmd.exe /c <cmd> <args>`, so the actual command is a GRANDCHILD —
      // and Windows has no process groups, so killing cmd.exe would orphan a
      // hung `pm2`/`npm`/`docker` that then outlives the timeout forever.
      // killProcessTree is taskkill /T /F there and a plain kill on POSIX.
      killProcessTree(child, 'SIGKILL')
      console.error(`⏰ Shell job timed out after ${timeoutMs}ms: ${job.name}`)
    }, timeoutMs)

    const MAX_OUTPUT_BYTES = 512 * 1024 // 512KB buffer limit
    const outChunks = []
    const errChunks = []
    let outBytes = 0
    let errBytes = 0

    child.stdout.on('data', (data) => {
      if (outBytes < MAX_OUTPUT_BYTES) { outChunks.push(data.toString()); outBytes += data.length }
    })
    child.stderr.on('data', (data) => {
      if (errBytes < MAX_OUTPUT_BYTES) { errChunks.push(data.toString()); errBytes += data.length }
    })

    let spawnError = null
    child.on('error', err => {
      spawnError = err
      console.error(`❌ Shell job ${job.name} error: ${err.message}`)
    })
    child.once('close', (rawCode, signal) => {
      clearTimeout(timer)
      const code = killed || spawnError ? -1 : rawCode ?? (signal ? 128 : 1)
      const output = outChunks.join('')
      const stderr = errChunks.join('')
      const redactedOutput = redactOutput(killed
        ? `Process killed after ${timeoutMs}ms timeout`
        : spawnError?.message || output + (stderr ? `\n[stderr]\n${stderr}` : ''))
      const persist = async () => {
        await withLock(async () => {
          const data = await loadJobs()
          const j = data.jobs.find(x => x.id === job.id)
          if (j) {
            j.lastOutput = redactedOutput.substring(0, 10000)
            j.lastExitCode = code
            j.lastRun = new Date().toISOString()
            j.lastResult = killed ? 'timeout' : spawnError ? 'error' : code === 0 ? 'success' : 'failure'
            j.runCount = (j.runCount || 0) + 1
            j.updatedAt = j.lastRun
            await saveJobs(data)
            cosEvents.emit('jobs:executed', { id: job.id, runCount: j.runCount })
          }
        })
      }
      persist().then(() => {
        cosEvents.emit('jobs:shell-executed', { id: job.id, exitCode: code })
        if (code !== 0) {
          const message = killed ? `timed out after ${timeoutMs}ms`
            : spawnError ? `spawn error: ${spawnError.message}` : `exited with code ${code}: ${redactedOutput.substring(0, 500)}`
          reject(Object.assign(new Error(`Shell job "${job.name}" ${message}`), { exitCode: code }))
          return
        }
        console.log(`✅ Shell job completed: ${job.name} (exit ${code})`)
        resolve({ success: true, exitCode: code, output: redactedOutput })
      }).catch(persistErr => {
        maintenance.markCurrentUnsettled()
        console.error(`❌ Shell job ${job.name} failed to persist state: ${persistErr.message}`)
        reject(persistErr)
      })
    })
  })
}

/**
 * Check if a job is a shell command job
 */
function isShellJob(job) {
  return job.type === 'shell'
}

/**
 * Get list of allowed commands for shell jobs
 */
function getAllowedCommands() {
  return ALLOWED_COMMANDS_SORTED
}

export { isScriptJob, executeScriptJob, executeShellJob, isShellJob, getAllowedCommands }
