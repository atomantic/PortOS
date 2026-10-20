import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile, access, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeVerifyContainment, runVerifyCommand } from './sandbox.js';

// The real OS boundary an agent-written test file or npm lifecycle script meets.
const mechanism = await probeVerifyContainment();
if (process.env.PORTOS_REQUIRE_LINUX_CONTAINMENT === '1' && mechanism.id !== 'linux-bubblewrap') {
  throw new Error(`Real Linux containment is required by this test job: ${mechanism.reason}`);
}

describe.skipIf(!mechanism.supported)(`runVerifyCommand under ${mechanism.id || 'no containment'}`, () => {
  let root;
  let worktree;
  let dataDir;
  let outside;
  let server;
  let port;
  let unixServer;
  let socketPath;
  let home;
  let keyStore;

  beforeAll(async () => {
    // Linux hides /tmp and /run behind tmpfs; /var/tmp keeps the socket below
    // reachable through the read-only root, so the seccomp filter is what's tested.
    root = await mkdtemp(join(process.platform === 'linux' ? '/var/tmp' : tmpdir(), 'autofix-verify-real-'));
    dataDir = join(root, 'data');
    worktree = join(dataDir, 'autofixer', 'worktrees', 'example');
    outside = join(root, 'outside');
    await mkdir(worktree, { recursive: true });
    await mkdir(outside);
    await writeFile(join(dataDir, 'providers.json'), '{"apiKey":"example-provider-key"}');
    // A credential store reached through a symlink (~/.ssh → elsewhere).
    home = join(root, 'home');
    keyStore = join(root, 'key-store');
    await mkdir(home);
    await mkdir(keyStore);
    await writeFile(join(keyStore, 'id_example'), 'example-private-key');
    await symlink(keyStore, join(home, '.ssh'));
    server = createServer((socket) => socket.end('reached'));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    // A host pathname socket (Docker, a database) outside every writable root.
    socketPath = join(outside, 's.sock');
    unixServer = createServer((socket) => socket.end('reached'));
    await new Promise((resolve) => unixServer.listen(socketPath, resolve));
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => unixServer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  const verify = (command) => runVerifyCommand(command, worktree, { dataDir, homeDir: home, timeoutMs: 30000 });

  it('runs a forking test command that writes inside the worktree', async () => {
    const result = await verify('echo built > out.txt && (cat out.txt) && sh -c "exit 0"');
    expect(result).toMatchObject({ ok: true, contained: true, mechanism: mechanism.id });
    expect(await readFile(join(worktree, 'out.txt'), 'utf8')).toBe('built\n');
  });

  it('carries no provider key or PortOS token and a private HOME', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-example-verify-secret');
    vi.stubEnv('PORTOS_API_TOKEN', 'example-portos-token');
    const result = await verify('env');
    expect(result.ok).toBe(true);
    expect(result.output).not.toContain('sk-ant-example-verify-secret');
    expect(result.output).not.toContain('PORTOS_API_TOKEN');
    expect(result.output).not.toMatch(new RegExp(`^HOME=${process.env.HOME}$`, 'm'));
  });

  const connectProbe = (target) => `${JSON.stringify(process.execPath)} -e "require('net').connect(${target}).on('data', (d) => { console.log(String(d)); process.exit(0); }).on('error', () => process.exit(3))"`;

  it('cannot write outside the worktree, read the PortOS data directory, or reach loopback', async () => {
    const write = await verify(`echo x > ${JSON.stringify(join(outside, 'escaped'))}`);
    expect(write.ok).toBe(false);
    await expect(access(join(outside, 'escaped'))).rejects.toThrow();

    const read = await verify(`cat ${JSON.stringify(join(dataDir, 'providers.json'))}`);
    expect(read.ok).toBe(false);
    expect(read.output).not.toContain('example-provider-key');

    const net = await verify(connectProbe(`${port}, '127.0.0.1'`));
    expect(net.ok).toBe(false);
    expect(net.output).not.toContain('reached');
  });

  it('cannot read a symlinked credential store through the link or its target', async () => {
    for (const path of [join(home, '.ssh', 'id_example'), join(keyStore, 'id_example')]) {
      const result = await verify(`cat ${JSON.stringify(path)}`);
      expect(result.ok).toBe(false);
      expect(result.output).not.toContain('example-private-key');
    }
  });

  it('cannot connect to a host pathname Unix socket', async () => {
    const unix = await verify(connectProbe(`'${socketPath}'`));
    expect(unix.ok).toBe(false);
    expect(unix.output).not.toContain('reached');
  });

  it.skipIf(process.platform !== 'linux')('cannot create an io_uring that bypasses socket syscall restrictions', async () => {
    await writeFile(join(worktree, 'uring-probe.py'), [
      'import ctypes, errno',
      'libc = ctypes.CDLL(None, use_errno=True)',
      'params = ctypes.create_string_buffer(256)',
      'result = libc.syscall(425, 1, ctypes.byref(params))',
      'assert result == -1 and ctypes.get_errno() == errno.EPERM',
    ].join('\n'));
    expect(await verify('python3 uring-probe.py')).toMatchObject({ ok: true, contained: true });
  });

  it('refuses datagram socketpairs that can reconnect to host pathname sockets', async () => {
    await writeFile(join(worktree, 'socketpair-probe.py'), [
      'import socket, errno',
      'a, b = socket.socketpair(type=socket.SOCK_STREAM)',
      'a.close(); b.close()',
      'try:',
      '    socket.socketpair(type=socket.SOCK_DGRAM)',
      'except OSError as error:',
      '    assert error.errno == errno.EPERM',
      'else:',
      '    raise AssertionError("datagram socketpair escaped")',
    ].join('\n'));
    expect(await verify('python3 socketpair-probe.py')).toMatchObject({ ok: true, contained: true });
  });

  it.each([false, true])('terminates detached descendants after verification (timeout=%s)', async timeout => {
    const marker = timeout ? 'timeout-late.txt' : 'completed-late.txt';
    await writeFile(join(worktree, 'descendant-probe.cjs'), [
      "const { spawn } = require('node:child_process');",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync('${marker}', 'late'), 1200)`)}], { detached: true, stdio: 'ignore' });`,
      "child.on('error', error => { console.error(error); process.exitCode = 1; });",
      "child.on('spawn', () => console.log('descendant-started')); child.unref();",
      ...(timeout ? ['setTimeout(() => {}, 2500);'] : []),
    ].join('\n'));
    const result = await runVerifyCommand(`${JSON.stringify(process.execPath)} descendant-probe.cjs`, worktree,
      { dataDir, homeDir: home, timeoutMs: timeout ? 600 : 30000 });
    expect(result.output).toContain('descendant-started');
    expect(result.ok).toBe(!timeout);
    await new Promise(resolve => setTimeout(resolve, 1500));
    await expect(access(join(worktree, marker))).rejects.toThrow();
  });
});
