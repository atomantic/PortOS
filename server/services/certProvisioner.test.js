import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { certExpiresAtFromPem } from '../../lib/certMeta.js';

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
const LIVE_FILES = [CERT, KEY, META];
const HOST = 'host.example.ts.net';
const PREVIOUS_ISSUANCE = '2025-01-01T00:00:00.000Z';

const runningStatus = (dns = `${HOST}.`) =>
  JSON.stringify({ BackendState: 'Running', Self: { DNSName: dns } });

// Routes the two CLI invocations; `cert` may write the files like the real CLI.
const stubCli = ({ status, cert }) => {
  execFile.mockImplementation((bin, args, opts, cb) => {
    if (args[0] === 'status') {
      if (status instanceof Error) return cb(status);
      return cb(null, { stdout: status });
    }
    const failure = typeof cert === 'function' ? cert(args) : cert;
    if (failure) return cb(failure);
    return cb(null, { stdout: '' });
  });
};

function makePair(name) {
  const key = join(tempRoot, `${name}.key.pem`);
  const cert = join(tempRoot, `${name}.cert.pem`);
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', key, '-out', cert, '-days', '30', '-subj', `/CN=${HOST}`
  ], { stdio: 'ignore' });
  return { cert: readFileSync(cert), key: readFileSync(key) };
}

let currentPair;
let replacement;
beforeAll(() => {
  currentPair = makePair('current');
  replacement = makePair('replacement');
});

function seedLivePair() {
  mkdirSync(CERT_DIR, { recursive: true });
  writeFileSync(CERT, currentPair.cert);
  writeFileSync(KEY, currentPair.key);
  writeFileSync(META, JSON.stringify({
    mode: 'tailscale',
    hostname: HOST,
    issuedAt: PREVIOUS_ISSUANCE,
    certMtime: statSync(CERT).mtimeMs,
    expiresAt: certExpiresAtFromPem(currentPair.cert)
  }));
}

function writeStaged(args, { cert, key }) {
  const [, certArg, keyArg] = args;
  const certPath = certArg.slice('--cert-file='.length);
  const keyPath = keyArg.slice('--key-file='.length);
  expect(dirname(certPath)).toBe(dirname(keyPath));
  expect(dirname(dirname(certPath))).toBe(CERT_DIR);
  if (cert) writeFileSync(certPath, cert);
  if (key) writeFileSync(keyPath, key);
}

const readLiveFiles = () => LIVE_FILES.map(path => readFileSync(path));
const expectNoStage = () => expect(readdirSync(CERT_DIR).sort()).toEqual(['cert.pem', 'key.pem', 'meta.json']);

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

  it.each([
    ['timeout after one write', () => ({ cert: replacement.cert }), new Error('timed out'), 'tailscale-cert-failed'],
    ['missing key', () => ({ cert: replacement.cert }), null, 'cert-files-missing'],
    ['missing cert', () => ({ key: replacement.key }), null, 'cert-files-missing'],
    ['mismatched pair', () => ({ cert: replacement.cert, key: currentPair.key }), null, 'tailscale-cert-failed'],
    ['empty key', () => ({ cert: replacement.cert, key: Buffer.alloc(0) }), null, 'tailscale-cert-failed'],
  ])('preserves the installed files after %s', async (_problem, stagedPair, failure, reason) => {
    seedLivePair();
    const before = readLiveFiles();
    stubCli({ status: runningStatus(), cert: args => {
      writeStaged(args, stagedPair());
      return failure;
    } });
    expect(await provisionTailscaleCert()).toMatchObject({ ok: false, reason });
    expect(readLiveFiles()).toEqual(before);
    expectNoStage();
  });
});

describe('provisionTailscaleCert success', () => {
  it('runs both bounded CLI stages and installs a validated replacement and metadata', async () => {
    seedLivePair();
    stubCli({ status: runningStatus(), cert: args => writeStaged(args, replacement) });
    const result = await provisionTailscaleCert();
    expect(result).toMatchObject({ ok: true, mode: 'tailscale', hostname: HOST, wroteNew: true });
    const [, statusArgs, statusOptions] = execFile.mock.calls[0];
    const [, certArgs, certOptions] = execFile.mock.calls[1];
    expect(statusArgs).toEqual(['status', '--json']);
    expect(statusOptions).toMatchObject({ timeout: 5000, killSignal: 'SIGKILL' });
    expect(certArgs[3]).toBe(HOST);
    expect(certOptions).toMatchObject({ timeout: 60_000, killSignal: 'SIGKILL' });
    expect(readFileSync(CERT)).toEqual(replacement.cert);
    expect(readFileSync(KEY)).toEqual(replacement.key);
    const meta = JSON.parse(readFileSync(META, 'utf8'));
    expect(meta).toMatchObject({
      mode: 'tailscale',
      hostname: HOST,
      certMtime: statSync(CERT).mtimeMs,
      expiresAt: certExpiresAtFromPem(replacement.cert)
    });
    expect(Number.isNaN(Date.parse(meta.issuedAt))).toBe(false);
    expect(meta.issuedAt).not.toBe(PREVIOUS_ISSUANCE);
    expectNoStage();
  });

  it('keeps a valid cached pair and its metadata untouched', async () => {
    seedLivePair();
    const before = readLiveFiles();
    const mtimes = LIVE_FILES.map(path => statSync(path).mtimeMs);
    stubCli({ status: runningStatus(), cert: args => writeStaged(args, currentPair) });
    expect(await provisionTailscaleCert()).toMatchObject({ ok: true, wroteNew: false });
    expect(readLiveFiles()).toEqual(before);
    expect(LIVE_FILES.map(path => statSync(path).mtimeMs)).toEqual(mtimes);
    expectNoStage();
  });

  it('treats concurrent requests for the same replacement as one change', async () => {
    seedLivePair();
    stubCli({ status: runningStatus(), cert: args => writeStaged(args, replacement) });
    const results = await Promise.all([provisionTailscaleCert(), provisionTailscaleCert()]);
    expect(results.map(result => result.wroteNew)).toEqual([true, false]);
    expect(readFileSync(CERT)).toEqual(replacement.cert);
    expect(readFileSync(KEY)).toEqual(replacement.key);
    expectNoStage();
  });

  it('requiresRestart follows the boot-time HTTPS state on every run', async () => {
    stubCli({ status: runningStatus(), cert: args => writeStaged(args, replacement) });
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
