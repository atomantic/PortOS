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
    expect(hops).toEqual([{
      requestId: 'R1',
      url: 'https://ex.com/a',
      remoteIPAddress: '93.184.216.34',
      status: 200,
      fromServiceWorker: false,
      fromDiskCache: false,
      fromPrefetchCache: false,
      serviceWorkerResponseSource: null,
    }]);
  });

  it('threads the delivery flags of every hop through (redirect AND final response)', () => {
    // The gate needs to tell "no peer IP, no explanation" from "Chrome reported it
    // made no connection", so the raw CDP delivery fields ride on each hop.
    const { hops } = pickMainFrameHops([
      docRequest('R1', 'https://ex.com/a', ''),
      {
        method: 'Network.requestWillBeSent',
        params: {
          requestId: 'R1',
          loaderId: 'R1',
          type: 'Document',
          request: { url: 'https://ex.com/b' },
          redirectResponse: { url: 'https://ex.com/a', remoteIPAddress: '93.184.216.34', status: 302, fromPrefetchCache: true },
        },
      },
      {
        method: 'Network.responseReceived',
        params: {
          requestId: 'R1',
          type: 'Document',
          response: { url: 'https://ex.com/b', remoteIPAddress: '', status: 200, fromServiceWorker: true, serviceWorkerResponseSource: 'cache-storage' },
        },
      },
    ]);
    expect(hops[0]).toMatchObject({ fromPrefetchCache: true, fromServiceWorker: false, serviceWorkerResponseSource: null });
    expect(hops[1]).toMatchObject({ fromServiceWorker: true, fromDiskCache: false, serviceWorkerResponseSource: 'cache-storage' });
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

  it('with topFrameId, ignores a sub-frame (iframe) document that also has requestId===loaderId', () => {
    // CDP marks the main resource of EVERY frame with requestId===loaderId, so an
    // iframe document (F2, its own frameId) looks like a top-level nav. Passing the
    // top frame's frameId restricts main-frame classification to F1 only — the
    // slow/cached iframe (F2, no response yet) must NOT gate the pending check.
    const msgs = [
      { method: 'Network.requestWillBeSent', params: { requestId: 'R1', loaderId: 'R1', frameId: 'F1', type: 'Document', request: { url: 'https://ex.com/a' } } },
      { method: 'Network.responseReceived', params: { requestId: 'R1', frameId: 'F1', type: 'Document', response: { url: 'https://ex.com/a', remoteIPAddress: '93.184.216.34', status: 200 } } },
      // Sub-frame document: distinct frameId, still requestId===loaderId, no response.
      { method: 'Network.requestWillBeSent', params: { requestId: 'R2', loaderId: 'R2', frameId: 'F2', type: 'Document', request: { url: 'https://widget.example/iframe' } } },
    ];
    const { mainRequestIds, pendingMainRequestIds, hops } = pickMainFrameHops(msgs, 'F1');
    expect(mainRequestIds).toEqual(['R1']);
    expect(pendingMainRequestIds).toEqual([]);
    expect(hops.map((h) => h.remoteIPAddress)).toEqual(['93.184.216.34']);
    // Without the frameId hint, the old classifier over-refuses (F2 is pending).
    const legacy = pickMainFrameHops(msgs);
    expect(legacy.pendingMainRequestIds).toEqual(['R2']);
  });

  it('falls back to requestId===loaderId when no request matches topFrameId', () => {
    // A frameId-format surprise (topFrameId matches nothing in the stream) must not
    // regress to refuse-all — retain the legacy classification.
    const { mainRequestIds, hops } = pickMainFrameHops([
      docRequest('R1', 'https://ex.com/a', ''),
      docResponse('R1', 'https://ex.com/a', '93.184.216.34'),
    ], 'FRAME-THAT-DOES-NOT-EXIST');
    expect(mainRequestIds).toEqual(['R1']);
    expect(hops.map((h) => h.remoteIPAddress)).toEqual(['93.184.216.34']);
  });
});

describe('hopMadeNoConnection (no-network delivery classifier)', () => {
  let hopMadeNoConnection;
  beforeEach(async () => {
    vi.resetModules();
    ({ hopMadeNoConnection } = await import('./browserService.js'));
  });

  it('classifies only explicitly no-network deliveries', () => {
    expect(hopMadeNoConnection({ fromDiskCache: true })).toBe(true);
    expect(hopMadeNoConnection({ fromPrefetchCache: true })).toBe(true);
    expect(hopMadeNoConnection({ serviceWorkerResponseSource: 'cache-storage' })).toBe(true);
    expect(hopMadeNoConnection({ serviceWorkerResponseSource: 'http-cache' })).toBe(true);
    expect(hopMadeNoConnection({ serviceWorkerResponseSource: 'fallback-code' })).toBe(true);
    // A service worker that passed the request THROUGH to the network did make a
    // connection — it just isn't annotated with the peer IP. Not exempt.
    expect(hopMadeNoConnection({ fromServiceWorker: true, serviceWorkerResponseSource: 'network' })).toBe(false);
    expect(hopMadeNoConnection({ fromServiceWorker: true })).toBe(false);
    expect(hopMadeNoConnection({})).toBe(false);
    expect(hopMadeNoConnection(null)).toBe(false);
  });
});

describe('ssrfPinRefusalReason (SSRF pin gate)', () => {
  let ssrfPinRefusalReason;
  beforeEach(async () => {
    vi.resetModules();
    ({ ssrfPinRefusalReason } = await import('./browserService.js'));
  });

  const allow = (ip) => !ip.startsWith('127.') && !ip.startsWith('169.254.');
  const docRequest = (requestId, url, redirectResponse) => ({
    method: 'Network.requestWillBeSent',
    params: { requestId, loaderId: requestId, type: 'Document', request: { url }, ...(redirectResponse ? { redirectResponse } : {}) },
  });
  const docResponse = (requestId, url, remoteIPAddress, delivery = {}) => ({
    method: 'Network.responseReceived',
    params: { requestId, type: 'Document', response: { url, remoteIPAddress, status: 200, ...delivery } },
  });

  it('passes (null) when every main-frame hop dialed an allowed IP', () => {
    const reason = ssrfPinRefusalReason([
      docRequest('R1', 'https://ex.com/a'),
      docResponse('R1', 'https://ex.com/a', '93.184.216.34'),
    ], allow, 'https://ex.com/a');
    expect(reason).toBeNull();
  });

  it('refuses a hop that dialed a disallowed IP', () => {
    const reason = ssrfPinRefusalReason([
      docRequest('R1', 'http://127.0.0.1/x'),
      docResponse('R1', 'http://127.0.0.1/x', '127.0.0.1'),
    ], allow, 'http://127.0.0.1/x');
    expect(reason).toMatch(/disallowed address 127\.0\.0\.1/);
  });

  it('refuses an in-flight top-level navigation (started, no response)', () => {
    const reason = ssrfPinRefusalReason([
      docRequest('R1', 'https://ex.com/a'),
      docResponse('R1', 'https://ex.com/a', '93.184.216.34'),
      docRequest('R2', 'https://evil.example/x'),
    ], allow, 'https://ex.com/a');
    expect(reason).toMatch(/still in flight/);
  });

  it('refuses when no main-frame document response was observed', () => {
    expect(ssrfPinRefusalReason([], allow, 'https://ex.com/a')).toMatch(/no main-frame document response/);
  });

  it('refuses a main document with a missing/empty remote IP (unverifiable)', () => {
    const reason = ssrfPinRefusalReason([
      docRequest('R1', 'https://ex.com/a'),
      docResponse('R1', 'https://ex.com/a', ''),
    ], allow, 'https://ex.com/a');
    expect(reason).toMatch(/unverifiable address/);
    // The refusal names the cause so the next occurrence is diagnosable.
    expect(reason).toMatch(/no remoteIPAddress; fromServiceWorker=false, fromDiskCache=false, fromPrefetchCache=false, serviceWorkerResponseSource=none/);
  });

  it('refuses a service-worker main document that passed the fetch to the NETWORK (empty IP, no no-network flag)', () => {
    // The exact shape that broke Stacker News: the SW mediated the document, so
    // Chrome reports no peer IP even though a real h2 fetch happened. That is NOT
    // a no-network delivery, so the fail-closed gate must still refuse — the fix
    // is the `Network.setBypassServiceWorker` in navigateToUrlPinned, not a
    // relaxation here.
    const reason = ssrfPinRefusalReason([
      docRequest('R1', 'https://pwa.example/'),
      docResponse('R1', 'https://pwa.example/', '', { fromServiceWorker: true, serviceWorkerResponseSource: 'network' }),
    ], allow, 'https://pwa.example/');
    expect(reason).toMatch(/unverifiable address/);
    expect(reason).toMatch(/fromServiceWorker=true/);
    expect(reason).toMatch(/serviceWorkerResponseSource=network/);
  });

  it('allows a cache-served hop when an EARLIER hop of the SAME navigation verified a real IP', () => {
    // R1 redirected through a network hop that pinned a real address; the final
    // hop of that same chain was answered from the disk cache — no connection was
    // made, so there is nothing to pin and refusing would be a false positive.
    const reason = ssrfPinRefusalReason([
      docRequest('R1', 'https://ex.com/a'),
      docRequest('R1', 'https://ex.com/b', { url: 'https://ex.com/a', remoteIPAddress: '93.184.216.34', status: 302 }),
      docResponse('R1', 'https://ex.com/b', '', { fromDiskCache: true }),
    ], allow, 'https://ex.com/a');
    expect(reason).toBeNull();
  });

  it('allows a service-worker hop served from cache-storage on a chain that verified a real IP', () => {
    const reason = ssrfPinRefusalReason([
      docRequest('R1', 'https://pwa.example/'),
      docRequest('R1', 'https://pwa.example/offline', { url: 'https://pwa.example/', remoteIPAddress: '93.184.216.34', status: 302 }),
      docResponse('R1', 'https://pwa.example/offline', '', { fromServiceWorker: true, serviceWorkerResponseSource: 'cache-storage' }),
    ], allow, 'https://pwa.example/');
    expect(reason).toBeNull();
  });

  it('refuses a cache-served navigation that a DIFFERENT navigation verified (cross-nav borrow)', () => {
    // R1 loaded clean from public, then the page client-side-navigated to a
    // cached document. R1's verified IP says nothing about R2's origin — a
    // previously cached loopback/private document would otherwise be admitted
    // unpinned, so the exemption must not cross navigations.
    const reason = ssrfPinRefusalReason([
      docRequest('R1', 'https://ex.com/a'),
      docResponse('R1', 'https://ex.com/a', '93.184.216.34'),
      docRequest('R2', 'http://127.0.0.1/secret'),
      docResponse('R2', 'http://127.0.0.1/secret', '', { fromDiskCache: true }),
    ], allow, 'https://ex.com/a');
    expect(reason).toMatch(/unverifiable address/);
    expect(reason).toMatch(/no verified network address for this navigation/);
  });

  it('refuses a cache-served hop whose URL host is blocked, even on a verified chain', () => {
    // A connectionless hop carries one address signal — its own URL. A redirect
    // from a verified public hop into a cached loopback document must still fail.
    const reason = ssrfPinRefusalReason([
      docRequest('R1', 'https://ex.com/a'),
      docRequest('R1', 'http://127.0.0.1/secret', { url: 'https://ex.com/a', remoteIPAddress: '93.184.216.34', status: 302 }),
      docResponse('R1', 'http://127.0.0.1/secret', '', { fromDiskCache: true }),
    ], allow, 'https://ex.com/a');
    expect(reason).toMatch(/unverifiable address/);
  });

  it('refuses a cache-served main document when NO hop of that navigation verified an IP', () => {
    // A fully cache-served navigation pinned nothing at all — a cache flag can
    // never stand in for a network check, so this still fails closed.
    const reason = ssrfPinRefusalReason([
      docRequest('R1', 'https://pwa.example/'),
      docResponse('R1', 'https://pwa.example/', '', { fromServiceWorker: true, serviceWorkerResponseSource: 'cache-storage' }),
    ], allow, 'https://pwa.example/');
    expect(reason).toMatch(/unverifiable address/);
    expect(reason).toMatch(/no verified network address for this navigation/);
  });

  it('still refuses a disallowed sub-resource on a page whose main doc was cache-served', () => {
    // The no-connection exception covers ONLY the main-frame empty-IP check;
    // every real connection the page made is still verified by collectConnectedIps.
    const reason = ssrfPinRefusalReason([
      docRequest('R1', 'https://pwa.example/'),
      docRequest('R1', 'https://pwa.example/app', { url: 'https://pwa.example/', remoteIPAddress: '93.184.216.34', status: 302 }),
      docResponse('R1', 'https://pwa.example/app', '', { fromDiskCache: true }),
      { method: 'Network.responseReceived', params: { requestId: 'R3', type: 'XHR', response: { url: 'https://pwa.example/latest/meta-data', remoteIPAddress: '169.254.169.254', status: 200 } } },
    ], allow, 'https://pwa.example/');
    expect(reason).toMatch(/disallowed address 169\.254\.169\.254/);
  });

  it('refuses a SUB-RESOURCE / fetch that dialed a blocked IP (rebind after page load)', () => {
    // Main doc loads clean from public, then the page fetch()es its now-private-
    // resolving hostname (a subresource, type XHR). Its real IP must be checked.
    const reason = ssrfPinRefusalReason([
      docRequest('R1', 'https://ex.com/a'),
      docResponse('R1', 'https://ex.com/a', '93.184.216.34'),
      { method: 'Network.responseReceived', params: { requestId: 'R2', type: 'XHR', response: { url: 'https://ex.com/latest/meta-data', remoteIPAddress: '169.254.169.254', status: 200 } } },
    ], allow, 'https://ex.com/a');
    expect(reason).toMatch(/disallowed address 169\.254\.169\.254/);
  });

  it('ignores sub-resources with an empty remote IP (data:/blob:/cache — no connection)', () => {
    const reason = ssrfPinRefusalReason([
      docRequest('R1', 'https://ex.com/a'),
      docResponse('R1', 'https://ex.com/a', '93.184.216.34'),
      { method: 'Network.responseReceived', params: { requestId: 'R2', type: 'Image', response: { url: 'data:image/png;base64,AAAA', remoteIPAddress: '', status: 200 } } },
    ], allow, 'https://ex.com/a');
    expect(reason).toBeNull();
  });

  it('allows an RFC1918 LAN sub-resource (only loopback/link-local/metadata are blocked)', () => {
    // isBlockedIngestHost does NOT block 192.168/10/172.16 — LAN pages stay ingestible.
    const lanAllow = (ip) => !ip.startsWith('127.') && !ip.startsWith('169.254.');
    const reason = ssrfPinRefusalReason([
      docRequest('R1', 'https://wiki.lan/a'),
      docResponse('R1', 'https://wiki.lan/a', '192.168.1.10'),
      { method: 'Network.responseReceived', params: { requestId: 'R2', type: 'Script', response: { url: 'https://wiki.lan/app.js', remoteIPAddress: '192.168.1.10', status: 200 } } },
    ], lanAllow, 'https://wiki.lan/a');
    expect(reason).toBeNull();
  });

  it('refuses a WebSocket opened to a blocked host literal (ws:// to loopback/localhost)', () => {
    // CDP gives WS no remoteIPAddress, so we gate on the WS host — this catches a
    // direct ws://localhost / ws://127.0.0.1 (host-level, not IP-level, check).
    const hostAllow = (h) => h !== 'localhost' && !h.startsWith('127.') && h !== '::1';
    const reason = ssrfPinRefusalReason([
      docRequest('R1', 'https://ex.com/a'),
      docResponse('R1', 'https://ex.com/a', '93.184.216.34'),
      { method: 'Network.webSocketCreated', params: { requestId: 'W1', url: 'ws://localhost:9222/devtools' } },
    ], hostAllow, 'https://ex.com/a');
    expect(reason).toMatch(/WebSocket to a disallowed host localhost/);
  });

  it('allows a WebSocket to a normal public host', () => {
    const hostAllow = (h) => h !== 'localhost' && !h.startsWith('127.');
    const reason = ssrfPinRefusalReason([
      docRequest('R1', 'https://ex.com/a'),
      docResponse('R1', 'https://ex.com/a', '93.184.216.34'),
      { method: 'Network.webSocketCreated', params: { requestId: 'W1', url: 'wss://realtime.example.com/socket' } },
    ], hostAllow, 'https://ex.com/a');
    expect(reason).toBeNull();
  });

  it('passes a public page that embeds a slow iframe when the top frameId is pinned', () => {
    // Top document loads clean from public; an embedded iframe (its own frameId,
    // requestId===loaderId) is still in flight at settle-end. Without the frameId
    // pin this over-refuses ("still in flight"); with it, only F1 gates the check.
    const msgs = [
      { method: 'Network.requestWillBeSent', params: { requestId: 'R1', loaderId: 'R1', frameId: 'F1', type: 'Document', request: { url: 'https://ex.com/article' } } },
      { method: 'Network.responseReceived', params: { requestId: 'R1', frameId: 'F1', type: 'Document', response: { url: 'https://ex.com/article', remoteIPAddress: '93.184.216.34', status: 200 } } },
      { method: 'Network.requestWillBeSent', params: { requestId: 'R2', loaderId: 'R2', frameId: 'F2', type: 'Document', request: { url: 'https://widget.example/embed' } } },
    ];
    expect(ssrfPinRefusalReason(msgs, allow, 'https://ex.com/article', 'F1')).toBeNull();
    // Sanity: the legacy classifier (no frameId) over-refuses the same stream.
    expect(ssrfPinRefusalReason(msgs, allow, 'https://ex.com/article')).toMatch(/still in flight/);
  });
});
