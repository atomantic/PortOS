/**
 * Windows shell-job spawn resolution.
 *
 * Every allowlisted shell-job command (`pm2`, `npm`, `gh`, `docker`, …) is a
 * `.cmd`/`.exe` on Windows, and `spawn()` under `shell: false` does NOT apply
 * PATHEXT — so a bare `pm2 jlist` failed with `spawn pm2 ENOENT` (exit -4058)
 * on every run. The shipped "System Health Check" job runs exactly that, so a
 * Windows install logged the failure every 15 minutes forever.
 *
 * These tests exercise the resolver and process-tree teardown at the shell
 * job boundary without starting a process.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { killProcessTree, prepareCliSpawn } from '../../lib/bufferedSpawn.js'
import { saveJobs } from './store.js'

const spawnMock = vi.fn()

// Partial mock — other modules in this import graph (fileUtils) need the real
// execFile/exec exports at load time.
vi.mock('../../lib/childProcess.js', async (importOriginal) => ({
  ...(await importOriginal()),
  spawn: (...args) => spawnMock(...args),
}))
vi.mock('../../lib/bufferedSpawn.js', async (importOriginal) => ({
  ...(await importOriginal()),
  prepareCliSpawn: vi.fn(),
  killProcessTree: vi.fn(),
}))
vi.mock('./store.js', () => ({
  loadJobs: vi.fn(async () => ({ jobs: [{ id: 'job-1', name: 'System Health Check' }] })),
  saveJobs: vi.fn(async () => {}),
}))
vi.mock('./crud.js', () => ({ recordJobExecution: vi.fn(async () => {}) }))

const { executeShellJob } = await import('./execution.js')

/** A child that promptly reports the chosen exit code. */
function fakeChild(exitCode = 0) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.exitCode = null
  child.kill = vi.fn()
  if (exitCode !== null) setImmediate(() => child.emit('close', exitCode, null))
  return child
}

describe('executeShellJob — Windows CLI shim resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    spawnMock.mockImplementation(() => fakeChild())
    prepareCliSpawn.mockImplementation((command, args) => ({ command, args }))
  })
  afterEach(() => vi.useRealTimers())

  it('spawns the command WITHOUT a shell (the injection guard stays intact)', async () => {
    await executeShellJob({ id: 'job-1', name: 'System Health Check', command: 'pm2 jlist' })
    const [, , opts] = spawnMock.mock.calls[0]
    expect(opts.shell).toBe(false)
  })

  it('passes the child environment to the resolver and spawns the resolved command and args', async () => {
    const resolvedArgs = ['/c', 'pm2.cmd', 'jlist']
    prepareCliSpawn.mockReturnValueOnce({ command: 'cmd.exe', args: resolvedArgs })

    await executeShellJob({ id: 'job-1', name: 'System Health Check', command: 'pm2 jlist' })

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [command, args, opts] = spawnMock.mock.calls[0]
    expect(command).toBe('cmd.exe')
    expect(args).toEqual(resolvedArgs)
    expect(prepareCliSpawn).toHaveBeenCalledExactlyOnceWith('pm2', ['jlist'], opts.env)
    expect(prepareCliSpawn.mock.calls[0][2]).toBe(opts.env)
    expect(opts.env.PWD).toBe(opts.cwd)
  })

  it('terminates the process tree and records a failed execution on timeout', async () => {
    vi.useFakeTimers()
    const child = fakeChild(null)
    spawnMock.mockReturnValueOnce(child)

    const result = executeShellJob({ id: 'job-1', name: 'System Health Check', command: 'pm2 jlist' })
    const timedOut = expect(result).rejects.toMatchObject({ code: 'JOB_EXECUTION_FAILED', exitCode: -1 })
    // On Windows the real command is a grandchild of its CLI shim.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    child.emit('close', null, 'SIGKILL')

    expect(killProcessTree).toHaveBeenCalledExactlyOnceWith(child, 'SIGKILL')
    expect(child.kill).not.toHaveBeenCalled()
    await timedOut
    expect(saveJobs).toHaveBeenCalledExactlyOnceWith({ jobs: [expect.objectContaining({
      id: 'job-1', lastExitCode: -1, lastResult: 'timeout',
    })] })
  })

  it('preserves a nonzero exit code on the job execution failure', async () => {
    spawnMock.mockImplementationOnce(() => fakeChild(7))

    await expect(
      executeShellJob({ id: 'job-1', name: 'System Health Check', command: 'pm2 jlist' })
    ).rejects.toMatchObject({ code: 'JOB_EXECUTION_FAILED', exitCode: 7 })
  })

  it('still rejects a command outside the allowlist', async () => {
    await expect(
      executeShellJob({ id: 'job-1', name: 'bad', command: 'rm -rf /' })
    ).rejects.toThrow(/Invalid shell command/)
    expect(spawnMock).not.toHaveBeenCalled()
  })
})
