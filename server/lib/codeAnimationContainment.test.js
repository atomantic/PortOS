import { describe, expect, it } from 'vitest';
import { codeAnimationBubblewrapArgs, codeAnimationSeatbeltProfile, codeAnimationSeccompFilter, codeAnimationWorkerFailure } from './codeAnimationContainment.js';
import { autofixVerifySeccompFilter } from './autofixVerifyContainment.js';

// Interpret the small classic-BPF instruction set this security filter uses.
// This catches ABI bypasses and jump/offset mistakes even on non-Linux hosts.
const verdict = (filter, { arch, nr, flags = 0, type = 0 }) => {
  const data = new Map([[0, nr], [4, arch], [16, flags], [24, type]]);
  let accumulator = 0;
  for (let pc = 0; pc < filter.length / 8; pc += 1) {
    const offset = pc * 8;
    const code = filter.readUInt16LE(offset);
    const value = filter.readUInt32LE(offset + 4);
    if (code === 0x20) accumulator = data.get(value) ?? 0;
    else if (code === 0x54) accumulator &= value;
    else if (code === 0x06) return value;
    else {
      const match = code === 0x15 ? accumulator === value
        : code === 0x35 ? accumulator >= value
          : (accumulator & value) !== 0;
      pc += filter[offset + (match ? 2 : 3)];
    }
  }
  throw new Error('Filter did not return a verdict');
};

describe('macOS Seatbelt profile', () => {
  const profile = codeAnimationSeatbeltProfile({
    executable: '/Applications/Blender.app/Contents/MacOS/Blender', toolRoots: ['/Applications/Blender.app'], workspace: '/example/workspace',
  });

  // Blender cannot start without listing the GPU (#14939). Any wider grant here
  // would open other drivers or Mach services to generated package code.
  it('grants only the Apple GPU user client from IOKit and keeps Mach, process and network denied', () => {
    expect(profile.match(/\(allow iokit[^\n]*/g)).toEqual(['(allow iokit-open (iokit-user-client-class "AGXDeviceUserClient"))']);
    expect(profile).toContain('(deny default)');
    expect(profile.match(/\(allow process-[^\s)]+/g)).toEqual(['(allow process-exec']);
    for (const denied of ['mach-lookup', 'network', 'process-fork', 'ipc-']) expect(profile).not.toContain(denied);
  });
});

describe('worker failure sentence', () => {
  it.each([
    [{ status: 'failed', reason: 'exit', signal: 'SIGSEGV', exitCode: null }, 'Blender crashed with SIGSEGV.'],
    [{ status: 'failed', reason: 'exit', signal: null, exitCode: 1 }, 'Blender exited with code 1.'],
    [{ status: 'terminated', reason: 'memory', signal: 'SIGKILL', exitCode: null }, 'Blender was stopped by the memory limit.'],
    [{ status: 'terminated', reason: 'canceled', signal: 'SIGKILL', exitCode: null }, 'Blender was canceled.'],
    [{ status: 'terminated', reason: 'watchdog', signal: 'SIGKILL', exitCode: null }, 'Blender was stopped by its supervisor.'],
    [{ status: 'failed', reason: 'spawn', signal: null, exitCode: null }, 'The worker failed before Blender finished.'],
  ])('describes %j', (run, sentence) => {
    expect(codeAnimationWorkerFailure(run)).toBe(sentence);
  });
});

describe('Linux worker containment policy', () => {
  it.each([
    ['x64', 0xc000003e, 41, 53],
    ['arm64', 0xc00000b7, 198, 199],
  ])('blocks direct and io_uring Unix sockets in autofix verification on %s', (name, arch, socket, socketpair) => {
    const filter = autofixVerifySeccompFilter(name);
    const run = (nr, flags = 0, type = 0) => verdict(filter, { arch, nr, flags, type });
    expect(run(socket, 1)).toBe(0x00050001);
    for (const nr of [425, 426, 427]) expect(run(nr)).toBe(0x00050001);
    expect(run(socketpair, 1, 1)).toBe(0x7fff0000);
    expect(run(socketpair, 1, 1 | 0x80000 | 0x800)).toBe(0x7fff0000);
    for (const type of [2, 5, 2 | 0x80000]) expect(run(socketpair, 1, type)).toBe(0x00050001);
    expect(run(1)).toBe(0x7fff0000);
    expect(run(0x40000000)).toBe(0x80000000);
    expect(verdict(filter, { arch: 0x40000003, nr: 102 })).toBe(0x80000000);
  });

  it.each([
    ['x64', 0xc000003e, 56, [57, 58, 41, 272, 308]],
    ['arm64', 0xc00000b7, 220, [198, 97, 268]],
  ])('denies process creation, sockets and namespace escape on %s while preserving threads', (name, arch, clone, denied) => {
    const filter = codeAnimationSeccompFilter(name);
    const run = (nr, flags = 0) => verdict(filter, { arch, nr, flags });
    for (const nr of denied) expect(run(nr)).toBe(0x00050001);
    expect(run(clone, 17)).toBe(0x00050001); // SIGCHLD: ordinary process
    expect(run(clone, 0x00010000)).toBe(0x7fff0000); // native thread
    expect(run(clone, 0x10010000)).toBe(0x00050001); // thread + new user namespace
    expect(run(435)).toBe(0x00050026); // clone3 must fall back to clone
    expect(run(0x40000000)).toBe(0x80000000); // x32
    expect(verdict(filter, { arch: 0x40000003, nr: 2 })).toBe(0x80000000); // i386 fork
    expect(run(1)).toBe(0x7fff0000);
  });

  it('refuses unknown architectures and never grants the host root or ambient writable scratch', () => {
    expect(() => codeAnimationSeccompFilter('riscv64')).toThrow(/x64 and arm64/);
    const args = codeAnimationBubblewrapArgs({
      executable: '/opt/example/bin/tool',
      toolRoots: ['/opt/example/lib', '/opt/example/bin'],
      workspace: '/tmp/example-worker',
      argv: ['/workspace/input/scene.py'],
    });
    const grants = [];
    for (let index = 0; index < args.length; index += 1) {
      if (['--bind', '--ro-bind', '--ro-bind-try', '--dev-bind'].includes(args[index])) {
        grants.push(args.slice(index, index + 3));
      }
    }
    expect(grants.filter(([kind]) => kind === '--bind')).toEqual(
      ['output', 'tmp', 'home'].map((name) => ['--bind', '/tmp/example-worker/' + name, '/workspace/' + name]),
    );
    expect(grants.some(([, source]) => ['/', '/etc', '/run', '/home', '/tmp'].includes(source))).toBe(false);
    expect(args).toContain('--clearenv');
    expect(args).toContain('--unshare-all');
    expect(args).toContain('--seccomp');
    expect(args.slice(-7)).toEqual(['--remount-ro', '/', '--chdir', '/workspace/tmp', '--', '/opt/example/bin/tool', '/workspace/input/scene.py']);
  });
});
