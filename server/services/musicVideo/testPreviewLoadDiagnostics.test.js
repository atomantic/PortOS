import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _withTestPreviewLoadDiagnostics } from './testPreviewLoadDiagnostics.js';

function fixture(evaluate = vi.fn().mockResolvedValue({ readyState: 'interactive', compositionReady: false,
  scriptCount: 3, moduleCount: 1, externalScriptCount: 0 })) {
  return Object.assign(new EventEmitter(), { evaluate, isClosed: () => false,
    context: () => ({ browser: () => ({ isConnected: () => true }) }) });
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
    expect(snapshot(failure)).toMatchObject({ pageClosed: true, browserConnected: false, documentProbe: 'unavailable' });
    expect(page.eventNames()).toEqual([]);
  });

  it('does not probe or retain observers after successful load and semantic readiness', async () => {
    const page = fixture();
    await _withTestPreviewLoadDiagnostics(page, async markReadiness => { page.emit('load'); markReadiness(); });
    expect(page.evaluate).not.toHaveBeenCalled();
    expect(page.eventNames()).toEqual([]);
  });
});
