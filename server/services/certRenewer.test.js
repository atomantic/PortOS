import { describe, it, expect, vi, beforeEach, afterEach, afterAll, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

const { tempRoot } = await vi.hoisted(async () => {
  const { createTempDataRoot } = await import('../lib/mockPathsDataRoot.js');
  return { tempRoot: createTempDataRoot('portos-cert-renewer-') };
});

vi.mock('../lib/fileUtils.js', async () =>
  makePathsProxy(await vi.importActual('../lib/fileUtils.js'), { dataRoot: () => tempRoot }));

const { execFile, findTailscale } = vi.hoisted(() => ({ execFile: vi.fn(), findTailscale: vi.fn() }));
vi.mock('../lib/childProcess.js', () => ({ execFile }));
vi.mock('../lib/tailscale.js', () => ({ findTailscale }));

import { initCertRenewer } from './certRenewer.js';

const CERT_DIR = join(tempRoot, 'certs');
const CERT = join(CERT_DIR, 'cert.pem');
const KEY = join(CERT_DIR, 'key.pem');
const META = join(CERT_DIR, 'meta.json');
const HOST = 'host.example.ts.net';
const oldMeta = { mode: 'tailscale', hostname: HOST, issuedAt: 'then' };
const expectedFiles = ['cert.pem', 'key.pem', 'meta.json'];

function makePair(name) {
  const key = join(tempRoot, `${name}.key.pem`);
  const cert = join(tempRoot, `${name}.cert.pem`);
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', key, '-out', cert, '-days', '30', '-subj', '/CN=fixture'
  ], { stdio: 'ignore' });
  return { cert: readFileSync(cert), key: readFileSync(key) };
}

let oldPair;
let newPair;
beforeAll(() => {
  oldPair = makePair('old');
  newPair = makePair('new');
});

function seed() {
  mkdirSync(CERT_DIR, { recursive: true });
  writeFileSync(CERT, oldPair.cert);
  writeFileSync(KEY, oldPair.key);
  writeFileSync(META, JSON.stringify(oldMeta));
}

function writeStaged(args, { cert, key }) {
  const [, certArg, keyArg] = args;
  if (cert) writeFileSync(certArg.slice('--cert-file='.length), cert);
  if (key) writeFileSync(keyArg.slice('--key-file='.length), key);
}

function readMeta() {
  return JSON.parse(readFileSync(META, 'utf8'));
}

async function runInitialRenewal() {
  const stop = initCertRenewer(server);
  await stop();
  expect(execFile).toHaveBeenCalledTimes(1);
  expect(readdirSync(CERT_DIR).sort()).toEqual(expectedFiles);
}

function expectOldPair() {
  expect(readFileSync(CERT)).toEqual(oldPair.cert);
  expect(readFileSync(KEY)).toEqual(oldPair.key);
  expect(readMeta()).toEqual(oldMeta);
  expect(server.setSecureContext).not.toHaveBeenCalled();
}

let server;
const timer = { unref: vi.fn() };
beforeEach(() => {
  vi.clearAllMocks();
  rmSync(CERT_DIR, { recursive: true, force: true });
  seed();
  server = { setSecureContext: vi.fn() };
  findTailscale.mockReturnValue('/fake/tailscale');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(globalThis, 'setInterval').mockImplementation(() => timer);
  vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

describe('certRenewer', () => {
  it('passes a 60s timeout, publishes the validated pair and hot-swaps it', async () => {
    execFile.mockImplementation((_bin, args, _opts, cb) => {
      writeStaged(args, newPair);
      cb(null, { stderr: 'Wrote public cert' });
    });
    await runInitialRenewal();

    expect(execFile.mock.calls[0][2]).toMatchObject({ timeout: 60_000 });
    expect(server.setSecureContext).toHaveBeenCalledExactlyOnceWith(newPair);
    expect(readFileSync(CERT)).toEqual(newPair.cert);
    expect(readFileSync(KEY)).toEqual(newPair.key);
    const meta = readMeta();
    expect(meta).toMatchObject({ mode: 'tailscale', hostname: HOST, certMtime: statSync(CERT).mtimeMs });
    expect(meta.issuedAt).not.toBe('then');
    expect(meta.expiresAt).toEqual(expect.any(String));
  });

  it('preserves the live pair and metadata after a CLI timeout during a write', async () => {
    execFile.mockImplementation((_bin, args, _opts, cb) => {
      writeStaged(args, { cert: 'partial cert' });
      cb(new Error('timed out'));
    });
    await runInitialRenewal();
    expectOldPair();
  });

  it.each(['missing', 'mismatched'])('preserves the live pair when the staged key is %s', async (problem) => {
    execFile.mockImplementation((_bin, args, _opts, cb) => {
      writeStaged(args, { cert: newPair.cert, key: problem === 'mismatched' ? oldPair.key : null });
      cb(null, { stderr: '' });
    });
    await runInitialRenewal();
    expectOldPair();
  });

  it('skips a renewal while another is still in flight', async () => {
    let finish;
    execFile.mockImplementation((_bin, args, _opts, cb) => {
      finish = () => {
        writeStaged(args, oldPair);
        cb(null, { stderr: '' });
      };
    });
    initCertRenewer(server);
    await vi.waitFor(() => expect(execFile).toHaveBeenCalledTimes(1));

    const tick = setInterval.mock.calls[0][0];
    const first = tick();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('previous renewal still running'));
    expect(execFile).toHaveBeenCalledTimes(1);

    finish();
    await first;
    expect(readdirSync(CERT_DIR).sort()).toEqual(expectedFiles);
    const second = tick();
    await vi.waitFor(() => expect(execFile).toHaveBeenCalledTimes(2));
    finish();
    await second;
    expect(readdirSync(CERT_DIR).sort()).toEqual(expectedFiles);
  });

  it('is a no-op teardown when the server cannot hot-swap, meta is absent or self-signed', () => {
    for (const setup of [
      () => initCertRenewer({}),
      () => { rmSync(META); return initCertRenewer(server); },
      () => { writeFileSync(META, JSON.stringify({ mode: 'self-signed' })); return initCertRenewer(server); }
    ]) {
      seed();
      const stop = setup();
      expect(typeof stop).toBe('function');
      stop();
    }
    expect(execFile).not.toHaveBeenCalled();
    expect(setInterval).not.toHaveBeenCalled();
    expect(clearInterval).not.toHaveBeenCalled();
  });

  it('schedules an unref-ed 24h interval and the teardown clears it', async () => {
    execFile.mockImplementation((_bin, args, _opts, cb) => {
      writeStaged(args, oldPair);
      cb(null, { stderr: '' });
    });
    const stop = initCertRenewer(server);
    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 24 * 60 * 60 * 1000);
    expect(timer.unref).toHaveBeenCalled();
    await stop();
    expect(clearInterval).toHaveBeenCalledWith(timer);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(readdirSync(CERT_DIR).sort()).toEqual(expectedFiles);
  });

  it('does not rewrite or hot-swap the cached certificate', async () => {
    execFile.mockImplementation((_bin, args, _opts, cb) => {
      writeStaged(args, oldPair);
      cb(null, { stderr: '' });
    });
    const before = statSync(CERT).mtimeMs;
    await runInitialRenewal();
    expectOldPair();
    expect(statSync(CERT).mtimeMs).toBe(before);
  });

  it('skips the run entirely when the tailscale CLI is missing', async () => {
    findTailscale.mockReturnValue(null);
    const stop = initCertRenewer(server);
    await stop();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('CLI not found'));
    expect(execFile).not.toHaveBeenCalled();
    expectOldPair();
  });
});
