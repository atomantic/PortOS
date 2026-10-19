// A CDP setup command that never answers must leave evidence of which step,
// connection and owned-child state it stalled in, read before cleanup and
// without page content or paths (#12294). Real Chrome cannot hang on demand,
// so a scripted pipe transport stands in for the owned browser.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

vi.mock('../../lib/fileUtils.js', async importOriginal => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-composition-setup-diagnostics-'),
}));

const owner = vi.hoisted(() => ({ order: [], transport: null, sent: null }));
vi.mock('./ownedBrowser.js', () => ({
  launchCompositionBrowser: async () => ({
    transport: owner.transport,
    lifecycleFacts: () => {
      owner.order.push('facts');
      return { childSpawned: true, childExited: false, childClosed: false, exitCode: 'none', signalCode: 'none' };
    },
    close: async () => { owner.order.push('close'); },
  }),
}));

const REPLIES = {
  'Target.createBrowserContext': { browserContextId: 'context-example' },
  'Target.createTarget': { targetId: 'target-example' },
  'Target.attachToTarget': { sessionId: 'session-example' },
};

// Answers browser-level setup, then leaves `stallOn` pending forever.
function scriptedTransport(stallOn) {
  const emitter = new EventEmitter();
  let stalled;
  owner.sent = new Promise(resolve => { stalled = resolve; });
  return {
    readyState: 1,
    send(text, callback) {
      callback?.();
      const { id, method } = JSON.parse(text);
      if (method === stallOn) return stalled();
      setImmediate(() => emitter.emit('message', Buffer.from(JSON.stringify({ id, result: REPLIES[method] ?? {} }))));
    },
    terminate() { this.readyState = 3; },
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
  };
}

const { PATHS } = await import('../../lib/fileUtils.js');
const { openComposition } = await import('./browser.js');

afterEach(() => { vi.useRealTimers(); owner.order = []; });
afterAll(() => cleanupTempDataRoots());

describe('composition CDP setup timeout evidence', () => {
  it('names the stalled phase, session and owned-child state before cleanup, without content or paths', async () => {
    const directory = 'compositions/setup-diagnostics';
    await mkdir(join(PATHS.data, directory), { recursive: true });
    await writeFile(join(PATHS.data, directory, 'index.html'), '<html><body>private-marker</body></html>');
    owner.transport = scriptedTransport('Page.enable');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const opened = openComposition(directory, { ownedBrowser: true }).catch(error => error);
    await owner.sent;
    await vi.advanceTimersByTimeAsync(30000);
    const error = await opened;

    expect(error.message).toMatch(/^Browser command timed out: Page\.enable \(/);
    expect(error.message).toContain('phase=session-setup');
    expect(error.message).toContain('context=created, session=attached, transport=open');
    expect(error.message).toContain('events=none');
    expect(error.message).toContain('childSpawned=true, childExited=false, childClosed=false, exitCode=none, signalCode=none');
    expect(error.message).not.toContain('private-marker');
    expect(error.message).not.toContain(PATHS.data);
    expect(error.message).not.toContain('session-example');
    expect(owner.order).toEqual(['facts', 'close']);
  });
});
