/**
 * The round-trip "can this shell run commands yet?" probe for a PTY session, in the dialect the session speaks.
 *
 * `buildReadinessProbe(nonce, shell)`: the round-trip "can this shell actually run commands yet?" probe `createShellSession`'s `waitForPromptReady` (`services/shell.js`) sends and watches for, in the dialect the session speaks: POSIX `printf '%s\n' 'PORTOSRDY''<nonce>'`, PowerShell `Write-Output ('PORTOSRDY' + '<nonce>')`, `cmd.exe` → `null`.
 * It prints a unique nonce the caller must SEE in the PTY output before injecting the real command (proof the shell is executing, not echoing keystrokes). The split-literal property is load-bearing in every dialect: the probe SOURCE never contains the assembled `PORTOSRDY<nonce>`, only two halves, so seeing it can only mean the shell EXECUTED the probe.
 * `cmd.exe` has no concatenation operator (`echo` prints its argument as typed), so the marker can't stay split in source yet appear in output; `null` tells the caller to skip to the bounded fallback timer rather than risk an always-matching probe.
 */
import { detectShellFlavor } from './shellCd.js';

/**
 * @param {string} nonce - unique per-probe token (opaque; not shell-quoted, so
 *   callers must keep it to a safe charset, e.g. hex)
 * @param {string} [shell] - the session's shell binary; see detectShellFlavor
 * @returns {string|null} a single command line with no trailing terminator,
 *   or `null` when this dialect has no safe split-literal probe
 */
export function buildReadinessProbe(nonce, shell) {
  switch (detectShellFlavor(shell)) {
    case 'cmd': return null;
    case 'powershell': return `Write-Output ('PORTOSRDY' + '${nonce}')`;
    default: return `printf '%s\\n' 'PORTOSRDY''${nonce}'`;
  }
}
