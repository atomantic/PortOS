/**
 * Move the PortOS-only `refresh-local-llm-catalog` scheduled task into the
 * PortOS app's Custom Tasks list.
 *
 * The old task type appeared for every managed app even though its prompt could
 * only edit PortOS. The destination is an app-scoped autonomous job, which keeps
 * provider/model/effort, prompt, cadence, git-workflow options, and PortOS run
 * history while removing the dead schedule entry and per-app overrides.
 *
 * Writes are ordered destination first, source tombstone last. If a partial run
 * is retried, an existing destination job wins so user edits are never replaced.
 */

import { readFile } from 'fs/promises'
import { join } from 'path'
import { atomicWrite } from '../../server/lib/fileUtils.js'
import { PORTOS_APP_ID } from '../../server/lib/appIdentity.js'
import {
  PORTOS_CATALOG_REFRESH_JOB_ID,
  PORTOS_CATALOG_REFRESH_TASK_TYPE,
  buildMigratedCatalogRefreshJob
} from '../../server/services/autonomousJobs/portosCatalogRefresh.js'

const CURRENT_SCHEDULE_REL = join('data', 'cos', 'task-schedule.json')
const LEGACY_SCHEDULE_REL = join('data', 'task-schedule.json')
const JOBS_REL = join('data', 'cos', 'autonomous-jobs.json')
const APPS_REL = join('data', 'apps.json')
const EXECUTION_KEY = `task:${PORTOS_CATALOG_REFRESH_TASK_TYPE}`

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value)

async function readOptionalJsonStrict(path, label) {
  const raw = await readFile(path, 'utf8').catch((err) => {
    if (err.code === 'ENOENT') return null
    throw err
  })
  if (raw == null) return null
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new Error(`${label} is unreadable; repair it before retrying migration 299: ${err.message}`)
  }
}

function removeLegacyScheduleState(schedule) {
  if (!isObject(schedule)) return false
  let changed = false
  if (isObject(schedule.tasks) && Object.hasOwn(schedule.tasks, PORTOS_CATALOG_REFRESH_TASK_TYPE)) {
    delete schedule.tasks[PORTOS_CATALOG_REFRESH_TASK_TYPE]
    changed = true
  }
  if (isObject(schedule.executions) && Object.hasOwn(schedule.executions, EXECUTION_KEY)) {
    delete schedule.executions[EXECUTION_KEY]
    changed = true
  }
  if (Array.isArray(schedule.onDemandRequests)) {
    const kept = schedule.onDemandRequests.filter((request) => request?.taskType !== PORTOS_CATALOG_REFRESH_TASK_TYPE)
    if (kept.length !== schedule.onDemandRequests.length) {
      schedule.onDemandRequests = kept
      changed = true
    }
  }
  return changed
}

export default {
  async up({ rootDir }) {
    const currentSchedulePath = join(rootDir, CURRENT_SCHEDULE_REL)
    const legacySchedulePath = join(rootDir, LEGACY_SCHEDULE_REL)
    const jobsPath = join(rootDir, JOBS_REL)
    const appsPath = join(rootDir, APPS_REL)

    const [currentSchedule, legacySchedule, appsData] = await Promise.all([
      readOptionalJsonStrict(currentSchedulePath, CURRENT_SCHEDULE_REL),
      readOptionalJsonStrict(legacySchedulePath, LEGACY_SCHEDULE_REL),
      readOptionalJsonStrict(appsPath, APPS_REL)
    ])

    for (const [label, schedule] of [[CURRENT_SCHEDULE_REL, currentSchedule], [LEGACY_SCHEDULE_REL, legacySchedule]]) {
      if (schedule != null && (!isObject(schedule) || !isObject(schedule.tasks))) {
        throw new Error(`${label} has an invalid tasks collection; repair it before retrying migration 299`)
      }
    }
    if (appsData != null && (!isObject(appsData) || !isObject(appsData.apps))) {
      throw new Error(`${APPS_REL} has an invalid apps collection; repair it before retrying migration 299`)
    }

    const schedules = [
      { path: currentSchedulePath, data: currentSchedule },
      { path: legacySchedulePath, data: legacySchedule }
    ]
    const sourceSchedule = schedules.find(({ data }) => isObject(data?.tasks?.[PORTOS_CATALOG_REFRESH_TASK_TYPE]))?.data
    const task = sourceSchedule?.tasks?.[PORTOS_CATALOG_REFRESH_TASK_TYPE] || null
    const execution = sourceSchedule?.executions?.[EXECUTION_KEY] || {}
    const portosApp = isObject(appsData?.apps?.[PORTOS_APP_ID]) ? appsData.apps[PORTOS_APP_ID] : null
    const appOverride = isObject(portosApp?.taskTypeOverrides?.[PORTOS_CATALOG_REFRESH_TASK_TYPE])
      ? portosApp.taskTypeOverrides[PORTOS_CATALOG_REFRESH_TASK_TYPE]
      : null
    const hasAnyAppOverride = isObject(appsData?.apps) && Object.values(appsData.apps).some(
      (app) => isObject(app?.taskTypeOverrides?.[PORTOS_CATALOG_REFRESH_TASK_TYPE])
    )

    // Fresh installs have neither persisted source. DEFAULT_JOBS seeds the new
    // disabled PortOS custom task during autonomous-job initialization.
    if (!task && !hasAnyAppOverride) {
      return { updated: 0, jobCreated: false, schedulesCleaned: 0, appOverridesRemoved: 0 }
    }

    const jobsData = await readOptionalJsonStrict(jobsPath, JOBS_REL) || {
      version: 1,
      lastUpdated: null,
      jobs: []
    }
    if (!isObject(jobsData) || !Array.isArray(jobsData.jobs)) {
      throw new Error(`${JOBS_REL} has an invalid jobs collection; repair it before retrying migration 299`)
    }

    let jobCreated = false
    if (!jobsData.jobs.some((job) => isObject(job) && job.id === PORTOS_CATALOG_REFRESH_JOB_ID)) {
      const sourceTask = task || { type: 'weekly', enabled: false }
      jobsData.jobs.push(buildMigratedCatalogRefreshJob({
        task: sourceTask,
        appOverride: appOverride || {},
        execution
      }))
      jobsData.lastUpdated = new Date().toISOString()
      await atomicWrite(jobsPath, jobsData)
      jobCreated = true
      console.log('📝 refresh-local-llm-catalog: created the PortOS app custom task')
    }

    let appOverridesRemoved = 0
    if (isObject(appsData?.apps)) {
      for (const app of Object.values(appsData.apps)) {
        if (!isObject(app?.taskTypeOverrides) || !Object.hasOwn(app.taskTypeOverrides, PORTOS_CATALOG_REFRESH_TASK_TYPE)) continue
        delete app.taskTypeOverrides[PORTOS_CATALOG_REFRESH_TASK_TYPE]
        appOverridesRemoved += 1
      }
      if (appOverridesRemoved > 0) await atomicWrite(appsPath, appsData)
    }

    let schedulesCleaned = 0
    for (const schedule of schedules) {
      if (removeLegacyScheduleState(schedule.data)) {
        await atomicWrite(schedule.path, schedule.data)
        schedulesCleaned += 1
      }
    }

    console.log(`✅ refresh-local-llm-catalog: moved to PortOS Custom Tasks and removed ${appOverridesRemoved} obsolete app override(s)`)
    return {
      updated: (jobCreated ? 1 : 0) + schedulesCleaned + appOverridesRemoved,
      jobCreated,
      schedulesCleaned,
      appOverridesRemoved
    }
  }
}
