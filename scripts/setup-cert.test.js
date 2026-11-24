import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { X509Certificate } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  runSetupCert,
  createContext,
  shouldRegenTailscale,
  shouldRegenSelfSigned,
  maybeFallbackSelfSigned
} from './setup-cert.js';

const HOST = 'box.tailnet-example.ts.net';
const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'setup-cert-fixtures-'));
const fixtures = {};

// Real X.509 pairs with controlled validity (EC keys keep generation fast).
function makeFixture(name, days) {
  const key = join(FIXTURE_ROOT, `${name}.key.pem`);
  const cert = join(FIXTURE_ROOT, `${name}.cert.pem`);
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', key, '-out', cert, '-days', String(days), '-subj', '/CN=fixture'
  ], { stdio: 'ignore' });
  fixtures[name] = { key: readFileSync(key), cert: readFileSync(cert) };
}

beforeAll(() => {
  makeFixture('long', 90);
  makeFixture('short', 10);
});
afterAll(() => rmSync(FIXTURE_ROOT, { recursive: true, force: true }));

let dataDir;
let certDir;
let logs;
let calls;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'setup-cert-data-'));
  certDir = join(dataDir, 'certs');
  logs = [];
  calls = [];
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const writePair = (fixture, meta) => {
  mkdirSync(certDir, { recursive: true });
  writeFileSync(join(certDir, 'cert.pem'), fixture.cert);
  writeFileSync(join(certDir, 'key.pem'), fixture.key);
  if (meta) writeFileSync(join(certDir, 'meta.json'), JSON.stringify(meta));
};
const readMetaFile = () => JSON.parse(readFileSync(join(certDir, 'meta.json'), 'utf-8'));
const output = () => logs.join('\n');

const tailscaleStatus = (overrides = {}) =>
  Buffer.from(JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${HOST}.` }, ...overrides }));

// Stubbed Tailscale + OpenSSL executors. `certFixture` is what `tailscale cert`
// "issues"; `tsCertFails` simulates a tailnet without HTTPS enabled.
function makeDeps({ ts = true, status = tailscaleStatus(), statusFails = false, tsCertFails = false, certFixture = 'long', sandboxed = false, ips = ['192.0.2.10'] } = {}) {
  return {
    log: (m) => logs.push(m),
    hasOnlySandboxedTailscale: () => sandboxed,
    findTailscale: () => (ts ? '/fake/tailscale' : null),
    networkInterfaces: () => ({ en0: ips.map((address) => ({ family: 'IPv4', internal: false, address })) }),
    execFileSync: (bin, args) => {
      calls.push([bin, ...args]);
      if (bin === 'openssl') {
        writeFileSync(args[args.indexOf('-keyout') + 1], fixtures.long.key);
        writeFileSync(args[args.indexOf('-out') + 1], fixtures.long.cert);
        return Buffer.alloc(0);
      }
      if (args[0] === 'status') {
        if (statusFails) throw new Error('daemon down');
        return status;
      }
      if (args[0] === 'cert') {
        if (tsCertFails) throw new Error('cert denied');
        const val = (prefix) => args.find((a) => a.startsWith(prefix)).slice(prefix.length);
        writeFileSync(val('--cert-file='), fixtures[certFixture].cert);
        writeFileSync(val('--key-file='), fixtures[certFixture].key);
        return Buffer.alloc(0);
      }
      throw new Error(`unexpected exec ${bin}`);
    }
  };
}

const run = (argv, depOpts) => runSetupCert({ dataDir, argv: ['node', 'setup-cert.js', ...argv], deps: makeDeps(depOpts) });
const opensslCalls = () => calls.filter((c) => c[0] === 'openssl');
const tsCertCalls = () => calls.filter((c) => c[1] === 'cert');

describe('runSetupCert: fresh install', () => {
  it('stays HTTP-only when Tailscale is absent and --self-signed is not passed', () => {
    run([], { ts: false });
    expect(existsSync(join(certDir, 'cert.pem'))).toBe(false);
    expect(opensslCalls()).toHaveLength(0);
    expect(output()).toContain('Staying HTTP-only');
  });

  it('stays HTTP-only when Tailscale reports a non-running backend', () => {
    run([], { status: tailscaleStatus({ BackendState: 'Stopped' }) });
    expect(existsSync(join(certDir, 'cert.pem'))).toBe(false);
    expect(output()).toContain('Staying HTTP-only');
  });

  it('stays HTTP-only when tailscale status fails', () => {
    run([], { statusFails: true });
    expect(output()).toContain('tailscale status failed');
    expect(output()).toContain('Staying HTTP-only');
  });
});

describe('runSetupCert: --self-signed', () => {
  it('generates a self-signed cert and records the detected IPs', () => {
    run(['--self-signed']);
    expect(opensslCalls()).toHaveLength(1);
    expect(tsCertCalls()).toHaveLength(0);
    expect(existsSync(join(certDir, 'cert.pem'))).toBe(true);
    expect(readMetaFile()).toMatchObject({ mode: 'self-signed', ips: ['127.0.0.1', '192.0.2.10'] });
  });

  it('skips regeneration when the IP set is unchanged', () => {
    run(['--self-signed']);
    calls.length = 0;
    run(['--self-signed']);
    expect(opensslCalls()).toHaveLength(0);
    expect(output()).toContain('still valid');
  });

  it('regenerates when the IP set rotates', () => {
    run(['--self-signed']);
    calls.length = 0;
    run(['--self-signed'], { ips: ['192.0.2.77'] });
    expect(opensslCalls()).toHaveLength(1);
    expect(readMetaFile().ips).toEqual(['127.0.0.1', '192.0.2.77']);
  });

  it('regenerates with --force even when nothing changed', () => {
    run(['--self-signed']);
    calls.length = 0;
    run(['--self-signed', '--force']);
    expect(opensslCalls()).toHaveLength(1);
  });

  it('leaves no staging directory behind', () => {
    run(['--self-signed']);
    const stray = (execFileSync('ls', ['-a', certDir]).toString()).split('\n').filter((n) => n.startsWith('.stage-'));
    expect(stray).toEqual([]);
  });
});

describe('runSetupCert: Tailscale provisioning', () => {
  it('provisions a cert and writes meta.json with expiresAt', () => {
    run([]);
    expect(tsCertCalls()).toHaveLength(1);
    const meta = readMetaFile();
    expect(meta).toMatchObject({ mode: 'tailscale', hostname: HOST });
    const expected = new Date(new X509Certificate(fixtures.long.cert).validTo).toISOString();
    expect(meta.expiresAt).toBe(expected);
    expect(output()).toContain('Tailscale cert installed');
  });

  it('skips regeneration when at least 30 days remain', () => {
    writePair(fixtures.long, { mode: 'tailscale', hostname: HOST });
    run([]);
    expect(tsCertCalls()).toHaveLength(0);
    expect(output()).toContain('still valid');
  });

  it('regenerates when fewer than 30 days remain', () => {
    writePair(fixtures.short, { mode: 'tailscale', hostname: HOST });
    run([]);
    expect(tsCertCalls()).toHaveLength(1);
    expect(readFileSync(join(certDir, 'cert.pem'))).toEqual(fixtures.long.cert);
  });

  it('regenerates when the hostname changed', () => {
    writePair(fixtures.long, { mode: 'tailscale', hostname: 'old.tailnet-example.ts.net' });
    run([]);
    expect(tsCertCalls()).toHaveLength(1);
    expect(readMetaFile().hostname).toBe(HOST);
  });

  it('regenerates when the cert PEM is corrupt', () => {
    writePair({ cert: Buffer.from('not a cert'), key: Buffer.from('not a key') }, { mode: 'tailscale', hostname: HOST });
    run([]);
    expect(tsCertCalls()).toHaveLength(1);
    expect(readFileSync(join(certDir, 'cert.pem'))).toEqual(fixtures.long.cert);
  });

  it('regenerates with --force', () => {
    writePair(fixtures.long, { mode: 'tailscale', hostname: HOST });
    run(['--force']);
    expect(tsCertCalls()).toHaveLength(1);
  });

  it('preserves an existing valid Tailscale cert when `tailscale cert` fails', () => {
    writePair(fixtures.short, { mode: 'tailscale', hostname: HOST });
    run([], { tsCertFails: true });
    expect(readFileSync(join(certDir, 'cert.pem'))).toEqual(fixtures.short.cert);
    expect(readMetaFile().mode).toBe('tailscale');
    expect(opensslCalls()).toHaveLength(0);
    expect(output()).toContain('Keeping existing tailscale cert');
  });

  it('preserves the existing cert and explains when only sandboxed Tailscale is installed', () => {
    writePair(fixtures.long, { mode: 'tailscale', hostname: HOST });
    run([], { sandboxed: true });
    expect(tsCertCalls()).toHaveLength(0);
    expect(opensslCalls()).toHaveLength(0);
    expect(output()).toContain('sandboxed Tailscale.app');
    expect(output()).toContain('Keeping existing tailscale cert');
  });
});

describe('shouldRegenTailscale / shouldRegenSelfSigned', () => {
  const ctxFor = (argv = []) => createContext({ dataDir, argv, deps: makeDeps() });

  it('keeps a tailscale cert with 90 days left and regenerates one with 10', () => {
    writePair(fixtures.long, { mode: 'tailscale', hostname: HOST });
    expect(shouldRegenTailscale(ctxFor(), HOST)).toBe(false);
    writePair(fixtures.short, { mode: 'tailscale', hostname: HOST });
    expect(shouldRegenTailscale(ctxFor(), HOST)).toBe(true);
  });

  it('regenerates a tailscale cert whose meta mode is not tailscale or is corrupt', () => {
    writePair(fixtures.long, { mode: 'self-signed' });
    expect(shouldRegenTailscale(ctxFor(), HOST)).toBe(true);
    writeFileSync(join(certDir, 'meta.json'), '{ truncated');
    expect(shouldRegenTailscale(ctxFor(), HOST)).toBe(true);
  });

  it('compares IP sets order-insensitively', () => {
    writePair(fixtures.long, { mode: 'self-signed', ips: ['192.0.2.10', '127.0.0.1'] });
    expect(shouldRegenSelfSigned(ctxFor(), ['127.0.0.1', '192.0.2.10'])).toBe(false);
    expect(shouldRegenSelfSigned(ctxFor(), ['127.0.0.1'])).toBe(true);
    expect(shouldRegenSelfSigned(ctxFor(['--force']), ['127.0.0.1', '192.0.2.10'])).toBe(true);
  });

  it('regenerates self-signed when the existing cert is tailscale-mode or absent', () => {
    expect(shouldRegenSelfSigned(ctxFor(), ['127.0.0.1'])).toBe(true);
    writePair(fixtures.long, { mode: 'tailscale', hostname: HOST });
    expect(shouldRegenSelfSigned(ctxFor(), ['127.0.0.1'])).toBe(true);
  });
});

describe('maybeFallbackSelfSigned', () => {
  const ctxFor = (depOpts) => createContext({ dataDir, argv: [], deps: makeDeps(depOpts) });

  it('keeps a valid tailscale cert untouched and points at the fix', () => {
    writePair(fixtures.long, { mode: 'tailscale', hostname: HOST });
    maybeFallbackSelfSigned(ctxFor());
    expect(opensslCalls()).toHaveLength(0);
    expect(readMetaFile().mode).toBe('tailscale');
    expect(output()).toContain('fix Tailscale');
  });

  it('keeps a cert with no meta.json', () => {
    writePair(fixtures.long);
    maybeFallbackSelfSigned(ctxFor());
    expect(opensslCalls()).toHaveLength(0);
    expect(output()).toContain('Keeping existing cert');
  });

  it('renews an existing self-signed cert whose IPs changed', () => {
    writePair(fixtures.long, { mode: 'self-signed', ips: ['127.0.0.1'] });
    maybeFallbackSelfSigned(ctxFor());
    expect(opensslCalls()).toHaveLength(1);
    expect(readMetaFile().ips).toEqual(['127.0.0.1', '192.0.2.10']);
  });

  it('reports corrupt cert+key files without deleting them', () => {
    writePair({ cert: Buffer.from('junk'), key: Buffer.from('junk') }, { mode: 'tailscale', hostname: HOST });
    maybeFallbackSelfSigned(ctxFor());
    expect(output()).toContain('present but unreadable');
    expect(readFileSync(join(certDir, 'cert.pem'), 'utf-8')).toBe('junk');
    expect(readFileSync(join(certDir, 'key.pem'), 'utf-8')).toBe('junk');
    expect(opensslCalls()).toHaveLength(0);
  });

  it('prints HTTP-only guidance when no cert files exist', () => {
    maybeFallbackSelfSigned(ctxFor());
    expect(output()).toContain('Staying HTTP-only');
  });
});
