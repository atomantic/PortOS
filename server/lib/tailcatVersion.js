/**
 * Tailcat CLI version floor for managed install/detect.
 *
 * `MIN_TAILCAT_VERSION` (`0.6.0`: modern `tailcat serve` defaults `--psk` on), `parseTailcatVersion` (handles the CLI's `v0.6.0` banner that `parseHarnessVersion` cannot), `isTailcatVersionAtLeast`, and `tailcatVersionTooOldMessage` for operator-facing upgrade guidance. Consumed by `services/tailcatPeer.js` so Dial-them and They-dial-us refuse ≤0.5.x: such clients can still DERP-ping while TCP `forward` / health probes time out with `context deadline exceeded`, and PortOS refuses an older binary rather than silently disabling PSK.
 */

import { compareSemver } from './versionUtils.js';

/** Lowest Tailcat release PortOS will use for managed forward/serve. */
export const MIN_TAILCAT_VERSION = '0.6.0';

/** Reviewed upstream release used by the Go install fallback. */
export const PINNED_TAILCAT_VERSION = '0.6.0';

/**
 * Parse a `tailcat version` banner into a bare semver string, or `null`: accepts `v0.6.0` (typical), bare `0.6.0`, and banners embedding the token; the leading `v` is stripped so the result suits {@link compareSemver}.
 *
 * @param {string|null|undefined} text
 * @returns {string|null}
 */
export function parseTailcatVersion(text) {
  if (typeof text !== 'string') return null;
  // `v?` must be in the match: a word boundary can't split `v0.6.0` (`v` and `0` are both word chars), so parseHarnessVersion would return null.
  const match = text.match(/v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i);
  return match ? match[1] : null;
}

/**
 * True when `version` is a parseable semver >= `minimum` (default {@link MIN_TAILCAT_VERSION}).
 *
 * @param {string|null|undefined} version
 * @param {string} [minimum]
 */
export function isTailcatVersionAtLeast(version, minimum = MIN_TAILCAT_VERSION) {
  if (typeof version !== 'string' || !version) return false;
  if (typeof minimum !== 'string' || !minimum) return false;
  return compareSemver(version, minimum) >= 0;
}

/**
 * Operator-facing upgrade guidance when detect/install can't produce a PSK-compatible Tailcat.
 *
 * @param {{ version?: string|null, platform?: string }} [opts]
 * @returns {string}
 */
export function tailcatVersionTooOldMessage({
  version = null,
  platform = process.platform,
} = {}) {
  const found = version ? `found ${version}` : 'could not determine version';
  const goInstall = `\`go install github.com/tailscale/tailcat/cmd/tailcat@v${PINNED_TAILCAT_VERSION}\``;
  const upgrade = platform === 'darwin'
    ? `\`brew upgrade tailcat\` (or \`brew install tailcat\` / ${goInstall})`
    : `${goInstall} or a release binary from https://github.com/tailscale/tailcat/releases`;
  return (
    `tailcat ${MIN_TAILCAT_VERSION}+ is required for PSK-compatible forward/serve (${found}). `
    + `Upgrade with ${upgrade}, then retry. Do not set --psk=false to paper over an old client.`
  );
}
