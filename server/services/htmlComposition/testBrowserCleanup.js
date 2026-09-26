import { killWithEscalation } from '../../lib/killWithEscalation.js';

async function withinDeadline(action, timeoutMs, stage) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Test Chrome ${stage} exceeded ${timeoutMs}ms deadline`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function terminateOwnedChrome(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  let escalation;
  let onExit;
  // Subscribe before kill. Wait for exit, not stdio close: Chrome descendants
  // can retain stderr after the owned process has terminated.
  const exited = new Promise(resolve => {
    onExit = resolve;
    proc.once('exit', onExit);
  });
  try {
    await withinDeadline(() => {
      escalation = killWithEscalation(proc, {
        label: 'HTML composition test Chrome',
        stillRunning: () => proc.exitCode === null && proc.signalCode === null,
        delayMs: 3000,
      });
      return exited;
    }, 10000, 'child termination');
  } finally {
    clearTimeout(escalation);
    proc.removeListener('exit', onExit);
  }
}

// Test-only lifecycle boundary. Disconnect failure must not strand the owned
// child, and neither failure may prevent removal of temporary test data.
export async function _cleanupTestBrowser({ browser, proc, cleanup }) {
  const errors = [];
  try {
    await withinDeadline(() => browser?.close(), 5000, 'browser disconnect').catch(error => errors.push(error));
    await terminateOwnedChrome(proc).catch(error => errors.push(error));
  } finally {
    proc?.stderr?.destroy();
    await cleanup();
  }
  if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('; '));
}
