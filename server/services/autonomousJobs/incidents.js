/**
 * Autonomous Jobs — deduplicated failure incidents.
 *
 * Persists machine-local incident rows (`data/cos/autonomous-job-incidents.json`, never federated) and applies the pure
 * state machine in `lib/autonomousJobIncidents.js`: the first failure of a `(jobId, signature)` notifies, identical repeats
 * only count until the reminder cooldown elapses, a new signature alerts at once, and a green run resolves the job's open
 * incidents. Reads and writes serialize through one mutex because every path is a read-modify-write of the same file.
 * Notification delivery is best-effort and never blocks or fails the job lifecycle that reports into here.
 */

import { join } from 'path'
import { randomUUID } from 'crypto'
import { PATHS, readJSONFile, atomicWrite, ensureDir } from '../../lib/fileUtils.js'
import { createMutex } from '../../lib/asyncMutex.js'
import { cosEvents } from '../cos/cosEvents.js'
import {
  recordFailure,
  recordSuccess,
  acknowledgeIncident,
  isOpenIncident,
  DEFAULT_REMINDER_COOLDOWN_HOURS,
} from '../../lib/autonomousJobIncidents.js'

const INCIDENTS_FILE = join(PATHS.cos, 'autonomous-job-incidents.json')
const withIncidentLock = createMutex()

async function loadIncidents() {
  const data = await readJSONFile(INCIDENTS_FILE, { incidents: [] }, { strict: true })
  return Array.isArray(data?.incidents) ? data.incidents : []
}

async function saveIncidents(incidents) {
  await ensureDir(PATHS.cos)
  await atomicWrite(INCIDENTS_FILE, { version: 1, incidents })
}

async function notifyIncident(incident, job, { created }) {
  const { addNotification, NOTIFICATION_TYPES, PRIORITY_LEVELS } = await import('../notifications.js')
  const name = job?.name || incident.jobId
  const repeats = incident.occurrenceCount > 1 ? ` (${incident.occurrenceCount} occurrences since ${incident.firstSeenAt})` : ''
  await addNotification({
    type: NOTIFICATION_TYPES.AGENT_WARNING,
    title: created ? `Autonomous job failing: ${name}` : `Autonomous job still failing: ${name}`,
    description: `${incident.sampleError}${repeats}`,
    priority: PRIORITY_LEVELS.MEDIUM,
    link: '/cos/jobs',
    metadata: { kind: 'autonomous-job-incident', jobId: incident.jobId, incidentId: incident.id },
  })
}

/**
 * Record a failed run for a job. Returns the incident and whether it notified.
 * @param {string} jobId
 * @param {string} error
 * @param {{ job?: object, now?: number, reminderCooldownHours?: number }} [opts]
 */
export async function recordJobFailureIncident(jobId, error, { job = null, now = Date.now(), reminderCooldownHours = DEFAULT_REMINDER_COOLDOWN_HOURS } = {}) {
  const outcome = await withIncidentLock(async () => {
    const result = recordFailure(await loadIncidents(), { jobId, error, now, reminderCooldownHours, idFactory: randomUUID })
    await saveIncidents(result.incidents)
    return result
  })
  if (outcome.shouldAlert) {
    await notifyIncident(outcome.incident, job, { created: outcome.created })
      .catch(err => console.error(`❌ Failed to notify job incident ${outcome.incident.id}: ${err.message}`))
  }
  cosEvents.emit('jobs:incidents-changed', { jobId })
  return { incident: outcome.incident, alerted: outcome.shouldAlert }
}

/** A green run resolves the job's open (unacknowledged) incidents. Returns the resolved rows. */
export async function resolveJobIncidents(jobId, now = Date.now()) {
  const { resolved } = await withIncidentLock(async () => {
    const result = recordSuccess(await loadIncidents(), { jobId, now })
    if (result.resolved.length) await saveIncidents(result.incidents)
    return result
  })
  if (resolved.length) cosEvents.emit('jobs:incidents-changed', { jobId })
  return resolved
}

/** Operator acknowledgement. Returns the updated incident, or null when unknown/already resolved. */
export async function acknowledgeJobIncident(id, now = Date.now()) {
  const result = await withIncidentLock(async () => {
    const next = acknowledgeIncident(await loadIncidents(), id, now)
    if (next) await saveIncidents(next.incidents)
    return next
  })
  if (result) cosEvents.emit('jobs:incidents-changed', { jobId: result.incident.jobId })
  return result?.incident ?? null
}

/** All incidents, newest first; `openOnly` hides resolved rows. */
export async function listJobIncidents({ openOnly = false } = {}) {
  const incidents = await withIncidentLock(loadIncidents)
  return incidents
    .filter(i => !openOnly || isOpenIncident(i))
    .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))
}
