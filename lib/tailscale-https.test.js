import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EventEmitter from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, renameSync, watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Fresh watcher stubs per test: watchCertReload makes one fs.watch call on the
// cert dir. `realWatch` flips to the real fs.watch for the rename-rotation test.
let realWatch = false;
let createdWatchers;
const makeWatcher = () => {
  const w = new EventEmitter();
  w.close = vi.fn();
  return w;
};

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    watch: vi.fn((path, listener) => {
      if (realWatch) return actual.watch(path, listener);
      const w = makeWatcher();
      w.listener = listener;
      createdWatchers.push(w);
      return w;
    }),
  };
});

import { createTailscaleServers, hasTailscaleCert, watchCertReload } from './tailscale-https.js';

// Long-lived self-signed P-256 pairs used only by these tests (CN=localhost).
const CERT_A = `-----BEGIN CERTIFICATE-----
MIIBfzCCASWgAwIBAgIUHUjoD7ndnDQ95qFsVDi744ttutYwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTEyMzA5MjQxNFoYDzIxMjYxMDMw
MDkyNDE0WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAARLv7wDPbYqCBI027nnFM7KHeIIEDnBXgs5NDhH/YQiov3LGfqpntCp
B+QtC+DRvQhyKGI2dWb5VJomCMUHrXGfo1MwUTAdBgNVHQ4EFgQUJtiwOFG0lT0p
BIqHov1REY4bDwcwHwYDVR0jBBgwFoAUJtiwOFG0lT0pBIqHov1REY4bDwcwDwYD
VR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiEAk79/ImutPh+0sCn5IXSv
lBhve3ciFUu3SKif3Cw4NnoCIHPO/ffR5oIRaOGPty7wfWOSPQng5gkye+UHa3Ez
/I8D
-----END CERTIFICATE-----
`;
const KEY_A = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg5hWBguvDAWz+05aX
97flUElm8FlRg5APv2J0ZTozi7KhRANCAARLv7wDPbYqCBI027nnFM7KHeIIEDnB
Xgs5NDhH/YQiov3LGfqpntCpB+QtC+DRvQhyKGI2dWb5VJomCMUHrXGf
-----END PRIVATE KEY-----
`;
// Valid key that does not belong to CERT_A.
const KEY_B = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgwNMOiCQVz3JfRpCf
sgy4BYQ2C6dHaCBGuHHrZcbaPauhRANCAASKUW44DgXvJa924j5kvy4ScY0ZAIdi
rUQb5DQ4vl8TXA7J/W/xiUu3BA11hOqd0QgF9rvR9svVCVnMya68c0Ro
-----END PRIVATE KEY-----
`;

let dir;
const writePair = (cert, key) => {
  if (cert !== null) writeFileSync(join(dir, 'cert.pem'), cert);
  if (key !== null) writeFileSync(join(dir, 'key.pem'), key);
};
const closeAll = (...servers) => servers.forEach((s) => s?.listening && s.close());

beforeEach(() => {
  createdWatchers = [];
  realWatch = false;
  dir = mkdtempSync(join(tmpdir(), 'ts-https-'));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('hasTailscaleCert / createTailscaleServers', () => {
  const handler = () => {};

  it('falls back to plain HTTP with no mirror when certDir is missing or unset', () => {
    for (const certDir of [undefined, join(dir, 'does-not-exist')]) {
      expect(hasTailscaleCert(certDir)).toBe(false);
      const { server, mirror, httpsEnabled } = createTailscaleServers(handler, { certDir });
      expect(httpsEnabled).toBe(false);
      expect(mirror).toBeNull();
      expect(typeof server.setSecureContext).toBe('undefined');
    }
  });

  it('treats a dir with only one of cert/key as no cert', () => {
    writePair(CERT_A, null);
    expect(hasTailscaleCert(dir)).toBe(false);
    unlinkSync(join(dir, 'cert.pem'));
    writePair(null, KEY_A);
    expect(hasTailscaleCert(dir)).toBe(false);
    expect(createTailscaleServers(handler, { certDir: dir }).httpsEnabled).toBe(false);
  });

  it.each([
    ['empty files', '', ''],
    ['truncated PEM', CERT_A.slice(0, 120), KEY_A.slice(0, 80)],
    ['mismatched cert and key', CERT_A, KEY_B],
  ])('degrades to HTTP instead of throwing for %s', (_label, cert, key) => {
    writePair(cert, key);
    expect(hasTailscaleCert(dir)).toBe(false);
    let result;
    expect(() => { result = createTailscaleServers(handler, { certDir: dir }); }).not.toThrow();
    expect(result.httpsEnabled).toBe(false);
    expect(result.mirror).toBeNull();
    expect(typeof result.server.setSecureContext).toBe('undefined');
  });

  it('creates an HTTPS server plus a loopback HTTP mirror for a valid pair', () => {
    writePair(CERT_A, KEY_A);
    expect(hasTailscaleCert(dir)).toBe(true);
    const { server, mirror, httpsEnabled } = createTailscaleServers(handler, { certDir: dir });
    try {
      expect(httpsEnabled).toBe(true);
      expect(typeof server.setSecureContext).toBe('function');
      expect(mirror).not.toBeNull();
      expect(typeof mirror.setSecureContext).toBe('undefined');
    } finally {
      closeAll(server, mirror);
    }
  });

  it('omits the mirror when httpMirror is false', () => {
    writePair(CERT_A, KEY_A);
    const { server, mirror, httpsEnabled } = createTailscaleServers(handler, { certDir: dir, httpMirror: false });
    expect(httpsEnabled).toBe(true);
    expect(mirror).toBeNull();
    closeAll(server);
  });
});

describe('watchCertReload', () => {
  const setup = (server = { setSecureContext: vi.fn() }) => {
    const logs = [];
    const stop = watchCertReload(server, dir, { log: (m) => logs.push(m) });
    return { server, logs, stop };
  };

  it('returns a no-op cleanup and watches nothing for servers without setSecureContext', () => {
    for (const s of [null, undefined, {}, createTailscaleServers(() => {}).server]) {
      const stop = watchCertReload(s, dir);
      expect(stop).toBeTypeOf('function');
      expect(() => stop()).not.toThrow();
    }
    expect(createdWatchers).toHaveLength(0);
  });

  it('watches the cert directory once and survives an error event', () => {
    const { logs, stop } = setup();
    expect(createdWatchers).toHaveLength(1);
    const [w] = createdWatchers;
    expect(watch).toHaveBeenCalledWith(dir, expect.any(Function));

    expect(w.listenerCount('error')).toBe(1);
    expect(() => w.emit('error', new Error('EPERM: operation not permitted'))).not.toThrow();
    expect(w.close).toHaveBeenCalled();
    expect(logs.some((l) => l.includes('cert watch error') && l.includes('EPERM'))).toBe(true);
    stop();
  });

  it('reloads for cert.pem, key.pem and null filenames but ignores unrelated files', () => {
    vi.useFakeTimers();
    writePair(CERT_A, KEY_A);
    const { server } = setup();
    const [w] = createdWatchers;

    w.listener('rename', 'meta.json');
    w.listener('change', 'cert.pem.tmp');
    vi.advanceTimersByTime(500);
    expect(server.setSecureContext).not.toHaveBeenCalled();

    for (const name of ['cert.pem', 'key.pem', null]) {
      w.listener('rename', name);
      vi.advanceTimersByTime(500);
    }
    expect(server.setSecureContext).toHaveBeenCalledTimes(3);
  });

  it('collapses a burst of cert and key change events into one reload after 500ms', () => {
    vi.useFakeTimers();
    writePair(CERT_A, KEY_A);
    const { server, logs } = setup();
    const [w] = createdWatchers;

    w.listener('rename', 'cert.pem');
    w.listener('rename', 'key.pem');
    w.listener('rename', 'cert.pem');
    vi.advanceTimersByTime(499);
    expect(server.setSecureContext).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(server.setSecureContext).toHaveBeenCalledTimes(1);
    const arg = server.setSecureContext.mock.calls[0][0];
    expect(arg.cert.toString()).toBe(CERT_A);
    expect(arg.key.toString()).toBe(KEY_A);
    expect(logs.some((l) => l.includes('cert hot-reloaded'))).toBe(true);
  });

  it('restarts the debounce window on each new event', () => {
    vi.useFakeTimers();
    writePair(CERT_A, KEY_A);
    const { server } = setup();
    const [certW] = createdWatchers;

    certW.listener('rename', 'cert.pem');
    vi.advanceTimersByTime(400);
    certW.listener('rename', 'cert.pem');
    vi.advanceTimersByTime(400);
    expect(server.setSecureContext).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(server.setSecureContext).toHaveBeenCalledTimes(1);
  });

  it('skips the reload when either file is missing', () => {
    vi.useFakeTimers();
    const { server } = setup();
    const [certW] = createdWatchers;

    writePair(CERT_A, null);
    certW.listener('rename', 'cert.pem');
    vi.advanceTimersByTime(500);
    expect(server.setSecureContext).not.toHaveBeenCalled();

    unlinkSync(join(dir, 'cert.pem'));
    writePair(null, KEY_A);
    certW.listener('rename', 'cert.pem');
    vi.advanceTimersByTime(500);
    expect(server.setSecureContext).not.toHaveBeenCalled();
  });

  it('logs and survives a setSecureContext failure, then reloads on the next event', () => {
    vi.useFakeTimers();
    writePair(CERT_A, KEY_A);
    const setSecureContext = vi.fn()
      .mockImplementationOnce(() => { throw new Error('bad PEM'); })
      .mockImplementation(() => {});
    const { logs } = setup({ setSecureContext });
    const [certW] = createdWatchers;

    certW.listener('rename', 'cert.pem');
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    expect(logs.some((l) => l.includes('cert reload failed') && l.includes('bad PEM'))).toBe(true);

    certW.listener('rename', 'cert.pem');
    vi.advanceTimersByTime(500);
    expect(setSecureContext).toHaveBeenCalledTimes(2);
  });

  it('rejects an invalid PEM on a real HTTPS server without throwing', () => {
    vi.useFakeTimers();
    writePair(CERT_A, KEY_A);
    const { server } = createTailscaleServers(() => {}, { certDir: dir });
    const { logs } = setup(server);
    const [certW] = createdWatchers;

    writePair('not a cert', 'not a key');
    certW.listener('rename', 'cert.pem');
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    expect(logs.some((l) => l.includes('cert reload failed'))).toBe(true);
  });

  it('stop() cancels a pending reload and closes the watcher', () => {
    vi.useFakeTimers();
    writePair(CERT_A, KEY_A);
    const { server, stop } = setup();
    const [certW] = createdWatchers;

    certW.listener('rename', 'cert.pem');
    stop();
    vi.advanceTimersByTime(1000);

    expect(server.setSecureContext).not.toHaveBeenCalled();
    expect(certW.close).toHaveBeenCalled();
  });

  it('keeps reloading across repeated atomic temp+rename rotations on a real filesystem', async () => {
    realWatch = true;
    writePair(CERT_A, KEY_A);
    const setSecureContext = vi.fn();
    const stop = watchCertReload({ setSecureContext }, dir, { log: () => {} });
    try {
      for (let i = 1; i <= 3; i++) {
        writeFileSync(join(dir, 'cert.pem.tmp'), CERT_A);
        writeFileSync(join(dir, 'key.pem.tmp'), KEY_A);
        renameSync(join(dir, 'cert.pem.tmp'), join(dir, 'cert.pem'));
        renameSync(join(dir, 'key.pem.tmp'), join(dir, 'key.pem'));
        await vi.waitFor(() => expect(setSecureContext).toHaveBeenCalledTimes(i), { timeout: 3000 });
        await new Promise((r) => setTimeout(r, 650));
      }
    } finally {
      stop();
    }
  });
});
