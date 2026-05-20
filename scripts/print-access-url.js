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
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CERT_DIR = join(ROOT, 'data', 'certs');
const META_PATH = join(CERT_DIR, 'meta.json');
const API_PORT = Number(process.env.PORT) || 5555;
const MIRROR_PORT = Number(process.env.PORTOS_HTTP_PORT) || 5553;

if (!hasTailscaleCert(CERT_DIR)) {
  console.log(`Access at: http://localhost:${API_PORT}`);
  process.exit(0);
}

let mode = '';
try {
  mode = JSON.parse(readFileSync(META_PATH, 'utf-8')).mode || '';
} catch { /* meta unreadable — fall through to generic warning */ }

console.log(`Access at: http://localhost:${MIRROR_PORT}  (loopback HTTP mirror — no cert warning)`);
if (mode === 'tailscale') {
  console.log(`       or: https://<machine>.<tailnet>.ts.net:${API_PORT}  (trusted via Tailscale)`);
  console.log(`       or: https://localhost:${API_PORT}  (browser warns — cert is for the Tailscale hostname)`);
} else if (mode === 'self-signed') {
  console.log(`       or: https://localhost:${API_PORT}  (browser warns on first visit — self-signed cert)`);
} else {
  console.log(`       or: https://localhost:${API_PORT}  (browser may warn on cert)`);
}
