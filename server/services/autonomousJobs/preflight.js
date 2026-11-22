/**
 * Autonomous Jobs — pre-dispatch configuration validation.
 *
 * `runJobPreflight(job)` is the deterministic, zero-LLM check `executeScheduledJob` runs before it reserves capacity or
 * builds a task: a pinned provider must exist, be enabled and hold the credential it needs; an `appId` must resolve to a
 * repo path that exists on disk; a shell job's command must pass `validateCommand`; a script job's handler must be
 * registered. Only local config and filesystem state is read, so a failure is a configuration verdict (`blocked_config`),
 * never a reason to spawn and fail again every period. Unpinned jobs skip the provider check on purpose: the active
 * provider and fallback chain resolve at dispatch and may legitimately differ from what is configured now.
 */

import { existsSync } from 'fs'
import { validateCommand } from '../../lib/commandSecurity.js'
import { expandHome } from '../../lib/fileUtils.js'
import { providerPrerequisites } from '../../lib/provider/providerPrerequisites.js'
import { getProviderById } from '../provider/providers.js'
import { getAppById } from '../apps.js'
import { SCRIPT_HANDLERS } from './scriptHandlers.js'

async function checkProvider(job) {
  if (!job.providerId) return null
  const provider = await getProviderById(job.providerId)
  if (!provider) return `pinned provider "${job.providerId}" does not exist`
  if (provider.enabled === false) return `pinned provider "${job.providerId}" is disabled`
  const missingKey = providerPrerequisites(provider).missing.find(entry => entry.code === 'apiKey')
  if (missingKey) return `pinned provider "${job.providerId}" has no credential: ${missingKey.label}`
  return null
}

async function checkApp(job) {
  if (!job.appId) return null
  const app = await getAppById(job.appId)
  if (!app) return `app "${job.appId}" does not exist`
  if (!app.repoPath) return `app "${job.appId}" has no repoPath`
  if (!existsSync(expandHome(app.repoPath))) return `repo path for app "${job.appId}" is missing on disk`
  return null
}

function checkExecution(job) {
  if (job.type === 'shell') {
    if (!job.command?.trim()) return 'shell job has no command'
    const validation = validateCommand(job.command)
    return validation.valid ? null : `shell command rejected: ${validation.error}`
  }
  if (job.type === 'script' && !SCRIPT_HANDLERS[job.scriptHandler]) {
    return `script handler "${job.scriptHandler ?? ''}" is not registered`
  }
  return null
}

/**
 * @param {object} job
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
export async function runJobPreflight(job) {
  const reason = checkExecution(job) ?? await checkApp(job) ?? await checkProvider(job)
  return reason ? { ok: false, reason } : { ok: true }
}
