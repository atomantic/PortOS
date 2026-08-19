import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runBrainParitySweep } from './brainParitySweep.js'
import { DEFAULT_JOBS } from './defaults.js'
import { SCRIPT_HANDLERS } from './scriptHandlers.js'

const peerReport = (overrides = {}) => ({
  peerId: 'peer-1',
  peerInstanceId: 'inst-1',
  peerName: 'Peer One',
  checkedAt: '2026-08-18T00:00:00.000Z',
  available: true,
  checksums: { local: 'aaa', peer: 'aaa', match: true },
  summary: { total: 10, 'in-parity': 10, 'local-only': 0, 'peer-only': 0, diverged: 0 },
  byType: [],
  ...overrides
})

describe('runBrainParitySweep', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })
  afterEach(() => { vi.restoreAllMocks() })

  it('sweeps every federating peer — never a single peer', async () => {
    const check = vi.fn().mockResolvedValue({ reports: [] })
    await runBrainParitySweep({ check })
    expect(check).toHaveBeenCalledTimes(1)
    expect(check.mock.calls[0][0]?.peerId).toBeUndefined()
  })

  it('reports a clean sweep with no out-of-parity peers', async () => {
    const check = vi.fn().mockResolvedValue({ reports: [peerReport()] })
    const result = await runBrainParitySweep({ check })
    expect(result.peersChecked).toBe(1)
    expect(result.peersOutOfParity).toBe(0)
    expect(result.outOfParityRecords).toBe(0)
    expect(result.peersUnavailable).toBe(0)
    expect(result.peers[0]).toMatchObject({ peerId: 'peer-1', available: true, recordsCompared: 10, checksumMatch: true })
  })

  it('counts local-only, peer-only and diverged records as out of parity', async () => {
    const check = vi.fn().mockResolvedValue({
      reports: [peerReport({
        summary: { total: 10, 'in-parity': 4, 'local-only': 2, 'peer-only': 3, diverged: 1 }
      })]
    })
    const result = await runBrainParitySweep({ check })
    expect(result.outOfParityRecords).toBe(6)
    expect(result.peersOutOfParity).toBe(1)
    expect(result.peers[0].outOfParity).toBe(6)
  })

  it('flags a checksum mismatch as out of parity even when every id and clock matches', async () => {
    // The case only the whole-brain checksum can see: same ids, same clocks,
    // different record BODIES. Counting only manifest differences would call
    // this install clean.
    const check = vi.fn().mockResolvedValue({
      reports: [peerReport({ checksums: { local: 'aaa', peer: 'bbb', match: false } })]
    })
    const result = await runBrainParitySweep({ check })
    expect(result.peersOutOfParity).toBe(1)
    expect(result.outOfParityRecords).toBe(0)
  })

  it('does not treat an unverified checksum as divergence', async () => {
    // A peer too old to serve a checksum yields match:null — unknown, not a
    // mismatch. Reporting it as out of parity would cry wolf on every sweep.
    const check = vi.fn().mockResolvedValue({
      reports: [peerReport({ checksums: { local: 'aaa', peer: null, match: null } })]
    })
    const result = await runBrainParitySweep({ check })
    expect(result.peersOutOfParity).toBe(0)
    expect(result.peers[0].checksumMatch).toBeNull()
  })

  it('separates unavailable peers from diverged ones', async () => {
    const check = vi.fn().mockResolvedValue({
      reports: [
        peerReport(),
        { peerId: 'peer-2', peerName: 'Peer Two', available: false, reason: 'peer-unreachable' }
      ]
    })
    const result = await runBrainParitySweep({ check })
    expect(result.peersChecked).toBe(2)
    expect(result.peersUnavailable).toBe(1)
    expect(result.peersOutOfParity).toBe(0)
    expect(result.peers[1]).toEqual({ peerId: 'peer-2', peerName: 'Peer Two', available: false, reason: 'peer-unreachable' })
  })

  it('returns a summary only — never the per-record report bodies', async () => {
    // The result is echoed by the manual-trigger route and emitted on
    // `jobs:script-executed`; a badly diverged install's byType lists must not
    // ride along.
    const check = vi.fn().mockResolvedValue({
      reports: [peerReport({ byType: [{ type: 'notes', counts: {}, records: [{ id: 'n1' }] }] })]
    })
    const result = await runBrainParitySweep({ check })
    expect(JSON.stringify(result)).not.toContain('n1')
    expect(result.peers[0].byType).toBeUndefined()
  })

  it('survives a malformed check result rather than throwing on the scheduler thread', async () => {
    const check = vi.fn().mockResolvedValue(null)
    await expect(runBrainParitySweep({ check })).resolves.toMatchObject({ peersChecked: 0 })
  })

  it('surfaces an unreadable peer registry distinctly from a peerless install', async () => {
    // Both check nothing and report zero peers. Only one of them means the
    // audit actually ran, so a scheduled sweep must not record "all clear"
    // for a registry it could not read.
    const unreadable = await runBrainParitySweep({
      check: vi.fn().mockResolvedValue({ reports: [], peerRegistryUnavailable: true })
    })
    const peerless = await runBrainParitySweep({
      check: vi.fn().mockResolvedValue({ reports: [] })
    })

    expect(unreadable.peerRegistryUnavailable).toBe(true)
    expect(peerless.peerRegistryUnavailable).toBe(false)
    expect(unreadable.peersChecked).toBe(0)
    expect(peerless.peersChecked).toBe(0)
  })
})

describe('job-brain-parity-sweep registration', () => {
  const job = DEFAULT_JOBS.find(j => j.id === 'job-brain-parity-sweep')

  it('ships as a script job wired to a registered handler', () => {
    expect(job).toBeDefined()
    expect(job.type).toBe('script')
    expect(SCRIPT_HANDLERS[job.scriptHandler]).toBe(runBrainParitySweep)
  })

  it('ships DISABLED — opt-in per install, not a forced background cost (#4519)', () => {
    expect(job.enabled).toBe(false)
  })
})
