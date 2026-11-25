import { afterAll, expect, it, vi } from 'vitest'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js'

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-memory-bm25-') }))

afterAll(cleanupTempDataRoots)

it('persists concurrent removals and drops their private terms after reload', async () => {
  const { batchIndex, removeMemoryFromIndex, searchBM25 } = await import('./memoryBM25.js')
  const { PATHS } = await import('../lib/fileUtils.js')
  await batchIndex([
    { id: 'purged', content: 'zirconium' },
    { id: 'rejected', content: 'molybdenum' },
    { id: 'retained', content: 'vanadium' }
  ])
  expect(await searchBM25('zirconium')).toEqual([{ id: 'purged', score: expect.any(Number) }])

  await Promise.all([removeMemoryFromIndex('purged'), removeMemoryFromIndex('rejected')])

  const persisted = await readFile(join(PATHS.memory, 'bm25-index.json'), 'utf8')
  expect(persisted).not.toMatch(/zirconium|molybdenum/)
  vi.resetModules()
  const restarted = await import('./memoryBM25.js')
  expect(await restarted.searchBM25('zirconium molybdenum')).toEqual([])
  expect(await restarted.searchBM25('vanadium')).toEqual([{ id: 'retained', score: expect.any(Number) }])
})
