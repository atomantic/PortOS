import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import { request } from '../lib/testHelper.js'
import { errorMiddleware } from '../lib/errorHandler.js'

vi.mock('../services/codeReview.js', () => ({
  runLocalCodeReview: vi.fn(),
  getCodeReviewDefaults: vi.fn(),
  getReviewerCliInstalled: vi.fn(),
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
  codeReviewSvc.getReviewerCliInstalled.mockResolvedValue({ claude: true, antigravity: false, codex: true, grok: true })
})

describe('GET /api/code-review/defaults', () => {
  it('merges the reviewer-CLI-installed probe into the defaults response', async () => {
    const res = await request(makeApp()).get('/api/code-review/defaults')
    expect(res.status).toBe(200)
    expect(res.body.reviewers).toEqual(['copilot'])
    expect(res.body.installed).toEqual({ claude: true, antigravity: false, codex: true, grok: true })
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

  // The effort check is keyed on the REQUESTED backend, not a flat union of every
  // local level, so a level the chosen backend doesn't accept is a 400 here rather
  // than a 200 with the effort silently dropped by the service's own normalizer.
  it('accepts an effort the requested backend takes, case-folded', async () => {
    codeReviewSvc.runLocalCodeReview.mockResolvedValue({
      ok: true, backend: 'ollama', model: 'm', effort: 'high', findings: 'No findings.',
    })

    const res = await request(makeApp())
      .post('/api/code-review/local')
      .send({ backend: 'ollama', model: 'm', effort: 'High', diff: 'diff --git a b' })

    expect(res.status).toBe(200)
    expect(codeReviewSvc.runLocalCodeReview).toHaveBeenCalledWith(
      expect.objectContaining({ effort: 'High' }),
    )
  })

  it('treats a blank effort as unpinned and falls back to the configured default', async () => {
    settingsSvc.getSettings.mockResolvedValue({
      codeReview: { ollamaModel: 'm', ollamaEffort: 'high' },
    })
    codeReviewSvc.runLocalCodeReview.mockResolvedValue({
      ok: true, backend: 'ollama', model: 'm', effort: 'high', findings: 'No findings.',
    })

    const res = await request(makeApp())
      .post('/api/code-review/local')
      .send({ backend: 'ollama', effort: '', diff: 'diff --git a b' })

    expect(res.status).toBe(200)
    expect(codeReviewSvc.runLocalCodeReview).toHaveBeenCalledWith(
      expect.objectContaining({ effort: 'high' }),
    )
  })

  it('returns 400 for an effort outside the requested backend ladder', async () => {
    const res = await request(makeApp())
      .post('/api/code-review/local')
      .send({ backend: 'ollama', model: 'm', effort: 'max', diff: 'diff --git a b' })

    expect(res.status).toBe(400)
    // `max` is a real level for some CLI reviewers, just not for a local backend —
    // the message names the ladder that DID apply so the caller can tell which.
    expect(JSON.stringify(res.body)).toContain('low, medium, high')
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

  // The old lmstudio-or-else ternary handed every non-lmstudio backend the
  // OLLAMA model id, so a third backend would have reviewed with the wrong model.
  it('reads each backend\'s own configured model scalar', async () => {
    settingsSvc.getSettings.mockResolvedValue({
      codeReview: { ollamaModel: 'ollama-model', mtplxModel: 'mtplx-model' },
    })
    codeReviewSvc.runLocalCodeReview.mockResolvedValue({
      ok: true, backend: 'mtplx', model: 'mtplx-model', findings: 'No findings.',
    })

    const res = await request(makeApp())
      .post('/api/code-review/local')
      .send({ backend: 'mtplx', diff: 'diff --git a b' })

    expect(res.status).toBe(200)
    expect(codeReviewSvc.runLocalCodeReview).toHaveBeenCalledWith(
      expect.objectContaining({ backend: 'mtplx', model: 'mtplx-model' }),
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
    // Standard error envelope: the failure message lands in `error`, and the
    // reviewer backend/model carry through in `context` for diagnostics.
    expect(res.body.error).toMatch(/lmstudio API error/)
    expect(res.body.context).toEqual({ backend: 'lmstudio', model: 'm' })
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
