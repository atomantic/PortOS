import { describe, it, expect, vi, beforeEach } from 'vitest';

const runner = vi.hoisted(() => ({ isVitest: true }));
const svc = vi.hoisted(() => ({ getHealthStatus: vi.fn(), launchBrowser: vi.fn() }));
const pw = vi.hoisted(() => ({ connectOverCDP: vi.fn() }));

vi.mock('../../../lib/runtimeEnv.js', () => ({ isVitestRunner: () => runner.isVitest }));
vi.mock('../../browserService.js', () => svc);
vi.mock('playwright-core', () => ({ chromium: pw }));

import {
  connectPortosBrowser, serializeBrowserOperation, browserOperationInProgress,
  step, pageTargetId, landedOnPost,
} from './browser.js';
import { ServerError } from '../../../lib/errorHandler.js';

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

describe('connectPortosBrowser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runner.isVitest = true;
  });

  it('refuses under Vitest without touching browserService or playwright', async () => {
    await expect(connectPortosBrowser()).rejects.toMatchObject({ status: 503, code: 'PORTOS_BROWSER_UNAVAILABLE' });
    expect(svc.getHealthStatus).not.toHaveBeenCalled();
    expect(pw.connectOverCDP).not.toHaveBeenCalled();
  });

  it('rewrites wildcard CDP hosts to loopback and connects with isLocal', async () => {
    runner.isVitest = false;
    const context = {};
    pw.connectOverCDP.mockResolvedValue({ contexts: () => [context], close: vi.fn() });
    for (const cdpHost of ['0.0.0.0', '::']) {
      svc.getHealthStatus.mockResolvedValue({ connected: true, cdpHost, cdpPort: 9222 });
      const res = await connectPortosBrowser();
      expect(res.context).toBe(context);
    }
    expect(pw.connectOverCDP).toHaveBeenCalledTimes(2);
    for (const call of pw.connectOverCDP.mock.calls) {
      expect(call[0]).toBe('http://127.0.0.1:9222');
      expect(call[1]).toMatchObject({ isLocal: true });
    }
  });

  it('keeps a concrete host as given', async () => {
    runner.isVitest = false;
    svc.getHealthStatus.mockResolvedValue({ connected: true, cdpHost: 'localhost', cdpPort: 9333 });
    pw.connectOverCDP.mockResolvedValue({ contexts: () => [{}], close: vi.fn() });
    await connectPortosBrowser();
    expect(pw.connectOverCDP.mock.calls[0][0]).toBe('http://localhost:9333');
  });

  it('launches a stopped browser unless launch is false', async () => {
    runner.isVitest = false;
    svc.getHealthStatus.mockResolvedValue({ connected: false });
    svc.launchBrowser.mockResolvedValue({ connected: true, cdpHost: '127.0.0.1', cdpPort: 1 });
    pw.connectOverCDP.mockResolvedValue({ contexts: () => [{}], close: vi.fn() });
    await connectPortosBrowser();
    expect(svc.launchBrowser).toHaveBeenCalledTimes(1);

    svc.launchBrowser.mockClear();
    await expect(connectPortosBrowser({ launch: false })).rejects.toMatchObject({ status: 503, code: 'PORTOS_BROWSER_UNAVAILABLE' });
    expect(svc.launchBrowser).not.toHaveBeenCalled();
  });

  it('closes the browser when it has no context', async () => {
    runner.isVitest = false;
    const close = vi.fn().mockResolvedValue();
    svc.getHealthStatus.mockResolvedValue({ connected: true, cdpHost: '127.0.0.1', cdpPort: 1 });
    pw.connectOverCDP.mockResolvedValue({ contexts: () => [], close });
    await expect(connectPortosBrowser()).rejects.toMatchObject({ status: 503, code: 'PORTOS_BROWSER_UNAVAILABLE' });
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('serializeBrowserOperation', () => {
  it('runs operations FIFO, reports the active one, and recovers after a rejection', async () => {
    expect(browserOperationInProgress()).toBeNull();
    const order = [];
    const gate = deferred();
    const first = serializeBrowserOperation(async () => { order.push('a:start'); await gate.promise; order.push('a:end'); }, { label: 'A', status: 'working' });
    const second = serializeBrowserOperation(async () => { order.push('b'); throw new Error('boom'); }, { label: 'B' });
    const third = serializeBrowserOperation(async () => { order.push('c'); return 'ok'; });
    const secondSettled = second.catch((e) => e);

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['a:start']);
    expect(browserOperationInProgress()).toEqual({ label: 'A', status: 'working' });

    gate.resolve();
    await first;
    expect((await secondSettled).message).toBe('boom');
    expect(await third).toBe('ok');
    expect(order).toEqual(['a:start', 'a:end', 'b', 'c']);
    expect(browserOperationInProgress()).toBeNull();
  });

  it('reports null label/status for an unlabeled operation', async () => {
    const gate = deferred();
    const run = serializeBrowserOperation(() => gate.promise);
    await Promise.resolve();
    expect(browserOperationInProgress()).toEqual({ label: null, status: null });
    gate.resolve();
    await run;
  });
});

describe('step', () => {
  it('runs bare when no operation holds the browser', async () => {
    expect(await step('X', 'go', async () => 7)).toBe(7);
  });

  it('passes ServerError through unchanged', async () => {
    const err = new ServerError('nope', { status: 409, code: 'PUBLISH_LOGIN_REQUIRED' });
    await expect(serializeBrowserOperation(() => step('X', 'go', async () => { throw err; }))).rejects.toBe(err);
  });

  it('wraps a timeout as 502 PUBLISH_STEP_FAILED with the tab-focus hint', async () => {
    const res = serializeBrowserOperation(() => step('X', 'click post', async () => { throw new Error('Timeout 30000ms exceeded\nwaiting for locator'); }));
    await expect(res).rejects.toMatchObject({ status: 502, code: 'PUBLISH_STEP_FAILED' });
    await expect(res).rejects.toThrow(/X: click post \(Timeout 30000ms exceeded\)\. Leave the PortOS Browser/);
  });

  it('wraps a non-timeout failure without the hint', async () => {
    const res = serializeBrowserOperation(() => step('X', 'go', async () => { throw new Error('bad selector'); }));
    await expect(res).rejects.toThrow('X: go (bad selector)');
    await expect(res).rejects.not.toThrow(/Leave the PortOS Browser/);
  });

  it('records status, isolates onStep throws, and awaits focus', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let focused = false;
    const onStep = vi.fn(() => { throw new Error('listener broke'); });
    const focus = () => new Promise((r) => setTimeout(() => { focused = true; r(); }, 5));
    let during;
    const result = await serializeBrowserOperation(async () => {
      const out = await step('X', 'name', async () => { during = { focused, progress: browserOperationInProgress() }; return 'done'; }, { status: 'custom' });
      return out;
    }, { label: 'L', onStep, focus });
    expect(result).toBe('done');
    expect(onStep).toHaveBeenCalledWith('custom');
    expect(errSpy).toHaveBeenCalled();
    expect(during.focused).toBe(true);
    expect(during.progress).toEqual({ label: 'L', status: 'custom' });
    errSpy.mockRestore();
  });

  it('ignores a rejecting focus', async () => {
    const result = await serializeBrowserOperation(() => step('X', 'n', async () => 'ok'), { focus: () => Promise.reject(new Error('gone')) });
    expect(result).toBe('ok');
  });
});

describe('pageTargetId', () => {
  it('returns the target id and detaches', async () => {
    const detach = vi.fn().mockResolvedValue();
    const context = { newCDPSession: vi.fn().mockResolvedValue({ send: vi.fn().mockResolvedValue({ targetInfo: { targetId: 'T1' } }), detach }) };
    expect(await pageTargetId(context, {})).toBe('T1');
    expect(detach).toHaveBeenCalledTimes(1);
  });

  it('returns null and still detaches when send fails', async () => {
    const detach = vi.fn().mockRejectedValue(new Error('already detached'));
    const context = { newCDPSession: vi.fn().mockResolvedValue({ send: vi.fn().mockRejectedValue(new Error('closed')), detach }) };
    expect(await pageTargetId(context, {})).toBeNull();
    expect(detach).toHaveBeenCalledTimes(1);
  });

  it('returns null when the session cannot open', async () => {
    const context = { newCDPSession: vi.fn().mockRejectedValue(new Error('closed')) };
    expect(await pageTargetId(context, {})).toBeNull();
  });
});

describe('landedOnPost', () => {
  const pattern = /https:\/\/example\.com\/post\/(\d+)/;
  const page = (url, shown) => ({ url: () => url, waitForFunction: vi.fn(() => (shown ? Promise.resolve() : Promise.reject(new Error('timeout')))) });

  it('returns the canonical link when URL and title both match', async () => {
    const p = page('https://example.com/post/42?x=1', true);
    expect(await landedOnPost(p, pattern, '  My Song  ', (m) => `canon:${m[1]}`)).toBe('canon:42');
    expect(p.waitForFunction.mock.calls[0][1]).toBe('My Song');
  });

  it('defaults canonical to the full match', async () => {
    expect(await landedOnPost(page('https://example.com/post/42?x=1', true), pattern, 'T')).toBe('https://example.com/post/42');
  });

  it('returns null without waiting when the URL does not match or title is empty', async () => {
    const miss = page('https://example.com/home', true);
    expect(await landedOnPost(miss, pattern, 'T')).toBeNull();
    expect(miss.waitForFunction).not.toHaveBeenCalled();
    const blank = page('https://example.com/post/1', true);
    expect(await landedOnPost(blank, pattern, '   ')).toBeNull();
    expect(blank.waitForFunction).not.toHaveBeenCalled();
  });

  it('returns null when the title never shows', async () => {
    expect(await landedOnPost(page('https://example.com/post/1', false), pattern, 'T')).toBeNull();
  });
});
