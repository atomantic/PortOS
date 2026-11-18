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
import { taskObjective } from '../lib/goalFidelity.js'
import { DEFAULT_TASK_PROMPTS } from './taskPromptDefaults/prompts.js'

const maintenanceObjective = taskObjective({ description: DEFAULT_TASK_PROMPTS['dependency-updates']
  .replaceAll('{appName}', 'Example').replaceAll('{repoPath}', '/example/repo')
  .replaceAll('{portosRoot}', '/example/portos').replaceAll('{worktreesRoot}', '/example/worktrees') })
const maintenanceReport = [
  'Paginated the alert inventory. Both open alerts have no patched version and are recorded in tracker issue #42.',
  'The full open PR inventory and per-package overlap checks found no automated PRs for either updated package.',
  'The containment probe returned exit 2 (refused, no work ran). Per the objective, installs and validation then ran on the host.',
  'Both dependency changes are minor. Regenerated the lockfile, reran the affected audits, and checked app startup.',
  'Reported results: JavaScript audits found only the previously tracked alerts, the Python OSV inventory found no alerts, and current image scan evidence found no actionable digest changes.',
].join('\n')
const maintenanceDiff = [
  'diff --git a/client/package.json b/client/package.json',
  '--- a/client/package.json', '+++ b/client/package.json', '@@ -1,2 +1,2 @@',
  '-  "chart-widget": "^3.10.1",', '-  "icon-set": "^1.74.0"',
  '+  "chart-widget": "^3.11.0",', '+  "icon-set": "^1.75.0"',
  'diff --git a/client/package-lock.json b/client/package-lock.json',
  '--- a/client/package-lock.json', '+++ b/client/package-lock.json', '@@ -1,2 +1,2 @@',
  '-  "chart-widget": "3.10.1",', '-  "icon-set": "1.74.0"',
  '+  "chart-widget": "3.11.0",', '+  "icon-set": "1.75.0"',
].join('\n')
const unrelatedDiff = 'diff --git a/banner.css b/banner.css\n--- a/banner.css\n+++ b/banner.css\n@@ -1 +1 @@\n-.banner { color: red; }\n+.banner { color: green; }'
const maintenanceCases = [
  ['bot-uncovered minor bumps', maintenanceDiff, 'ship'],
  ['unrelated source change despite the same report', unrelatedDiff, 'rethink'],
]
const maintenanceReview = {
  backend: 'ollama', objective: maintenanceObjective, executionReport: maintenanceReport,
  baseUrl: 'http://127.0.0.1:11434/v1',
}

// Screenshots, surviving-use witnesses and the diff share ONE request: no
// secondary pass may re-judge or rewrite the primary verdict.
describe('goal-fidelity evidence workflow', () => {
  afterAll(() => fixturePaths.root && rmSync(fixturePaths.root, { recursive: true, force: true }))
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it.each(maintenanceCases)('supplies first-attempt audit evidence and retains the verdict for %s', async (_name, diff, verdict) => {
    const fetchMock = vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body)
      expect(request.tools).toBeUndefined()
      const evidence = request.messages[1].content
      expect(evidence.indexOf('## Phase 2 — Everything the bots did not cover')).toBeGreaterThan(8_000)
      expect(evidence).toContain('Then minor versions')
      expect(evidence).toContain(diff)
      expect(evidence).toContain('CURRENT RUN EXECUTION REPORT (untrusted agent-authored claims')
      expect(evidence).toContain(maintenanceReport)
      expect(evidence).toContain('a report cannot establish missing source changes')
      return mockJsonResponse({ choices: [{ message: { content: JSON.stringify({
        verdict, missing: verdict === 'ship' ? [] : ['actual dependency changes'],
        unrequested: verdict === 'ship' ? [] : ['banner color'], evidence: 'The audit outcomes are agent-reported.',
      }) } }] })
    })
    vi.stubGlobal('fetch', fetchMock)
    expect(await runLocalGoalFidelityReview({ ...maintenanceReview, model: 'example-model', diff })).toMatchObject({ ok: true, verdict })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  // Opt-in calibration against an actual local reviewer. CI uses the transport assertions above.
  it.runIf(Boolean(process.env.GOAL_FIDELITY_EVAL_MODEL)).each(maintenanceCases)('judges first-attempt audit evidence with a local model for %s', async (_name, diff, verdict) => {
    const result = await runLocalGoalFidelityReview({
      ...maintenanceReview, model: process.env.GOAL_FIDELITY_EVAL_MODEL, diff, timeoutMs: 180_000,
    })
    expect(result.ok, result.error).toBe(true)
    expect(result, JSON.stringify(result)).toMatchObject({ verdict })
  }, 190_000)

  it('truncates the report within the remaining budget without changing source evidence', async () => {
    const objective = 'x'.repeat(16_000)
    const diff = `+{}${' '.repeat(51_895)}+{}`
    const fetchMock = vi.fn(async (_url, init) => {
      const content = JSON.parse(init.body).messages[1].content
      const report = content.split('CURRENT RUN EXECUTION REPORT')[1].split('```text\n')[1].split('\n```')[0]
      expect(content).toContain(diff)
      expect(report.length).toBe(99)
      expect(report).toMatch(/…\[execution report truncated\]$/)
      return mockJsonResponse({ choices: [{ message: { content: '{"verdict":"ship","missing":[],"unrequested":[],"evidence":"No independent test results."}' } }] })
    })
    vi.stubGlobal('fetch', fetchMock)
    expect(await runLocalGoalFidelityReview({
      ...maintenanceReview, model: 'example-model', objective, diff, executionReport: 'x'.repeat(200),
    })).toMatchObject({ ok: true, verdict: 'ship' })
  })

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
