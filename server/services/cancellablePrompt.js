/** Bind the streamed prompt runner's concrete attempts to an operation's cancellation. */
export async function runCancellablePrompt(runPrompt, args, signal, stopRun = stopProviderRun) {
  if (!signal) return runPrompt(args);
  signal.throwIfAborted();
  const active = new Set();
  const stopping = [];
  const stop = (runId) => {
    stopping.push(stopRun(runId).catch((error) => {
      console.error(`❌ Could not stop provider run: ${error.message}`);
    }));
  };
  const onAbort = () => {
    for (const runId of active) stop(runId);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const result = await runPrompt({
      ...args,
      beforeExecute: async (run) => {
        signal.throwIfAborted();
        if (args.beforeExecute) {
          await args.beforeExecute(run);
          signal.throwIfAborted();
        }
      },
      onRunCreated: (runId) => {
        if (signal.aborted) stop(runId);
        else active.add(runId);
      },
      onRunSettled: (runId) => active.delete(runId),
    });
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener('abort', onAbort);
    await Promise.all(stopping);
  }
}

async function stopProviderRun(runId) {
  const { stopRun } = await import('./runner.js');
  return stopRun(runId);
}
