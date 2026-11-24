/**
 * Settles the crash handlers of one fixture-owned Chrome on macOS (#18438).
 *
 * Full Chrome starts `chrome_crashpad_handler` in its own session, reparented to
 * launchd, so neither Playwright's process-group kill nor the fixture's exit
 * proof covers it. Unbranded builds start a second handler to monitor the first.
 * A handler exits when the last process holding the crash exception port it
 * serves is gone, and every Chrome descendant inherits that port. Normally that
 * is tens of milliseconds after the browser; a descendant still exiting (or one
 * that detached) keeps the handlers alive after a successful browser close. No
 * switch in a macOS build skips the handler: `--disable-breakpad` leaves it
 * running and `--disable-crashpad-for-testing` is not compiled in.
 *
 * A handler's arguments name no profile, only its crash database, which by
 * default every Chrome of the same brand shares. Each owned launch therefore
 * gets a private database, and only processes serving exactly that one are ever
 * signalled. The arguments identify a handler even in a hardened build, where
 * macOS hides the environment that run-level containment reads.
 */
import { realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { browserCleanupDeadline } from './ownedBrowserCleanup.js';
import { probeTestPid, readTestProcessesAsync, testProcessSettlement } from './testOwnedProcesses.js';

const POLL_MS = 25;

/**
 * @param {string} root - the launch's private directory; the database is created under it
 * @param {object} [options]
 * @param {string} [options.name] - database directory name, distinct for each launch sharing a root
 * @returns {{ env: object, identify: (ms: number) => void, settle: (ms: number) => Promise<string> }}
 *   `env` goes to the launch, `identify` runs once its browser is up, and `settle` after that browser's exit
 *   resolves redacted evidence or rejects when a handler's exit is unproven.
 */
export function ownedCrashHandlers(root, {
  name = 'crashpad', platform = process.platform, graceMs = 500,
  read = readTestProcessesAsync, probe = probeTestPid, kill = (pid, signal) => process.kill(pid, signal),
  now = () => performance.now(), wait = delay,
} = {}) {
  if (platform !== 'darwin') return { env: {}, identify() {}, settle: async () => 'unsupported' };
  // Chrome resolves the directory before passing it to the handler.
  const database = join(realpathSync(root), name);
  const serves = ({ args, terminal }) => !terminal && basename(args?.[0] ?? '') === 'chrome_crashpad_handler'
    && args.filter(arg => arg.startsWith('--database=')).join('\0') === `--database=${database}`;
  const inventory = async (timeoutMs) => {
    const records = await read(null, { timeoutMs });
    return records?.filter(record => serves(record) && typeof record.start === 'string' && record.start)
      .map(({ pid, start }) => ({ pid, start })) ?? null;
  };
  let identified = null;

  const settle = async (budgetMs) => {
    const deadline = now() + budgetMs;
    const left = () => Math.max(1, Math.ceil(deadline - now()));
    const unavailable = () => new Error('Owned browser crash handler inventory unavailable');
    const handlers = await browserCleanupDeadline(
      Promise.resolve(identified).then(known => known ?? inventory(left())), left(), unavailable);
    if (!handlers) throw unavailable();
    const graceEnds = Math.min(deadline, now() + graceMs);
    const pending = new Set(handlers);
    const attempted = new Set();
    let signalled = 0;
    const evidence = () => `found=${handlers.length} signalled=${signalled} settled=${handlers.length - pending.size}`;
    const stopOwned = (handler, records) => {
      if (testProcessSettlement(handler, records, probe) === 'terminated') { pending.delete(handler); return; }
      const current = records?.find(record => record.pid === handler.pid);
      // Signal only a freshly re-proven incarnation, and never the same one twice.
      if (attempted.has(handler) || current?.start !== handler.start || !serves(current)) return;
      attempted.add(handler);
      try { kill(handler.pid, 'SIGKILL'); signalled++; } catch { /* its settlement stays unproven */ }
    };
    for (;;) {
      for (const handler of pending) if (probe(handler.pid) === false) pending.delete(handler);
      if (!pending.size) break;
      if (now() >= deadline) throw new Error(`Owned browser crash handler exit unconfirmed: ${evidence()}`);
      if (now() >= graceEnds) {
        const records = await read([...pending].map(handler => handler.pid), { timeoutMs: left() });
        for (const handler of [...pending]) stopOwned(handler, records);
      }
      await wait(Math.min(POLL_MS, left()));
    }
    if (signalled) console.log(`🧹 Owned browser crash handlers outlived their browser: ${evidence()}`);
    return evidence();
  };

  return {
    env: { BREAKPAD_DUMP_LOCATION: database },
    // Chrome completes its handler handshake before it accepts a connection, so
    // a launched browser's handlers all exist by now. A failed read leaves the
    // identities unknown, and settle inventories again.
    identify(timeoutMs) { identified ??= inventory(timeoutMs).catch(() => null); },
    settle,
  };
}
