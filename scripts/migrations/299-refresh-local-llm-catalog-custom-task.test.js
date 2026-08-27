import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { PORTOS_APP_ID } from '../../server/lib/appIdentity.js'
import { PORTOS_CATALOG_REFRESH_JOB_ID } from '../../server/services/autonomousJobs/portosCatalogRefresh.js'
import migration from './299-refresh-local-llm-catalog-custom-task.js'

const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

describe('migration 299 — local-LLM catalog refresh → PortOS custom task', () => {
  let rootDir
  let schedulePath
  let legacySchedulePath
  let jobsPath
  let appsPath

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-299-'))
    schedulePath = join(rootDir, 'data', 'cos', 'task-schedule.json')
    legacySchedulePath = join(rootDir, 'data', 'task-schedule.json')
    jobsPath = join(rootDir, 'data', 'cos', 'autonomous-jobs.json')
    appsPath = join(rootDir, 'data', 'apps.json')
  })

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }))

  it('no-ops on a fresh install so DEFAULT_JOBS can seed the task', async () => {
    await expect(migration.up({ rootDir })).resolves.toEqual({
      updated: 0,
      jobCreated: false,
      schedulesCleaned: 0,
      appOverridesRemoved: 0
    })
  })

  it('moves effective PortOS settings and history, then removes every old schedule surface', async () => {
    writeJson(schedulePath, {
      version: 2,
      tasks: {
        security: { enabled: true },
        'refresh-local-llm-catalog': {
          enabled: true,
          type: 'weekly',
          providerId: 'global-provider',
          model: 'global-model',
          effort: 'xhigh',
          prompt: 'Refresh {appName} from {repoPath} on {defaultBranch}.',
          taskMetadata: { useWorktree: true, openPR: true, simplify: true }
        }
      },
      executions: {
        'task:security': { count: 1 },
        'task:refresh-local-llm-catalog': {
          count: 8,
          perApp: { [PORTOS_APP_ID]: { count: 3, lastRun: '2026-08-20T00:00:00.000Z' } }
        }
      },
      onDemandRequests: [
        { id: 'keep', taskType: 'security' },
        { id: 'remove', taskType: 'refresh-local-llm-catalog' }
      ]
    })
    writeJson(jobsPath, { version: 1, jobs: [{ id: 'job-existing', name: 'Existing' }] })
    writeJson(appsPath, {
      apps: {
        [PORTOS_APP_ID]: {
          name: 'PortOS',
          taskTypeOverrides: {
            security: { enabled: true },
            'refresh-local-llm-catalog': {
              enabled: true,
              interval: 'custom',
              intervalMs: 12_345,
              providerId: 'app-provider',
              model: 'app-model',
              taskMetadata: { simplify: false }
            }
          }
        },
        'example-app': {
          taskTypeOverrides: { 'refresh-local-llm-catalog': { enabled: false } }
        }
      }
    })

    const result = await migration.up({ rootDir })
    expect(result).toMatchObject({ jobCreated: true, schedulesCleaned: 1, appOverridesRemoved: 2 })

    const jobs = readJson(jobsPath).jobs
    expect(jobs.map((job) => job.id)).toEqual(['job-existing', PORTOS_CATALOG_REFRESH_JOB_ID])
    expect(jobs[1]).toMatchObject({
      appId: PORTOS_APP_ID,
      enabled: true,
      interval: 'custom',
      intervalMs: 12_345,
      providerId: 'app-provider',
      model: 'app-model',
      effort: 'xhigh',
      promptTemplate: 'Refresh PortOS from . on the repository default branch.',
      taskMetadata: { useWorktree: true, openPR: true, simplify: false },
      runCount: 3,
      lastRun: '2026-08-20T00:00:00.000Z'
    })

    const schedule = readJson(schedulePath)
    expect(schedule.tasks).toEqual({ security: { enabled: true } })
    expect(schedule.executions).toEqual({ 'task:security': { count: 1 } })
    expect(schedule.onDemandRequests).toEqual([{ id: 'keep', taskType: 'security' }])
    const apps = readJson(appsPath).apps
    expect(apps[PORTOS_APP_ID].taskTypeOverrides).toEqual({ security: { enabled: true } })
    expect(apps['example-app'].taskTypeOverrides).toEqual({})
  })

  it('migrates the legacy schedule path and preserves the global pause', async () => {
    writeJson(legacySchedulePath, {
      tasks: { 'refresh-local-llm-catalog': { enabled: false, type: 'daily' } },
      executions: {}
    })
    writeJson(appsPath, {
      apps: { [PORTOS_APP_ID]: { taskTypeOverrides: { 'refresh-local-llm-catalog': { enabled: true } } } }
    })

    await migration.up({ rootDir })
    const job = readJson(jobsPath).jobs.find((candidate) => candidate.id === PORTOS_CATALOG_REFRESH_JOB_ID)
    expect(job).toMatchObject({ enabled: false, interval: 'daily' })
    expect(readJson(legacySchedulePath).tasks).toEqual({})
  })

  it('disables an invalid legacy cron instead of breaking autonomous-job registration', async () => {
    writeJson(schedulePath, {
      tasks: {
        'refresh-local-llm-catalog': {
          enabled: true,
          type: 'cron',
          cronExpression: '60 0 * * *'
        }
      },
      executions: {}
    })
    writeJson(appsPath, {
      apps: { [PORTOS_APP_ID]: { taskTypeOverrides: { 'refresh-local-llm-catalog': { enabled: true } } } }
    })

    await migration.up({ rootDir })
    const job = readJson(jobsPath).jobs.find((candidate) => candidate.id === PORTOS_CATALOG_REFRESH_JOB_ID)
    expect(job).toMatchObject({ enabled: false, interval: 'weekly' })
    expect(job).not.toHaveProperty('cronExpression')
  })

  it('keeps a failure-parked PortOS schedule disabled', async () => {
    writeJson(schedulePath, {
      tasks: { 'refresh-local-llm-catalog': { enabled: true, type: 'weekly' } },
      executions: {
        'task:refresh-local-llm-catalog': {
          perApp: {
            [PORTOS_APP_ID]: {
              count: 4,
              failureParkedAt: '2026-08-25T00:00:00.000Z',
              failureParkReason: 'auth-error'
            }
          }
        }
      }
    })
    writeJson(appsPath, {
      apps: { [PORTOS_APP_ID]: { taskTypeOverrides: { 'refresh-local-llm-catalog': { enabled: true } } } }
    })

    await migration.up({ rootDir })
    const job = readJson(jobsPath).jobs.find((candidate) => candidate.id === PORTOS_CATALOG_REFRESH_JOB_ID)
    expect(job).toMatchObject({ enabled: false, runCount: 4 })
  })

  it('preserves an existing destination job while completing a partial migration cleanup', async () => {
    writeJson(schedulePath, {
      tasks: { 'refresh-local-llm-catalog': { enabled: true, type: 'weekly' } },
      executions: {}
    })
    writeJson(jobsPath, {
      version: 1,
      jobs: [{ id: PORTOS_CATALOG_REFRESH_JOB_ID, name: 'My customized destination', enabled: false }]
    })
    writeJson(appsPath, {
      apps: { [PORTOS_APP_ID]: { taskTypeOverrides: { 'refresh-local-llm-catalog': { enabled: true } } } }
    })

    const result = await migration.up({ rootDir })
    expect(result.jobCreated).toBe(false)
    expect(readJson(jobsPath).jobs[0].name).toBe('My customized destination')
    expect(readJson(schedulePath).tasks).toEqual({})
    expect(readJson(appsPath).apps[PORTOS_APP_ID].taskTypeOverrides).toEqual({})
  })

  it('fails closed on corrupt persisted state instead of overwriting it', async () => {
    mkdirSync(join(rootDir, 'data', 'cos'), { recursive: true })
    writeFileSync(schedulePath, '{not json')

    await expect(migration.up({ rootDir })).rejects.toThrow('task-schedule.json is unreadable')
    expect(readFileSync(schedulePath, 'utf8')).toBe('{not json')
  })

  it('fails closed on a malformed jobs collection before removing the source', async () => {
    writeJson(schedulePath, {
      tasks: { 'refresh-local-llm-catalog': { enabled: true, type: 'weekly' } },
      executions: {}
    })
    writeJson(jobsPath, { version: 1, jobs: null })
    writeJson(appsPath, {
      apps: { [PORTOS_APP_ID]: { taskTypeOverrides: { 'refresh-local-llm-catalog': { enabled: true } } } }
    })

    await expect(migration.up({ rootDir })).rejects.toThrow('invalid jobs collection')
    expect(readJson(schedulePath).tasks).toHaveProperty('refresh-local-llm-catalog')
    expect(readJson(appsPath).apps[PORTOS_APP_ID].taskTypeOverrides).toHaveProperty('refresh-local-llm-catalog')
  })

  it('fails closed on a malformed apps collection before removing the source', async () => {
    writeJson(schedulePath, {
      tasks: { 'refresh-local-llm-catalog': { enabled: true, type: 'weekly' } },
      executions: {}
    })
    writeJson(appsPath, { apps: null })

    await expect(migration.up({ rootDir })).rejects.toThrow('invalid apps collection')
    expect(readJson(schedulePath).tasks).toHaveProperty('refresh-local-llm-catalog')
  })
})
