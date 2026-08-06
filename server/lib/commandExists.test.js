import { describe, it, expect, vi, beforeEach } from 'vitest'

const execFileMock = { impl: (_cmd, _args, _opts, cb) => cb(null, { stdout: '', stderr: '' }) }
vi.mock('child_process', () => ({
  execFile: (cmd, args, opts, cb) => execFileMock.impl(cmd, args, opts, cb),
}))

const { commandExists } = await import('./commandExists.js')

describe('commandExists', () => {
  beforeEach(() => {
    execFileMock.impl = (_cmd, _args, _opts, cb) => cb(null, { stdout: '', stderr: '' })
  })

  it('resolves true when the command exits cleanly', async () => {
    await expect(commandExists('claude', ['--version'])).resolves.toBe(true)
  })

  it('resolves false when the command errors (e.g. ENOENT)', async () => {
    execFileMock.impl = (_cmd, _args, _opts, cb) => cb(new Error('ENOENT'))
    await expect(commandExists('nope', ['--version'])).resolves.toBe(false)
  })

  it('defaults args to ["--version"] when omitted', async () => {
    let seenArgs = null
    execFileMock.impl = (_cmd, args, _opts, cb) => { seenArgs = args; cb(null, { stdout: '', stderr: '' }) }
    await commandExists('claude')
    expect(seenArgs).toEqual(['--version'])
  })

  it('defaults the timeout to 5s when no opts are passed', async () => {
    let seenOpts = null
    execFileMock.impl = (_cmd, _args, opts, cb) => { seenOpts = opts; cb(null, { stdout: '', stderr: '' }) }
    await commandExists('claude')
    expect(seenOpts.timeout).toBe(5_000)
  })

  it('honors a longer timeoutMs for a heavier CLI probe', async () => {
    let seenOpts = null
    execFileMock.impl = (_cmd, _args, opts, cb) => { seenOpts = opts; cb(null, { stdout: '', stderr: '' }) }
    await commandExists('codex', undefined, { timeoutMs: 15_000 })
    expect(seenOpts.timeout).toBe(15_000)
  })
})
