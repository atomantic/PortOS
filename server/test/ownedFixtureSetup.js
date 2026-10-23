import { browserCleanupDeadline } from '../../scripts/lib/ownedBrowserCleanup.js';

/** Own the whole setup continuation, including work before browser launch.
 * Phase operations must retain acquired resources before returning. close()
 * stops admission immediately, then waits for that continuation before cleanup.
 */
export function createOwnedFixtureSetup({ cleanup, timeoutMs = 30000, report = message => console.log(message) }) {
  let task, closing, started, stopped = false, active = 'not-started';
  const phases = [];
  const elapsed = () => Math.max(0, Math.round(performance.now() - started));
  const evidence = () => `phase=${active} elapsed=${elapsed()}ms completed=${phases.join(',') || 'none'}`;
  const assertActive = () => {
    if (stopped || elapsed() >= timeoutMs) throw new Error(`Fixture setup stopped; ${evidence()}`);
  };
  const phase = async (label, work) => {
    // Labels are static identifiers, never paths, launch errors or user data.
    if (!/^[a-z0-9-]{1,48}$/.test(label) || phases.length >= 32) throw new Error('Invalid fixture setup phase');
    assertActive();
    active = label;
    const began = elapsed();
    const value = await work(Math.max(1, timeoutMs - elapsed()));
    phases.push(`${label}:${elapsed() - began}ms`);
    assertActive();
    return value;
  };
  return {
    run(work) {
      if (task || stopped) throw new Error('Fixture setup already started or closed');
      started = performance.now();
      task = Promise.resolve().then(() => work(phase));
      return browserCleanupDeadline(task, timeoutMs, () => {
        stopped = true;
        return new Error(`Fixture setup deadline; ${evidence()}`);
      }).then(value => {
        report(`⏱️ Fixture setup ready; ${evidence()}`);
        return value;
      }, error => {
        stopped = true;
        report(`⏱️ Fixture setup failed; ${evidence()}`);
        throw error;
      });
    },
    close() {
      stopped = true;
      return closing ??= (async () => {
        if (task) {
          report(`⏱️ Fixture setup teardown waiting; ${evidence()}`);
          // The setup verdict is owned by run(); cleanup errors remain failures.
          await task.catch(() => {});
        }
        await cleanup();
      })();
    },
  };
}
