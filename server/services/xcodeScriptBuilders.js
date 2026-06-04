/**
 * AppleScript fragment builders for the macOS screenshot automation script
 * emitted by `xcodeScripts.js` (`generateMacScreenshotScript`).
 *
 * These produce the literal `osascript -e "…"` shell snippets that get baked
 * into the generated `take_screenshots_macos.sh`. They are NOT executed here —
 * the strings are written verbatim into the bash script the user runs.
 *
 * The macOS screenshot script drives the app through System Events
 * accessibility scripting; every UI-automation helper repeats the same
 * `tell application "System Events" / tell process "<target>"` wrapper and an
 * optional leading `tell application "<target>" to activate`. Collapsing that
 * boilerplate into one builder keeps the five helpers (setup_window,
 * click_sidebar, click_at, go_back, capture_window) from drifting and removes
 * the bulk of the repeated AppleScript in the file.
 *
 * Kept as a sibling `server/services` module (not `server/lib`) because it is
 * specific to the Xcode script generator and not a general-purpose helper.
 */

/**
 * Emit a single-line `osascript -e 'tell application "<target>" to activate'`
 * snippet (single-quoted form). The trailing redirection is the caller's.
 */
export function activateAppLine(targetName) {
  return `osascript -e 'tell application "${targetName}" to activate'`;
}

/**
 * Build an `osascript -e "…"` block that runs an AppleScript body inside a
 * `tell process "<target>"` / `tell application "System Events"` wrapper.
 *
 * Options:
 *   - body:        AppleScript statements to nest inside the process tell
 *                  block. Lines are emitted with 8-space indentation so the
 *                  output matches the hand-written originals.
 *   - activate:    when true, prefix the script with
 *                  `tell application "<target>" to activate` (double-quoted,
 *                  escaped for the outer double-quoted shell string).
 *   - redirect:    shell redirection appended after the closing quote
 *                  (e.g. ` 2>/dev/null` or ` 2>/dev/null || true`).
 *
 * The result is double-quoted (`osascript -e "…"`) so `\"` escapes are used
 * for the inner AppleScript string literals, matching the originals exactly.
 */
export function osascriptSystemEvents(targetName, { body, activate = false, redirect = '' } = {}) {
  const lines = [];
  lines.push('    osascript -e "');
  if (activate) {
    lines.push(`    tell application \\"${targetName}\\" to activate`);
  }
  lines.push('    tell application \\"System Events\\"');
  lines.push(`        tell process \\"${targetName}\\"`);
  for (const bodyLine of body) {
    lines.push(bodyLine);
  }
  lines.push('        end tell');
  lines.push(`    end tell"${redirect}`);
  return lines.join('\n');
}
