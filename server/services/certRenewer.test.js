import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
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

const seed = () => {
  mkdirSync(CERT_DIR, { recursive: true });
  writeFileSync(CERT, 'old-cert');
  writeFileSync(KEY, 'old-key');
  utimesSync(CERT, 1_000_000, 1_000_000);
  writeFileSync(META, JSON.stringify({ mode: 'tailscale', hostname: HOST, issuedAt: 'then', certMtime: 1_000_000_000 }));
};
const rotate = () => {
  writeFileSync(CERT, 'new-cert');
  writeFileSync(KEY, 'new-key');
  utimesSync(CERT, 2_000_000, 2_000_000);
};

// initCertRenewer fires one renewal immediately and returns nothing, so tests
// observe the outcome through the server stub and meta.json.
const runInitial = async (server) => {
  initCertRenewer(server);
  await vi.waitFor(() => expect(execFile).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 50));
};

let server;
beforeEach(() => {
  vi.clearAllMocks();
  rmSync(CERT_DIR, { recursive: true, force: true });
  seed();
  server = { setSecureContext: vi.fn() };
  findTailscale.mockReturnValue('/usr/local/bin/tailscale');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(globalThis, 'setInterval').mockImplementation(() => ({ unref() {} }));
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

describe('certRenewer', () => {
  it('passes a 60s timeout, hot-swaps the renewed cert and persists fresh meta atomically', async () => {
    execFile.mockImplementation((_bin, _args, _opts, cb) => { rotate(); cb(null, { stderr: 'Wrote public cert' }); });
    await runInitial(server);

    expect(execFile.mock.calls[0][2]).toMatchObject({ timeout: 60_000 });
    expect(server.setSecureContext).toHaveBeenCalledTimes(1);
    const meta = JSON.parse(readFileSync(META, 'utf8'));
    expect(meta).toMatchObject({ mode: 'tailscale', hostname: HOST, certMtime: 2_000_000_000 });
    expect(meta.issuedAt).not.toBe('then');
    expect(meta).toHaveProperty('expiresAt');
  });

  it('does not hot-swap or rewrite meta when tailscale cert fails, even if files changed', async () => {
    execFile.mockImplementation((_bin, _args, _opts, cb) => { rotate(); cb(new Error('timed out')); });
    await runInitial(server);

    expect(server.setSecureContext).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(META, 'utf8')).issuedAt).toBe('then');
  });

  it('skips a renewal while another is still in flight', async () => {
    let finish;
    execFile.mockImplementation((_bin, _args, _opts, cb) => { finish = () => cb(null, { stderr: '' }); });
    initCertRenewer(server);
    await vi.waitFor(() => expect(execFile).toHaveBeenCalledTimes(1));

    const tick = setInterval.mock.calls[0][0];
    tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(execFile).toHaveBeenCalledTimes(1);

    finish();
    await new Promise((r) => setTimeout(r, 20));
    tick();
    await vi.waitFor(() => expect(execFile).toHaveBeenCalledTimes(2));
  });
});
