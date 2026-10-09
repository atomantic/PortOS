import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _withTestPreviewLoadDiagnostics } from './testPreviewLoadDiagnostics.js';

function fixture(evaluate = vi.fn().mockResolvedValue({ readyState: 'interactive', compositionReady: false,
  scriptCount: 3, moduleCount: 1, externalScriptCount: 0 }), browser = { isConnected: () => true }) {
  return Object.assign(new EventEmitter(), { evaluate, isClosed: () => false,
    context: () => ({ browser: () => browser }) });
}
// A browser-target CDP session whose replies the probe must reduce to scalars.
function browserSession(send) {
  const session = { send: vi.fn(send), detach: vi.fn().mockResolvedValue() };
  return { session, browser: { isConnected: () => true, newBrowserCDPSession: async () => session } };
}
const snapshot = error => JSON.parse(error.message.split('; preview lifecycle: ')[1]);
afterEach(() => vi.useRealTimers());

describe('preview load failure evidence', () => {
  it('retains bounded phase facts on the original failure without console text, URLs or page data', async () => {
    const page = fixture(vi.fn().mockResolvedValue({ readyState: 'secret', compositionReady: 'secret',
      scriptCount: 10000, moduleCount: -1, externalScriptCount: 'secret', source: 'secret' }));
    const failure = new Error('load deadline');
    await expect(_withTestPreviewLoadDiagnostics(page, async () => {
      page.emit('domcontentloaded');
      for (let i = 0; i < 1005; i++) page.emit('console', { type: () => 'warning', text: () => { throw new Error('Do not read console text'); } });
      page.emit('pageerror', { name: 'SyntaxError', message: 'secret' });
      page.emit('pageerror', { name: 'secret', message: 'secret' });
      page.emit('requestfailed', { resourceType: () => 'script', url: () => { throw new Error('Do not read URLs'); } });
      throw failure;
    })).rejects.toBe(failure);
    expect(snapshot(failure)).toMatchObject({ phase: 'load', domContentLoaded: true, load: false,
      consoleWarning: 1000, syntaxError: 1, otherError: 1, scriptFailed: 1,
      browserConnected: true, pageClosed: false, documentProbe: 'captured',
      readyState: 'unavailable', compositionReady: 'unavailable', scriptCount: 1000,
      moduleCount: 'unavailable', externalScriptCount: 'unavailable' });
    expect(failure.message).not.toContain('secret');
    expect(page.eventNames()).toEqual([]);
  });

  it('bounds an unresponsive renderer probe and owns its late rejection before cleanup', async () => {
    vi.useFakeTimers();
    let rejectProbe;
    const page = fixture(vi.fn(() => new Promise((_, reject) => { rejectProbe = reject; })));
    const failure = new Error('semantic deadline');
    const result = _withTestPreviewLoadDiagnostics(page, async markReadiness => {
      page.emit('load'); markReadiness(); throw failure;
    });
    const checked = expect(result).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(250);
    await checked;
    expect(snapshot(failure)).toMatchObject({ phase: 'composition-readiness', load: true, documentProbe: 'deadline' });
    rejectProbe(new Error('late private renderer error'));
    await Promise.resolve();
    expect(page.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves a disconnected page failure when document evaluation rejects', async () => {
    const page = fixture(vi.fn().mockRejectedValue(new Error('private evaluation error')));
    page.isClosed = () => true;
    page.context = () => ({ browser: () => ({ isConnected: () => false }) });
    const failure = new Error('load failed');
    await expect(_withTestPreviewLoadDiagnostics(page, async () => { throw failure; })).rejects.toBe(failure);
    expect(snapshot(failure)).toMatchObject({ pageClosed: true, browserConnected: false, documentProbe: 'unavailable', processProbe: 'unavailable' });
    expect(page.eventNames()).toEqual([]);
  });

  it('separates browser-process delivery from renderer execution with per-process CPU, keeping no version strings or process ids', async () => {
    vi.useFakeTimers();
    const samples = [
      { processInfo: [{ type: 'browser', id: 9001, cpuTime: 1 }, { type: 'renderer', id: 9002, cpuTime: 2 },
        { type: 'renderer', id: 9003, cpuTime: 3 }, { type: 'GPU', id: 9004, cpuTime: 4 }, { type: 'secret-utility', id: 9005, cpuTime: 0 }] },
      // 250 ms later: one renderer pegged, GPU at 20%, browser idle; a new renderer has no baseline.
      { processInfo: [{ type: 'browser', id: 9001, cpuTime: 1 }, { type: 'renderer', id: 9002, cpuTime: 2.25 },
        { type: 'renderer', id: 9003, cpuTime: 3.01 }, { type: 'GPU', id: 9004, cpuTime: 4.05 },
        { type: 'renderer', id: 9006, cpuTime: 50 }, { type: 'secret-utility', id: 9005, cpuTime: 99 }] },
    ];
    const { session, browser } = browserSession(async method => method === 'Browser.getVersion'
      ? { product: 'secret-product', userAgent: 'secret-agent' } : samples.shift());
    const page = fixture(undefined, browser);
    const failure = new Error('load deadline');
    const checked = expect(_withTestPreviewLoadDiagnostics(page, async () => { throw failure; })).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(250);
    await checked;
    expect(snapshot(failure)).toMatchObject({ documentProbe: 'captured', processProbe: 'captured', browserRoundTripMs: 0,
      rendererProcesses: 3, busiestRendererCpuPct: 100, gpuCpuPct: 20, browserCpuPct: 0 });
    expect(failure.message).not.toMatch(/secret|900\d/);
    expect(session.detach).toHaveBeenCalled();
  });

  it('bounds a browser session that stops answering and owns its late rejection', async () => {
    vi.useFakeTimers();
    let rejectVersion;
    const { browser } = browserSession(() => new Promise((_, reject) => { rejectVersion = reject; }));
    const page = fixture(undefined, browser);
    const failure = new Error('load deadline');
    const checked = expect(_withTestPreviewLoadDiagnostics(page, async () => { throw failure; })).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(1000);
    await checked;
    expect(snapshot(failure)).toMatchObject({ documentProbe: 'captured', processProbe: 'deadline' });
    rejectVersion(new Error('late private CDP error'));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not probe or retain observers after successful load and semantic readiness', async () => {
    const { session, browser } = browserSession(async () => ({}));
    const page = fixture(undefined, browser);
    await _withTestPreviewLoadDiagnostics(page, async markReadiness => { page.emit('load'); markReadiness(); });
    expect(page.evaluate).not.toHaveBeenCalled();
    expect(session.send).not.toHaveBeenCalled();
    expect(page.eventNames()).toEqual([]);
  });
});
