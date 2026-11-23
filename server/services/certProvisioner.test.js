import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

const { tempRoot } = await vi.hoisted(async () => {
  const { createTempDataRoot } = await import('../lib/mockPathsDataRoot.js');
  return { tempRoot: createTempDataRoot('portos-cert-provisioner-') };
});

// certProvisioner derives its cert paths from PATHS.data at module load, so the
// temp root must exist before the import and stay fixed for the whole file.
vi.mock('../lib/fileUtils.js', async () =>
  makePathsProxy(await vi.importActual('../lib/fileUtils.js'), { dataRoot: () => tempRoot }));

const { execFile, findTailscale, isSandboxedTailscale, getHttpsEnabledAtBoot } = vi.hoisted(() => ({
  execFile: vi.fn(),
  findTailscale: vi.fn(),
  isSandboxedTailscale: vi.fn(),
  getHttpsEnabledAtBoot: vi.fn(),
}));
vi.mock('../lib/childProcess.js', () => ({ execFile }));
vi.mock('../lib/tailscale.js', () => ({ findTailscale, isSandboxedTailscale }));
vi.mock('../lib/httpsState.js', () => ({ getHttpsEnabledAtBoot }));

import { provisionTailscaleCert } from './certProvisioner.js';

const CERT_DIR = join(tempRoot, 'certs');
const CERT = join(CERT_DIR, 'cert.pem');
const KEY = join(CERT_DIR, 'key.pem');
const META = join(CERT_DIR, 'meta.json');

const runningStatus = (dns = 'host.example.ts.net.') =>
  JSON.stringify({ BackendState: 'Running', Self: { DNSName: dns } });

// Routes the two CLI invocations; `cert` may write the files like the real CLI.
const stubCli = ({ status, cert }) => {
  execFile.mockImplementation((bin, args, opts, cb) => {
    if (args[0] === 'status') {
      if (status instanceof Error) return cb(status);
      return cb(null, { stdout: status });
    }
    if (cert instanceof Error) return cb(cert);
    cert?.();
    return cb(null, { stdout: '' });
  });
};
const writeCertFiles = (mtimeSec) => () => {
  mkdirSync(CERT_DIR, { recursive: true });
  writeFileSync(CERT, 'cert');
  writeFileSync(KEY, 'key');
  utimesSync(CERT, mtimeSec, mtimeSec);
};

beforeEach(() => {
  vi.clearAllMocks();
  rmSync(CERT_DIR, { recursive: true, force: true });
  findTailscale.mockReturnValue('/usr/local/bin/tailscale');
  isSandboxedTailscale.mockReturnValue(false);
  getHttpsEnabledAtBoot.mockReturnValue({ value: false, initialized: true });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

describe('provisionTailscaleCert failure reasons', () => {
  it('tailscale-not-installed when no CLI is found', async () => {
    findTailscale.mockReturnValue(null);
    expect(await provisionTailscaleCert()).toMatchObject({ ok: false, reason: 'tailscale-not-installed' });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('tailscale-status-failed when status exits non-zero or returns bad JSON', async () => {
    stubCli({ status: new Error('boom') });
    expect(await provisionTailscaleCert()).toMatchObject({
      ok: false, reason: 'tailscale-status-failed', message: 'tailscale status failed: boom',
    });
    stubCli({ status: 'not json' });
    expect((await provisionTailscaleCert()).reason).toBe('tailscale-status-failed');
  });

  it('tailscale-not-running reports the backend state', async () => {
    stubCli({ status: JSON.stringify({ BackendState: 'Stopped' }) });
    const result = await provisionTailscaleCert();
    expect(result).toMatchObject({ ok: false, reason: 'tailscale-not-running' });
    expect(result.message).toContain('Tailscale is Stopped');
  });

  it('no-magic-dns when Self.DNSName is empty or just a dot', async () => {
    stubCli({ status: runningStatus('.') });
    expect((await provisionTailscaleCert()).reason).toBe('no-magic-dns');
    stubCli({ status: JSON.stringify({ BackendState: 'Running' }) });
    expect((await provisionTailscaleCert()).reason).toBe('no-magic-dns');
  });

  it('tailscale-sandboxed only for a sandboxed CLI with "operation not permitted"', async () => {
    isSandboxedTailscale.mockReturnValue(true);
    stubCli({ status: runningStatus(), cert: Object.assign(new Error('x'), { stderr: 'open: Operation not permitted' }) });
    const result = await provisionTailscaleCert();
    expect(result.reason).toBe('tailscale-sandboxed');
    expect(result.message).toContain('brew install tailscale');

    isSandboxedTailscale.mockReturnValue(false);
    expect((await provisionTailscaleCert()).reason).toBe('tailscale-cert-failed');
  });

  it('tailscale-cert-failed adds the HTTPS-not-enabled hint and normalizes the period', async () => {
    stubCli({ status: runningStatus(), cert: Object.assign(new Error('x'), { stderr: 'HTTPS is not enabled\nmore' }) });
    const result = await provisionTailscaleCert();
    expect(result.reason).toBe('tailscale-cert-failed');
    expect(result.message).toBe(
      'tailscale cert failed: HTTPS is not enabled. Enable "HTTPS Certificates" at login.tailscale.com/admin/dns and retry.'
    );
  });

  it('tailscale-cert-failed keeps existing terminal punctuation and omits the hint otherwise', async () => {
    stubCli({ status: runningStatus(), cert: Object.assign(new Error('x'), { stderr: 'rate limited!' }) });
    expect((await provisionTailscaleCert()).message).toBe('tailscale cert failed: rate limited!');
  });

  it('cert-files-missing when the CLI succeeds without writing files', async () => {
    stubCli({ status: runningStatus(), cert: () => {} });
    expect(await provisionTailscaleCert()).toMatchObject({ ok: false, reason: 'cert-files-missing' });
    expect(existsSync(META)).toBe(false);
  });
});

describe('provisionTailscaleCert success', () => {
  it('strips the trailing dot, passes cert/key paths, and persists meta.json', async () => {
    stubCli({ status: runningStatus(), cert: writeCertFiles(2_000_000) });
    const result = await provisionTailscaleCert();
    expect(result).toMatchObject({ ok: true, mode: 'tailscale', hostname: 'host.example.ts.net', wroteNew: true });
    const certCall = execFile.mock.calls.find(c => c[1][0] === 'cert');
    expect(certCall[1]).toEqual(['cert', `--cert-file=${CERT}`, `--key-file=${KEY}`, 'host.example.ts.net']);
    const meta = JSON.parse(readFileSync(META, 'utf8'));
    expect(meta).toMatchObject({ mode: 'tailscale', hostname: 'host.example.ts.net', certMtime: 2_000_000_000 });
    expect(Number.isNaN(Date.parse(meta.issuedAt))).toBe(false);
    expect(meta).toHaveProperty('expiresAt', null); // fixture cert is not a parseable PEM
  });

  it('wroteNew is false when the CLI leaves cert.pem untouched', async () => {
    writeCertFiles(2_000_000)();
    stubCli({ status: runningStatus(), cert: () => {} });
    expect((await provisionTailscaleCert()).wroteNew).toBe(false);
  });

  it('requiresRestart follows the boot-time HTTPS state on every run', async () => {
    stubCli({ status: runningStatus(), cert: writeCertFiles(2_000_000) });
    const first = await provisionTailscaleCert();
    const second = await provisionTailscaleCert();
    expect([first.requiresRestart, second.requiresRestart]).toEqual([true, true]);
    expect(first.message).toContain('Restart PortOS to enable HTTPS');

    getHttpsEnabledAtBoot.mockReturnValue({ value: true, initialized: true });
    const booted = await provisionTailscaleCert();
    expect(booted.requiresRestart).toBe(false);
    expect(booted.message).not.toContain('Restart PortOS');
  });
});
