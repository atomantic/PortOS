#!/usr/bin/env node
/**
 * Provisions a TLS cert for PortOS at data/certs/{cert,key}.pem.
 *
 * Prefers a real Let's Encrypt cert via `tailscale cert` (browsers trust it,
 * no click-through). Will only generate a self-signed cert when the user opts
 * in via `--self-signed` OR a self-signed cert is already present on disk
 * (renewal/IP-rotation path). On a fresh install without Tailscale and without
 * `--self-signed`, this script exits cleanly and PortOS keeps serving plain
 * HTTP on :5555 — silently flipping a vanilla install to HTTPS with a
 * self-signed cert breaks the documented `http://localhost:5555` URL and
 * forces a click-through warning, which is a worse first-run UX than HTTP.
 *
 * Why we prefer Tailscale: Let's Encrypt does not issue certs for bare IPs.
 * Tailscale owns `ts.net` and provisions LE certs against your tailnet's
 * `<machine>.<tailnet>.ts.net` hostname via DNS-01. MagicDNS resolves that
 * name to the 100.x Tailscale IP, so `https://<host>.ts.net` hits the same
 * server as `https://100.x.y.z` — but with a trusted cert.
 *
 * Renewal: the LE cert lives ~90 days. `tailscale cert` is a no-op when the
 * cached cert has >1/3 lifetime remaining and fetches a fresh one otherwise.
 * `server/services/certRenewer.js` calls it daily and hot-swaps the running
 * HTTPS server's SecureContext without a restart.
 *
 * Flags:
 *   --force          regenerate even if meta says nothing changed
 *   --self-signed    skip Tailscale attempt and go straight to self-signed
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'fs';
import { networkInterfaces } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { findTailscale } from '../server/lib/tailscale.js';
import { hasTailscaleCert } from '../lib/tailscale-https.js';
import { certPaths } from '../lib/certPaths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { dir: CERT_DIR, cert: CERT_PATH, key: KEY_PATH, meta: META_PATH } = certPaths(join(ROOT, 'data'));

const FORCE = process.argv.includes('--force');
const SELF_SIGNED_ONLY = process.argv.includes('--self-signed');

function tailscaleStatus(bin) {
  const out = execFileSync(bin, ['status', '--json'], { stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(out.toString());
}

function tailscaleHostname(status) {
  const raw = status?.Self?.DNSName;
  if (!raw) return null;
  return raw.replace(/\.$/, '');
}

function runTailscaleCert(bin, hostname) {
  mkdirSync(CERT_DIR, { recursive: true });
  execFileSync(bin, [
    'cert',
    `--cert-file=${CERT_PATH}`,
    `--key-file=${KEY_PATH}`,
    hostname
  ], { stdio: 'inherit' });
}

// ---- Self-signed path ----------------------------------------------------

function detectIPs() {
  const ips = new Set(['127.0.0.1']);
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const iface of nets[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) ips.add(iface.address);
    }
  }
  return [...ips].sort();
}

function buildSANs(ips) {
  const dns = ['localhost'];
  const lines = [
    ...dns.map((d, i) => `DNS.${i + 1} = ${d}`),
    ...ips.map((ip, i) => `IP.${i + 1} = ${ip}`)
  ];
  return lines.join('\n');
}

function generateSelfSigned(ips) {
  mkdirSync(CERT_DIR, { recursive: true });

  const cnf = `
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
req_extensions = v3_req
x509_extensions = v3_req

[dn]
CN = PortOS

[v3_req]
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
${buildSANs(ips)}
`;

  const cnfPath = join(CERT_DIR, 'openssl.cnf');
  writeFileSync(cnfPath, cnf);

  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', KEY_PATH,
    '-out', CERT_PATH,
    '-days', '3650',
    '-config', cnfPath,
    '-extensions', 'v3_req'
  ], { stdio: ['ignore', 'ignore', 'inherit'] });

  writeFileSync(META_PATH, JSON.stringify({
    mode: 'self-signed',
    ips,
    generatedAt: new Date().toISOString()
  }, null, 2));
  console.log(`🔒 Generated self-signed cert for ${ips.join(', ')}`);
}

// ---- Regeneration logic --------------------------------------------------

function readMeta() {
  if (!existsSync(META_PATH)) return null;
  try {
    return JSON.parse(readFileSync(META_PATH, 'utf-8'));
  } catch {
    // Partial/corrupt meta.json (e.g. interrupted write) — treat as absent so
    // the script falls through to its normal "no usable cert state" branches
    // instead of crashing `npm start` before the server can even boot HTTP.
    return null;
  }
}

function certExpiresAt() {
  if (!existsSync(CERT_PATH)) return null;
  const out = execFileSync('openssl', ['x509', '-in', CERT_PATH, '-noout', '-enddate']).toString();
  const match = out.match(/notAfter=(.+)/);
  return match ? new Date(match[1]) : null;
}

function daysUntil(date) {
  return (date.getTime() - Date.now()) / 86400000;
}

function shouldRegenTailscale(hostname) {
  if (FORCE) return true;
  // hasTailscaleCert covers BOTH file presence AND PEM parseability — so a
  // half-written cert from an interrupted prior run regenerates instead of
  // being preserved (the file would be present but createSecureContext would
  // throw at server boot).
  if (!hasTailscaleCert(CERT_DIR)) return true;
  const meta = readMeta();
  if (!meta || meta.mode !== 'tailscale' || meta.hostname !== hostname) return true;
  const expiry = certExpiresAt();
  if (!expiry) return true;
  // Renew when <30 days remain (LE issues 90-day certs; tailscale cert no-ops
  // when >1/3 lifetime remains, so we lean on the CLI's own cache window)
  return daysUntil(expiry) < 30;
}

function shouldRegenSelfSigned(ips) {
  if (FORCE) return true;
  if (!hasTailscaleCert(CERT_DIR)) return true;
  const meta = readMeta();
  if (!meta || meta.mode !== 'self-signed') return true;
  const prev = (meta.ips || []).slice().sort().join(',');
  const curr = ips.slice().sort().join(',');
  return prev !== curr;
}

// ---- Main ----------------------------------------------------------------

function trySelfSigned() {
  const ips = detectIPs();
  if (shouldRegenSelfSigned(ips)) {
    generateSelfSigned(ips);
  } else {
    console.log(`🔒 Self-signed cert still valid for ${ips.join(', ')} (use --force to regenerate)`);
  }
}

// Implicit fallback gate. Decides what to do (and what to tell the user) when
// the Tailscale provisioning path didn't run / failed. Three cases — picked by
// what's actually on disk, because `server/lib/tailscale-https.js` boots HTTPS
// purely on cert+key file presence (not on meta.mode):
//   1. Self-signed cert on disk → renewal path (regenerate on IP changes).
//   2. Tailscale (or unknown-mode) cert on disk → keep the existing cert in
//      place; the server will still boot HTTPS. We deliberately don't silently
//      flip cert types or delete the user's files. Tell the user accurately.
//   3. No cert files at all → server boots HTTP. Print HTTPS opt-in guidance.
// Case 2 is what stops the "Tailscale was broken since last run, but cert
// files are stale on disk and the server still serves TLS" surprise.
function maybeFallbackSelfSigned() {
  const meta = readMeta();
  const hasCert = hasTailscaleCert(CERT_DIR);

  // Files exist but are unparseable (interrupted provisioning). hasTailscaleCert
  // already returned false, so the server will boot HTTP — but the user has
  // cert files on disk wondering why HTTPS isn't active. Tell them explicitly.
  if (!hasCert && existsSync(CERT_PATH) && existsSync(KEY_PATH)) {
    console.log(`⚠️  data/certs/{cert,key}.pem present but unreadable — server will boot HTTP-only.`);
    console.log(`   To recover: \`npm run setup:cert -- --self-signed\` to regenerate, or delete the files to revert.`);
    return;
  }

  if (hasCert && meta?.mode === 'self-signed') {
    trySelfSigned();
    return;
  }

  if (hasCert) {
    const modeLabel = meta?.mode ? `existing ${meta.mode} cert` : 'existing cert';
    console.log(`ℹ️  Keeping ${modeLabel} at data/certs/{cert,key}.pem — server will boot HTTPS on :5555.`);
    if (meta?.mode === 'tailscale') {
      console.log(`   To refresh the LE cert, fix Tailscale and re-run \`npm run setup:cert\`.`);
    }
    console.log(`   To revert to HTTP-only, delete data/certs/{cert,key}.pem and restart.`);
    return;
  }

  console.log(`ℹ️  Staying HTTP-only on :5555 (no Tailscale cert provisioned).`);
  console.log(`   To enable HTTPS (required for in-browser mic), choose one:`);
  console.log(`     • Install Tailscale + enable HTTPS in the tailnet admin, then \`npm run setup:cert\``);
  console.log(`     • Generate a self-signed cert (browser warning): \`npm run setup:cert -- --self-signed\``);
}

if (SELF_SIGNED_ONLY) {
  trySelfSigned();
  process.exit(0);
}

const bin = findTailscale();
if (!bin) {
  console.log(`ℹ️  Tailscale CLI not found.`);
  maybeFallbackSelfSigned();
  process.exit(0);
}

let status;
try {
  status = tailscaleStatus(bin);
} catch (err) {
  console.log(`ℹ️  tailscale status failed (${err.message}).`);
  maybeFallbackSelfSigned();
  process.exit(0);
}

const hostname = tailscaleHostname(status);
if (!hostname || status.BackendState !== 'Running') {
  console.log(`ℹ️  Tailscale not running or no DNSName.`);
  maybeFallbackSelfSigned();
  process.exit(0);
}

if (!shouldRegenTailscale(hostname)) {
  const expiry = certExpiresAt();
  const days = expiry ? Math.floor(daysUntil(expiry)) : '?';
  console.log(`🔒 Tailscale cert for ${hostname} still valid (${days}d remaining)`);
  process.exit(0);
}

console.log(`🔒 Fetching Let's Encrypt cert for ${hostname} via Tailscale...`);
try {
  runTailscaleCert(bin, hostname);
} catch (err) {
  console.log(`⚠️  tailscale cert failed (${err.message}).`);
  console.log(`   (Common cause: HTTPS Certificates not enabled in the tailnet admin console at login.tailscale.com/admin/dns)`);
  maybeFallbackSelfSigned();
  process.exit(0);
}

if (!existsSync(CERT_PATH) || !existsSync(KEY_PATH)) {
  console.log(`⚠️  tailscale cert returned success but files missing.`);
  maybeFallbackSelfSigned();
  process.exit(0);
}

const expiry = certExpiresAt();
writeFileSync(META_PATH, JSON.stringify({
  mode: 'tailscale',
  hostname,
  issuedAt: new Date().toISOString(),
  expiresAt: expiry?.toISOString() ?? null,
  certMtime: statSync(CERT_PATH).mtimeMs
}, null, 2));
console.log(`✅ Tailscale cert installed for ${hostname} (expires ${expiry?.toISOString() ?? 'unknown'})`);
