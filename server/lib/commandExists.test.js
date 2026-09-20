import { describe, it, expect, vi, beforeEach } from 'vitest'

const execFileMock = { impl: (_cmd, _args, _opts, cb) => cb(null, { stdout: '', stderr: '' }) }
vi.mock('./childProcess.js', () => ({
  execFile: (cmd, args, opts, cb) => execFileMock.impl(cmd, args, opts, cb),
}))

// Real by default (a no-op off Windows); overridden in the shim suite below to
// stand in for what it returns on a real Windows box.
const prepareMock = { impl: null }
vi.mock('./bufferedSpawn.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    prepareCliSpawn: (cmd, args, env) => (
      prepareMock.impl ? prepareMock.impl(cmd, args, env) : actual.prepareCliSpawn(cmd, args, env)
    ),
  }
})

const { commandExists } = await import('./commandExists.js')

describe('commandExists', () => {
  beforeEach(() => {
    execFileMock.impl = (_cmd, _args, _opts, cb) => cb(null, { stdout: '', stderr: '' })
    prepareMock.impl = null
  })

  it('resolves true when the command exits cleanly', async () => {
    await expect(commandExists('claude', ['--version'])).resolves.toBe(true)
  })

  it('resolves false when the command errors (e.g. ENOENT)', async () => {
    execFileMock.impl = (_cmd, _args, _opts, cb) => cb(new Error('ENOENT'))
    await expect(commandExists('nope', ['--version'])).resolves.toBe(false)
  })

  it('resolves false when spawning throws synchronously (e.g. ENOEXEC)', async () => {
    execFileMock.impl = () => { throw Object.assign(new Error('ENOEXEC'), { code: 'ENOEXEC' }) }
    await expect(commandExists('broken-shim', ['--version'])).resolves.toBe(false)
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

  it('uses the supplied child environment and working directory', async () => {
    let seenOpts = null
    execFileMock.impl = (_cmd, _args, opts, cb) => { seenOpts = opts; cb(null, { stdout: '', stderr: '' }) }
    const env = { PATH: '/example/bin' }

    await commandExists('opencode', undefined, { env, cwd: '/example/workspace' })

    expect(seenOpts).toEqual({ timeout: 5_000, env, cwd: '/example/workspace' })
  })

  // A bare `codex` is a `.cmd` shim on Windows. execFile's default shell:false
  // applies no PATHEXT search to the bare name and refuses a `.cmd` target
  // outright post-CVE-2024-27980 — both land in the same catch as a missing
  // binary, so every npm-shimmed reviewer CLI read as "not installed" there.
  describe('Windows .cmd shims', () => {
    it('probes the launchable pair prepareCliSpawn resolved, not the bare name', async () => {
      prepareMock.impl = () => ({
        command: 'cmd.exe',
        args: ['/c', 'C:\\ProgramData\\npm\\codex.cmd', '--version'],
      })
      let seen = null
      execFileMock.impl = (cmd, args, _opts, cb) => { seen = { cmd, args }; cb(null, { stdout: 'codex-cli 0.1.0', stderr: '' }) }

      await expect(commandExists('codex')).resolves.toBe(true)
      expect(seen).toEqual({
        cmd: 'cmd.exe',
        args: ['/c', 'C:\\ProgramData\\npm\\codex.cmd', '--version'],
      })
    })

    it('resolves the bare name against the CHILD env, so a PATH override is honored', async () => {
      let seenEnv = null
      prepareMock.impl = (cmd, args, env) => { seenEnv = env; return { command: cmd, args } }
      const env = { PATH: '/example/bin' }

      await commandExists('codex', undefined, { env })

      expect(seenEnv).toBe(env)
    })

    it('falls back to process.env when the caller passes no child env', async () => {
      let seenEnv = null
      prepareMock.impl = (cmd, args, env) => { seenEnv = env; return { command: cmd, args } }

      await commandExists('codex')

      expect(seenEnv).toBe(process.env)
    })
  })
})
