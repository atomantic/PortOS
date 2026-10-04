import { isNonBlankStr } from './textUtils.js';

/** Same executable for managed browsing and isolated headless rendering. */
export function browserExecutablePath(config, os = process.platform) {
  if (isNonBlankStr(config?.chromePath)) return config.chromePath;
  if (os === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (os === 'win32') return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  return 'google-chrome';
}

export function deriveMacAppBundleFromChromePath(chromePath) {
  if (!isNonBlankStr(chromePath)) return null;
  const normalized = chromePath.trim().replaceAll('\\', '/');
  const appMarker = '.app/';
  const appIndex = normalized.toLowerCase().indexOf(appMarker);
  if (appIndex < 0) return null;
  return normalized.slice(0, appIndex + '.app'.length);
}

export function hasConfiguredBrowser(config) {
  return isNonBlankStr(config?.chromePath) || isNonBlankStr(config?.macAppBundle);
}

export function normalizeBrowserConfig(config) {
  const next = { ...(config || {}) };
  if (!isNonBlankStr(next.macAppBundle)) {
    const derived = deriveMacAppBundleFromChromePath(next.chromePath);
    if (derived) next.macAppBundle = derived;
  }
  return next;
}

export function isMacAppBundlePath(value) {
  if (!isNonBlankStr(value)) return false;
  return /(^|[/\\])[^/\\]+\.app[/\\]?$/i.test(value.trim());
}

export function validateChromePath(value) {
  if (!isNonBlankStr(value)) return null;
  const trimmed = value.trim();
  if (/[\\/]$/.test(trimmed)) return 'chromePath must point to an executable file, not a directory';
  if (isMacAppBundlePath(trimmed)) {
    return 'chromePath must point to the executable inside the .app bundle; use macAppBundle for the bundle path';
  }
  if ((/^[a-z]:[\\/]/i.test(trimmed) || trimmed.includes('\\')) && !/\.exe$/i.test(trimmed)) {
    return 'chromePath must point to a Windows .exe file';
  }
  return null;
}

export function validateMacAppBundle(value) {
  if (!isNonBlankStr(value)) return null;
  if (!isMacAppBundlePath(value)) return 'macAppBundle must point to a macOS .app bundle';
  return null;
}
