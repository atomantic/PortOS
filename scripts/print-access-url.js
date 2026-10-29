#!/usr/bin/env node
/**
 * Print the URL(s) the user should open to reach PortOS, gated on the same
 * cert detection the server uses (`hasTailscaleCert` from
 * lib/tailscale-https.js — checks file presence AND PEM parseability).
 * Called from setup.sh's final banner so we never advertise an HTTPS URL the
 * server isn't actually serving (e.g. corrupt cert files would let the server
 * boot HTTP-only while setup.sh's file-presence check still claimed HTTPS).
 */
import { hasTailscaleCert } from '../lib/tailscale-https.js';
import { certPaths } from '../lib/certPaths.js';
import { getTailscaleHttpsUrl, readCertMeta } from '../lib/certMeta.js';
import { join, dirname } from 'path';
import { resolveHttpMirrorPortForRoot } from './lib/envFile.js';
import { PORTS } from '../server/lib/ports.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';

import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { dir: CERT_DIR, meta: META_PATH } = certPaths(join(ROOT, 'data'));
// These maintenance commands target the PM2-managed server, whose PORT is fixed.
const API_PORT = PORTS.API;
const MIRROR_PORT = resolveHttpMirrorPortForRoot(ROOT);

export function printAccessUrl() {
  if (!hasTailscaleCert(CERT_DIR)) {
    console.log(`Access at: http://localhost:${API_PORT}`);
    return;
  }

  const meta = readCertMeta(META_PATH);
  const mode = meta?.mode || '';
  const trustedUrl = getTailscaleHttpsUrl(meta, API_PORT);

  console.log(`Access at: http://localhost:${MIRROR_PORT}  (loopback HTTP mirror — no cert warning)`);
  if (mode === 'tailscale' && trustedUrl) {
    console.log(`       or: ${trustedUrl}  (trusted via Tailscale)`);
    console.log(`       or: https://localhost:${API_PORT}  (browser warns — cert is for the Tailscale hostname)`);
  } else if (mode === 'self-signed') {
    console.log(`       or: https://localhost:${API_PORT}  (browser warns on first visit — self-signed cert)`);
  } else {
    console.log(`       or: https://localhost:${API_PORT}  (browser may warn on cert)`);
  }
}

if (isDirectlyInvoked(import.meta.url)) printAccessUrl();
