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
  it('names a stalled Chromium launch, closes Vite, and closes a browser that arrives late', async () => {
    const { server, createServer } = fakeVite();
    const late = fakeBrowser();
    let arrive;
    const chromium = { launch: vi.fn(() => new Promise(resolve => { arrive = () => resolve(late); })) };
    let temp;
    const viteConfig = vi.fn(dir => { temp = dir; return SCOPED; });

    const error = await startBrowserFixture({ name: 'example', createServer, viteConfig, chromium, phaseMs: PHASE_MS })
      .catch(caught => caught);

    expect(error.message).toMatch(/^example startup failed during Chromium launch: timed out after 50ms \(completed: Vite server start \d+ms; cleaned up\)$/);
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(existsSync(temp)).toBe(false);
    expect(chromium.launch.mock.calls[0][0]).toMatchObject({ timeout: 50, env: { TMPDIR: temp } });

    arrive();
    await vi.waitFor(() => expect(late.close).toHaveBeenCalledTimes(1));
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
