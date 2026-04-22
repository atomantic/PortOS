/**
 * tailscale-https — zero-dep helper that boots a Node server with HTTPS when a
 * Tailscale (or any other) cert is present, plain HTTP otherwise, and an
 * optional loopback-only HTTP mirror so http://localhost:<mirror> works
 * without the cert warning you get on a Tailscale IP.
 *
 * Canonical source: PortOS (atomantic/PortOS:lib/tailscale-https.js).
 * PortOS's "Upgrade to TLS" action copies this file verbatim into a managed
 * app's repo, so apps stay self-contained and can run without PortOS.
 *
 * Usage:
 *   import { createTailscaleServers, watchCertReload } from './lib/tailscale-https.js';
 *
 *   const { server, mirror, httpsEnabled } = createTailscaleServers(app, {
 *     certDir: join(DATA_DIR, 'certs')
 *   });
 *   io.attach(server);
 *   if (mirror) io.attach(mirror);
 *   server.listen(PORT, HOST, () => console.log(`up on :${PORT}`));
 *   if (mirror) mirror.listen(MIRROR_PORT, '127.0.0.1');
 *   if (httpsEnabled) watchCertReload(server, CERT_DIR);
 *
 * No side effects at import time — safe to require in any Node project.
 */
import { createServer as createHttpServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { existsSync, readFileSync, watch } from 'fs';
import { join } from 'path';

function loadCert(certDir) {
  if (!certDir) return null;
  const certPath = join(certDir, 'cert.pem');
  const keyPath = join(certDir, 'key.pem');
  if (!existsSync(certPath) || !existsSync(keyPath)) return null;
  return {
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
    certPath,
    keyPath
  };
}

/**
 * Create the listener(s) for a Node HTTP request handler (express/koa/http).
 * Does NOT call .listen() — the caller wires up Socket.IO / error handlers
 * first, then listens when ready.
 *
 * @param {import('http').RequestListener} handler - express app or plain handler
 * @param {object} [opts]
 * @param {string} [opts.certDir] - dir containing cert.pem + key.pem
 * @param {boolean} [opts.httpMirror] - when HTTPS is active, also create a plain-HTTP
 *   sibling server bound to 127.0.0.1 for local dev without cert warnings.
 *   Defaults to true when HTTPS is active.
 * @returns {{ server: import('http').Server, mirror: import('http').Server|null, httpsEnabled: boolean }}
 */
export function createTailscaleServers(handler, opts = {}) {
  const { certDir, httpMirror = true } = opts;
  const credentials = loadCert(certDir);
  const httpsEnabled = Boolean(credentials);

  const server = httpsEnabled
    ? createHttpsServer({ cert: credentials.cert, key: credentials.key }, handler)
    : createHttpServer(handler);

  const mirror = httpsEnabled && httpMirror ? createHttpServer(handler) : null;

  return { server, mirror, httpsEnabled };
}

/**
 * Watch the cert + key files and hot-swap the HTTPS server's SecureContext
 * when they change. Use this when an external process (Tailscale CLI, certbot,
 * ACME client) rotates the cert — new TLS handshakes pick up the renewed cert
 * without a restart. Returns an unsubscribe fn.
 *
 * @param {import('https').Server} httpsServer
 * @param {string} certDir
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.log=console.log]
 * @returns {() => void} stop — cancels the watchers
 */
export function watchCertReload(httpsServer, certDir, opts = {}) {
  const log = opts.log || console.log;
  if (!httpsServer || typeof httpsServer.setSecureContext !== 'function') {
    return () => {};
  }
  const certPath = join(certDir, 'cert.pem');
  const keyPath = join(certDir, 'key.pem');

  let pending = null;
  const reload = () => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      if (!existsSync(certPath) || !existsSync(keyPath)) return;
      try {
        httpsServer.setSecureContext({
          cert: readFileSync(certPath),
          key: readFileSync(keyPath)
        });
        log(`🔒 cert hot-reloaded from ${certDir}`);
      } catch (err) {
        log(`⚠️ cert reload failed: ${err.message}`);
      }
    }, 500);
  };

  // fs.watch debounced — Tailscale rewrites both files, we get a burst of events
  const watchers = [
    watch(certPath, reload),
    watch(keyPath, reload)
  ];

  return () => {
    clearTimeout(pending);
    watchers.forEach(w => w.close());
  };
}

/**
 * True when `certDir` contains a usable cert+key pair.
 * @param {string} certDir
 */
export function hasTailscaleCert(certDir) {
  return Boolean(loadCert(certDir));
}
