/**
 * Shared Python-sidecar process runner — the STAGE:/RESULT: wire protocol.
 *
 * Every media sidecar (scripts/generate_musicgen.py, generate_audioldm2.py,
 * generate_acestep.py, transcribe_muscriptor.py, …) speaks the same contract:
 * `STAGE:<name>[:detail]` lines on stderr drive the JS-side phase/progress
 * display, and a final `RESULT:<json>` line on stdout reports what was
 * produced. This module holds the one spawn/stream/close implementation so
 * consumers (pipeline/musicGen.js, audioMidiTranscription.js) can't drift on
 * the protocol.
 *
 * Not a route handler — the spawn-error / close branches run outside the
 * Express lifecycle and must not throw, so they resolve a structured result
 * instead.
 */

import { spawn } from 'child_process';

// Only the trailing RESULT: line is ever consumed, and sidecar runs are
// long-lived (first-run weight downloads, multi-minute inference) — so both
// streams are tail-capped rather than accumulated unbounded. stdout keeps
// enough for a generous RESULT payload; stderr keeps enough for a useful
// failure tail.
const STDOUT_TAIL = 16_000;
const STDERR_TAIL = 4000;

/**
 * Pull the sidecar's final `RESULT:<json>` line out of its stdout. Returns
 * null when no parseable result line is present so the caller can fail with a
 * useful message instead of a malformed success.
 */
export function parseSidecarResult(stdout) {
  const line = (stdout || '').split(/\r?\n/).reverse().find((l) => l.startsWith('RESULT:'));
  if (!line) return null;
  try {
    return JSON.parse(line.slice('RESULT:'.length));
  } catch {
    return null;
  }
}

/**
 * Spawn a sidecar and resolve `{ ok, stdout, canceled?, reason? }`.
 *
 * - `onStage(stage, detail, raw)` fires once per `STAGE:` line on stderr —
 *   the caller decides what to do with it (log, SSE frame, idle-watchdog
 *   reset). `raw` is the full text after the `STAGE:` prefix.
 * - `onProcess(proc | null)` hands the live child to the caller for external
 *   cancel tracking (killWithEscalation); called with null once it exits.
 * - `signal` (optional AbortSignal) SIGTERMs the child; an already-aborted
 *   signal resolves canceled without spawning (a cancel arriving between the
 *   caller creating the controller and this executor running would otherwise
 *   be silently missed).
 * - A SIGTERM/SIGKILL exit resolves `{ ok: false, canceled: true }`; a
 *   non-zero exit carries the last few stderr lines as `reason`.
 */
export function runSidecarProcess({ bin, args, env, signal, onStage, onProcess }) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, canceled: true, reason: 'cancelled (aborted before spawn)', stdout: '' });
      return;
    }
    const proc = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    onProcess?.(proc);
    let stdoutTail = '';
    let stderrTail = '';
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      cleanup();
      onProcess?.(null);
      resolve(val);
    };

    let onAbort = null;
    const cleanup = () => { if (signal && onAbort) signal.removeEventListener('abort', onAbort); };
    if (signal) {
      onAbort = () => proc.kill('SIGTERM');
      signal.addEventListener('abort', onAbort, { once: true });
    }

    proc.stdout.on('data', (chunk) => {
      stdoutTail = (stdoutTail + chunk.toString()).slice(-STDOUT_TAIL);
    });
    proc.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      stderrTail = (stderrTail + s).slice(-STDERR_TAIL);
      for (const line of s.split(/\r?\n/)) {
        const t = line.trim();
        if (t.startsWith('STAGE:')) {
          const raw = t.slice('STAGE:'.length);
          const [stage, detail] = raw.split(':');
          onStage?.(stage, detail || null, raw);
        }
      }
    });
    proc.on('error', (err) => finish({ ok: false, reason: `spawn failed: ${err.message}`, stdout: stdoutTail }));
    proc.on('close', (code, sig) => {
      if (sig === 'SIGTERM' || sig === 'SIGKILL') {
        finish({ ok: false, canceled: true, reason: `cancelled (${sig})`, stdout: stdoutTail });
        return;
      }
      if (code !== 0) {
        const tail = stderrTail.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
        finish({ ok: false, reason: tail || `exit ${code}`, stdout: stdoutTail });
        return;
      }
      finish({ ok: true, stdout: stdoutTail });
    });
  });
}
