// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { startBrowserFixture } from './browserFixture.js';

const PHASE_MS = { vite: 50, chromium: 50, warmup: 50, cleanup: 50 };
const SCOPED = { optimizeDeps: { entries: ['src/Example.jsx'] } };

const fakeVite = () => {
  const server = { listen: vi.fn(async () => {}), close: vi.fn(async () => {}),
    resolvedUrls: { local: ['http://127.0.0.1:1/'] } };
  return { server, createServer: vi.fn(async () => server) };
};
const fakeBrowser = (page) => ({ close: vi.fn(async () => {}), newPage: vi.fn(async () => page) });

describe('startBrowserFixture', () => {
  it('retries a stalled Chromium launch once, then names the phase and closes every browser that arrives late', async () => {
    const { server, createServer } = fakeVite();
    const late = [fakeBrowser(), fakeBrowser()];
    const arrive = [];
    const chromium = { launch: vi.fn(() => new Promise(resolve => {
      const browser = late[arrive.length];
      arrive.push(() => resolve(browser));
    })) };
    let temp;
    const viteConfig = vi.fn(dir => { temp = dir; return SCOPED; });

    const error = await startBrowserFixture({ name: 'example', createServer, viteConfig, chromium, phaseMs: PHASE_MS })
      .catch(caught => caught);

    expect(error.message).toMatch(/^example startup failed during Chromium launch: timed out after 50ms \(retried after a first attempt timed out after 25ms\) \(completed: Vite server start \d+ms; cleaned up\)$/);
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(existsSync(temp)).toBe(false);
    // Each attempt is a fresh process whose own launch timeout kills it.
    expect(chromium.launch.mock.calls.map(([options]) => options.timeout)).toEqual([25, 25]);
    expect(chromium.launch.mock.calls[1][0]).toMatchObject({ env: { TMPDIR: temp } });

    arrive[1]();
    arrive[0]();
    await vi.waitFor(() => {
      expect(late[0].close).toHaveBeenCalledTimes(1);
      expect(late[1].close).toHaveBeenCalledTimes(1);
    });
  });

  it('uses the retried launch and closes the first one when it arrives late', async () => {
    const { server, createServer } = fakeVite();
    const stalled = fakeBrowser();
    const retried = fakeBrowser();
    let arrive;
    const chromium = { launch: vi.fn()
      .mockReturnValueOnce(new Promise(resolve => { arrive = () => resolve(stalled); }))
      .mockResolvedValueOnce(retried) };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const fixture = await startBrowserFixture({ name: 'example', createServer, viteConfig: () => SCOPED, chromium,
      phaseMs: PHASE_MS });

    expect(fixture.browser).toBe(retried);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/Chromium launch \d+ms \(retried after a first attempt timed out after 25ms\)/));
    log.mockRestore();
    arrive();
    await vi.waitFor(() => expect(stalled.close).toHaveBeenCalledTimes(1));

    await fixture.close();
    expect(retried.close).toHaveBeenCalledTimes(1);
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(existsSync(fixture.temp)).toBe(false);
  });

  it('names a stalled Vite start and never listens on a server that arrives late', async () => {
    const { server } = fakeVite();
    let arrive;
    const createServer = vi.fn(() => new Promise(resolve => { arrive = () => resolve(server); }));
    const chromium = { launch: vi.fn() };

    const error = await startBrowserFixture({ name: 'example', createServer, viteConfig: () => SCOPED, chromium,
      phaseMs: PHASE_MS }).catch(caught => caught);

    expect(error.message).toMatch(/^example startup failed during Vite server start: timed out after 50ms \(completed: none; cleaned up\)$/);
    expect(chromium.launch).not.toHaveBeenCalled();

    arrive();
    await vi.waitFor(() => expect(server.close).toHaveBeenCalledTimes(1));
    expect(server.listen).not.toHaveBeenCalled();
  });

  it('closes the launched browser and Vite when the warmup page fails', async () => {
    const { server, createServer } = fakeVite();
    const page = { close: vi.fn(async () => {}) };
    const browser = fakeBrowser(page);
    const chromium = { launch: vi.fn(async () => browser) };
    const cause = new Error('net::ERR_CONNECTION_REFUSED');

    const error = await startBrowserFixture({ name: 'example', createServer, viteConfig: () => SCOPED, chromium,
      phaseMs: PHASE_MS, warmup: async () => { throw cause; } }).catch(caught => caught);

    expect(error.message).toMatch(/during first page warmup: net::ERR_CONNECTION_REFUSED \(completed: Vite server start \d+ms, Chromium launch \d+ms; cleaned up\)/);
    expect(error.cause).toBe(cause);
    expect(page.close).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(server.close).toHaveBeenCalledTimes(1);
  });
});
