import { describe, expect, it } from 'vitest';
import {
  PREVIEW_PAGE_CSP,
  _previewBubblewrapArgs,
  _previewChromeArgs,
  previewIsolationPlan,
  _previewSeatbeltProfile,
} from './generatedPreviewSandbox.js';

describe('generated preview isolation plan', () => {
  const executable = '/synthetic/chrome';
  const profileDir = '/tmp/portos-preview-profile';

  it('denies IP networking in the Seatbelt profile and still allows unix sockets', () => {
    const profile = _previewSeatbeltProfile();
    const deny = profile.indexOf('(deny network*)');
    const allowUnix = profile.indexOf('(allow network-outbound (remote unix-socket))');
    const denyResolver = profile.indexOf('(literal "/private/var/run/mDNSResponder")');
    expect(profile).toContain('(deny system-socket (socket-domain AF_INET))');
    expect(profile).toContain('(deny system-socket (socket-domain AF_INET6))');
    expect(profile).toContain('(allow network-bind (local unix-socket))');
    expect(profile).toContain('com.apple.dnssd.service');
    expect(allowUnix).toBeGreaterThan(deny);
    expect(denyResolver).toBeGreaterThan(allowUnix);
  });

  it('wraps Chrome with Seatbelt on macOS and does not bypass the dead proxy', () => {
    const plan = previewIsolationPlan({
      platform: 'darwin', seatbeltAvailable: true, bubblewrapAvailable: false, executable, profileDir,
    });
    expect(plan).toMatchObject({ supported: true, mechanism: 'macos-seatbelt', command: '/usr/bin/sandbox-exec' });
    expect(plan.args[0]).toBe('-p');
    expect(plan.args).toContain(executable);
    expect(plan.args).toContain('--remote-debugging-pipe');
    expect(plan.args).toContain('--proxy-server=http://127.0.0.1:9');
    expect(plan.args.join('\n')).not.toContain('proxy-bypass');
    expect(plan.args).not.toContain('--remote-debugging-port=0');
  });

  it('uses an empty network namespace on Linux', () => {
    const chromeArgs = _previewChromeArgs(profileDir);
    const plan = previewIsolationPlan({
      platform: 'linux', seatbeltAvailable: false, bubblewrapAvailable: true, executable, profileDir,
    });
    expect(plan.command).toBe('/usr/bin/bwrap');
    expect(plan.args).toEqual(_previewBubblewrapArgs(executable, chromeArgs));
    expect(plan.args).toContain('--unshare-net');
    expect(plan.args).toContain('--die-with-parent');
    const covered = previewIsolationPlan({
      platform: 'linux', seatbeltAvailable: false, bubblewrapAvailable: true, executable, profileDir,
      hostResolverSockets: ['/run/systemd/resolve/io.systemd.Resolve'],
    });
    const rootBind = covered.args.indexOf('/');
    const cover = covered.args.indexOf('/run/systemd/resolve/io.systemd.Resolve');
    expect(covered.args.slice(cover - 2, cover + 1)).toEqual([
      '--ro-bind-try', '/dev/null', '/run/systemd/resolve/io.systemd.Resolve',
    ]);
    expect(cover).toBeGreaterThan(rootBind);
  });

  it('refuses Windows and a host missing its mechanism', () => {
    expect(previewIsolationPlan({
      platform: 'win32', seatbeltAvailable: false, bubblewrapAvailable: false, executable, profileDir,
    })).toMatchObject({ supported: false, mechanism: null });
    expect(previewIsolationPlan({
      platform: 'linux', seatbeltAvailable: false, bubblewrapAvailable: false, executable, profileDir,
    }).reason).toMatch(/bubblewrap/);
    expect(previewIsolationPlan({
      platform: 'darwin', seatbeltAvailable: false, bubblewrapAvailable: true, executable, profileDir,
    }).supported).toBe(false);
  });

  it('keeps the negative-control launch free of the network flags', () => {
    const plan = previewIsolationPlan({
      platform: 'darwin', seatbeltAvailable: true, bubblewrapAvailable: false, executable, profileDir, isolation: 'off',
    });
    expect(plan).toMatchObject({ supported: true, mechanism: 'none', command: executable });
    expect(plan.args).toContain('--remote-debugging-pipe');
    expect(plan.args.join('\n')).not.toContain('webrtc');
    expect(plan.args.join('\n')).not.toContain('proxy-server');
    expect(plan.args.join('\n')).not.toContain('host-resolver-rules');
  });

  it('keeps the page policy closed to connections, frames, and workers', () => {
    expect(PREVIEW_PAGE_CSP).toContain("connect-src 'none'");
    expect(PREVIEW_PAGE_CSP).toContain("frame-src 'none'");
    expect(PREVIEW_PAGE_CSP).toContain("worker-src 'none'");
    expect(PREVIEW_PAGE_CSP).not.toContain('http:');
  });
});
