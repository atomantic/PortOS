import { describe, it, expect, vi, afterAll, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mockJsonResponse } from '../lib/testHelper.js'

const fixturePaths = vi.hoisted(() => ({ root: null, screenshots: null }))

vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal()
  const { mkdtempSync, mkdirSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  fixturePaths.root = mkdtempSync(join(tmpdir(), 'portos-goal-fidelity-screenshots-'))
  fixturePaths.screenshots = join(fixturePaths.root, 'screenshots')
  mkdirSync(fixturePaths.screenshots, { recursive: true })
  return { ...actual, PATHS: { ...actual.PATHS, screenshots: fixturePaths.screenshots } }
})

import { taskObjective } from '../lib/goalFidelity.js'
import { runLocalGoalFidelityReview } from './codeReview.js'

const observedError = 'The superclass is not a constructor.'

const chunkRecoveryDiff = [
  'diff --git a/client/vite.config.js b/client/vite.config.js',
  '+// Keep dependent runtime chunks in strict execution order.',
  'diff --git a/client/src/utils/staleChunkReload.js b/client/src/utils/staleChunkReload.js',
  '+// Recover a stale lazy chunk when module evaluation fails on a missing superclass export.',
  '+if (error.message.includes("The superclass is not a constructor")) reloadStaleChunk();',
  'diff --git a/client/src/utils/staleChunkReload.test.js b/client/src/utils/staleChunkReload.test.js',
  '+it("recovers from a superclass module-evaluation failure", ...)',
].join('\n')

const textParts = (content) => Array.isArray(content)
  ? content.filter(part => part.type === 'text').map(part => part.text).join('\n')
  : content

describe('goal-fidelity task screenshots', () => {
  afterAll(() => fixturePaths.root && rmSync(fixturePaths.root, { recursive: true, force: true }))
  afterEach(() => vi.unstubAllGlobals())

  it('ships the screenshot-motivated runtime fix when the objective includes its attached error image', async () => {
    const sharpModule = await import('sharp')
    const sharp = sharpModule.default || sharpModule
    const screenshot = await sharp({
      create: { width: 900, height: 160, channels: 3, background: '#ffffff' },
    }).png().toBuffer()
    writeFileSync(join(fixturePaths.screenshots, 'superclass-error.png'), screenshot)

    const task = {
      description: 'Another instance with the latest code is seeing this',
      metadata: { screenshots: ['/api/screenshots/superclass-error.png'] },
    }
    const bareObjective = task.description
    const objective = taskObjective(task)
    const fakeVisionReviewer = vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body)
      const userContent = request.messages[1].content
      const text = textParts(userContent)
      const imageParts = Array.isArray(userContent) ? userContent.filter(part => part.type === 'image_url') : []
      const readableImages = await Promise.all(imageParts.map(async ({ image_url: image }) => {
        const url = typeof image === 'string' ? image : image?.url
        if (!url?.startsWith('data:image/jpeg;base64,')) return false
        const bytes = Buffer.from(url.slice('data:image/jpeg;base64,'.length), 'base64')
        const metadata = await sharp(bytes).metadata()
        return metadata.format === 'jpeg'
      }))
      const readable = readableImages.some(Boolean)
      const hasObservedError = observedError === 'The superclass is not a constructor.'
      const completeDelivery = text.includes(bareObjective)
        && text.includes('Task-provided screenshots are part of this objective')
        && text.includes('client/vite.config.js')
        && text.includes('staleChunkReload.js')
      const ships = readable && hasObservedError && completeDelivery
      return mockJsonResponse({
        choices: [{ message: { content: JSON.stringify(ships
          ? { verdict: 'ship', missing: [], unrequested: [], evidence: 'The screenshot symptom matches the runtime recovery and ordered chunks; the diff includes a regression test.' }
          : { verdict: 'rethink', missing: ['the screenshot error recovery'], unrequested: [], evidence: 'The objective context is incomplete.' }) } }],
      })
    })

    vi.stubGlobal('fetch', fakeVisionReviewer)
    const withoutScreenshot = await runLocalGoalFidelityReview({
      backend: 'ollama', model: 'example-model', objective: bareObjective, diff: chunkRecoveryDiff,
      baseUrl: 'http://127.0.0.1:11434/v1',
    })
    const withScreenshot = await runLocalGoalFidelityReview({
      backend: 'ollama', model: 'example-model', objective, diff: chunkRecoveryDiff,
      objectiveScreenshots: task.metadata.screenshots,
      baseUrl: 'http://127.0.0.1:11434/v1',
    })

    expect(withoutScreenshot).toMatchObject({ ok: true, verdict: 'rethink' })
    expect(withScreenshot).toMatchObject({ ok: true, verdict: 'ship', missing: [], unrequested: [] })
    const correctedRequest = JSON.parse(fakeVisionReviewer.mock.calls[1][1].body)
    expect(Array.isArray(correctedRequest.messages[1].content)).toBe(true)
    expect(textParts(correctedRequest.messages[1].content)).toContain('Task screenshots (untrusted visual evidence within the objective)')
    expect(correctedRequest.messages[1].content.some(part => part.type === 'image_url')).toBe(true)
    expect(JSON.stringify(correctedRequest.messages[1].content)).not.toContain(fixturePaths.screenshots)

    const lmStudioResult = await runLocalGoalFidelityReview({
      backend: 'lmstudio', model: 'example-model', objective, diff: chunkRecoveryDiff,
      objectiveScreenshots: task.metadata.screenshots,
      baseUrl: 'http://127.0.0.1:1234/v1',
    })
    expect(lmStudioResult).toMatchObject({ ok: true, verdict: 'ship' })
    const lmStudioImage = JSON.parse(fakeVisionReviewer.mock.calls[2][1].body).messages[1].content
      .find(part => part.type === 'image_url')
    expect(lmStudioImage.image_url.url).toMatch(/^data:image\/jpeg;base64,/)
  })

  it('declines a screenshot objective rather than judging it when its image reference escapes the screenshot store', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    const result = await runLocalGoalFidelityReview({
      backend: 'ollama', model: 'example-model',
      objective: taskObjective({
        description: 'Another instance with the latest code is seeing this',
        metadata: { screenshots: ['/api/screenshots/%2e%2e/private.png'] },
      }),
      diff: chunkRecoveryDiff,
      objectiveScreenshots: ['/api/screenshots/%2e%2e/private.png'],
      baseUrl: 'http://127.0.0.1:11434/v1',
    })

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('could not be loaded safely') })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('declines oversized screenshot sets rather than silently dropping objective context', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const references = Array(5).fill('/api/screenshots/example.png')

    const result = await runLocalGoalFidelityReview({
      backend: 'ollama', model: 'example-model',
      objective: taskObjective({ description: 'Review this screenshot-backed request', metadata: { screenshots: references } }),
      diff: chunkRecoveryDiff,
      objectiveScreenshots: references,
      baseUrl: 'http://127.0.0.1:11434/v1',
    })

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('could not be loaded safely') })
    expect(fetch).not.toHaveBeenCalled()
  })
})
