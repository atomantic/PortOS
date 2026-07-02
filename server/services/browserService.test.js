import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, utimes, writeFile } from 'fs/promises';
import { join } from 'path';
import { createTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

describe('browserService config persistence', () => {
  let tempRoot;

  beforeEach(() => {
    vi.resetModules();
    tempRoot = createTempDataRoot('portos-browser-service-');
  });

  afterEach(async () => {
    vi.doUnmock('../lib/fileUtils.js');
    await rm(tempRoot, { recursive: true, force: true });
  });

  async function importService() {
    vi.doMock('../lib/fileUtils.js', async (importOriginal) => {
      const actual = await importOriginal();
      return makePathsProxy(actual, {
        dataRoot: tempRoot,
        extraOverrides: (root) => ({
          browserProfile: join(root, 'browser-profile'),
          browserDownloads: join(root, 'downloads'),
        }),
      });
    });
    return import('./browserService.js');
  }

  it('atomically saves normalized config with a derived macOS app bundle', async () => {
    const service = await importService();
    const saved = await service.saveConfig({
      chromePath: '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    });

    expect(saved.macAppBundle).toBe('/Applications/Google Chrome Canary.app');
    const onDisk = JSON.parse(await readFile(join(tempRoot, 'browser-config.json'), 'utf-8'));
    expect(onDisk.macAppBundle).toBe('/Applications/Google Chrome Canary.app');
  });

  it('reloads config after the setup script writes browser-config.json directly', async () => {
    const service = await importService();
    await service.saveConfig({ cdpPort: 5556 });
    await mkdir(tempRoot, { recursive: true });
    const configPath = join(tempRoot, 'browser-config.json');
    await writeFile(configPath, JSON.stringify({ cdpPort: 6000, headless: false }));
    const later = new Date(Date.now() + 1000);
    await utimes(configPath, later, later);

    const reloaded = await service.getConfig();
    expect(reloaded.cdpPort).toBe(6000);
    expect(reloaded.headless).toBe(false);
  });
});

describe('pickMainFrameHops (SSRF pin — main-frame connection IPs)', () => {
  // Pure helper: no data-root proxy needed, import the real module directly.
  let pickMainFrameHops;
  beforeEach(async () => {
    vi.resetModules();
    ({ pickMainFrameHops } = await import('./browserService.js'));
  });

  // A main-document navigation: requestId === loaderId marks the top frame.
  const docRequest = (requestId, url, remoteIPAddress, redirectResponse) => ({
    method: 'Network.requestWillBeSent',
    params: { requestId, loaderId: requestId, type: 'Document', request: { url }, ...(redirectResponse ? { redirectResponse } : {}) },
  });
  const docResponse = (requestId, url, remoteIPAddress) => ({
    method: 'Network.responseReceived',
    params: { requestId, type: 'Document', response: { url, remoteIPAddress, status: 200 } },
  });

  it('captures the single-hop main document response IP', () => {
    const { hops, finalUrl, mainRequestIds } = pickMainFrameHops([
      docRequest('R1', 'https://ex.com/a', ''),
      docResponse('R1', 'https://ex.com/a', '93.184.216.34'),
    ]);
    expect(mainRequestIds).toEqual(['R1']);
    expect(finalUrl).toBe('https://ex.com/a');
    expect(hops).toEqual([{ url: 'https://ex.com/a', remoteIPAddress: '93.184.216.34', status: 200 }]);
  });

  it('captures EVERY redirect hop IP plus the final response (per-hop pin)', () => {
    const { hops } = pickMainFrameHops([
      docRequest('R1', 'https://ex.com/a', ''),
      // redirect: the response that caused the redirect rides on the NEXT request
      docRequest('R1', 'http://127.0.0.1:5555/secret', '', { url: 'https://ex.com/a', remoteIPAddress: '93.184.216.34', status: 302 }),
      docResponse('R1', 'http://127.0.0.1:5555/secret', '127.0.0.1'),
    ]);
    expect(hops.map((h) => h.remoteIPAddress)).toEqual(['93.184.216.34', '127.0.0.1']);
  });

  it('captures a SECOND top-level navigation (client-side nav during settle)', () => {
    // A page that loads clean (R1 → public), then location.replace()s to a new
    // top-level document (R2, a fresh requestId===loaderId) Chrome dials at
    // metadata during the settle window. Both main-frame loads must be captured.
    const { hops, finalUrl, mainRequestIds } = pickMainFrameHops([
      docRequest('R1', 'https://ex.com/a', ''),
      docResponse('R1', 'https://ex.com/a', '93.184.216.34'),
      docRequest('R2', 'https://evil.example/x', ''),
      docResponse('R2', 'https://evil.example/x', '169.254.169.254'),
    ]);
    expect(mainRequestIds).toEqual(['R1', 'R2']);
    expect(hops.map((h) => h.remoteIPAddress)).toEqual(['93.184.216.34', '169.254.169.254']);
    expect(finalUrl).toBe('https://evil.example/x');
  });

  it('ignores sub-resource requests (requestId !== loaderId)', () => {
    const { hops, mainRequestIds } = pickMainFrameHops([
      docRequest('R1', 'https://ex.com/a', ''),
      // A sub-resource: different requestId/loaderId, type Image — must be excluded.
      { method: 'Network.requestWillBeSent', params: { requestId: 'R2', loaderId: 'R1', type: 'Image', request: { url: 'http://169.254.169.254/latest' } } },
      { method: 'Network.responseReceived', params: { requestId: 'R2', type: 'Image', response: { url: 'http://169.254.169.254/latest', remoteIPAddress: '169.254.169.254', status: 200 } } },
      docResponse('R1', 'https://ex.com/a', '93.184.216.34'),
    ]);
    expect(mainRequestIds).toEqual(['R1']);
    expect(hops.map((h) => h.remoteIPAddress)).toEqual(['93.184.216.34']);
  });

  it('flags a top-level navigation that started but has no response yet (in-flight → pending)', () => {
    // R1 completed clean; R2 (a client-side nav) STARTED during settle but the
    // socket closed before its responseReceived — its final IP is unverified, so
    // the caller must fail closed rather than read a possibly-private page.
    const { hops, mainRequestIds, pendingMainRequestIds } = pickMainFrameHops([
      docRequest('R1', 'https://ex.com/a', ''),
      docResponse('R1', 'https://ex.com/a', '93.184.216.34'),
      docRequest('R2', 'https://evil.example/x', ''),
    ]);
    expect(mainRequestIds).toEqual(['R1', 'R2']);
    expect(pendingMainRequestIds).toEqual(['R2']);
    // R2 contributed no hop (no response captured), so its IP was never checked.
    expect(hops.map((h) => h.remoteIPAddress)).toEqual(['93.184.216.34']);
  });

  it('returns no hops when no main-frame document load is present', () => {
    const { hops, mainRequestIds, finalUrl } = pickMainFrameHops([
      { method: 'Network.requestWillBeSent', params: { requestId: 'R2', loaderId: 'R1', type: 'Image', request: { url: 'https://cdn/x.png' } } },
    ]);
    expect(mainRequestIds).toEqual([]);
    expect(hops).toEqual([]);
    expect(finalUrl).toBeNull();
  });
});
