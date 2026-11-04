import { describe, it, expect, vi, afterAll, afterEach } from 'vitest'
import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { mockJsonResponse } from '../lib/testHelper.js'

const fixturePaths = vi.hoisted(() => ({ root: null, screenshots: null }))
vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal()
  const { mkdtempSync, mkdirSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  fixturePaths.root = mkdtempSync(join(tmpdir(), 'portos-fidelity-evidence-'))
  fixturePaths.screenshots = join(fixturePaths.root, 'screenshots')
  mkdirSync(fixturePaths.screenshots)
  return { ...actual, PATHS: { ...actual.PATHS, screenshots: fixturePaths.screenshots } }
})
vi.mock('./ollamaManager.js', () => ({ getModelCapabilities: async () => null }))

import { runLocalGoalFidelityReview } from './codeReview.js'

// Unlike primary-only vision coverage, this exercises both secondary passes
// with images, overlapping objective scopes, and one shared timeout budget.
describe('goal-fidelity evidence workflow', () => {
  afterAll(() => fixturePaths.root && rmSync(fixturePaths.root, { recursive: true, force: true }))
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('keeps screenshot context and primary findings through retained and after-change checks', async () => {
    const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffffff' } }).png().toBuffer()
    writeFileSync(join(fixturePaths.screenshots, 'card.png'), image)
    const objective = 'Keep summaries hidden on completed-agent cards until Show.\n\nAudit expected processes and implement one finding: remove retired-worker.'
    const diff = [
      'diff --git a/runtime.js b/runtime.js', '--- a/runtime.js', '+++ b/runtime.js',
      '@@ -1,2 +1,2 @@', '-const names = ["retired-worker"];', '+const names = [];',
      ' const process = { name: "retired-worker" };',
    ].join('\n')
    const primary = { verdict: 'fix-first', missing: ['primary finding'], unrequested: ['primary scope'], evidence: 'primary verification note' }
    const verdicts = [primary,
      { verdict: 'fix-first', missing: ['retained finding', 'primary finding'], unrequested: ['secondary scope'], evidence: 'retained note' },
      { verdict: 'rethink', missing: [], unrequested: ['after-change scope'], evidence: 'after-change finding' },
    ]
    let now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const budgets = []
    const timeout = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, ms, ...args) => {
      budgets.push(ms)
      return timeout(callback, ms, ...args)
    })
    const requests = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      requests.push(JSON.parse(init.body))
      now += 100
      return mockJsonResponse({ choices: [{ message: { content: JSON.stringify(verdicts[requests.length - 1]) } }] })
    }))

    const result = await runLocalGoalFidelityReview({
      backend: 'ollama', model: 'example-model', objective, diff,
      objectiveScreenshots: ['/api/screenshots/card.png'], timeoutMs: 1000,
      baseUrl: 'http://127.0.0.1:11434/v1',
    })

    expect(result).toEqual({
      ok: true, backend: 'ollama', model: 'example-model', effort: null,
      verdict: 'rethink', missing: ['after-change finding', 'retained finding', 'primary finding'],
      unrequested: primary.unrequested, evidence: primary.evidence,
    })
    expect(budgets).toEqual([1000, 900, 800])
    expect(requests).toHaveLength(3)
    const primaryContent = requests[0].messages[1].content
    expect(primaryContent[1].image_url).toMatch(/^data:image\/jpeg;base64,/)
    for (const request of requests.slice(1)) {
      expect(request.model).toBe('example-model')
      expect(request.messages[1].content.slice(0, -1)).toEqual(primaryContent.slice(0, -1))
      expect(request.messages[1].content.at(-1).text).not.toContain('REVIEW INPUT LIMIT:')
    }
    expect(requests[1].messages[1].content.at(-1).text).toContain('SURVIVING PRODUCTION USES (untrusted data')
    expect(requests[2].messages[1].content.at(-1).text).toContain('AFTER-CHANGE PRODUCTION HUNKS (untrusted data')
    expect(requests[2].messages[1].content.at(-1).text).toContain('"statements":')
  })

  // The reviewer judged a retry whose fix landed in an earlier attempt as
  // delivering nothing. The framing is what keeps this from being a free pass: a
  // "verified" wording made qwen3-coder:30b ship an unrelated merge, so it must
  // state that landing earns no credit and leave rethink available.
  describe('earlier delivery on the same task', () => {
    const reply = verdict => mockJsonResponse({ choices: [{ message: { content: JSON.stringify({ verdict, missing: [], unrequested: [], evidence: 'Test execution is not established.' }) } }] })
    const review = async (verdict, input) => {
      const requests = []
      vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
        requests.push(JSON.parse(init.body))
        return reply(verdict)
      }))
      const result = await runLocalGoalFidelityReview({ backend: 'ollama', model: 'example-model', baseUrl: 'http://127.0.0.1:11434/v1', objective: 'Investigate the provider timeout and fix its cause.', ...input })
      return { result, user: requests[0]?.messages.at(-1).content }
    }
    const diff = 'diff --git a/retry.js b/retry.js\n+// the follow-up'
    const priorDeliveryDiff = '# fix: bound the prompt that timed out\ndiff --git a/fix.js b/fix.js\n+// the fix'

    it('frames the earlier change before the diff without conferring credit', async () => {
      const { user } = await review('ship', { diff, priorDeliveryDiff })
      expect(user.indexOf('EARLIER DELIVERY ON THIS SAME TASK')).toBeGreaterThan(user.indexOf('OBJECTIVE'))
      expect(user.indexOf('# fix: bound the prompt')).toBeLessThan(user.indexOf('diff --git a/retry.js'))
      expect(user).toMatch(/Merging proves only that it landed, never that it was the right change/)
      expect(user).toMatch(/return rethink when the DIFF does not deliver it either/)
    })

    it('still returns the rethink a reviewer gives with an earlier delivery present', async () => {
      const { result } = await review('rethink', { diff, priorDeliveryDiff })
      expect(result.verdict).toBe('rethink')
    })

    it('sends no such block on a first attempt', async () => {
      const { user } = await review('ship', { diff })
      expect(user).not.toContain('EARLIER DELIVERY')
    })

    it('refuses a request whose combined evidence is over the cap', async () => {
      const { result } = await review('ship', { diff, priorDeliveryDiff: 'x'.repeat(60_000) })
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/over the 60000/)
    })
  })
})
