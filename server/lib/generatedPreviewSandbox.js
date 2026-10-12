/**
 * Network-isolation contract for generated preview browsers (#11157).
 *
 * A fresh srcdoc realm gets its own constructors, so a page CSP and a
 * constructor freeze in the original document do not stop WebRTC, DNS, or a
 * nested navigation. The preview browser therefore runs under an OS mechanism
 * that denies IP networking, with Chrome flags only as defense in depth.
 * Firefox, WebKit, and hosts without Seatbelt or bubblewrap are unsupported:
 * callers fail closed instead of executing generated HTML in the user's browser.
 *
 * Pure: no filesystem, process, or settings access.
 */

export const PREVIEW_SEATBELT = '/usr/bin/sandbox-exec';
export const PREVIEW_BUBBLEWRAP = '/usr/bin/bwrap';

// Header policy for a generated page whose scripts and media are same-origin
// files or data/blob URLs. connect-src and frame-src stay closed; the OS jail
// is what actually stops UDP and a fresh realm that ignores this policy.
export const PREVIEW_PAGE_CSP = [
  'sandbox allow-scripts',
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/**
 * Chrome arguments for one private preview profile.
 * `denyNetwork` adds the flags that block proxied UDP and DNS. They are not
 * the boundary: a test proves the OS jail with those flags absent on the
 * negative control, and present only on the jailed launch. `dropSandbox` adds
 * `--no-sandbox` because Chrome's own `sandbox_init` returns EPERM inside
 * Seatbelt or bubblewrap and the renderer then crashes. The outer jail is the
 * egress boundary.
 */
export function _previewChromeArgs(profileDir, { denyNetwork = true, dropSandbox = false } = {}) {
  return [
    '--headless=new',
    ...(dropSandbox ? ['--no-sandbox'] : []),
    '--remote-debugging-pipe',
    ...(denyNetwork ? [
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--host-resolver-rules=MAP * ~NOTFOUND',
      '--proxy-server=http://127.0.0.1:9',
    ] : []),
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-component-update',
    '--disable-sync',
    '--disable-breakpad',
    '--no-first-run',
    '--no-default-browser-check',
    '--mute-audio',
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ];
}

/**
 * Seatbelt profile: allow Chrome's normal process and file needs, then deny
 * IP networking. Last matching rule wins. Unix sockets are allowed again after
 * `(deny network*)` so the browser can bind its own helper sockets. The system
 * resolver socket stays denied: `getaddrinfo` would otherwise ask mDNSResponder,
 * outside the jail, to send the DNS query.
 */
export function _previewSeatbeltProfile() {
  return `(version 1)
(allow default)
(deny network*)
(deny system-socket (socket-domain AF_INET))
(deny system-socket (socket-domain AF_INET6))
(allow system-socket (socket-domain AF_UNIX))
(allow system-socket (socket-domain AF_SYSTEM))
(allow network-bind (local unix-socket))
(allow network-inbound (local unix-socket))
(allow network-outbound (remote unix-socket))
(deny network-outbound
  (literal "/private/var/run/mDNSResponder")
  (literal "/var/run/mDNSResponder")
  (remote unix-socket (path-literal "/private/var/run/mDNSResponder"))
  (remote unix-socket (path-literal "/var/run/mDNSResponder")))
(deny mach-lookup
  (global-name "com.apple.mDNSResponder"
               "com.apple.mDNSResponder.helper"
               "com.apple.dnssd.service"))
`;
}

/** Host resolver sockets an empty network namespace does not hide. */
export const PREVIEW_HOST_RESOLVER_SOCKETS = [
  '/run/systemd/resolve/io.systemd.Resolve',
  '/run/systemd/resolve/io.systemd.Resolve.Monitor',
  '/run/nscd/socket',
  '/var/run/nscd/socket',
  '/run/avahi-daemon/socket',
  '/var/run/avahi-daemon/socket',
];

/**
 * bubblewrap argv after the bwrap binary. The network namespace is empty.
 * `hostResolverSockets` are paths that exist on this host; each is covered
 * with `/dev/null` so glibc cannot ask the host resolver to send DNS.
 */
export function _previewBubblewrapArgs(executable, chromeArgs, hostResolverSockets = []) {
  const covers = [];
  for (const path of hostResolverSockets) {
    covers.push('--ro-bind-try', '/dev/null', path);
  }
  return [
    '--unshare-net',
    '--die-with-parent',
    '--bind', '/', '/',
    '--dev-bind', '/dev', '/dev',
    '--proc', '/proc',
    ...covers,
    '--',
    executable,
    ...chromeArgs,
  ];
}

/**
 * How to spawn the preview browser, or a refusal. `isolation: 'off'` is the
 * negative control used by the egress test (no OS jail and no network flags).
 * Production previews pass `'required'`. `'os'` is the collector proof: the same
 * jail, without Chrome's network flags, so silence is attributable to the OS.
 */
export function previewIsolationPlan({
  platform,
  seatbeltAvailable,
  bubblewrapAvailable,
  executable,
  profileDir,
  dropSandbox = false,
  isolation = 'required',
  hostResolverSockets = [],
}) {
  const denyNetwork = isolation !== 'off' && isolation !== 'os';
  const chromeArgs = _previewChromeArgs(profileDir, { denyNetwork, dropSandbox });
  if (isolation === 'off') {
    return { supported: true, mechanism: 'none', command: executable, args: chromeArgs, reason: null };
  }
  if (platform === 'darwin' && seatbeltAvailable) {
    return {
      supported: true,
      mechanism: 'macos-seatbelt',
      command: PREVIEW_SEATBELT,
      args: ['-p', _previewSeatbeltProfile(), executable, ...chromeArgs],
      reason: null,
    };
  }
  if (platform === 'linux' && bubblewrapAvailable) {
    return {
      supported: true,
      mechanism: 'linux-bubblewrap',
      command: PREVIEW_BUBBLEWRAP,
      args: _previewBubblewrapArgs(executable, chromeArgs, hostResolverSockets),
      reason: null,
    };
  }
  const reason = platform === 'darwin'
    ? 'macOS Seatbelt (/usr/bin/sandbox-exec) is unavailable, so generated previews cannot run.'
    : platform === 'linux'
      ? 'Linux bubblewrap (/usr/bin/bwrap) is unavailable, so generated previews cannot run.'
      : `Generated previews have no enforced network isolation on ${platform}. Firefox and WebKit are not used.`;
  return { supported: false, mechanism: null, command: null, args: [], reason };
}
