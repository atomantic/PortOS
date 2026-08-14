import { describe, it, expect, vi, beforeEach } from 'vitest'
import EventEmitter from 'events'

vi.mock('./brainStorage.js', () => ({
  brainEvents: new EventEmitter(),
  getAll: vi.fn().mockResolvedValue([]),
  memoryRecencyMs: (record) => Date.parse(record?.updatedAt ?? '') || 0
}))

import {
  getBrainProjections,
  BRAIN_SEARCH_TYPES,
  BRAIN_PROJECTION_TYPES,
  __resetBrainSearchIndex
} from './brainSearchIndex.js'
import { getAll, brainEvents } from './brainStorage.js'

const deferred = () => {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

describe('brainSearchIndex', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetBrainSearchIndex()
    getAll.mockResolvedValue([])
  })

  it('covers every brain type unified search reads', () => {
    expect([...BRAIN_SEARCH_TYPES]).toEqual([
      'inbox', 'people', 'projects', 'ideas', 'admin', 'memories', 'links'
    ])
  })

  it('indexes every search source plus the graph-only journals type', () => {
    for (const type of BRAIN_SEARCH_TYPES) {
      expect(BRAIN_PROJECTION_TYPES).toContain(type)
    }
    expect(BRAIN_PROJECTION_TYPES).toContain('journals')
    // Graph-only types (not unified-search sources) still have to be projected,
    // or getBrainGraphSearchIndex throws on them.
    expect(BRAIN_PROJECTION_TYPES).toContain('songs')
    expect(BRAIN_SEARCH_TYPES).not.toContain('songs')
  })

  it('rejects a type it does not index', async () => {
    // `buckets` is a real brain entity store with no projection — the graph and
    // unified search both ignore it.
    await expect(getBrainProjections('buckets')).rejects.toThrow(/unknown projection type/)
  })

  it('projects only the fields its consumers read', async () => {
    getAll.mockResolvedValue([
      { id: 'p1', name: 'Ada Placeholder', context: 'colleague', avatarBlob: 'x'.repeat(50), embedding: [1, 2, 3] }
    ])

    const [projection] = await getBrainProjections('people')
    expect(projection).toEqual({ id: 'p1', name: 'Ada Placeholder', context: 'colleague' })
    expect(projection).not.toHaveProperty('avatarBlob')
    expect(projection).not.toHaveProperty('embedding')
  })

  it('projects a journal entry as a body predicate, never the body', async () => {
    getAll.mockResolvedValue([
      { id: '2026-01-01', content: 'x'.repeat(500), segments: [{ text: 'x' }] },
      { id: '2026-01-02', content: '', segments: [] },
      { id: '2026-01-03', content: '', segments: [{ text: 'voice note' }] }
    ])

    expect(await getBrainProjections('journals')).toEqual([
      { id: '2026-01-01', date: undefined, hasBody: true },
      { id: '2026-01-02', date: undefined, hasBody: false },
      { id: '2026-01-03', date: undefined, hasBody: true }
    ])
  })

  it('keeps store order when the caller opts out of ranking', async () => {
    getAll.mockResolvedValue([
      { id: 'older', title: 'Older', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'newer', title: 'Newer', updatedAt: '2026-02-01T00:00:00.000Z' }
    ])

    expect((await getBrainProjections('memories')).map((p) => p.id)).toEqual(['newer', 'older'])
    expect((await getBrainProjections('memories', { ranked: false })).map((p) => p.id))
      .toEqual(['older', 'newer'])
  })

  it('scans the store once and serves later reads from memory', async () => {
    getAll.mockResolvedValue([{ id: 'l1', title: 'Example', url: 'https://example.com' }])

    await getBrainProjections('links')
    await getBrainProjections('links')

    expect(getAll).toHaveBeenCalledTimes(1)
  })

  it('caches a built-but-empty store instead of re-scanning it', async () => {
    getAll.mockResolvedValue([])

    expect(await getBrainProjections('links')).toEqual([])
    expect(await getBrainProjections('links')).toEqual([])

    // `null` means NOT BUILT; an empty result is built and must stay cached.
    expect(getAll).toHaveBeenCalledTimes(1)
  })

  it('collapses concurrent first reads into one scan', async () => {
    const gate = deferred()
    getAll.mockReturnValue(gate.promise)

    const both = Promise.all([getBrainProjections('ideas'), getBrainProjections('ideas')])
    gate.resolve([{ id: 'i1', title: 'Example idea' }])
    const [a, b] = await both

    expect(getAll).toHaveBeenCalledTimes(1)
    expect(a).toEqual(b)
  })

  it('patches the projection on an upserted event without re-scanning', async () => {
    getAll.mockResolvedValue([{ id: 'p1', name: 'Ada Placeholder', context: 'colleague' }])
    await getBrainProjections('people')

    brainEvents.emit('people:upserted', { id: 'p1', record: { id: 'p1', name: 'Ada Renamed', context: 'friend' } })
    brainEvents.emit('people:upserted', { id: 'p2', record: { id: 'p2', name: 'Bo Placeholder', context: 'neighbor' } })

    const projections = await getBrainProjections('people')
    expect(getAll).toHaveBeenCalledTimes(1)
    expect(projections).toEqual([
      { id: 'p1', name: 'Ada Renamed', context: 'friend' },
      { id: 'p2', name: 'Bo Placeholder', context: 'neighbor' }
    ])
  })

  it('drops a record on a deleted event', async () => {
    getAll.mockResolvedValue([
      { id: 'p1', name: 'Ada Placeholder' },
      { id: 'p2', name: 'Bo Placeholder' }
    ])
    await getBrainProjections('people')

    brainEvents.emit('people:deleted', { id: 'p1', record: { id: 'p1' } })

    expect(await getBrainProjections('people')).toEqual([{ id: 'p2', name: 'Bo Placeholder', context: undefined }])
    expect(getAll).toHaveBeenCalledTimes(1)
  })

  it('rebuilds after record:changed — the signal event-silent peer applies emit', async () => {
    getAll.mockResolvedValue([{ id: 'p1', name: 'Ada Placeholder' }])
    await getBrainProjections('people')

    getAll.mockResolvedValue([
      { id: 'p1', name: 'Ada Placeholder' },
      { id: 'p2', name: 'Synced From Peer' }
    ])
    brainEvents.emit('record:changed', { type: 'people', id: 'p2' })

    const projections = await getBrainProjections('people')
    expect(getAll).toHaveBeenCalledTimes(2)
    expect(projections.map((p) => p.id)).toEqual(['p1', 'p2'])
  })

  it('leaves other types alone when one type is invalidated', async () => {
    getAll.mockResolvedValue([{ id: 'x1', title: 'Example' }])
    await getBrainProjections('people')
    await getBrainProjections('links')

    brainEvents.emit('record:changed', { type: 'people', id: 'x1' })

    // links stays cached across the people invalidation…
    await getBrainProjections('links')
    expect(getAll).toHaveBeenCalledTimes(2)

    // …while people re-scans.
    await getBrainProjections('people')
    expect(getAll).toHaveBeenCalledTimes(3)
  })

  it('discards a scan that an invalidation superseded mid-flight', async () => {
    const gate = deferred()
    getAll.mockReturnValueOnce(gate.promise)

    const pending = getBrainProjections('people')
    // A peer apply lands while the first scan is still reading the directory.
    brainEvents.emit('record:changed', { type: 'people', id: 'p2' })
    gate.resolve([{ id: 'p1', name: 'Stale Snapshot' }])
    await pending

    getAll.mockResolvedValue([{ id: 'p1', name: 'Fresh Snapshot' }])
    const projections = await getBrainProjections('people')

    expect(getAll).toHaveBeenCalledTimes(2)
    expect(projections[0].name).toBe('Fresh Snapshot')
  })

  it('discards a scan that an upsert superseded mid-flight', async () => {
    const gate = deferred()
    getAll.mockReturnValueOnce(gate.promise)

    const pending = getBrainProjections('people')
    brainEvents.emit('people:upserted', { id: 'p9', record: { id: 'p9', name: 'Written Mid Scan' } })
    gate.resolve([])
    await pending

    getAll.mockResolvedValue([{ id: 'p9', name: 'Written Mid Scan' }])
    expect((await getBrainProjections('people')).map((p) => p.id)).toEqual(['p9'])
    expect(getAll).toHaveBeenCalledTimes(2)
  })

  it('orders inbox entries newest-first by capture time', async () => {
    getAll.mockResolvedValue([
      { id: 'older', capturedText: 'first', capturedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'newer', capturedText: 'second', capturedAt: '2026-02-01T00:00:00.000Z' }
    ])

    const projections = await getBrainProjections('inbox')
    expect(projections.map((p) => p.id)).toEqual(['newer', 'older'])
  })

  it('keeps store order for unranked types', async () => {
    getAll.mockResolvedValue([
      { id: 'b', name: 'Beta' },
      { id: 'a', name: 'Alpha' }
    ])

    expect((await getBrainProjections('projects')).map((p) => p.id)).toEqual(['b', 'a'])
  })
})
