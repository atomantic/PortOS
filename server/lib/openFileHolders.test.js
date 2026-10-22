import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { findOpenFileHolders } from './openFileHolders.js'

// The result gates deleting staged files another process may still read, so a
// listing that cannot prove it is complete must never read as "no holders".
describe('findOpenFileHolders', () => {
  let dir
  let canary
  const staged = '/staging/model.safetensors'
  const listing = (stdout) => async () => ({ stdout })

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'portos-open-file-holders-'))
    canary = join(dir, 'marker.json')
    await writeFile(canary, '{}')
  })
  afterAll(() => rm(dir, { recursive: true, force: true }))

  it('reports the other processes holding the files, never itself', async () => {
    const run = async () => { throw Object.assign(new Error('exit 1'), { stdout: `p100\nn${canary}\np200\nn${staged}\np200\nn${staged}\n` }) }
    await expect(findOpenFileHolders([staged], { canary, platform: 'linux', selfPid: 100, run }))
      .resolves.toEqual({ known: true, pids: [200] })
  })

  it.each([
    ['the listing omits the canary this process holds', { platform: 'darwin', run: listing('p200\nn/staging/x\n') }],
    ['lsof is missing', { platform: 'linux', run: async () => { throw Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' }) } }],
    ['the platform has no lsof', { platform: 'win32', run: listing('p100\n') }]
  ])('fails closed when %s', async (_label, opts) => {
    await expect(findOpenFileHolders([staged], { canary, selfPid: 100, ...opts })).resolves.toMatchObject({ known: false })
  })
})
