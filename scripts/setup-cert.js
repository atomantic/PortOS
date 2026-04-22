#!/usr/bin/env node
/**
 * Provisions a TLS cert for PortOS at data/certs/{cert,key}.pem.
 *
 * Prefers a real Let's Encrypt cert via `tailscale cert` (browsers trust it,
 * no click-through). Falls back to a self-signed cert covering localhost +
 * every non-internal IPv4 on the host (including the Tailscale IP) when
 * Tailscale HTTPS isn't available.
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CERT_DIR = join(ROOT, 'data', 'certs');
const KEY_PATH = join(CERT_DIR, 'key.pem');
const CERT_PATH = join(CERT_DIR, 'cert.pem');
const META_PATH = join(CERT_DIR, 'meta.json');

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
  return JSON.parse(readFileSync(META_PATH, 'utf-8'));
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
  if (!existsSync(CERT_PATH) || !existsSync(KEY_PATH)) return true;
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
  if (!existsSync(CERT_PATH) || !existsSync(KEY_PATH)) return true;
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

if (SELF_SIGNED_ONLY) {
  trySelfSigned();
  process.exit(0);
}

const bin = findTailscale();
if (!bin) {
  console.log(`ℹ️  Tailscale CLI not found — falling back to self-signed cert.`);
  trySelfSigned();
  process.exit(0);
}

let status;
try {
  status = tailscaleStatus(bin);
} catch (err) {
  console.log(`ℹ️  tailscale status failed (${err.message}) — falling back to self-signed cert.`);
  trySelfSigned();
  process.exit(0);
}

const hostname = tailscaleHostname(status);
if (!hostname || status.BackendState !== 'Running') {
  console.log(`ℹ️  Tailscale not running or no DNSName — falling back to self-signed cert.`);
  trySelfSigned();
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
  console.log(`⚠️  tailscale cert failed (${err.message}) — falling back to self-signed cert.`);
  console.log(`   (Common cause: HTTPS Certificates not enabled in the tailnet admin console at login.tailscale.com/admin/dns)`);
  trySelfSigned();
  process.exit(0);
}

if (!existsSync(CERT_PATH) || !existsSync(KEY_PATH)) {
  console.log(`⚠️  tailscale cert returned success but files missing — falling back to self-signed.`);
  trySelfSigned();
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
