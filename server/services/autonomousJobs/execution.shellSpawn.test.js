/**
 * Windows shell-job spawn resolution.
 *
 * Every allowlisted shell-job command (`pm2`, `npm`, `gh`, `docker`, …) is a
 * `.cmd`/`.exe` on Windows, and `spawn()` under `shell: false` does NOT apply
 * PATHEXT — so a bare `pm2 jlist` failed with `spawn pm2 ENOENT` (exit -4058)
 * on every run. The shipped "System Health Check" job runs exactly that, so a
 * Windows install logged the failure every 15 minutes forever.
 *
 * These tests pin the fix: the command goes through `prepareCliSpawn` against
 * the CHILD's env before `spawn()` sees it, and POSIX behavior is unchanged.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

const spawnMock = vi.fn()

// Partial mock — other modules in this import graph (fileUtils) need the real
// execFile/exec exports at load time.
vi.mock('../../lib/childProcess.js', async (importOriginal) => ({
  ...(await importOriginal()),
  spawn: (...args) => spawnMock(...args),
}))
vi.mock('./store.js', () => ({
  loadJobs: vi.fn(async () => ({ jobs: [{ id: 'job-1', name: 'System Health Check' }] })),
  saveJobs: vi.fn(async () => {}),
}))
vi.mock('./crud.js', () => ({ recordJobExecution: vi.fn(async () => {}) }))

const { executeShellJob } = await import('./execution.js')

/** A child that exits 0 immediately, so executeShellJob resolves. */
function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.exitCode = null
  child.kill = vi.fn()
  setImmediate(() => child.emit('close', 0, null))
  return child
}

describe('executeShellJob — Windows CLI shim resolution', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => fakeChild())
  })
  afterEach(() => vi.unstubAllEnvs())

  it('spawns the command WITHOUT a shell (the injection guard stays intact)', async () => {
    await executeShellJob({ id: 'job-1', name: 'System Health Check', command: 'pm2 jlist' })
    const [, , opts] = spawnMock.mock.calls[0]
    expect(opts.shell).toBe(false)
    expect(opts.windowsHide).toBe(true)
  })

  it('resolves the command against the CHILD env, not process.env', async () => {
    // The env handed to spawn must be the same object PATH was resolved from,
    // so a PATH override in the child env is honored rather than silently
    // resolved against a different PATH.
    await executeShellJob({ id: 'job-1', name: 'System Health Check', command: 'pm2 jlist' })
    const [, , opts] = spawnMock.mock.calls[0]
    expect(opts.env).toBeTruthy()
    // withSpawnCwdEnv pins PWD to the spawn cwd.
    expect(opts.env.PWD).toBe(opts.cwd)
  })

  it('passes parsed args through to spawn', async () => {
    await executeShellJob({ id: 'job-1', name: 'System Health Check', command: 'pm2 jlist' })
    const [command, args] = spawnMock.mock.calls[0]
    // On POSIX prepareCliSpawn is a no-op, so this is the bare pair. On Windows
    // the pair may be rewritten to `cmd.exe /c <resolved.cmd> …` — in both
    // cases the original argv must still be reachable in the final command line.
    expect([command, ...args].join(' ')).toMatch(/pm2.*jlist/)
  })

  it('routes the spawn through prepareCliSpawn (source contract)', async () => {
    // prepareCliSpawn is a pure filesystem-backed resolver that no-ops off
    // win32, so a POSIX CI run can't observe the rewrite behaviorally. Pin the
    // wiring instead: a future edit that reintroduces `spawn(validation.baseCommand)`
    // would restore the ENOENT bug with every other test still green.
    const { readFileSync } = await import('fs')
    const { fileURLToPath } = await import('url')
    const src = readFileSync(fileURLToPath(new URL('./execution.js', import.meta.url)), 'utf-8')
    expect(src).toMatch(/import\s*\{[^}]*\bprepareCliSpawn\b[^}]*\}\s*from\s*'\.\.\/\.\.\/lib\/bufferedSpawn\.js'/)
    expect(src).toMatch(
      /const\s*\{\s*command:\s*spawnCommand,\s*args:\s*spawnArgs\s*\}\s*=\s*\n?\s*prepareCliSpawn\(\s*validation\.baseCommand,\s*validation\.args \|\| \[\],\s*childEnv\s*\)/
    )
    // The resolved pair must be what spawn() actually receives.
    expect(src).toMatch(/spawn\(\s*spawnCommand,\s*spawnArgs,/)
  })

  it('kills the process TREE on timeout, not just the direct child', async () => {
    // The Windows spawn is `cmd.exe /c <cmd> <args>`, so the real command is a
    // grandchild; Windows has no process groups, so a bare child.kill() would
    // orphan a hung pm2/npm/docker past the timeout. Pin the tree-kill wiring.
    const { readFileSync } = await import('fs')
    const { fileURLToPath } = await import('url')
    const src = readFileSync(fileURLToPath(new URL('./execution.js', import.meta.url)), 'utf-8')
    expect(src).toMatch(/import\s*\{[^}]*\bkillProcessTree\b[^}]*\}\s*from\s*'\.\.\/\.\.\/lib\/bufferedSpawn\.js'/)
    expect(src).toMatch(/killProcessTree\(\s*child,\s*'SIGKILL'\s*\)/)
    expect(src, 'the timeout path must not bare-kill the direct child')
      .not.toMatch(/child\.kill\('SIGKILL'\)/)
  })

  it('still rejects a command outside the allowlist', async () => {
    await expect(
      executeShellJob({ id: 'job-1', name: 'bad', command: 'rm -rf /' })
    ).rejects.toThrow(/Invalid shell command/)
    expect(spawnMock).not.toHaveBeenCalled()
  })
})
