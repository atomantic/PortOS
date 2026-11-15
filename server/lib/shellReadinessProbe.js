/**
 * Build the round-trip "can this shell actually run commands yet?" probe for
 * the shell a PTY session is actually running (see `createShellSession`'s
 * `waitForPromptReady` in `services/shell.js`).
 *
 * `buildReadinessProbe(nonce, shell)` — the round-trip "can this shell actually run commands yet?"
 * probe `createShellSession`'s `waitForPromptReady` sends and watches for, in the dialect the session
 * speaks: POSIX `printf '%s\n' 'PORTOSRDY''<nonce>'` (unchanged), PowerShell `Write-Output
 * ('PORTOSRDY' + '<nonce>')`, `cmd.exe` → `null` (no split-literal concatenation operator exists
 * there, so the caller skips straight to the bounded fallback timer instead of risking an
 * always-matching probe). The split-literal property is load-bearing in every dialect: the probe
 * source never contains the assembled marker, so seeing it in the output can only mean the shell
 * executed the probe.
 *
 * The probe prints a unique nonce and the caller waits to SEE it in the PTY
 * output before injecting the real command — proof the shell is executing,
 * not just echoing keystrokes. The split-literal property is load-bearing and
 * must survive in every dialect: the probe SOURCE must never contain the
 * assembled `PORTOSRDY<nonce>` string, only its two halves as separate
 * literals, so a sighting of the assembled marker in the output can only mean
 * the shell EXECUTED the probe (not merely echoed the command line back).
 *
 * `printf` (POSIX) and `Write-Output` (PowerShell) both support string
 * concatenation from two literals, so both dialects get a real probe.
 * `cmd.exe` has no such operator — `echo` prints its argument line as typed —
 * so there is no way to keep the marker split in `cmd`'s source while still
 * producing it in the output; `null` tells the caller to skip straight to the
 * bounded fallback timer instead of risking an always-matching probe.
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
    // Keep byte-identical to the pre-dialect-aware probe.
    default: return `printf '%s\\n' 'PORTOSRDY''${nonce}'`;
  }
}
