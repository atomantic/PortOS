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

const cos = vi.hoisted(() => ({ state: null, emitted: [] }))
vi.mock('../services/cos/cosState.js', () => ({
  withStateLock: async work => work(),
  loadState: async () => cos.state,
  saveState: async state => { cos.state = structuredClone(state) },
}))
vi.mock('../services/cos/cosEvents.js', () => ({ cosEvents: { emit: (event, payload) => cos.emitted.push([event, payload]) } }))

const { default: routes } = await import('./codeReview.js')
const { pickCodeReviewDefaults } = await import('../services/codeReview.js')

const app = express()
app.use(express.json())
app.use('/api/code-review', routes)
app.use(errorMiddleware)
const report = body => request(app).post('/api/code-review/cli-outcome').send(body)

beforeEach(() => {
  cos.emitted = []
  cos.state = { agents: {
    'agent-example': { id: 'agent-example', status: 'running', metadata: { taskDescription: 'Example claim' } },
    'agent-finished': { id: 'agent-finished', status: 'completed', metadata: {} },
  } }
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
        opencode: { code: 'REVIEWER_ACCESS_DENIED', reason: 'configuration', failureCount: 1, lastFailureAt: expect.any(Number) },
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

describe('verdicts on the owning run (#16572)', () => {
  // `recorded` stays the reviewer-health result: codex has no fault to clear here.
  it('records a findings verdict with its round and changed-line count on the running agent', async () => {
    const result = await report({ reviewer: 'codex', outcome: 'reviewed', verdict: 'findings', agentId: 'agent-example', round: 2, changedLines: 140 })
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ recorded: false, runRecorded: true })
    const agent = cos.state.agents['agent-example']
    expect(agent.metadata.taskDescription).toBe('Example claim')
    expect(agent.metadata.reviewVerdicts).toEqual([
      { reviewer: 'codex', verdict: 'findings', round: 2, changedLines: 140, recordedAt: expect.any(String) },
    ])
    expect(cos.emitted).toEqual([
      ['agent:updated', agent],
      ['reviewer-verdict:recorded', { agentId: 'agent-example', reviewer: 'codex', verdict: 'findings' }],
    ])
  })

  it('refuses a run that is not live and leaves a report without a run id unrecorded', async () => {
    const before = structuredClone(cos.state)
    const finished = await report({ reviewer: 'codex', outcome: 'reviewed', verdict: 'clean', agentId: 'agent-finished', round: 1, changedLines: 3 })
    expect(finished.body).toEqual({ recorded: false, runRecorded: false, reason: 'run-not-running' })
    expect((await report({ reviewer: 'codex', outcome: 'reviewed', verdict: 'clean' })).body).toEqual({ recorded: false })
    expect(cos.state).toEqual(before)
  })

  it.each([
    { agentId: '../agent-example' },
    { round: 0 },
    { changedLines: -1 },
    { round: 1.5 },
  ])('rejects an out-of-shape run field (%j)', async extra => {
    const before = structuredClone(cos.state)
    expect((await report({ reviewer: 'codex', outcome: 'reviewed', verdict: 'clean', agentId: 'agent-example', ...extra })).status).toBe(400)
    expect(cos.state).toEqual(before)
  })
})
