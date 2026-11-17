/**
 * AppleScript fragment builders for the macOS screenshot script from
 * `xcodeScripts.js`: literal `osascript -e "…"` snippets baked into the
 * generated shell script, never executed here.
 */

// Single-line single-quoted `osascript -e 'tell application "<target>" to activate'`; the caller adds redirection.
export function activateAppLine(targetName) {
  return `osascript -e 'tell application "${targetName}" to activate'`;
}

/**
 * Build an `osascript -e "…"` block that runs an AppleScript body inside a
 * `tell process "<target>"` / `tell application "System Events"` wrapper.
 *
 * Options: `body` (statements nested in the process tell, 8-space indented),
 * `activate` (prefix `tell application "<target>" to activate`), `redirect`
 * (shell redirection after the closing quote). The result is double-quoted, so
 * inner string literals use `\"` escapes.
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
