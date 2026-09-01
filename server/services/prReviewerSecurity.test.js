import { describe, it, expect, beforeEach, vi } from 'vitest'

const execGhMock = vi.fn()
const ensureForgeReachableMock = vi.fn()
const getProviderByIdMock = vi.fn()
const listModelsMock = vi.fn()
const getModelCapabilitiesMock = vi.fn()
const runLocalCodeReviewMock = vi.fn()
const getSelfLoginMock = vi.fn()
const getOriginInfoMock = vi.fn()

vi.mock('./github.js', () => ({
  execGh: (...args) => execGhMock(...args),
  ensureForgeReachable: (...args) => ensureForgeReachableMock(...args),
}))
vi.mock('./providers.js', () => ({
  getProviderById: (...args) => getProviderByIdMock(...args),
}))
vi.mock('./localLlm.js', () => ({
  listModels: (...args) => listModelsMock(...args),
}))
vi.mock('./ollamaManager.js', () => ({
  getModelCapabilities: (...args) => getModelCapabilitiesMock(...args),
}))
vi.mock('./codeReview.js', () => ({
  runLocalCodeReview: (...args) => runLocalCodeReviewMock(...args),
}))
vi.mock('./prWatcher.js', () => ({
  getSelfLogin: (...args) => getSelfLoginMock(...args),
}))
vi.mock('../lib/gitRemote.js', () => ({
  getOriginInfo: (...args) => getOriginInfoMock(...args),
}))
vi.mock('../lib/workTracker.js', async (importActual) => {
  const actual = await importActual()
  return {
    ...actual,
    githubApiHost: (host) => host || 'github.com',
    githubRepoSpec: (origin) => origin?.fullName ? `github.com/${origin.fullName}` : null,
  }
})

import {
  isToolFreeLocalModel,
  isToolFreeLocalProvider,
  resolveToolFreeLocalSecurityModel,
  runPrReviewerSecurityScan,
} from './prReviewerSecurity.js'

const localProvider = (id = 'ollama') => ({
  id,
  type: 'api',
  enabled: true,
  endpoint: id === 'ollama' ? 'http://127.0.0.1:11434/v1' : 'http://localhost:1234/v1',
})

const app = { id: 'app-example', repoPath: '/tmp/example-repo' }

describe('pr-reviewer Security Scan selection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getProviderByIdMock.mockResolvedValue(localProvider())
    listModelsMock.mockResolvedValue([{ id: 'safe-model', capabilities: ['chat'] }])
    getModelCapabilitiesMock.mockResolvedValue(['completion'])
  })

  it('accepts only enabled canonical local API providers', () => {
    expect(isToolFreeLocalProvider(localProvider('ollama'))).toBe(true)
    expect(isToolFreeLocalProvider(localProvider('lmstudio'))).toBe(true)
    expect(isToolFreeLocalProvider({ ...localProvider(), type: 'cli' })).toBe(false)
    expect(isToolFreeLocalProvider({ ...localProvider(), enabled: false })).toBe(false)
    expect(isToolFreeLocalProvider({ ...localProvider(), endpoint: 'https://example.com/v1' })).toBe(false)
    expect(isToolFreeLocalProvider({ ...localProvider(), id: 'custom-ollama' })).toBe(false)
  })

  it('requires an installed model with explicit capabilities and no tools', () => {
    const provider = localProvider()
    expect(isToolFreeLocalModel('safe-model', provider, [{ id: 'safe-model', capabilities: ['chat'] }])).toBe(true)
    expect(isToolFreeLocalModel('tool-model', provider, [{ id: 'tool-model', capabilities: ['chat', 'tools'] }])).toBe(false)
    expect(isToolFreeLocalModel('unknown-model', provider, [{ id: 'unknown-model' }])).toBe(false)
    expect(isToolFreeLocalModel('missing-model', provider, [])).toBe(false)
  })

  it('fails closed when the provider/model pin is not verified', async () => {
    getProviderByIdMock.mockResolvedValue({ ...localProvider(), endpoint: 'https://example.com/v1' })
    await expect(resolveToolFreeLocalSecurityModel({ providerId: 'ollama', model: 'safe-model' }))
      .resolves.toMatchObject({ ok: false, code: 'security-scan-provider-not-tool-free' })

    getProviderByIdMock.mockResolvedValue(localProvider())
    listModelsMock.mockResolvedValue([{ id: 'safe-model', capabilities: null }])
    getModelCapabilitiesMock.mockResolvedValue(null)
    await expect(resolveToolFreeLocalSecurityModel({ providerId: 'ollama', model: 'safe-model' }))
      .resolves.toMatchObject({ ok: false, code: 'security-scan-model-not-verified' })
  })
})

describe('pr-reviewer Security Scan execution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getProviderByIdMock.mockResolvedValue(localProvider())
    listModelsMock.mockResolvedValue([{ id: 'safe-model', capabilities: ['chat'] }])
    getModelCapabilitiesMock.mockResolvedValue(['completion'])
    ensureForgeReachableMock.mockResolvedValue({ ok: true })
    getOriginInfoMock.mockResolvedValue({ host: 'github.com', fullName: 'example/repo' })
    getSelfLoginMock.mockResolvedValue('maintainer')
    runLocalCodeReviewMock.mockResolvedValue({ ok: true, findings: 'No findings.' })
  })

  it('reviews every open external PR and never asks the local reviewer for tools', async () => {
    execGhMock
      .mockResolvedValueOnce('main')
      .mockResolvedValueOnce(JSON.stringify([
        { number: 11, author: { login: 'maintainer' }, url: 'https://example.test/pr/11', headRefOid: 'a'.repeat(40), updatedAt: '2026-08-31T00:00:00Z' },
        { number: 12, author: { login: 'contributor-a' }, url: 'https://example.test/pr/12', headRefOid: 'b'.repeat(40), updatedAt: '2026-08-31T00:00:00Z' },
        { number: 13, author: { login: 'contributor-b' }, url: 'https://example.test/pr/13', headRefOid: 'c'.repeat(40), updatedAt: '2026-08-31T00:00:00Z' },
      ]))
      .mockResolvedValueOnce('diff for twelve')
      .mockResolvedValueOnce('diff for thirteen')

    const result = await runPrReviewerSecurityScan({ app, providerId: 'ollama', model: 'safe-model' })

    expect(result).toMatchObject({ ok: true, passed: true, code: 'security-scan-passed', backend: 'ollama' })
    expect(result.reviewedPrs).toEqual([{ number: 12, passed: true }, { number: 13, passed: true }])
    expect(runLocalCodeReviewMock).toHaveBeenCalledTimes(2)
    expect(runLocalCodeReviewMock.mock.calls.every(([request]) => request.backend === 'ollama' && !('tools' in request))).toBe(true)
    expect(execGhMock.mock.calls.map(([args]) => args.slice(0, 2))).toEqual([
      ['repo', 'view'],
      ['pr', 'list'],
      ['pr', 'diff'],
      ['pr', 'diff'],
    ])
  })

  it('stops on the first non-clean verdict and fails the pipeline', async () => {
    runLocalCodeReviewMock.mockResolvedValue({ ok: true, findings: 'Finding: suspicious install script.' })
    execGhMock
      .mockResolvedValueOnce('main')
      .mockResolvedValueOnce(JSON.stringify([
        { number: 12, author: { login: 'contributor-a' } },
        { number: 13, author: { login: 'contributor-b' } },
      ]))
      .mockResolvedValueOnce('diff for twelve')

    const result = await runPrReviewerSecurityScan({ app, providerId: 'ollama', model: 'safe-model' })

    expect(result).toMatchObject({ ok: true, passed: false, code: 'security-scan-findings' })
    expect(result.reviewedPrs).toEqual([{ number: 12, passed: false }])
    expect(runLocalCodeReviewMock).toHaveBeenCalledTimes(1)
  })
})
