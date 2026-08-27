import { describe, expect, it } from 'vitest'
import { PORTOS_APP_ID } from '../../lib/appIdentity.js'
import { DEFAULT_TASK_INTERVALS, SELF_IMPROVEMENT_TASK_TYPES, TASK_TYPE_DESCRIPTIONS } from '../taskScheduleRegistry.js'
import { generateTaskFromJob } from './skillTemplates.js'
import { DAY } from './constants.js'
import { DEFAULT_JOBS, createDefaultJobsData, mergeWithDefaults } from './defaults.js'
import {
  PORTOS_CLI_CATALOG_REFRESH_JOB_ID,
  PORTOS_CLI_CATALOG_REFRESH_TASK_TYPE,
  PORTOS_CLI_CATALOG_REFRESH_JOB
} from './portosCliCatalogRefresh.js'

describe('PortOS CLI provider catalog refresh custom task', () => {
  it('ships as a disabled monthly PortOS custom task, not a global task type', () => {
    const job = DEFAULT_JOBS.find((candidate) => candidate.id === PORTOS_CLI_CATALOG_REFRESH_JOB_ID)

    expect(job).toBe(PORTOS_CLI_CATALOG_REFRESH_JOB)
    expect(job).toMatchObject({
      appId: PORTOS_APP_ID,
      type: 'agent',
      interval: 'monthly',
      intervalMs: 30 * DAY,
      enabled: false,
      taskMetadata: { useWorktree: true, openPR: true, simplify: true, noChangeSuccess: true }
    })
    expect(SELF_IMPROVEMENT_TASK_TYPES).not.toContain(PORTOS_CLI_CATALOG_REFRESH_TASK_TYPE)
    expect(DEFAULT_TASK_INTERVALS[PORTOS_CLI_CATALOG_REFRESH_TASK_TYPE]).toBeUndefined()
    expect(TASK_TYPE_DESCRIPTIONS[PORTOS_CLI_CATALOG_REFRESH_TASK_TYPE]).toBeUndefined()
  })

  it('keeps the prompt in the prepared PortOS workspace and makes the no-op contract explicit', () => {
    expect(PORTOS_CLI_CATALOG_REFRESH_JOB.promptTemplate).toContain('CODEX_MODELS')
    expect(PORTOS_CLI_CATALOG_REFRESH_JOB.promptTemplate).toContain('ANTIGRAVITY_MODELS')
    expect(PORTOS_CLI_CATALOG_REFRESH_JOB.promptTemplate).toContain('PRIOR_ANTIGRAVITY_MODEL_CATALOGS')
    expect(PORTOS_CLI_CATALOG_REFRESH_JOB.promptTemplate).toContain('PRIOR_CODEX_MODEL_CATALOGS')
    expect(PORTOS_CLI_CATALOG_REFRESH_JOB.promptTemplate).toContain('migrateCodexProvider')
    expect(PORTOS_CLI_CATALOG_REFRESH_JOB.promptTemplate).toContain('Do NOT create a commit, push a branch, or open a PR')
    expect(PORTOS_CLI_CATALOG_REFRESH_JOB.promptTemplate).toContain('data/providers.json')
  })

  it('seeds a fresh install with the app scope, workflow metadata, and snapshot fields', () => {
    const data = createDefaultJobsData()
    const job = data.jobs.find((candidate) => candidate.id === PORTOS_CLI_CATALOG_REFRESH_JOB_ID)

    expect(job).toMatchObject({
      appId: PORTOS_APP_ID,
      taskMetadata: { useWorktree: true, openPR: true, simplify: true, noChangeSuccess: true },
      providerId: null,
      model: null,
      effort: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      _shippedDefaults: {
        name: PORTOS_CLI_CATALOG_REFRESH_JOB.name,
        interval: 'monthly',
        intervalMs: 30 * DAY,
        promptTemplate: PORTOS_CLI_CATALOG_REFRESH_JOB.promptTemplate
      }
    })
  })

  it('preserves a customized task during an upgrade', () => {
    const seededData = createDefaultJobsData()
    const seededJob = seededData.jobs.find((job) => job.id === PORTOS_CLI_CATALOG_REFRESH_JOB_ID)
    const customized = {
      ...seededJob,
      name: 'My provider audit',
      description: 'Keep my wording',
      interval: 'weekly',
      intervalMs: 7 * DAY,
      enabled: true,
      promptTemplate: 'Keep my provider instructions',
      taskMetadata: { useWorktree: false, openPR: false, simplify: false },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      _shippedDefaults: { ...seededJob._shippedDefaults }
    }
    const storedJobs = seededData.jobs.map((job) => (
      job.id === PORTOS_CLI_CATALOG_REFRESH_JOB_ID ? customized : job
    ))
    const { data, dirty } = mergeWithDefaults({ version: 1, jobs: storedJobs })
    const job = data.jobs.find((candidate) => candidate.id === PORTOS_CLI_CATALOG_REFRESH_JOB_ID)

    expect(dirty).toBe(false)
    expect(job).toMatchObject({
      name: 'My provider audit',
      description: 'Keep my wording',
      interval: 'weekly',
      intervalMs: 7 * DAY,
      enabled: true,
      promptTemplate: 'Keep my provider instructions',
      taskMetadata: { useWorktree: false, openPR: false, simplify: false }
    })
  })

  it('forwards app scope and provider/model/effort pins to the spawned task', async () => {
    const task = await generateTaskFromJob({
      ...PORTOS_CLI_CATALOG_REFRESH_JOB,
      providerId: 'codex-cli',
      model: 'gpt-example',
      effort: 'high'
    })

    expect(task.metadata).toMatchObject({
      app: PORTOS_APP_ID,
      useWorktree: true,
      openPR: true,
      simplify: true,
      noChangeSuccess: true,
      provider: 'codex-cli',
      model: 'gpt-example',
      effort: 'high'
    })
  })
})
