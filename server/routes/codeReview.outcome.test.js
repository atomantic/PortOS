import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { request } from '../lib/testHelper.js'
import { errorMiddleware } from '../lib/errorHandler.js'

const settings = vi.hoisted(() => ({ current: {} }))
vi.mock('../services/settings.js', () => ({
  getSettings: async () => settings.current,
  updateSettingsWith: async mutate => { settings.current = await mutate(settings.current) },
  settingsEvents: { on: () => {} },
}))

const { default: routes } = await import('./codeReview.js')
const { pickCodeReviewDefaults } = await import('../services/codeReview.js')

const app = express()
app.use(express.json())
app.use('/api/code-review', routes)
app.use(errorMiddleware)
const report = body => request(app).post('/api/code-review/cli-outcome').send(body)

beforeEach(() => {
  settings.current = {
    codeReview: {
      reviewers: ['opencode', 'codex'],
      optionalReviewers: ['opencode'],
      opencodeModel: 'example/model',
    },
  }
})

describe('CLI reviewer outcome reporting', () => {
  it('persists only bounded health evidence and clears it after a real verdict', async () => {
    const configured = structuredClone(settings.current.codeReview)
    // Synthetic provider output: even an accepted message is never persisted.
    const refusal = await report({
      reviewer: 'opencode', outcome: 'failed',
      failure: { name: 'FreeTierError', message: 'synthetic private diagnostic' },
    })
    expect(refusal.status).toBe(200)
    expect(refusal.body).toEqual({ recorded: true, code: 'REVIEWER_ACCESS_DENIED' })
    expect(settings.current.codeReview).toEqual({
      ...configured,
      reviewerHealth: {
        opencode: { code: 'REVIEWER_ACCESS_DENIED', reason: 'configuration', lastFailureAt: expect.any(Number) },
      },
    })
    expect(pickCodeReviewDefaults(settings.current).reviewerConfigFaults).toEqual({
      opencode: { code: 'REVIEWER_ACCESS_DENIED', lastFailureAt: expect.any(Number) },
    })

    // Exit success with no verdict must not erase the refusal.
    expect((await report({ reviewer: 'opencode', outcome: 'reviewed' })).status).toBe(400)
    expect(settings.current.codeReview.reviewerHealth.opencode.code).toBe('REVIEWER_ACCESS_DENIED')
    expect((await report({ reviewer: 'opencode', outcome: 'reviewed', verdict: 'findings' })).body).toEqual({ recorded: true })
    expect(settings.current.codeReview).toEqual(configured)
    expect(pickCodeReviewDefaults(settings.current).reviewerConfigFaults).toBeUndefined()
  })

  it.each([
    { providerErrorType: 'FreeTierError' },
    { message: "OpenCode's free tier can only be used from within OpenCode" },
  ])('recognizes a structured non-retryable APIError refusal (%j)', async evidence => {
    const result = await report({
      reviewer: 'opencode', outcome: 'failed',
      failure: { name: 'APIError', statusCode: 403, isRetryable: false, ...evidence },
    })
    expect(result.body).toEqual({ recorded: true, code: 'REVIEWER_ACCESS_DENIED' })
  })

  it.each([
    ['opencode', { name: 'APIError', statusCode: 403, isRetryable: false }],
    ['opencode', { name: 'APIError', statusCode: 403, isRetryable: true, providerErrorType: 'FreeTierError' }],
    ['opencode', { name: 'TimeoutError' }],
    ['codex', { name: 'FreeTierError' }],
  ])('does not classify unrelated failures as access faults (%s, %j)', async (reviewer, failure) => {
    const before = structuredClone(settings.current)
    const result = await report({ reviewer, outcome: 'failed', failure })
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ recorded: false, code: null })
    expect(settings.current).toEqual(before)
  })

  it.each([
    { reviewer: 'opencode~opt', outcome: 'failed', failure: { name: 'FreeTierError' } },
    { reviewer: 'opencode', outcome: 'failed', failure: { name: 'FreeTierError', responseHeaders: { authorization: 'synthetic-secret' } } },
    { reviewer: 'opencode', outcome: 'failed', failure: { message: 'x'.repeat(513) } },
    { reviewer: 'opencode', outcome: 'reviewed', verdict: 'inconclusive' },
  ])('rejects invalid or unbounded reports without a health write', async body => {
    expect((await report(body)).status).toBe(400)
    expect(settings.current.codeReview.reviewerHealth).toBeUndefined()
  })
})
