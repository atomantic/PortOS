/**
 * Tailcat CLI version floor for PortOS-managed install/detect.
 *
 * Modern `tailcat serve` defaults `--psk` to true (documented since v0.6.0).
 * Clients on ≤0.5.x can still DERP-ping (`--key=new` pong) while TCP
 * `forward` / PortOS health probes time out with `context deadline exceeded`.
 * PortOS refuses to drive forward/serve with an older binary rather than
 * silently disabling PSK.
 */

import { compareSemver } from './versionUtils.js';

/** Lowest Tailcat release PortOS will use for managed forward/serve. */
export const MIN_TAILCAT_VERSION = '0.6.0';

/**
 * Parse a `tailcat version` banner into a bare semver string, or `null`.
 *
 * Real CLI output is typically `v0.6.0` (leading `v`). Also accepts bare
 * `0.6.0` and banners that embed the token among other text. Leading `v` is
 * stripped so the result is safe for {@link compareSemver}.
 *
 * @param {string|null|undefined} text
 * @returns {string|null}
 */
export function parseTailcatVersion(text) {
  if (typeof text !== 'string') return null;
  // `v?` must be in the match: a word-boundary alone cannot split `v0.6.0`
  // (both `v` and `0` are word chars), so parseHarnessVersion would return null.
  const match = text.match(/v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i);
  return match ? match[1] : null;
}

/**
 * True when `version` is a parseable semver ≥ `minimum` (default
 * {@link MIN_TAILCAT_VERSION}).
 *
 * @param {string|null|undefined} version
 * @param {string} [minimum]
 * @returns {boolean}
 */
export function isTailcatVersionAtLeast(version, minimum = MIN_TAILCAT_VERSION) {
  if (typeof version !== 'string' || !version) return false;
  if (typeof minimum !== 'string' || !minimum) return false;
  return compareSemver(version, minimum) >= 0;
}

/**
 * Operator-facing upgrade guidance when detect/install cannot produce a
 * PSK-compatible Tailcat.
 *
 * @param {{ version?: string|null, platform?: string }} [opts]
 * @returns {string}
 */
export function tailcatVersionTooOldMessage({
  version = null,
  platform = process.platform,
} = {}) {
  const found = version ? `found ${version}` : 'could not determine version';
  const upgrade = platform === 'darwin'
    ? '`brew upgrade tailcat` (or `brew install tailcat` / `go install github.com/tailscale/tailcat/cmd/tailcat@latest`)'
    : '`go install github.com/tailscale/tailcat/cmd/tailcat@latest` or a release binary from https://github.com/tailscale/tailcat/releases';
  return (
    `tailcat ${MIN_TAILCAT_VERSION}+ is required for PSK-compatible forward/serve (${found}). `
    + `Upgrade with ${upgrade}, then retry. Do not set --psk=false to paper over an old client.`
  );
}
