export function createRunLifecycle({ runId, controller, stallTimeout, absoluteTimeout, onTimeout }) {
  let settled = false;
  let started = false;
  let stallTimeoutHandle = null;
  let absoluteTimeoutHandle = null;

  const markSettled = () => {
    if (settled) return false;
    settled = true;
    clearTimeout(stallTimeoutHandle);
    clearTimeout(absoluteTimeoutHandle);
    stallTimeoutHandle = null;
    absoluteTimeoutHandle = null;
    return true;
  };

  const fireTimeout = (bound) => {
    if (settled) return;
    const limit = bound === 'absolute' ? absoluteTimeout : stallTimeout;
    console.log(`⏱️ API run ${runId} timed out: ${bound} bound of ${limit}ms`);
    controller.abort();
    try {
      const result = onTimeout(bound);
      if (result && typeof result.then === 'function') {
        result.catch(err => console.error(`❌ API run ${runId} timeout handler error: ${err.message}`));
      }
    } catch (err) {
      console.error(`❌ API run ${runId} timeout handler error: ${err.message}`);
    }
  };

  const armStallTimer = () => {
    stallTimeoutHandle = setTimeout(() => fireTimeout('stall'), stallTimeout);
  };

  const noteStreamProgress = () => {
    if (!started || settled) return;
    clearTimeout(stallTimeoutHandle);
    armStallTimer();
  };

  const start = () => {
    if (started || settled) return;
    started = true;
    armStallTimer();
    absoluteTimeoutHandle = setTimeout(() => fireTimeout('absolute'), absoluteTimeout);
  };

  return { start, markSettled, noteStreamProgress };
}
