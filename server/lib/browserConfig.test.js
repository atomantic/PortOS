import { describe, expect, it } from 'vitest';
import {
  deriveMacAppBundleFromChromePath,
  hasConfiguredBrowser,
  normalizeBrowserConfig,
  validateChromePath,
  validateMacAppBundle,
} from './browserConfig.js';

describe('browserConfig', () => {
  it('derives a macOS app bundle from an executable inside the bundle', () => {
    expect(deriveMacAppBundleFromChromePath('/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'))
      .toBe('/Applications/Google Chrome Canary.app');
  });

  it('normalizes config by filling macAppBundle when chromePath points inside an app', () => {
    expect(normalizeBrowserConfig({
      chromePath: '/Users/me/Applications/Chromium.app/Contents/MacOS/Chromium',
    })).toEqual({
      chromePath: '/Users/me/Applications/Chromium.app/Contents/MacOS/Chromium',
      macAppBundle: '/Users/me/Applications/Chromium.app',
    });
  });

  it('treats either chromePath or macAppBundle as an existing custom browser choice', () => {
    expect(hasConfiguredBrowser({ chromePath: '' })).toBe(false);
    expect(hasConfiguredBrowser({ macAppBundle: '/Applications/Brave Browser.app' })).toBe(true);
    expect(hasConfiguredBrowser({ chromePath: '/usr/bin/chromium' })).toBe(true);
  });

  it('rejects a macOS app bundle in chromePath', () => {
    expect(validateChromePath('/Applications/Google Chrome Canary.app'))
      .toMatch(/executable inside the \.app bundle/);
  });

  it('requires Windows-style chromePath values to point at an exe', () => {
    expect(validateChromePath('C:\\Program Files\\Google\\Chrome SxS\\Application\\chrome.exe')).toBe(null);
    expect(validateChromePath('C:\\Program Files\\Google\\Chrome SxS\\Application')).toMatch(/Windows \.exe/);
  });

  it('requires macAppBundle to be a .app path', () => {
    expect(validateMacAppBundle('/Applications/Google Chrome Canary.app')).toBe(null);
    expect(validateMacAppBundle('/Applications/Google Chrome Canary')).toMatch(/\.app bundle/);
  });
});
