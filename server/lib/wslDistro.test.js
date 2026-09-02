import { describe, expect, it, vi } from 'vitest';

import { detectWslProjectDir, parseWslDistroList, parseWslProbe } from './wslDistro.js';

/** The probe args, recognised by shape rather than by the module's own constant. */
const isProbe = (args) => args[0] === '-e';

/** A `wsl.exe` that answers the probe and nothing else. */
const wslThatAnswers = (stdout) => vi.fn(async (args) => (
  isProbe(args)
    ? { launched: true, ok: true, stdout, error: '' }
    : { launched: true, ok: true, stdout: '', error: '' }
));

describe('parseWslProbe', () => {
  it('reads the distro name and home the probe prints', () => {
    expect(parseWslProbe('Ubuntu\n/home/alice\n')).toEqual({ distro: 'Ubuntu', home: '/home/alice' });
  });

  it('tolerates CRLF and a blank trailing line', () => {
    expect(parseWslProbe('Ubuntu\r\n/home/alice\r\n\r\n')).toEqual({ distro: 'Ubuntu', home: '/home/alice' });
  });

  it('rejects a home that is not an absolute POSIX path', () => {
    // Otherwise the caller derives a path at the ROOT of somebody's distro.
    expect(parseWslProbe('Ubuntu\n\n')).toBeNull();
    expect(parseWslProbe('Ubuntu\nrelative/home\n')).toBeNull();
    expect(parseWslProbe('')).toBeNull();
  });
});

describe('parseWslDistroList', () => {
  it('recovers names from the UTF-16LE bytes a UTF-8 reader leaves NULs in', () => {
    const utf16 = [...'Ubuntu-24.04'].map((ch) => `${ch}\u0000`).join('');
    expect(parseWslDistroList(`${utf16}\r\n`)).toEqual(['Ubuntu-24.04']);
  });

  it('drops the container engines own distros, and keeps everything else', () => {
    const listed = 'Ubuntu\ndocker-desktop\ndocker-desktop-data\nrancher-desktop-data\npodman-machine-default\nDebian\n';
    expect(parseWslDistroList(listed)).toEqual(['Ubuntu', 'Debian']);
  });
});

describe('detectWslProjectDir', () => {
  it('derives the project directory from what the default distro says', async () => {
    const run = wslThatAnswers('Ubuntu\n/home/alice\n');

    const found = await detectWslProjectDir('qwen-serving', { run, exists: async () => true });

    expect(found).toMatchObject({
      dir: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\qwen-serving',
      distro: 'Ubuntu',
    });
    // The probe runs the distro's OWN shell — `wsl --list` prints UTF-16LE that
    // a UTF-8 reader mangles, while an executed program's stdout passes through.
    expect(run).toHaveBeenCalledWith(['-e', 'sh', '-c', expect.stringContaining('WSL_DISTRO_NAME')]);
  });

  it('separates a host with no WSL from a WSL with no distro', async () => {
    const missing = vi.fn(async () => ({ launched: false, ok: false, stdout: '', error: 'ENOENT' }));
    expect(await detectWslProjectDir('qwen-serving', { run: missing })).toMatchObject({ dir: null, reason: 'no-wsl' });

    const refused = vi.fn(async () => ({ launched: true, ok: false, stdout: '', error: 'no installed distributions' }));
    expect(await detectWslProjectDir('qwen-serving', { run: refused })).toMatchObject({ dir: null, reason: 'no-distro' });
  });

  it('refuses a container engines own distro, and names the real ones instead', async () => {
    const run = vi.fn(async (args) => (isProbe(args)
      ? { launched: true, ok: true, stdout: 'docker-desktop\n/root\n', error: '' }
      : { launched: true, ok: true, stdout: 'Ubuntu\ndocker-desktop\n', error: '' }));

    const found = await detectWslProjectDir('qwen-serving', { run, exists: async () => true });

    // Its filesystem is recreated on a Docker Desktop reset — not a home for
    // 20 GB of weights, even though WSL itself is working fine.
    expect(found).toMatchObject({ dir: null, reason: 'internal-distro', distro: 'docker-desktop', distros: ['Ubuntu'] });
  });

  it('refuses a distro whose share Windows cannot actually read', async () => {
    const run = wslThatAnswers('Ubuntu\n/home/alice\n');

    const found = await detectWslProjectDir('qwen-serving', { run, exists: async () => false });

    // WSL answering and \\wsl.localhost answering are separate facts; returning
    // a path only the container can see would repeat the 9p mistake.
    expect(found).toMatchObject({ dir: null, reason: 'unreadable-share', home: '\\\\wsl.localhost\\Ubuntu\\home\\alice' });
  });
});
