import { describe, expect, it } from 'vitest'
import { PORTOS_APP_ID } from '../../lib/appIdentity.js'
import { DEFAULT_TASK_PROMPTS, PREVIOUS_DEFAULT_PROMPTS } from '../taskPromptDefaults.js'
import { SELF_IMPROVEMENT_TASK_TYPES, DEFAULT_TASK_INTERVALS } from '../taskScheduleRegistry.js'
import { DEFAULT_JOBS, mergeWithDefaults } from './defaults.js'
import {
  PORTOS_CATALOG_REFRESH_JOB_ID,
  PORTOS_CATALOG_REFRESH_JOB,
  buildMigratedCatalogRefreshJob,
  catalogRefreshJobScheduleFields,
  catalogRefreshPromptForCustomJob
} from './portosCatalogRefresh.js'

describe('PortOS local-LLM catalog refresh custom task', () => {
  it('ships as a disabled weekly custom task scoped to PortOS, not a global task type', () => {
    const job = DEFAULT_JOBS.find((candidate) => candidate.id === PORTOS_CATALOG_REFRESH_JOB_ID)
    expect(job).toBe(PORTOS_CATALOG_REFRESH_JOB)
    expect(job).toMatchObject({
      appId: PORTOS_APP_ID,
      type: 'agent',
      interval: 'weekly',
      enabled: false,
      taskMetadata: { useWorktree: true, openPR: true, simplify: true }
    })
    expect(SELF_IMPROVEMENT_TASK_TYPES).not.toContain('refresh-local-llm-catalog')
    expect(DEFAULT_TASK_INTERVALS['refresh-local-llm-catalog']).toBeUndefined()
  })

  it('adapts scheduled-task placeholders to the prepared custom-task workspace', () => {
    const prompt = catalogRefreshPromptForCustomJob('For {appName}, inspect {repoPath}/x on {defaultBranch}.')
    expect(prompt).toBe('For PortOS, inspect ./x on the repository default branch.')
    expect(PORTOS_CATALOG_REFRESH_JOB.promptTemplate).toContain('LOCAL_LLM_CATALOG')
    expect(PORTOS_CATALOG_REFRESH_JOB.promptTemplate).toContain('Do NOT create or edit a changelog file or fragment')
    expect(PORTOS_CATALOG_REFRESH_JOB.promptTemplate).not.toContain('changelog:add')
    expect(PORTOS_CATALOG_REFRESH_JOB.promptTemplate).not.toMatch(/\{(?:appName|repoPath|defaultBranch)\}/)
  })

  it('reasserts PortOS scope if persisted shipped state drifts', () => {
    const stored = {
      version: 1,
      jobs: [{ ...PORTOS_CATALOG_REFRESH_JOB, appId: 'example-app' }]
    }
    const { data, dirty } = mergeWithDefaults(stored)

    expect(dirty).toBe(true)
    expect(data.jobs.find((job) => job.id === PORTOS_CATALOG_REFRESH_JOB_ID)?.appId).toBe(PORTOS_APP_ID)
  })

  it('maps supported fixed, custom, and cron cadences', () => {
    expect(catalogRefreshJobScheduleFields({ type: 'daily' })).toMatchObject({ interval: 'daily' })
    expect(catalogRefreshJobScheduleFields({ type: 'custom', intervalMs: 1234 })).toEqual({ interval: 'custom', intervalMs: 1234 })
    expect(catalogRefreshJobScheduleFields({ type: 'weekly' }, { interval: '0 6 * * 1' }))
      .toEqual({ interval: 'daily', intervalMs: 86_400_000, cronExpression: '0 6 * * 1' })
  })

  it('disables malformed cron schedules instead of persisting a startup-breaking expression', () => {
    expect(catalogRefreshJobScheduleFields({ type: 'cron', cronExpression: '60 0 * * *' }))
      .toEqual({ interval: 'weekly', intervalMs: 604_800_000, unsupportedScheduleType: 'invalid-cron' })

    const job = buildMigratedCatalogRefreshJob({
      task: { enabled: true, type: 'cron', cronExpression: '60 0 * * *' },
      appOverride: { enabled: true }
    })
    expect(job).toMatchObject({ enabled: false, interval: 'weekly' })
    expect(job).not.toHaveProperty('cronExpression')
  })

  it('preserves effective pins, metadata, prompt, and PortOS execution history', () => {
    const job = buildMigratedCatalogRefreshJob({
      task: {
        enabled: true,
        type: 'weekly',
        providerId: 'global-provider',
        model: 'global-model',
        effort: 'high',
        prompt: 'Work in {repoPath} for {appName}.',
        taskMetadata: { useWorktree: true, openPR: true, simplify: true }
      },
      appOverride: {
        enabled: true,
        interval: 'custom',
        intervalMs: 7_200_000,
        providerId: 'app-provider',
        model: 'app-model',
        taskMetadata: { simplify: false }
      },
      execution: {
        count: 99,
        perApp: { [PORTOS_APP_ID]: { count: 4, lastRun: '2026-08-01T00:00:00.000Z' } }
      },
      now: '2026-08-26T00:00:00.000Z'
    })

    expect(job).toMatchObject({
      enabled: true,
      interval: 'custom',
      intervalMs: 7_200_000,
      providerId: 'app-provider',
      model: 'app-model',
      effort: 'high',
      promptTemplate: 'Work in . for PortOS.',
      taskMetadata: { useWorktree: true, openPR: true, simplify: false },
      lastRun: '2026-08-01T00:00:00.000Z',
      runCount: 4
    })
  })

  it('upgrades a stored shipped prompt while preserving a genuinely customized prompt', () => {
    const previous = PREVIOUS_DEFAULT_PROMPTS['refresh-local-llm-catalog'].at(-1)
    const migrated = buildMigratedCatalogRefreshJob({
      task: { enabled: true, type: 'weekly', prompt: previous },
      appOverride: { enabled: true }
    })

    expect(migrated.promptTemplate).toContain('Do NOT create or edit a changelog file or fragment')
    expect(migrated.promptTemplate).not.toContain('changelog:add')
    expect(migrated.promptTemplate).toBe(catalogRefreshPromptForCustomJob(
      DEFAULT_TASK_PROMPTS['refresh-local-llm-catalog']
    ))

    const customized = buildMigratedCatalogRefreshJob({
      task: { enabled: true, type: 'weekly', prompt: 'Keep my {appName} instructions.' },
      appOverride: { enabled: true }
    })
    expect(customized.promptTemplate).toBe('Keep my PortOS instructions.')
  })

  it('keeps the job disabled when the global pause is on or the cadence is unsupported', () => {
    expect(buildMigratedCatalogRefreshJob({
      task: { enabled: false, type: 'weekly' },
      appOverride: { enabled: true }
    }).enabled).toBe(false)
    const once = buildMigratedCatalogRefreshJob({
      task: { enabled: true, type: 'once' },
      appOverride: { enabled: true }
    })
    expect(once).toMatchObject({ enabled: false, interval: 'weekly' })
    expect(once).not.toHaveProperty('unsupportedScheduleType')
  })

  it('keeps a failure-parked PortOS schedule disabled after migration', () => {
    const parked = buildMigratedCatalogRefreshJob({
      task: { enabled: true, type: 'weekly' },
      appOverride: { enabled: true },
      execution: {
        perApp: {
          [PORTOS_APP_ID]: {
            count: 3,
            failureParkedAt: '2026-08-25T00:00:00.000Z',
            failureParkReason: 'auth-error'
          }
        }
      }
    })

    expect(parked).toMatchObject({ enabled: false, runCount: 3 })
  })
})
