/**
 * Normalize a provider command to its comparable binary basename.
 *
 * Strips the directory, lowercases, and drops a Windows `.exe` suffix so a
 * provider configured as `/opt/homebrew/bin/agy`, `AGY`, or `cursor-agent.exe`
 * still matches the bare name. Deliberately does NOT strip `.cmd`/`.bat`: those
 * are npm shim wrappers whose behavior can differ from the native binary, so a
 * predicate that wants them must say so.
 *
 * @param {string|null|undefined} command
 * @returns {string} the normalized basename, or '' for a non-string/empty input
 */
export function commandBasename(command) {
  if (typeof command !== 'string' || command === '') return '';
  return command.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
}
