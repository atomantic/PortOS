import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'

// A scripted stand-in for a spawned child. It has no `pid`, so killProcessTree
// takes its `.kill()` path and never signals a real process group.
const fakeChild = (script) => {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.kill = vi.fn()
  setImmediate(() => script(child))
  return child
}
const exitWith = (stdout, code = 0) => (child) => {
  if (stdout) child.stdout.emit('data', Buffer.from(stdout))
  child.exitCode = code
  child.emit('close', code)
}

// Scripted by default; `spawnMock.impl = null` reaches the real spawn for the
// one real-process contract test below.
const spawnMock = { impl: null, calls: [] }
vi.mock('./childProcess.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    spawn: (cmd, args, opts) => {
      const call = { cmd, args, opts }
      spawnMock.calls.push(call)
      call.child = spawnMock.impl ? spawnMock.impl(cmd, args, opts) : actual.spawn(cmd, args, opts)
      return call.child
    },
  }
})

const rmMock = { fail: false }
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    rmSync: (...a) => {
      if (rmMock.fail) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
      return actual.rmSync(...a)
    },
  }
})

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

const { commandExists, commandOutput } = await import('./commandExists.js')
const lastSpawn = () => spawnMock.calls.at(-1)

describe('commandExists', () => {
  beforeEach(() => {
    spawnMock.impl = () => fakeChild(exitWith(''))
    spawnMock.calls = []
    prepareMock.impl = null
    rmMock.fail = false
  })

  it('resolves true when the command exits cleanly', async () => {
    await expect(commandExists('claude', ['--version'])).resolves.toBe(true)
  })

  it('resolves false when the command errors (e.g. ENOENT)', async () => {
    spawnMock.impl = () => fakeChild((c) => c.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' })))
    await expect(commandExists('nope', ['--version'])).resolves.toBe(false)
  })

  it('resolves false when spawning throws synchronously (e.g. ENOEXEC)', async () => {
    spawnMock.impl = () => { throw Object.assign(new Error('ENOEXEC'), { code: 'ENOEXEC' }) }
    await expect(commandExists('broken-shim', ['--version'])).resolves.toBe(false)
  })

  it('defaults args to ["--version"] and closes the child stdin', async () => {
    await commandExists('claude')
    expect(lastSpawn().args).toEqual(['--version'])
    expect(lastSpawn().opts.stdio[0]).toBe('ignore')
  })

  it('uses the supplied child environment and working directory', async () => {
    const env = { PATH: '/example/bin' }

    await commandExists('opencode', undefined, { env, cwd: '/example/workspace' })

    const { opts } = lastSpawn()
    expect(opts.cwd).toBe('/example/workspace')
    // The caller's own vars survive; TMPDIR/TMP/TEMP are pinned to a
    // throwaway per-probe scratch dir so a real CLI (kilo, opencode) cannot
    // write its own scratch/cache state into the caller's TMPDIR (#9039).
    expect(opts.env.PATH).toBe('/example/bin')
    expect(opts.env.TMPDIR).toBe(opts.env.TMP)
    expect(opts.env.TMPDIR).toBe(opts.env.TEMP)
    expect(opts.env.TMPDIR).toMatch(/portos-cli-probe-/)
  })

  it('removes its throwaway scratch dir once the probe settles, success or failure', async () => {
    await commandExists('claude')
    const okDir = lastSpawn().opts.env.TMPDIR
    spawnMock.impl = () => fakeChild(exitWith('', 1))
    await commandExists('nope')
    const failDir = lastSpawn().opts.env.TMPDIR

    expect(okDir).toMatch(/portos-cli-probe-/)
    expect(existsSync(okDir)).toBe(false)
    expect(existsSync(failDir)).toBe(false)
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
      spawnMock.impl = () => fakeChild(exitWith('codex-cli 0.1.0'))

      await expect(commandExists('codex')).resolves.toBe(true)
      expect({ cmd: lastSpawn().cmd, args: lastSpawn().args }).toEqual({
        cmd: 'cmd.exe',
        args: ['/c', 'C:\\ProgramData\\npm\\codex.cmd', '--version'],
      })
    })

    it('resolves the bare name against the CHILD env, so a PATH override is honored', async () => {
      let seenEnv = null
      prepareMock.impl = (cmd, args, env) => { seenEnv = env; return { command: cmd, args } }
      const env = { PATH: '/example/bin' }

      await commandExists('codex', undefined, { env })

      // Not the exact same object — the caller's vars ride along, plus the
      // isolated TMPDIR/TMP/TEMP scratch override (see the throwaway-scratch
      // tests above) — but every var the caller supplied is still there.
      expect(seenEnv).toMatchObject(env)
    })

    it('falls back to process.env when the caller passes no child env', async () => {
      let seenEnv = null
      prepareMock.impl = (cmd, args, env) => { seenEnv = env; return { command: cmd, args } }

      await commandExists('codex')

      // Every process.env var rides along except TMPDIR/TMP/TEMP, which are
      // pinned to the isolated per-probe scratch dir instead.
      const { TMPDIR: _t, TMP: _tm, TEMP: _te, ...restOfProcessEnv } = process.env
      expect(seenEnv).toMatchObject(restOfProcessEnv)
      expect(seenEnv.TMPDIR).toMatch(/portos-cli-probe-/)
    })
  })
})

describe('commandOutput lifecycle (#10604)', () => {
  beforeEach(() => {
    spawnMock.calls = []
    prepareMock.impl = null
    rmMock.fail = false
  })

  it('keeps empty output, non-empty output and failure distinct', async () => {
    spawnMock.impl = () => fakeChild(exitWith(''))
    await expect(commandOutput('tool')).resolves.toBe('')
    spawnMock.impl = () => fakeChild(exitWith('  tool 1.2.3\n'))
    await expect(commandOutput('tool')).resolves.toBe('tool 1.2.3')
    spawnMock.impl = () => fakeChild(exitWith('partial', 2))
    await expect(commandOutput('tool')).resolves.toBeNull()
  })

  it.each(['stdout', 'stderr'])('fails a probe whose %s exceeds maxBuffer and terminates the child', async (stream) => {
    let child
    spawnMock.impl = () => (child = fakeChild((c) => {
      c[stream].emit('data', Buffer.alloc(32, 'x'))
      exitWith('')(c)
    }))
    await expect(commandOutput('chatty', [], { maxBuffer: 16 })).resolves.toBeNull()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('settles at the deadline when the child never closes, ignoring late events', async () => {
    let child
    spawnMock.impl = () => (child = fakeChild(() => {}))
    await expect(commandOutput('stuck', [], { timeoutMs: 20 })).resolves.toBeNull()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(existsSync(lastSpawn().opts.env.TMPDIR)).toBe(false)
    // A late error or close after the result is fixed must not throw.
    expect(() => {
      child.emit('error', new Error('late'))
      child.stdout.emit('data', Buffer.from('late'))
      child.emit('close', 0)
    }).not.toThrow()
  })

  it('a failed scratch cleanup cannot replace the probe result', async () => {
    rmMock.fail = true
    spawnMock.impl = () => fakeChild(exitWith('v1'))
    await expect(commandOutput('tool')).resolves.toBe('v1')
  })

  // Real processes, POSIX only: the deadline must settle the probe on time, and
  // escalation must reach everything in the probe's own process group.
  const waitUntilGone = async (pid) => {
    const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
    const until = Date.now() + 5_000
    while (alive() && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
    return !alive()
  }

  it.skipIf(process.platform === 'win32')('a real child that ignores SIGTERM cannot hold the probe past its deadline', async () => {
    spawnMock.impl = null
    const script = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('alive')"
    const started = Date.now()

    await expect(commandOutput(process.execPath, ['-e', script], { timeoutMs: 300 })).resolves.toBeNull()

    expect(Date.now() - started).toBeLessThan(2_000)
    expect(existsSync(lastSpawn().opts.env.TMPDIR)).toBe(false)
    expect(await waitUntilGone(lastSpawn().child.pid)).toBe(true)
  }, 10_000)

  it.skipIf(process.platform === 'win32')('escalation reaches a descendant that ignores SIGTERM after its parent exits', async () => {
    spawnMock.impl = null
    const { mkdtempSync, readFileSync, rmSync } = await vi.importActual('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'probe-test-'))
    const pidFile = join(dir, 'grandchild.pid')
    const grandchild = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
    // The parent keeps the default SIGTERM behavior (exits); its child ignores it.
    const parent = `const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' });
      require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000)`

    try {
      await expect(commandOutput(process.execPath, ['-e', parent], { timeoutMs: 500 })).resolves.toBeNull()

      const grandchildPid = Number(readFileSync(pidFile, 'utf8'))
      expect(grandchildPid).toBeGreaterThan(0)
      expect(await waitUntilGone(grandchildPid)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 10_000)
})
