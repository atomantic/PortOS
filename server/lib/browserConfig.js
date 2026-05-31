export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function deriveMacAppBundleFromChromePath(chromePath) {
  if (!isNonEmptyString(chromePath)) return null;
  const normalized = chromePath.trim().replaceAll('\\', '/');
  const appMarker = '.app/';
  const appIndex = normalized.toLowerCase().indexOf(appMarker);
  if (appIndex < 0) return null;
  return normalized.slice(0, appIndex + '.app'.length);
}

export function hasConfiguredBrowser(config) {
  return isNonEmptyString(config?.chromePath) || isNonEmptyString(config?.macAppBundle);
}

export function normalizeBrowserConfig(config) {
  const next = { ...(config || {}) };
  if (!isNonEmptyString(next.macAppBundle)) {
    const derived = deriveMacAppBundleFromChromePath(next.chromePath);
    if (derived) next.macAppBundle = derived;
  }
  return next;
}

export function isMacAppBundlePath(value) {
  if (!isNonEmptyString(value)) return false;
  return /(^|[/\\])[^/\\]+\.app[/\\]?$/i.test(value.trim());
}

export function validateChromePath(value) {
  if (!isNonEmptyString(value)) return null;
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
  if (!isNonEmptyString(value)) return null;
  if (!isMacAppBundlePath(value)) return 'macAppBundle must point to a macOS .app bundle';
  return null;
}
