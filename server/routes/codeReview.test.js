import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import { request } from '../lib/testHelper.js'
import { errorMiddleware } from '../lib/errorHandler.js'

vi.mock('../services/codeReview.js', () => ({
  runLocalCodeReview: vi.fn(),
  getCodeReviewDefaults: vi.fn(),
}))

vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn(),
}))

const codeReviewSvc = await import('../services/codeReview.js')
const settingsSvc = await import('../services/settings.js')
const { default: routes } = await import('./codeReview.js')

const makeApp = () => {
  const app = express()
  app.use(express.json())
  app.use('/api/code-review', routes)
  app.use(errorMiddleware)
  return app
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default settings stub — tests override as needed
  settingsSvc.getSettings.mockResolvedValue({})
  codeReviewSvc.getCodeReviewDefaults.mockResolvedValue({
    reviewers: ['copilot'],
    stopMode: 'all',
    reviewerApplies: false,
    lmstudioModel: null,
    ollamaModel: null,
  })
})

describe('POST /api/code-review/local', () => {
  it('returns 400 when diff is empty (Zod min(1) rejection)', async () => {
    const res = await request(makeApp())
      .post('/api/code-review/local')
      .send({ backend: 'lmstudio', model: 'qwen', diff: '' })
    expect(res.status).toBe(400)
    expect(codeReviewSvc.runLocalCodeReview).not.toHaveBeenCalled()
  })

  it('returns 400 when diff is missing', async () => {
    const res = await request(makeApp())
      .post('/api/code-review/local')
      .send({ backend: 'ollama', model: 'codellama' })
    expect(res.status).toBe(400)
    expect(codeReviewSvc.runLocalCodeReview).not.toHaveBeenCalled()
  })

  it('returns 400 when backend is an unknown enum value', async () => {
    const res = await request(makeApp())
      .post('/api/code-review/local')
      .send({ backend: 'copilot', model: 'x', diff: 'diff --git a b' })
    expect(res.status).toBe(400)
    expect(codeReviewSvc.runLocalCodeReview).not.toHaveBeenCalled()
  })

  it('falls back to the settings model when model is omitted', async () => {
    settingsSvc.getSettings.mockResolvedValue({
      codeReview: { lmstudioModel: 'settings-model' },
    })
    codeReviewSvc.runLocalCodeReview.mockResolvedValue({
      ok: true,
      backend: 'lmstudio',
      model: 'settings-model',
      findings: 'No findings.',
    })

    const res = await request(makeApp())
      .post('/api/code-review/local')
      .send({ backend: 'lmstudio', diff: 'diff --git a b' })

    expect(res.status).toBe(200)
    expect(codeReviewSvc.runLocalCodeReview).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'settings-model' }),
    )
  })

  it('passes the caller-supplied model through when present', async () => {
    settingsSvc.getSettings.mockResolvedValue({
      codeReview: { ollamaModel: 'settings-model' },
    })
    codeReviewSvc.runLocalCodeReview.mockResolvedValue({
      ok: true,
      backend: 'ollama',
      model: 'caller-model',
      findings: 'No findings.',
    })

    const res = await request(makeApp())
      .post('/api/code-review/local')
      .send({ backend: 'ollama', model: 'caller-model', diff: 'diff --git a b' })

    expect(res.status).toBe(200)
    expect(codeReviewSvc.runLocalCodeReview).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'caller-model' }),
    )
  })

  it('returns 502 when the service returns { ok: false }', async () => {
    codeReviewSvc.runLocalCodeReview.mockResolvedValue({
      ok: false,
      backend: 'lmstudio',
      model: 'm',
      error: 'lmstudio API error 503: service unavailable',
    })

    const res = await request(makeApp())
      .post('/api/code-review/local')
      .send({ backend: 'lmstudio', model: 'm', diff: 'diff --git a b' })

    expect(res.status).toBe(502)
    expect(res.body.ok).toBe(false)
    expect(res.body.error).toMatch(/lmstudio API error/)
  })

  it('returns 200 with findings on success', async () => {
    codeReviewSvc.runLocalCodeReview.mockResolvedValue({
      ok: true,
      backend: 'ollama',
      model: 'codellama',
      findings: '## Blocking\n- file.js:10 fix the bug',
    })

    const res = await request(makeApp())
      .post('/api/code-review/local')
      .send({ backend: 'ollama', model: 'codellama', diff: 'diff --git a b' })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.findings).toContain('Blocking')
  })
})
