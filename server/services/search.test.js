import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock all dependencies
vi.mock('./brainStorage.js', () => ({
  getInboxLog: vi.fn().mockResolvedValue([]),
  getPeople: vi.fn().mockResolvedValue([]),
  getProjects: vi.fn().mockResolvedValue([]),
  getIdeas: vi.fn().mockResolvedValue([]),
  getAdminItems: vi.fn().mockResolvedValue([]),
  getMemoryEntries: vi.fn().mockResolvedValue([]),
  getLinks: vi.fn().mockResolvedValue([])
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

import { fanOutSearch } from './search.js'
import { getInboxLog, getPeople, getProjects, getIdeas, getAdminItems, getMemoryEntries, getLinks } from './brainStorage.js'
import { searchBM25 } from './memoryBM25.js'
import { getMemories, ensureBackend, hybridSearchMemories } from './memoryBackend.js'
import { getAllApps } from './apps.js'
import { getHistory } from './history.js'

describe('search service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ensureBackend.mockResolvedValue('file')
  })

  describe('fanOutSearch', () => {
    it('should return empty array when no sources match', async () => {
      const results = await fanOutSearch('nonexistent')
      expect(results).toEqual([])
    })

    it('should search across brain inbox entries', async () => {
      getInboxLog.mockResolvedValue([
        { id: 'i1', capturedText: 'Hello world from inbox' },
        { id: 'i2', capturedText: 'Another thought' }
      ])

      const results = await fanOutSearch('hello')
      const brainSource = results.find(s => s.id === 'brain')
      expect(brainSource).toBeDefined()
      expect(brainSource.results).toHaveLength(1)
      expect(brainSource.results[0].id).toBe('i1')
      expect(brainSource.results[0].type).toBe('inbox')
    })

    it('should search across people', async () => {
      getPeople.mockResolvedValue([
        { id: 'p1', name: 'John Doe', context: 'Friend from school' },
        { id: 'p2', name: 'Jane Smith', context: 'Colleague at work' }
      ])

      const results = await fanOutSearch('john')
      const brainSource = results.find(s => s.id === 'brain')
      expect(brainSource).toBeDefined()
      const personResult = brainSource.results.find(r => r.id === 'p1')
      expect(personResult).toBeDefined()
      expect(personResult.type).toBe('person')
      expect(personResult.title).toBe('John Doe')
    })

    it('should search across projects', async () => {
      getProjects.mockResolvedValue([
        { id: 'pr1', name: 'PortOS', notes: 'Personal operating system' }
      ])

      const results = await fanOutSearch('portos')
      const brainSource = results.find(s => s.id === 'brain')
      expect(brainSource).toBeDefined()
      const projectResult = brainSource.results.find(r => r.id === 'pr1')
      expect(projectResult).toBeDefined()
      expect(projectResult.type).toBe('project')
    })

    it('should search across ideas', async () => {
      getIdeas.mockResolvedValue([
        { id: 'id1', title: 'AI assistant', oneLiner: 'Build a smart agent', notes: 'Use LLMs' }
      ])

      const results = await fanOutSearch('agent')
      const brainSource = results.find(s => s.id === 'brain')
      expect(brainSource).toBeDefined()
      const ideaResult = brainSource.results.find(r => r.id === 'id1')
      expect(ideaResult).toBeDefined()
      expect(ideaResult.type).toBe('idea')
    })

    it('should search across links', async () => {
      getLinks.mockResolvedValue([
        { id: 'l1', title: 'GitHub', url: 'https://github.com', description: 'Code hosting platform' }
      ])

      const results = await fanOutSearch('github')
      const brainSource = results.find(s => s.id === 'brain')
      expect(brainSource).toBeDefined()
      const linkResult = brainSource.results.find(r => r.id === 'l1')
      expect(linkResult).toBeDefined()
      expect(linkResult.type).toBe('link')
    })

    it('should search apps', async () => {
      getAllApps.mockResolvedValue([
        { id: 'a1', name: 'MortalLoom', description: 'Longevity tracker app' },
        { id: 'a2', name: 'PortOS', description: 'Personal OS' }
      ])

      const results = await fanOutSearch('mortal')
      const appsSource = results.find(s => s.id === 'apps')
      expect(appsSource).toBeDefined()
      expect(appsSource.results).toHaveLength(1)
      expect(appsSource.results[0].id).toBe('a1')
      expect(appsSource.results[0].type).toBe('app')
    })

    it('should search history', async () => {
      getHistory.mockResolvedValue({
        entries: [
          { id: 'h1', targetName: 'deploy', action: 'deployed app to production' },
          { id: 'h2', targetName: 'test', action: 'ran test suite' }
        ]
      })

      const results = await fanOutSearch('deploy')
      const historySource = results.find(s => s.id === 'history')
      expect(historySource).toBeDefined()
      expect(historySource.results).toHaveLength(1)
      expect(historySource.results[0].id).toBe('h1')
      expect(historySource.results[0].type).toBe('history')
    })

    it('should search health metrics', async () => {
      const results = await fanOutSearch('heart')
      const healthSource = results.find(s => s.id === 'health')
      expect(healthSource).toBeDefined()
      expect(healthSource.results.length).toBeGreaterThan(0)
      expect(healthSource.results[0].type).toBe('health-metric')
    })

    it('should match health metrics by display name', async () => {
      const results = await fanOutSearch('steps')
      const healthSource = results.find(s => s.id === 'health')
      expect(healthSource).toBeDefined()
      const stepsResult = healthSource.results.find(r => r.id === 'step_count')
      expect(stepsResult).toBeDefined()
      expect(stepsResult.title).toBe('Steps')
    })

    it('should match health metrics by key name', async () => {
      const results = await fanOutSearch('hrv')
      const healthSource = results.find(s => s.id === 'health')
      expect(healthSource).toBeDefined()
      const hrvResult = healthSource.results.find(r => r.id === 'hrv')
      expect(hrvResult).toBeDefined()
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
      const memorySource = results.find(s => s.id === 'memory')
      expect(memorySource).toBeDefined()
      expect(memorySource.results).toHaveLength(1)
      expect(memorySource.results[0].type).toBe('memory')
    })

    it('should use hybrid search for postgres backend', async () => {
      ensureBackend.mockResolvedValue('postgres')
      hybridSearchMemories.mockResolvedValue({
        memories: [
          { id: 'pgm1', summary: 'Postgres memory result' }
        ]
      })

      const results = await fanOutSearch('postgres')
      const memorySource = results.find(s => s.id === 'memory')
      expect(memorySource).toBeDefined()
      expect(memorySource.results).toHaveLength(1)
      expect(hybridSearchMemories).toHaveBeenCalledWith('postgres', null, { limit: 10 })
    })

    it('should handle failing adapters gracefully', async () => {
      getInboxLog.mockRejectedValue(new Error('DB error'))
      getPeople.mockRejectedValue(new Error('DB error'))
      getProjects.mockRejectedValue(new Error('DB error'))
      getIdeas.mockRejectedValue(new Error('DB error'))
      getAdminItems.mockRejectedValue(new Error('DB error'))
      getMemoryEntries.mockRejectedValue(new Error('DB error'))
      getLinks.mockRejectedValue(new Error('DB error'))
      searchBM25.mockRejectedValue(new Error('Index error'))
      getAllApps.mockRejectedValue(new Error('App error'))
      getHistory.mockRejectedValue(new Error('History error'))

      // Should not throw, should return health results at minimum
      const results = await fanOutSearch('test')
      // Only health (synchronous) should have results, others fall back
      expect(Array.isArray(results)).toBe(true)
    })

    it('should limit brain results to 8', async () => {
      getInboxLog.mockResolvedValue(
        Array.from({ length: 20 }, (_, i) => ({
          id: `inbox-${i}`,
          capturedText: `test entry ${i}`
        }))
      )

      const results = await fanOutSearch('test')
      const brainSource = results.find(s => s.id === 'brain')
      expect(brainSource.results.length).toBeLessThanOrEqual(8)
    })

    it('should only return non-empty sources', async () => {
      // Only apps have results
      getAllApps.mockResolvedValue([
        { id: 'a1', name: 'TestApp', description: 'A test app' }
      ])

      const results = await fanOutSearch('testapp')
      for (const source of results) {
        expect(source.results.length).toBeGreaterThan(0)
      }
    })

    it('should be case-insensitive', async () => {
      getAllApps.mockResolvedValue([
        { id: 'a1', name: 'PortOS', description: 'Personal OS' }
      ])

      const results = await fanOutSearch('PORTOS')
      const appsSource = results.find(s => s.id === 'apps')
      expect(appsSource).toBeDefined()
      expect(appsSource.results).toHaveLength(1)
    })
  })
})
