import { describe, it, expect, vi, beforeEach } from 'vitest'
import EventEmitter from 'events'

// Mock all dependencies. Brain search runs through the REAL brainSearchIndex
// (issue #3506), so the seam mocked here is brainStorage's disk reader.
vi.mock('./brainStorage.js', () => ({
  brainEvents: new EventEmitter(),
  getAll: vi.fn().mockResolvedValue([]),
  memoryRecencyMs: (record) => Date.parse(record?.updatedAt ?? '') || 0
}))

vi.mock('./memoryBM25.js', () => ({
  searchBM25: vi.fn().mockResolvedValue([])
}))

vi.mock('./memoryBackend.js', () => ({
  getMemories: vi.fn().mockResolvedValue({ memories: [] }),
  ensureBackend: vi.fn().mockResolvedValue('file'),
  hybridSearchMemories: vi.fn().mockResolvedValue({ memories: [] })
}))

vi.mock('./apps.js', () => ({
  getAllApps: vi.fn().mockResolvedValue([])
}))

vi.mock('./history.js', () => ({
  getHistory: vi.fn().mockResolvedValue({ entries: [] })
}))

vi.mock('./musicVideo/projects.js', () => ({
  listProjects: vi.fn().mockResolvedValue([])
}))

import { fanOutSearch } from './search.js'
import { getAll } from './brainStorage.js'
import { __resetBrainSearchIndex, BRAIN_SEARCH_TYPES } from './brainSearchIndex.js'
import { searchBM25 } from './memoryBM25.js'
import { getMemories, ensureBackend, hybridSearchMemories } from './memoryBackend.js'
import { getAllApps } from './apps.js'
import { getHistory } from './history.js'
import { listProjects as listMusicVideoProjects } from './musicVideo/projects.js'

// Per-type record fixtures the mocked brainStorage.getAll serves.
let brainRecords = {}
const setBrainRecords = (type, records) => { brainRecords[type] = records }

describe('search service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    brainRecords = {}
    __resetBrainSearchIndex()
    getAll.mockImplementation(async (type) => brainRecords[type] ?? [])
    ensureBackend.mockResolvedValue('file')
  })

  describe('fanOutSearch', () => {
    it('should return empty array when no sources match', async () => {
      const results = await fanOutSearch('nonexistent')
      expect(results).toEqual([])
    })

    it('logs query length and counts, never the query text', async () => {
      setBrainRecords('inbox', [{ id: 'i1', capturedText: 'alice example note' }])
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      try {
        const results = await fanOutSearch('alice example')
        expect(results.length).toBeGreaterThan(0)
        const lines = logSpy.mock.calls.map((args) => args.join(' '))
        expect(lines.some((l) => l.includes('alice example'))).toBe(false)
        expect(lines.some((l) => l.includes('13 chars'))).toBe(true)
        expect(lines.some((l) => /: \d+ results across \d+ sources/.test(l))).toBe(true)
      } finally {
        logSpy.mockRestore()
      }
    })

    it('should search across brain inbox entries', async () => {
      setBrainRecords('inbox', [
        { id: 'i1', capturedText: 'Hello world from inbox' },
        { id: 'i2', capturedText: 'Another thought' }
      ])

      const results = await fanOutSearch('hello')
      expect(results.find(s => s.id === 'brain')).toMatchObject({
        label: 'Brain',
        icon: 'Brain',
        results: [{ id: 'i1', type: 'inbox', title: 'Hello world from inbox', url: '/brain/inbox' }]
      })
    })

    it('should search across people', async () => {
      setBrainRecords('people', [
        { id: 'p1', name: 'John Doe', context: 'Friend from school' },
        { id: 'p2', name: 'Jane Smith', context: 'Colleague at work' }
      ])

      const results = await fanOutSearch('john')
      expect(results.find(s => s.id === 'brain')).toMatchObject({
        label: 'Brain',
        icon: 'Brain',
        results: [{ id: 'p1', type: 'person', title: 'John Doe', url: '/brain/memory?type=people&id=p1' }]
      })
    })

    it('should search across projects', async () => {
      setBrainRecords('projects', [
        { id: 'pr1', name: 'PortOS', notes: 'Personal operating system' }
      ])

      const results = await fanOutSearch('portos')
      expect(results.find(s => s.id === 'brain')).toMatchObject({
        label: 'Brain',
        icon: 'Brain',
        results: [{ id: 'pr1', type: 'project', title: 'PortOS', url: '/brain/memory?type=projects&id=pr1' }]
      })
    })

    it('should search across ideas', async () => {
      setBrainRecords('ideas', [
        { id: 'id1', title: 'AI assistant', oneLiner: 'Build a smart agent', notes: 'Use LLMs' }
      ])

      const results = await fanOutSearch('agent')
      expect(results.find(s => s.id === 'brain')).toMatchObject({
        label: 'Brain',
        icon: 'Brain',
        results: [{ id: 'id1', type: 'idea', title: 'AI assistant', url: '/brain/memory?type=ideas&id=id1' }]
      })
    })

    it('should search across links', async () => {
      setBrainRecords('links', [
        { id: 'l1', title: 'GitHub', url: 'https://github.com', description: 'Code hosting platform' }
      ])

      const results = await fanOutSearch('github')
      expect(results.find(s => s.id === 'brain')).toMatchObject({
        label: 'Brain',
        icon: 'Brain',
        results: [{ id: 'l1', type: 'link', title: 'GitHub', url: '/brain/links' }]
      })
    })

    it('should search across threads and deep-link the record drawer', async () => {
      setBrainRecords('threads', [
        { id: 'th1', title: 'Renew the domain', nextAction: 'Log into the registrar', notes: 'Expires soon' },
        { id: 'th2', title: 'Unrelated', nextAction: 'Nothing here', notes: '' }
      ])

      const results = await fanOutSearch('registrar')
      const brainSource = results.find(s => s.id === 'brain')
      expect(brainSource.results.map(r => r.id)).toEqual(['th1'])
      expect(brainSource.results[0]).toMatchObject({
        type: 'thread',
        title: 'Renew the domain',
        url: '/brain/threads?thread=th1'
      })
    })

    it('should search across admin items', async () => {
      setBrainRecords('admin', [
        { id: 'ad1', title: 'Renew registration', notes: 'Due next month', nextAction: 'Book appointment' }
      ])

      const results = await fanOutSearch('renew')
      expect(results.find(s => s.id === 'brain')).toMatchObject({
        label: 'Brain',
        icon: 'Brain',
        results: [{ id: 'ad1', type: 'admin', title: 'Renew registration', url: '/brain/memory?type=admin&id=ad1' }]
      })
    })

    it('should search across memory entries, newest first', async () => {
      setBrainRecords('memories', [
        { id: 'me-old', title: 'Trip notes', content: 'older recollection', updatedAt: '2020-01-01T00:00:00.000Z' },
        { id: 'me-new', title: 'Trip recap', content: 'newer recollection', updatedAt: '2026-01-01T00:00:00.000Z' }
      ])

      const results = await fanOutSearch('recollection')
      const brainSource = results.find(s => s.id === 'brain')
      const memoryEntries = brainSource.results.filter(r => r.type === 'memory-entry')
      expect(memoryEntries.map(r => r.id)).toEqual(['me-new', 'me-old'])
    })

    it('should read each brain store from disk only once across repeated queries', async () => {
      setBrainRecords('people', [{ id: 'p1', name: 'Ada Placeholder', context: 'colleague' }])

      await fanOutSearch('ada')
      const afterFirst = getAll.mock.calls.length
      await fanOutSearch('ada')
      await fanOutSearch('placeholder')

      // One scan per brain source on the first query; every later keystroke is
      // served from the in-memory projection (issue #3506).
      expect(afterFirst).toBe(BRAIN_SEARCH_TYPES.length)
      expect(getAll).toHaveBeenCalledTimes(BRAIN_SEARCH_TYPES.length)
    })

    it('should not re-scan a brain store that is legitimately empty', async () => {
      await fanOutSearch('anything')
      await fanOutSearch('anything else')

      expect(getAll).toHaveBeenCalledTimes(BRAIN_SEARCH_TYPES.length)
    })

    it('should search apps', async () => {
      getAllApps.mockResolvedValue([
        { id: 'a1', name: 'MortalLoom', description: 'Longevity tracker app' },
        { id: 'a2', name: 'PortOS', description: 'Personal OS' }
      ])

      const results = await fanOutSearch('mortal')
      expect(results.find(s => s.id === 'apps')).toMatchObject({
        label: 'Apps',
        icon: 'Package',
        results: [{ id: 'a1', type: 'app', title: 'MortalLoom', url: '/apps' }]
      })
    })

    it('should search history', async () => {
      getHistory.mockResolvedValue({
        entries: [
          { id: 'h1', targetName: 'deploy', action: 'deployed app to production' },
          { id: 'h2', targetName: 'test', action: 'ran test suite' }
        ]
      })

      const results = await fanOutSearch('deploy')
      expect(results.find(s => s.id === 'history')).toMatchObject({
        label: 'History',
        icon: 'History',
        results: [{ id: 'h1', type: 'history', title: 'deploy', url: '/devtools/history' }]
      })
    })

    it('should search health metrics', async () => {
      const results = await fanOutSearch('heart')
      const healthSource = results.find(s => s.id === 'health')
      expect(healthSource).toMatchObject({ label: 'Health', icon: 'HeartPulse' })
      expect(healthSource.results[0]).toMatchObject({ id: 'heart_rate', type: 'health-metric', title: 'Heart Rate', url: '/meatspace/health' })
    })

    it('should match health metrics by display name', async () => {
      const results = await fanOutSearch('steps')
      const healthSource = results.find(s => s.id === 'health')
      expect(healthSource).toMatchObject({ label: 'Health', icon: 'HeartPulse' })
      expect(healthSource.results.find(r => r.id === 'step_count')).toMatchObject({ id: 'step_count', type: 'health-metric', title: 'Steps', url: '/meatspace/health' })
    })

    it('should match health metrics by key name', async () => {
      const results = await fanOutSearch('hrv')
      const healthSource = results.find(s => s.id === 'health')
      expect(healthSource).toMatchObject({ label: 'Health', icon: 'HeartPulse' })
      expect(healthSource.results.find(r => r.id === 'hrv')).toMatchObject({ id: 'hrv', type: 'health-metric', title: 'HRV', url: '/meatspace/health' })
    })

    it('should use BM25 search for file-based memory backend', async () => {
      ensureBackend.mockResolvedValue('file')
      searchBM25.mockResolvedValue([
        { id: 'mem1', score: 1.5 }
      ])
      getMemories.mockResolvedValue({
        memories: [
          { id: 'mem1', summary: 'Test memory about coding' }
        ]
      })

      const results = await fanOutSearch('coding')
      expect(results.find(s => s.id === 'memory')).toMatchObject({
        label: 'Memory',
        icon: 'Cpu',
        results: [{ id: 'mem1', type: 'memory', title: 'Test memory about coding', url: '/cos/memory' }]
      })
    })

    it('should use hybrid search for postgres backend', async () => {
      ensureBackend.mockResolvedValue('postgres')
      hybridSearchMemories.mockResolvedValue({
        memories: [
          { id: 'pgm1', summary: 'Postgres memory result' }
        ]
      })

      const results = await fanOutSearch('postgres')
      expect(results.find(s => s.id === 'memory')).toMatchObject({
        label: 'Memory',
        icon: 'Cpu',
        results: [{ id: 'pgm1', type: 'memory', title: 'Postgres memory result', url: '/cos/memory' }]
      })
      expect(hybridSearchMemories).toHaveBeenCalledWith('postgres', null, { limit: 10 })
    })

    it('should handle failing adapters gracefully', async () => {
      getAll.mockRejectedValue(new Error('DB error'))
      searchBM25.mockRejectedValue(new Error('Index error'))
      getAllApps.mockRejectedValue(new Error('App error'))
      getHistory.mockRejectedValue(new Error('History error'))

      // Should not throw, should return health results at minimum
      const results = await fanOutSearch('heart')
      // Only health (synchronous) should have results, others fall back
      expect(results).toHaveLength(1)
      expect(results[0].id).toBe('health')
      expect(results[0].results.length).toBeGreaterThan(0)
      expect(results[0].results[0].id).toBe('heart_rate')
    })

    it('should limit brain results to 8', async () => {
      setBrainRecords('inbox', Array.from({ length: 20 }, (_, i) => ({
        id: `inbox-${i}`,
        capturedText: `test entry ${i}`
      })))

      const results = await fanOutSearch('test')
      const brainSource = results.find(s => s.id === 'brain')
      expect(brainSource.results.map(r => r.id)).toEqual(Array.from({ length: 8 }, (_, i) => `inbox-${i}`))
    })

    it('should only return non-empty sources', async () => {
      // Only apps have results
      getAllApps.mockResolvedValue([
        { id: 'a1', name: 'TestApp', description: 'A test app' }
      ])

      const results = await fanOutSearch('testapp')
      expect(results).toMatchObject([{ id: 'apps', results: [{ id: 'a1', title: 'TestApp' }] }])
    })

    it('should be case-insensitive', async () => {
      getAllApps.mockResolvedValue([
        { id: 'a1', name: 'PortOS', description: 'Personal OS' }
      ])

      const results = await fanOutSearch('PORTOS')
      expect(results.find(s => s.id === 'apps')).toMatchObject({
        label: 'Apps',
        icon: 'Package',
        results: [{ id: 'a1', type: 'app', title: 'PortOS', url: '/apps' }]
      })
    })

    it('should search across music-video projects', async () => {
      listMusicVideoProjects.mockResolvedValue([
        { id: 'mv-1', name: 'Cyberpunk Odyssey', concept: 'Sci-fi cyberpunk music video' },
        { id: 'mv-2', name: 'Acoustic Sunset', concept: 'Serene folk ballad' }
      ])

      const results = await fanOutSearch('cyberpunk')
      expect(results.find(s => s.id === 'musicVideo')).toMatchObject({
        label: 'Music Video',
        icon: 'Video',
        results: [{ id: 'mv-1', type: 'music-video', title: 'Cyberpunk Odyssey', url: '/music-video/mv-1' }]
      })
    })

    it('should keep music-video matches when a concept is a structured object', async () => {
      listMusicVideoProjects.mockResolvedValue([
        { id: 'mv-1', name: 'Example project', concept: { prompt: 'Synthetic concept', style: 'Synthetic style' } },
        { id: 'mv-2', name: 'Example legacy', concept: 'Legacy concept text' },
        { id: 'mv-3', name: 'Example empty', concept: {} },
        { id: 'mv-4', name: 'Example null', concept: null, description: 'Fallback description' }
      ])

      const results = await fanOutSearch('example')
      const mvSource = results.find(s => s.id === 'musicVideo')
      expect(mvSource).toMatchObject({ label: 'Music Video', icon: 'Video' })
      expect(mvSource.results).toHaveLength(4)
      const snippets = Object.fromEntries(mvSource.results.map(r => [r.id, r.snippet]))
      expect(snippets['mv-1']).toBe('Synthetic concept')
      expect(snippets['mv-2']).toBe('Legacy concept text')
      expect(snippets['mv-3']).toBe('Example empty')
      expect(snippets['mv-4']).toBe('Fallback description')
    })

    it('should cap music-video results at five when concepts are structured', async () => {
      listMusicVideoProjects.mockResolvedValue(
        Array.from({ length: 7 }, (_, i) => ({
          id: `mv-${i}`,
          name: `Example ${i}`,
          concept: { prompt: `Concept ${i}`, style: 'Style' }
        }))
      )

      const results = await fanOutSearch('example')
      const mvSource = results.find(s => s.id === 'musicVideo')
      expect(mvSource.results).toHaveLength(5)
      expect(mvSource.results.map(r => r.snippet)).toEqual(['Concept 0', 'Concept 1', 'Concept 2', 'Concept 3', 'Concept 4'])
    })
  })
})
