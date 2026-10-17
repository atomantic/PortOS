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
})
