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

import { spawn } from 'child_process'
import { PATHS } from '../../lib/fileUtils.js'
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
async function executeScriptJob(job, { manual = false } = {}) {
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
  await recordJobExecution(job.id)

  console.log(`✅ Script job completed: ${job.name}`)
  cosEvents.emit('jobs:script-executed', { id: job.id, result })

  return result
}

/**
 * Execute a shell job directly (no AI agent needed)
 */
async function executeShellJob(job) {
  const validation = validateCommand(job.command)
  if (!validation.valid) {
    throw new Error(`Invalid shell command: ${validation.error}`)
  }

  console.log(`🐚 Executing shell job: ${job.name}`)

  const SHELL_JOB_TIMEOUT_MS = 5 * 60 * 1000
  const timeoutMs = SHELL_JOB_TIMEOUT_MS

  return new Promise((resolve, reject) => {
    let killed = false
    const child = spawn(validation.baseCommand, validation.args || [], {
      cwd: PATHS.root,
      shell: false,
      windowsHide: true
    })

    const timer = setTimeout(() => {
      if (child.exitCode !== null) return
      killed = true
      child.kill('SIGKILL')
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

    child.on('close', (rawCode, signal) => {
      const code = rawCode ?? (signal ? 128 : 1)
      clearTimeout(timer)
      if (killed) {
        const persistTimeout = async () => {
          await withLock(async () => {
            const data = await loadJobs()
            const j = data.jobs.find(x => x.id === job.id)
            if (j) {
              j.lastOutput = `Process killed after ${timeoutMs}ms timeout`
              j.lastExitCode = -1
              j.lastResult = 'timeout'
              await saveJobs(data)
            }
          })
          await recordJobExecution(job.id)
        }
        persistTimeout().then(() => {
          const err = new Error(`Shell job "${job.name}" timed out after ${timeoutMs}ms`)
          err.exitCode = -1
          reject(err)
        }).catch((persistErr) => {
          console.error(`❌ Shell job ${job.name} failed to persist timeout state: ${persistErr.message}`)
          const err = new Error(`Shell job "${job.name}" timed out after ${timeoutMs}ms`)
          err.exitCode = -1
          reject(err)
        })
        return
      }
      const output = outChunks.join('')
      const error = errChunks.join('')
      const fullOutput = output + (error ? `\n[stderr]\n${error}` : '')
      const redactedOutput = redactOutput(fullOutput)

      // Persist output/exit code and record execution in a single lock cycle
      const persist = async () => {
        await withLock(async () => {
          const data = await loadJobs()
          const j = data.jobs.find(x => x.id === job.id)
          if (j) {
            j.lastOutput = redactedOutput.substring(0, 10000)
            j.lastExitCode = code
            j.lastRun = new Date().toISOString()
            j.lastResult = code === 0 ? 'success' : 'failure'
            j.runCount = (j.runCount || 0) + 1
            j.updatedAt = j.lastRun
            await saveJobs(data)
            console.log(`🤖 Shell job executed: ${j.name} (run #${j.runCount})`)
            cosEvents.emit('jobs:executed', { id: job.id, runCount: j.runCount })
          }
        })
      }

      persist().then(() => {
        if (code !== 0) {
          console.error(`❌ Shell job failed: ${job.name} (exit ${code})`)
          cosEvents.emit('jobs:shell-executed', { id: job.id, exitCode: code })
          const err = new Error(`Shell job "${job.name}" exited with code ${code}: ${redactedOutput.substring(0, 500)}`)
          err.exitCode = code
          reject(err)
          return
        }

        console.log(`✅ Shell job completed: ${job.name} (exit ${code})`)
        cosEvents.emit('jobs:shell-executed', { id: job.id, exitCode: code })
        resolve({ success: true, exitCode: code, output: redactedOutput })
      }).catch((persistErr) => {
        console.error(`❌ Shell job ${job.name} failed to persist state: ${persistErr.message}`)
        reject(persistErr)
      })
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      console.error(`❌ Shell job ${job.name} error: ${err.message}`)
      const persistError = async () => {
        await withLock(async () => {
          const data = await loadJobs()
          const j = data.jobs.find(x => x.id === job.id)
          if (j) {
            j.lastOutput = err.message
            j.lastExitCode = -1
            j.lastRun = new Date().toISOString()
            j.lastResult = 'error'
            await saveJobs(data)
          }
        })
        await recordJobExecution(job.id)
      }
      persistError().then(() => {
        reject(new Error(`Shell job "${job.name}" spawn error: ${err.message}`))
      }).catch((persistErr) => {
        console.error(`❌ Shell job ${job.name} failed to persist error state: ${persistErr.message}`)
        reject(new Error(`Shell job "${job.name}" spawn error: ${err.message}`))
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
