// @vitest-environment node

import { describe, it, expect, afterEach, vi } from 'vitest';

// `isMac`/`modKey` are evaluated once at module load, so every case has to
// reset the module registry and re-import after stubbing `navigator`.
async function loadPlatform(navigatorStub) {
  vi.resetModules();
  if (navigatorStub === undefined) vi.stubGlobal('navigator', undefined);
  else vi.stubGlobal('navigator', navigatorStub);
  return import('./platform.js');
}

describe('platform', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('detects macOS from userAgentData.platform', async () => {
    const { isMac, modKey } = await loadPlatform({ userAgentData: { platform: 'macOS' }, platform: 'Win32' });
    expect(isMac).toBe(true);
    expect(modKey).toBe('⌘');
  });

  it('prefers userAgentData over the legacy navigator.platform', async () => {
    const { isMac } = await loadPlatform({ userAgentData: { platform: 'Windows' }, platform: 'MacIntel' });
    expect(isMac).toBe(false);
  });

  it('falls back to navigator.platform when userAgentData is absent', async () => {
    const { isMac, modKey } = await loadPlatform({ platform: 'MacIntel' });
    expect(isMac).toBe(true);
    expect(modKey).toBe('⌘');
  });

  it.each(['iPhone', 'iPad', 'iPod'])('treats %s as a Mac-family platform', async (platform) => {
    const { isMac } = await loadPlatform({ platform });
    expect(isMac).toBe(true);
  });

  it('reports non-Mac platforms with the Ctrl modifier label', async () => {
    const { isMac, modKey } = await loadPlatform({ platform: 'Linux x86_64' });
    expect(isMac).toBe(false);
    expect(modKey).toBe('Ctrl');
  });

  it('does not throw when navigator is unavailable (SSR / node context)', async () => {
    const { isMac, modKey } = await loadPlatform(undefined);
    expect(isMac).toBe(false);
    expect(modKey).toBe('Ctrl');
  });

  it('treats a navigator with neither platform field as non-Mac', async () => {
    const { isMac } = await loadPlatform({});
    expect(isMac).toBe(false);
  });
});
