import { beforeEach, describe, expect, it, vi } from 'vitest'

const execGhMock = vi.fn()
const ensureForgeReachableMock = vi.fn()
const getSelfLoginMock = vi.fn()
const getOriginInfoMock = vi.fn()
const runModelAbuseScanMock = vi.fn()

vi.mock('./github.js', () => ({
  execGh: (...args) => execGhMock(...args),
  ensureForgeReachable: (...args) => ensureForgeReachableMock(...args),
}))
vi.mock('./prWatcher.js', () => ({
  getSelfLogin: (...args) => getSelfLoginMock(...args),
}))
vi.mock('./modelAbuseGuard.js', () => ({
  runModelAbuseScan: (...args) => runModelAbuseScanMock(...args),
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
  listExternalOpenPullRequests,
  runPrReviewerSecurityScan,
  securityScanFingerprint,
  summarizeSecurityScanReport,
} from './prReviewerSecurity.js'

const app = { id: 'app-example', repoPath: '/tmp/example-repo' }
const guardVerdict = (safe = true) => ({
  ok: true,
  safe,
  code: safe ? 'security-guard-passed' : 'security-guard-classified-malicious',
  guardId: 'llama-prompt-guard-2-86m',
  model: 'Llama Prompt Guard 2 86M',
  revision: 'a8ded8e697ce7c355e395a0df51f94adb4a2fd27',
  findings: safe ? [] : [{
    severity: 'blocking',
    category: 'prompt-classifier',
    location: 'external-content',
    reason: 'The dedicated model-abuse classifier marked one or more complete content windows as malicious.',
  }],
  layers: { deterministic: 'passed', classifier: safe ? 'passed' : 'blocked', verdict: 'validated' },
  chunkCount: 1,
  minBenignScore: safe ? 0.99 : null,
})

const listedPr = (number, authorLogin, headRefOid, overrides = {}) => ({
  number,
  author: { login: authorLogin },
  url: `https://example.test/pr/${number}`,
  headRefOid,
  updatedAt: '2026-08-31T00:00:00Z',
  title: `Contributor update ${number}`,
  body: `Description for PR ${number}`,
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  ensureForgeReachableMock.mockResolvedValue({ ok: true })
  getOriginInfoMock.mockResolvedValue({ host: 'github.com', fullName: 'example/repo' })
  getSelfLoginMock.mockResolvedValue('maintainer')
  runModelAbuseScanMock.mockResolvedValue(guardVerdict())
})

describe('pr-reviewer model-abuse preflight', () => {
  it('lists every external open PR and excludes the repository owner', async () => {
    execGhMock
      .mockResolvedValueOnce('main')
      .mockResolvedValueOnce(JSON.stringify([
        listedPr(11, 'maintainer', 'a'.repeat(40)),
        listedPr(12, 'Contributor-A', 'b'.repeat(40)),
      ]))

    const result = await listExternalOpenPullRequests(app)

    expect(result).toMatchObject({
      ok: true,
      repoSpec: 'github.com/example/repo',
      repoFullName: 'example/repo',
      defaultBranch: 'main',
    })
    expect(result.prs).toEqual([expect.objectContaining({ number: 12, authorLogin: 'Contributor-A' })])
    expect(execGhMock).toHaveBeenCalledWith([
      'pr', 'list', '--repo', 'github.com/example/repo', '--base', 'main', '--state', 'open',
      '--limit', '200', '--json', 'number,author,url,headRefOid,updatedAt,title,body',
    ])
  })

  it('keys a pending report to the exact external PR head set', () => {
    const base = {
      ok: true,
      repoFullName: 'example/repo',
      defaultBranch: 'main',
      prs: [{ number: 12, headRefOid: 'a'.repeat(40) }],
    }
    expect(securityScanFingerprint(base)).toBe(securityScanFingerprint({
      ...base,
      prs: [{ number: 12, headRefOid: 'a'.repeat(40) }],
    }))
    expect(securityScanFingerprint({
      ...base,
      prs: [{ number: 12, headRefOid: 'b'.repeat(40) }],
    })).not.toBe(securityScanFingerprint(base))
    expect(securityScanFingerprint({ ...base, prs: [{ number: 12, headRefOid: null }] })).toBeNull()
  })

  it('scans every external PR through the dedicated classifier and keeps only generic report data', async () => {
    execGhMock
      .mockResolvedValueOnce('main')
      .mockResolvedValueOnce(JSON.stringify([
        listedPr(11, 'maintainer', 'a'.repeat(40)),
        listedPr(12, 'contributor-a', 'b'.repeat(40)),
        listedPr(13, 'contributor-b', 'c'.repeat(40)),
      ]))
      .mockResolvedValueOnce('diff for twelve')
      .mockResolvedValueOnce('diff for thirteen')

    const result = await runPrReviewerSecurityScan({ app })

    expect(result).toMatchObject({ ok: true, passed: true, code: 'security-scan-passed' })
    expect(result.reviewedPrs).toEqual([
      expect.objectContaining({ number: 12, passed: true, findings: 'No model-abuse findings.' }),
      expect.objectContaining({ number: 13, passed: true, findings: 'No model-abuse findings.' }),
    ])
    expect(result.reviewedPrs[0]).not.toHaveProperty('rawResponse')
    expect(result.reviewedPrs[0]).not.toHaveProperty('diff')
    expect(result.guardId).toBe('llama-prompt-guard-2-86m')
    expect(runModelAbuseScanMock).toHaveBeenCalledTimes(2)
    expect(runModelAbuseScanMock.mock.calls[0][0].content).toContain('Complete unified diff:')
    expect(runModelAbuseScanMock.mock.calls[0][0].content).toContain('diff for twelve')
  })

  it('reviews all external PRs before returning a generic finding report', async () => {
    runModelAbuseScanMock.mockResolvedValue(guardVerdict(false))
    execGhMock
      .mockResolvedValueOnce('main')
      .mockResolvedValueOnce(JSON.stringify([
        listedPr(12, 'contributor-a', 'b'.repeat(40)),
        listedPr(13, 'contributor-b', 'c'.repeat(40)),
      ]))
      .mockResolvedValueOnce('diff for twelve')
      .mockResolvedValueOnce('diff for thirteen')

    const result = await runPrReviewerSecurityScan({ app })

    expect(result).toMatchObject({ ok: true, passed: false, code: 'security-scan-findings' })
    expect(result.reviewedPrs).toHaveLength(2)
    expect(result.reviewedPrs.every((report) => report.safe === false)).toBe(true)
    expect(result.reviewedPrs[0].findings).toContain('dedicated model-abuse classifier')
    expect(result.reviewedPrs[0].securityFindings[0]).not.toHaveProperty('quote')
    expect(runModelAbuseScanMock).toHaveBeenCalledTimes(2)
  })

  it('fails closed while retaining generic reports collected before an unavailable verdict', async () => {
    runModelAbuseScanMock
      .mockResolvedValueOnce(guardVerdict())
      .mockResolvedValueOnce({ ok: false, code: 'security-guard-timeout' })
    execGhMock
      .mockResolvedValueOnce('main')
      .mockResolvedValueOnce(JSON.stringify([
        listedPr(12, 'contributor-a', 'b'.repeat(40)),
        listedPr(13, 'contributor-b', 'c'.repeat(40)),
      ]))
      .mockResolvedValueOnce('diff for twelve')
      .mockResolvedValueOnce('diff for thirteen')

    const result = await runPrReviewerSecurityScan({ app })

    expect(result).toMatchObject({ ok: false, passed: false, code: 'security-guard-timeout' })
    expect(result.reviewedPrs).toEqual([expect.objectContaining({ number: 12, safe: true })])
  })

  it('summarizes a report without exposing source content', () => {
    expect(summarizeSecurityScanReport({
      number: 12,
      safe: false,
      securityFindings: [{ severity: 'blocking', reason: 'generic' }],
      diff: 'must not be returned',
    })).toEqual({
      number: 12,
      safe: false,
      findingCount: 1,
      guardId: 'llama-prompt-guard-2-86m',
    })
  })
})
