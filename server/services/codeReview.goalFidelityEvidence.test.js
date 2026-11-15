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

// Screenshots, surviving-use witnesses and the diff share ONE request: no
// secondary pass may re-judge or rewrite the primary verdict.
describe('goal-fidelity evidence workflow', () => {
  afterAll(() => fixturePaths.root && rmSync(fixturePaths.root, { recursive: true, force: true }))
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('sends screenshot context and surviving-use witnesses in a single review and keeps its verdict', async () => {
    const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffffff' } }).png().toBuffer()
    writeFileSync(join(fixturePaths.screenshots, 'card.png'), image)
    const objective = 'Audit expected processes and implement one finding: remove retired-worker.'
    const diff = [
      'diff --git a/runtime.js b/runtime.js', '--- a/runtime.js', '+++ b/runtime.js',
      '@@ -1,2 +1,2 @@', '-const names = ["retired-worker"];', '+const names = [];',
      ' const process = { name: "retired-worker" };',
    ].join('\n')
    const primary = { verdict: 'fix-first', missing: ['primary finding'], unrequested: ['primary scope'], evidence: 'primary verification note' }
    const requests = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      requests.push(JSON.parse(init.body))
      return mockJsonResponse({ choices: [{ message: { content: JSON.stringify(primary) } }] })
    }))

    const result = await runLocalGoalFidelityReview({
      backend: 'ollama', model: 'example-model', objective, diff,
      objectiveScreenshots: ['/api/screenshots/card.png'], timeoutMs: 1000,
      baseUrl: 'http://127.0.0.1:11434/v1',
    })

    expect(result).toEqual({ ok: true, backend: 'ollama', model: 'example-model', effort: null, ...primary })
    expect(requests).toHaveLength(1)
    const [objectivePart, imagePart, evidencePart] = requests[0].messages[1].content
    expect(objectivePart.text).toContain(objective)
    expect(imagePart.image_url).toMatch(/^data:image\/jpeg;base64,/)
    expect(evidencePart.text).toContain(diff)
    expect(evidencePart.text).toContain('SURVIVING PRODUCTION USES (untrusted data')
    expect(evidencePart.text).toContain('const process = { name: \\"retired-worker\\" };')
    expect(evidencePart.text).toContain('REVIEW INPUT LIMIT:')
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
