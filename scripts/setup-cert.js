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
 * Exports `runSetupCert({ dataDir, argv, deps })` plus the decision helpers so the
 * regeneration/fallback matrix is testable; the CLI only runs when invoked directly.
 *
 * Flags:
 *   --force          regenerate even if meta says nothing changed
 *   --self-signed    skip Tailscale attempt and go straight to self-signed
 */
import { execFileSync } from 'child_process';
import { createSecureContext } from 'tls';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, statSync } from 'fs';
import { networkInterfaces } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { findTailscale, hasOnlySandboxedTailscale } from '../server/lib/tailscale.js';
import { hasTailscaleCert } from '../lib/tailscale-https.js';
import { certPaths } from '../lib/certPaths.js';
import { readCertExpiresAt } from '../lib/certMeta.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const DEFAULT_DEPS = {
  execFileSync,
  networkInterfaces,
  findTailscale,
  hasOnlySandboxedTailscale,
  now: () => Date.now(),
  log: (msg) => console.log(msg)
};

/**
 * Bundle paths, flags and injectable side-effect seams. Tests stub `deps`
 * (Tailscale/OpenSSL executors, interface list, clock) and point `dataDir` at a
 * temp directory; the CLI uses the defaults.
 */
export function createContext({ dataDir = join(ROOT, 'data'), argv = process.argv, deps = {} } = {}) {
  const { dir, cert, key, meta } = certPaths(dataDir);
  return {
    certDir: dir,
    certPath: cert,
    keyPath: key,
    metaPath: meta,
    force: argv.includes('--force'),
    selfSignedOnly: argv.includes('--self-signed'),
    deps: { ...DEFAULT_DEPS, ...deps }
  };
}

function tailscaleStatus(ctx, bin) {
  const out = ctx.deps.execFileSync(bin, ['status', '--json'], { stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(out.toString());
}

function tailscaleHostname(status) {
  const raw = status?.Self?.DNSName;
  if (!raw) return null;
  return raw.replace(/\.$/, '');
}

function runTailscaleCert(ctx, bin, hostname) {
  mkdirSync(ctx.certDir, { recursive: true });
  ctx.deps.execFileSync(bin, [
    'cert',
    `--cert-file=${ctx.certPath}`,
    `--key-file=${ctx.keyPath}`,
    hostname
  ], { stdio: 'inherit' });
}

// ---- Self-signed path ----------------------------------------------------

function detectIPs(ctx) {
  const ips = new Set(['127.0.0.1']);
  const nets = ctx.deps.networkInterfaces();
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

function generateSelfSigned(ctx, ips) {
  mkdirSync(ctx.certDir, { recursive: true });

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

  // Stage everything (including openssl.cnf) in a sibling temp dir so an
  // interrupted run never leaves a truncated key/cert at the live paths.
  const stage = mkdtempSync(join(ctx.certDir, '.stage-'));
  try {
    const cnfPath = join(stage, 'openssl.cnf');
    const stagedKey = join(stage, 'key.pem');
    const stagedCert = join(stage, 'cert.pem');
    const stagedMeta = join(stage, 'meta.json');
    writeFileSync(cnfPath, cnf);

    ctx.deps.execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', stagedKey,
      '-out', stagedCert,
      '-days', '3650',
      '-config', cnfPath,
      '-extensions', 'v3_req'
    ], { stdio: ['ignore', 'ignore', 'inherit'] });
    chmodSync(stagedKey, 0o600);

    // Throws on an unparseable or mismatched pair, before anything goes live.
    createSecureContext({ cert: readFileSync(stagedCert), key: readFileSync(stagedKey) });

    writeFileSync(stagedMeta, JSON.stringify({
      mode: 'self-signed',
      ips,
      generatedAt: new Date(ctx.deps.now()).toISOString()
    }, null, 2));

    // Same-filesystem renames; meta last so it only ever describes a live pair.
    renameSync(stagedKey, ctx.keyPath);
    renameSync(stagedCert, ctx.certPath);
    renameSync(stagedMeta, ctx.metaPath);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  ctx.deps.log(`🔒 Generated self-signed cert for ${ips.join(', ')}`);
}

// ---- Regeneration logic --------------------------------------------------

function readMeta(ctx) {
  if (!existsSync(ctx.metaPath)) return null;
  try {
    return JSON.parse(readFileSync(ctx.metaPath, 'utf-8'));
  } catch {
    // Partial/corrupt meta.json (e.g. interrupted write) — treat as absent so
    // the script falls through to its normal "no usable cert state" branches
    // instead of crashing `npm start` before the server can even boot HTTP.
    return null;
  }
}

function certExpiresAt(ctx) {
  const iso = readCertExpiresAt(ctx.certPath);
  return iso ? new Date(iso) : null;
}

function daysUntil(ctx, date) {
  return (date.getTime() - ctx.deps.now()) / 86400000;
}

export function shouldRegenTailscale(ctx, hostname) {
  if (ctx.force) return true;
  // hasTailscaleCert covers BOTH file presence AND PEM parseability — so a
  // half-written cert from an interrupted prior run regenerates instead of
  // being preserved (the file would be present but createSecureContext would
  // throw at server boot).
  if (!hasTailscaleCert(ctx.certDir)) return true;
  const meta = readMeta(ctx);
  if (!meta || meta.mode !== 'tailscale' || meta.hostname !== hostname) return true;
  const expiry = certExpiresAt(ctx);
  if (!expiry) return true;
  // Renew when <30 days remain (LE issues 90-day certs; tailscale cert no-ops
  // when >1/3 lifetime remains, so we lean on the CLI's own cache window)
  return daysUntil(ctx, expiry) < 30;
}

export function shouldRegenSelfSigned(ctx, ips) {
  if (ctx.force) return true;
  if (!hasTailscaleCert(ctx.certDir)) return true;
  const meta = readMeta(ctx);
  if (!meta || meta.mode !== 'self-signed') return true;
  const prev = (meta.ips || []).slice().sort().join(',');
  const curr = ips.slice().sort().join(',');
  return prev !== curr;
}

// ---- Main ----------------------------------------------------------------

function trySelfSigned(ctx) {
  const ips = detectIPs(ctx);
  if (shouldRegenSelfSigned(ctx, ips)) {
    generateSelfSigned(ctx, ips);
  } else {
    ctx.deps.log(`🔒 Self-signed cert still valid for ${ips.join(', ')} (use --force to regenerate)`);
  }
}

// Implicit fallback gate. Decides what to do (and what to tell the user) when
// the Tailscale provisioning path didn't run / failed. Three cases — picked by
// what's actually on disk, because `lib/tailscale-https.js` boots HTTPS
// purely on cert+key file presence (not on meta.mode):
//   1. Self-signed cert on disk → renewal path (regenerate on IP changes).
//   2. Tailscale (or unknown-mode) cert on disk → keep the existing cert in
//      place; the server will still boot HTTPS. We deliberately don't silently
//      flip cert types or delete the user's files. Tell the user accurately.
//   3. No cert files at all → server boots HTTP. Print HTTPS opt-in guidance.
// Case 2 is what stops the "Tailscale was broken since last run, but cert
// files are stale on disk and the server still serves TLS" surprise.
export function maybeFallbackSelfSigned(ctx) {
  const { log } = ctx.deps;
  const meta = readMeta(ctx);
  const hasCert = hasTailscaleCert(ctx.certDir);

  // Files exist but are unparseable (interrupted provisioning). hasTailscaleCert
  // already returned false, so the server will boot HTTP — but the user has
  // cert files on disk wondering why HTTPS isn't active. Tell them explicitly.
  if (!hasCert && existsSync(ctx.certPath) && existsSync(ctx.keyPath)) {
    log(`⚠️  data/certs/{cert,key}.pem present but unreadable — server will boot HTTP-only.`);
    log(`   To recover: \`npm run setup:cert -- --self-signed\` to regenerate, or delete the files to revert.`);
    return;
  }

  if (hasCert && meta?.mode === 'self-signed') {
    trySelfSigned(ctx);
    return;
  }

  if (hasCert) {
    const modeLabel = meta?.mode ? `existing ${meta.mode} cert` : 'existing cert';
    log(`ℹ️  Keeping ${modeLabel} at data/certs/{cert,key}.pem — server will boot HTTPS on :5555.`);
    if (meta?.mode === 'tailscale') {
      log(`   To refresh the LE cert, fix Tailscale and re-run \`npm run setup:cert\`.`);
    }
    log(`   To revert to HTTP-only, delete data/certs/{cert,key}.pem and restart.`);
    return;
  }

  log(`ℹ️  Staying HTTP-only on :5555 (no Tailscale cert provisioned).`);
  log(`   To enable HTTPS (required for in-browser mic), choose one:`);
  log(`     • Install Tailscale + enable HTTPS in the tailnet admin, then \`npm run setup:cert\``);
  log(`     • Generate a self-signed cert (browser warning): \`npm run setup:cert -- --self-signed\``);
}

/**
 * Provision the cert for `dataDir`. Always resolves without calling
 * process.exit; every "nothing more to do" path is an early return.
 */
export function runSetupCert(options = {}) {
  const ctx = createContext(options);
  const { log } = ctx.deps;

  if (ctx.selfSignedOnly) {
    trySelfSigned(ctx);
    return;
  }

  if (ctx.deps.hasOnlySandboxedTailscale()) {
    log(`⚠️  Only the sandboxed Tailscale.app CLI is installed.`);
    log(`   It can't write the LE cert to data/certs/ ("operation not permitted").`);
    log(`   Install the unsandboxed CLI:  brew install tailscale`);
    log(`   Then re-run:                  npm run setup:cert`);
    maybeFallbackSelfSigned(ctx);
    return;
  }

  const bin = ctx.deps.findTailscale();
  if (!bin) {
    log(`ℹ️  Tailscale CLI not found.`);
    maybeFallbackSelfSigned(ctx);
    return;
  }

  let status;
  try {
    status = tailscaleStatus(ctx, bin);
  } catch (err) {
    log(`ℹ️  tailscale status failed (${err.message}).`);
    maybeFallbackSelfSigned(ctx);
    return;
  }

  const hostname = tailscaleHostname(status);
  if (!hostname || status.BackendState !== 'Running') {
    log(`ℹ️  Tailscale not running or no DNSName.`);
    maybeFallbackSelfSigned(ctx);
    return;
  }

  if (!shouldRegenTailscale(ctx, hostname)) {
    const expiry = certExpiresAt(ctx);
    const days = expiry ? Math.floor(daysUntil(ctx, expiry)) : '?';
    log(`🔒 Tailscale cert for ${hostname} still valid (${days}d remaining)`);
    return;
  }

  log(`🔒 Fetching Let's Encrypt cert for ${hostname} via Tailscale...`);
  try {
    runTailscaleCert(ctx, bin, hostname);
  } catch (err) {
    log(`⚠️  tailscale cert failed (${err.message}).`);
    log(`   (Common cause: HTTPS Certificates not enabled in the tailnet admin console at login.tailscale.com/admin/dns)`);
    maybeFallbackSelfSigned(ctx);
    return;
  }

  if (!existsSync(ctx.certPath) || !existsSync(ctx.keyPath)) {
    log(`⚠️  tailscale cert returned success but files missing.`);
    maybeFallbackSelfSigned(ctx);
    return;
  }

  const expiry = certExpiresAt(ctx);
  const metaTmp = `${ctx.metaPath}.${process.pid}.tmp`;
  writeFileSync(metaTmp, JSON.stringify({
    mode: 'tailscale',
    hostname,
    issuedAt: new Date(ctx.deps.now()).toISOString(),
    expiresAt: expiry?.toISOString() ?? null,
    certMtime: statSync(ctx.certPath).mtimeMs
  }, null, 2));
  renameSync(metaTmp, ctx.metaPath);
  log(`✅ Tailscale cert installed for ${hostname} (expires ${expiry?.toISOString() ?? 'unknown'})`);
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  runSetupCert();
}
