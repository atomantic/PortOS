import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the settings store before importing the SUT — the resolver reads
// `settings.codeReview` synchronously on every call and we want test-local
// control of that value without touching disk.
const mockedSettings = { current: {} }
vi.mock('./settings.js', () => ({
  getSettings: () => Promise.resolve(mockedSettings.current),
  // Stub the EventEmitter shape the module subscribes to for cache
  // invalidation — only `.on()` is hit at import time; the SUT never emits.
  settingsEvents: { on: () => {}, emit: () => {} },
}))
// Same one-liner stub for the two backend managers — `getCodeReviewDefaults`
// + `pickCodeReviewDefaults` don't touch them, only `runLocalCodeReview`
// does, and those tests stub `global.fetch` directly.
vi.mock('./lmStudioManager.js', () => ({ getBaseUrl: () => 'http://localhost:1234' }))
vi.mock('./ollamaManager.js', () => ({ getBaseUrl: () => 'http://localhost:11434' }))

import { mockJsonResponse, mockTextResponse } from '../lib/testHelper.js'
import {
  isLocalLlmReviewer,
  pickCodeReviewDefaults,
  getCodeReviewDefaults,
  runLocalCodeReview,
  __resetCodeReviewDefaultsCache,
} from './codeReview.js'

describe('codeReview helpers', () => {
  afterEach(() => {
    mockedSettings.current = {}
    __resetCodeReviewDefaultsCache()
    vi.restoreAllMocks()
  })

  describe('isLocalLlmReviewer', () => {
    it('classifies only lmstudio + ollama as local-LLM reviewers', () => {
      expect(isLocalLlmReviewer('lmstudio')).toBe(true)
      expect(isLocalLlmReviewer('ollama')).toBe(true)
      expect(isLocalLlmReviewer('copilot')).toBe(false)
      expect(isLocalLlmReviewer('codex')).toBe(false)
      expect(isLocalLlmReviewer('')).toBe(false)
      expect(isLocalLlmReviewer(undefined)).toBe(false)
    })
  })

  describe('pickCodeReviewDefaults', () => {
    it('returns the hardcoded fallback when settings has no codeReview slice', () => {
      expect(pickCodeReviewDefaults(null)).toEqual({
        reviewers: ['copilot'],
        stopMode: 'all',
        reviewerApplies: false,
        lmstudioModel: null,
        ollamaModel: null,
      })
      expect(pickCodeReviewDefaults({})).toEqual({
        reviewers: ['copilot'],
        stopMode: 'all',
        reviewerApplies: false,
        lmstudioModel: null,
        ollamaModel: null,
      })
    })

    it('strips unknown reviewer enum values from a hand-edited settings.json', () => {
      const out = pickCodeReviewDefaults({
        codeReview: { reviewers: ['antigravity', 'bogus', 'lmstudio', 'antigravity'] },
      })
      expect(out.reviewers).toEqual(['antigravity', 'lmstudio'])
    })

    it('maps legacy gemini defaults to antigravity', () => {
      const out = pickCodeReviewDefaults({
        codeReview: { reviewers: ['gemini', 'lmstudio'] },
      })
      expect(out.reviewers).toEqual(['antigravity', 'lmstudio'])
    })

    it('coerces invalid stop-mode + reviewerApplies + model strings', () => {
      const out = pickCodeReviewDefaults({
        codeReview: {
          reviewers: ['copilot'],
          stopMode: 'nope',
          reviewerApplies: 'truthy-string',
          lmstudioModel: '',
          ollamaModel: 42,
        },
      })
      expect(out.stopMode).toBe('all')
      expect(out.reviewerApplies).toBe(false)
      expect(out.lmstudioModel).toBeNull()
      expect(out.ollamaModel).toBeNull()
    })

    it('passes through a valid full payload', () => {
      const out = pickCodeReviewDefaults({
        codeReview: {
          reviewers: ['codex', 'lmstudio'],
          stopMode: 'on-clean',
          reviewerApplies: true,
          lmstudioModel: 'qwen2.5-coder:7b',
          ollamaModel: 'codellama',
        },
      })
      expect(out).toEqual({
        reviewers: ['codex', 'lmstudio'],
        stopMode: 'on-clean',
        reviewerApplies: true,
        lmstudioModel: 'qwen2.5-coder:7b',
        ollamaModel: 'codellama',
      })
    })
  })

  describe('getCodeReviewDefaults', () => {
    it('reads from the settings store and runs the same pick logic', async () => {
      mockedSettings.current = {
        codeReview: { reviewers: ['ollama'], ollamaModel: 'codellama' },
      }
      const out = await getCodeReviewDefaults()
      expect(out.reviewers).toEqual(['ollama'])
      expect(out.ollamaModel).toBe('codellama')
      expect(out.stopMode).toBe('all')
    })
  })

  describe('runLocalCodeReview', () => {
    beforeEach(() => {
      // Default fetch mock — chat-completions success with a static body. Each
      // test that wants a different shape replaces this in its own setup.
      global.fetch = vi.fn().mockResolvedValue(mockJsonResponse({ choices: [{ message: { content: 'No findings.' } }] }))
    })

    it('rejects unsupported reviewer backends', async () => {
      const r = await runLocalCodeReview({ backend: 'copilot', model: 'x', diff: 'a' })
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/Unsupported reviewer backend/)
    })

    it('requires a model id', async () => {
      const r = await runLocalCodeReview({ backend: 'lmstudio', model: '', diff: 'a' })
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/No model configured/)
    })

    it('requires a non-empty diff', async () => {
      const r = await runLocalCodeReview({ backend: 'lmstudio', model: 'm', diff: '   ' })
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/Empty diff/)
    })

    it('posts to the backend chat-completions endpoint and returns the response content', async () => {
      const r = await runLocalCodeReview({ backend: 'ollama', model: 'codellama', diff: 'diff --git a b' })
      expect(r).toEqual({ ok: true, backend: 'ollama', model: 'codellama', findings: 'No findings.' })
      expect(global.fetch).toHaveBeenCalledTimes(1)
      const [url, init] = global.fetch.mock.calls[0]
      expect(url).toMatch(/\/v1\/chat\/completions$/)
      // Default Ollama base url; assert it's hitting the right host so a
      // future rename of the env-var fallback doesn't silently flip backends.
      expect(url).toMatch(/11434/)
      const body = JSON.parse(init.body)
      expect(body.model).toBe('codellama')
      expect(body.stream).toBe(false)
      expect(body.messages[0].role).toBe('system')
      expect(body.messages[1].content).toContain('diff --git a b')
    })

    it('surfaces a non-2xx HTTP error with the status code', async () => {
      global.fetch = vi.fn().mockResolvedValue(mockTextResponse('boom', { ok: false, status: 500 }))
      const r = await runLocalCodeReview({ backend: 'lmstudio', model: 'm', diff: 'x' })
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/lmstudio API error 500: boom/)
    })

    it('surfaces a fetch-level failure', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
      const r = await runLocalCodeReview({ backend: 'lmstudio', model: 'm', diff: 'x' })
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/lmstudio request failed: ECONNREFUSED/)
    })

    it('flags an empty model response so the agent never silently records "no findings"', async () => {
      global.fetch = vi.fn().mockResolvedValue(mockJsonResponse({ choices: [{ message: { content: '' } }] }))
      const r = await runLocalCodeReview({ backend: 'ollama', model: 'm', diff: 'x' })
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/no content/)
    })

    it('surfaces a 200-with-non-JSON body instead of masking it as "no content"', async () => {
      global.fetch = vi.fn().mockResolvedValue(mockTextResponse('<html><body>502 Bad Gateway</body></html>'))
      const r = await runLocalCodeReview({ backend: 'lmstudio', model: 'm', diff: 'x' })
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/non-JSON response/)
      expect(r.error).toMatch(/502 Bad Gateway/)
    })
  })
})
